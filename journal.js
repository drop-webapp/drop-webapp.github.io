"use strict";

const $ = (id) => document.getElementById(id);
const apiOrigin = document.body.dataset.apiOrigin || "";
let csrfToken;
const editor = $("editor");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayFormatter = new Intl.DateTimeFormat("zh-CN", {month: "long", day: "numeric", weekday: "short"});
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit"});
const selected = new Set();
const errorMessages = {
  authentication_required: "请重新登录。",
  calendar_not_configured: "日程服务尚未配置。",
  calendar_access_denied: "当前账号无法读取日程。",
  invalid_date_or_timezone: "无法识别所选日期或时区。",
  calendar_provider_error: "暂时无法读取日程，请稍后重试。",
  transcription_not_configured: "语音转写尚未配置。",
  audio_required: "没有收到录音，请重试。",
  audio_too_large: "录音文件过大，请缩短录音。",
  transcription_provider_error: "语音转写失败，请稍后重试。",
};
let dayEvents = [];
let archivedEvents = [];
let editing = null;
let coordinates = null;
let editorVersion = 0;
let loadVersion = 0;
let recorder = null;
let recordingBusy = false;
let saving = false;
let editorBaseline = editorSnapshot();
let unloadWarning = false;

function editorSnapshot() {
  return JSON.stringify([
    ...["text", "occurred_at", "city", "place", "event"].map((name) => editor.elements[name].value),
    coordinates,
  ]);
}

function preventDraftLoss(event) {
  event.preventDefault();
  event.returnValue = true;
}

function syncDraftWarning() {
  const dirty = saving || editorSnapshot() !== editorBaseline;
  if (dirty === unloadWarning) return;
  unloadWarning = dirty;
  if (dirty) window.addEventListener("beforeunload", preventDraftLoss);
  else window.removeEventListener("beforeunload", preventDraftLoss);
}

function confirmDiscard() {
  return !saving && (editorSnapshot() === editorBaseline || window.confirm("放弃未保存的修改？"));
}

function editorStatus(message = "", failed = false) {
  const status = $("editor-status");
  status.textContent = message;
  status.classList.toggle("destructive", failed);
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(label, action) {
  const node = element("button", label, "quiet");
  node.type = "button";
  node.addEventListener("click", () => action(node));
  return node;
}

function localDateTime(value) {
  const date = new Date(value);
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function dateKey(value = new Date()) {
  return localDateTime(value).slice(0, 10);
}

function notice(message = "") {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}

async function api(path, {method = "GET", body} = {}) {
  const headers = {Accept: "application/json"};
  if (method !== "GET") {
    const csrf = document.cookie.split("; ").find((item) => item.startsWith("csrftoken="));
    if (csrfToken) headers["X-CSRFToken"] = csrfToken;
    else if (csrf) headers["X-CSRFToken"] = decodeURIComponent(csrf.slice("csrftoken=".length));
  }
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(apiOrigin + "/api/" + path, {method, body, headers, credentials: "include"});
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = {401: "请重新登录。", 403: "当前操作没有权限。", 404: "这项内容已不存在。", 503: "服务暂时不可用。"};
    const detail = typeof result.error === "string" ? result.error : result.detail;
    throw new Error(errorMessages[detail] || detail || fallback[response.status] || "请求失败，请重试。");
  }
  return result;
}

async function run(control, action) {
  control.disabled = true;
  notice();
  try {
    await action();
  } catch (error) {
    notice(error.message);
  } finally {
    control.disabled = false;
  }
}

function eventName(event) {
  return typeof event === "string" ? event : event?.title;
}

function updateShareSelection() {
  $("share-count").textContent = selected.size ? ` · 已选 ${selected.size} 条` : "";
  $("create-share").disabled = !selected.size ||
    !$("share-form").querySelector('input[name="fields"]:checked');
}

function renderEntries(target, entries, isPublic = false) {
  target.replaceChildren(...entries.map((entry) => {
    const card = element("article", undefined, "note");
    if (entry.occurred_at) {
      const date = new Date(entry.occurred_at);
      const label = isPublic ? date.toLocaleString("zh-CN") : timeFormatter.format(date);
      const time = element("time", label);
      time.dateTime = entry.occurred_at;
      card.append(time);
    }
    if (entry.text) card.append(element("p", entry.text));
    const meta = [entry.city, entry.place, eventName(entry.event)].filter(Boolean);
    if (entry.latitude != null) meta.push("纬度 " + entry.latitude);
    if (entry.longitude != null) meta.push("经度 " + entry.longitude);
    if (meta.length) card.append(element("p", meta.join(" · "), "note-meta"));
    if (!isPublic) {
      const actions = element("div", undefined, "note-actions");
      const remove = button("删除", (control) => {
        if (saving) return;
        const message = editing?.id === entry.id && editorSnapshot() !== editorBaseline
          ? "删除这条记录并放弃未保存的修改？"
          : "删除这条记录？";
        if (!window.confirm(message)) return;
        return run(control, async () => {
          await api("entries/" + entry.id + "/", {method: "DELETE"});
          selected.delete(entry.id);
          updateShareSelection();
          if (editing?.id === entry.id) resetEditor();
          await loadDay();
        });
      });
      const label = element("label");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(entry.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selected.add(entry.id);
          $("share").open = true;
        } else {
          selected.delete(entry.id);
        }
        updateShareSelection();
      });
      label.append(checkbox, " 分享");
      const menu = element("details", undefined, "note-menu");
      const menuLabel = element("summary", "更多");
      remove.classList.add("destructive");
      menu.append(menuLabel, button("编辑", () => {
        menu.open = false;
        editEntry(entry);
      }), remove);
      actions.append(label, menu);
      card.append(actions);
    }
    return card;
  }));
}

function showCoordinates(value) {
  coordinates = value;
  syncDraftWarning();
  $("coordinates").value = value ? value.latitude.toFixed(5) + ", " + value.longitude.toFixed(5) : "";
  $("clear-location").hidden = !value;
}

function renderEventOptions(current) {
  const select = editor.elements.event;
  const previous = select.eventById?.get(select.value);
  const chosen = current === undefined ? previous : current;
  const snapshots = [...dayEvents, ...archivedEvents];
  if (editing?.event) snapshots.push(editing.event);
  if (chosen) snapshots.push(chosen);
  const eventById = new Map(snapshots.map((event) => [event.id, event]));
  select.replaceChildren(new Option("无", ""), ...[...eventById.values()].map((event) =>
    new Option(eventName(event) || "未命名日程", event.id)));
  select.value = chosen?.id || "";
  select.eventById = eventById;
}

function resetEditor() {
  editorVersion += 1;
  editing = null;
  editor.elements.text.required = true;
  editor.elements.occurred_at.disabled = false;
  editor.elements.event.disabled = false;
  editor.reset();
  showCoordinates(null);
  renderEventOptions(null);
  $("capture-title").textContent = "写日记";
  $("save").textContent = "记一滴";
  $("cancel").hidden = true;
  $("backdate").hidden = !$("date").value || $("date").value >= dateKey();
  editorBaseline = editorSnapshot();
  syncDraftWarning();
}

function editEntry(entry) {
  if (!confirmDiscard()) return;
  editorStatus();
  editorVersion += 1;
  editing = entry;
  editor.elements.text.required = !entry.archived;
  editor.elements.occurred_at.disabled = Boolean(entry.archived);
  editor.elements.event.disabled = Boolean(entry.archived);
  editor.elements.text.value = entry.text;
  editor.elements.occurred_at.value = localDateTime(entry.occurred_at);
  editor.elements.city.value = entry.city || "";
  editor.elements.place.value = entry.place || "";
  const value = entry.latitude != null && entry.longitude != null
    ? {latitude: Number(entry.latitude), longitude: Number(entry.longitude)}
    : null;
  showCoordinates(value);
  renderEventOptions(entry.event);
  $("details").open = true;
  $("capture-title").textContent = "编辑记录";
  $("save").textContent = "保存修改";
  $("cancel").hidden = false;
  $("backdate").hidden = true;
  editorBaseline = editorSnapshot();
  syncDraftWarning();
  editor.elements.text.focus();
}

async function loadDay() {
  const version = ++loadVersion;
  const day = $("date").value;
  const date = new Date(day + "T12:00:00");
  $("day-title").textContent = dayFormatter.format(date);
  $("year").textContent = String(date.getFullYear());
  $("today").hidden = day === dateKey();
  $("backdate").hidden = day >= dateKey() || Boolean(editing);
  $("backdate").textContent = "补记 " + dayFormatter.format(date);
  $("retry-day").hidden = true;
  $("entry-state").textContent = "正在读取记录…";
  $("entries").replaceChildren();
  $("events").textContent = "正在读取日程…";
  $("archive").hidden = true;
  dayEvents = [];
  archivedEvents = [];
  renderEventOptions();
  const query = new URLSearchParams({date: day, tz});
  await Promise.all([
    api("entries/?" + query).then(({entries}) => {
      if (version !== loadVersion) return;
      archivedEvents = entries.filter((entry) => entry.archived && entry.event).map((entry) => entry.event);
      renderEventOptions();
      renderEntries($("entries"), entries);
      $("entry-state").textContent = entries.length ? entries.length + " 条记录" : "这一天还没有记录。可以写一条，也可以切换日期。";
    }).catch((error) => {
      if (version !== loadVersion) return;
      $("entry-state").textContent = error.message;
      $("retry-day").hidden = false;
    }),
    api("integrations/calendar/?" + query).then(({events}) => {
      if (version !== loadVersion) return;
      dayEvents = events;
      renderEventOptions();
      renderCalendar(events);
    }).catch((error) => {
      if (version === loadVersion) $("events").textContent = error.message;
    }),
  ]);
}

function renderCalendar(events) {
  $("events").replaceChildren(...events.map((event, index) => {
    const label = element("label");
    const check = element("input");
    check.type = "checkbox";
    check.value = index;
    const time = event.all_day ? "全天" : timeFormatter.format(new Date(event.start));
    label.append(check, " " + time + " · " + event.title);
    return label;
  }));
  $("archive").hidden = !events.length;
  if (!events.length) $("events").textContent = "当天没有日程。";
}

function setDay(day, clearSelection = true) {
  if (clearSelection) selected.clear();
  updateShareSelection();
  $("date").value = day;
  return loadDay();
}

function moveDay(offset) {
  const day = new Date($("date").value + "T12:00:00");
  day.setDate(day.getDate() + offset);
  return setDay(dateKey(day));
}

async function refreshLinks() {
  const {shares} = await api("shares/");
  $("links").replaceChildren(...shares.map((share) => {
    const row = element("div");
    const link = element("a", "打开链接");
    link.href = share.url;
    const revoke = button("撤销", (control) => run(control, async () => {
      await api("shares/" + share.id + "/", {method: "DELETE"});
      $("share-result").replaceChildren();
      await refreshLinks();
      notice("已撤销链接。");
    }));
    row.append(link, " ", revoke);
    return row;
  }));
  if (!shares.length) $("links").textContent = "暂无分享链接。";
}

editor.addEventListener("submit", (event) => {
  event.preventDefault();
  if (saving) return;
  if (recordingBusy || $("locate").disabled) {
    editorStatus("请先完成语音转写或定位，再保存。", true);
    return;
  }
  saving = true;
  $("editor-controls").disabled = true;
  editorStatus("正在保存…");
  syncDraftWarning();
  void (async () => {
    try {
      const fields = editor.elements;
      const text = fields.text.value.trim();
      if (!text && !editing?.archived) throw new Error("请输入记录正文。");
      const enteredAt = fields.occurred_at.value;
      const originalTime = editing && enteredAt === localDateTime(editing.occurred_at);
      const occurredAt = originalTime ? editing.occurred_at : new Date(enteredAt || Date.now()).toISOString();
      const choice = fields.event.value;
      const version = editorVersion;
      const body = {
        text,
        occurred_at: occurredAt,
        city: fields.city.value.trim(),
        place: fields.place.value.trim(),
        latitude: coordinates?.latitude ?? null,
        longitude: coordinates?.longitude ?? null,
        event: fields.event.eventById.get(choice) ?? null,
      };
      if (editing?.archived) {
        delete body.occurred_at;
        delete body.event;
      }
      const path = editing ? "entries/" + editing.id + "/" : "entries/";
      await api(path, {method: editing ? "PATCH" : "POST", body});
      if (editorVersion === version) resetEditor();
      const day = dateKey(occurredAt);
      editorStatus("已保存。");
      void setDay(day, day !== $("date").value);
    } catch (error) {
      editorStatus(error instanceof TypeError ? "无法连接服务器，内容已保留。请重试。" : error.message, true);
    } finally {
      saving = false;
      $("editor-controls").disabled = false;
      syncDraftWarning();
    }
  })();
});

$("cancel").addEventListener("click", () => {
  if (!confirmDiscard()) return;
  resetEditor();
  editorStatus();
  editor.elements.text.focus();
});
editor.addEventListener("input", () => {
  syncDraftWarning();
  if ($("editor-status").textContent === "已保存。") editorStatus();
});
editor.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) ||
      event.isComposing || event.target !== editor.elements.text) return;
  event.preventDefault();
  if (!event.repeat && !saving) editor.requestSubmit($("save"));
});
$("backdate").addEventListener("click", () => {
  const time = editor.elements.occurred_at;
  const clock = time.value.slice(11) || localDateTime(Date.now()).slice(11);
  time.value = $("date").value + "T" + clock;
  $("details").open = true;
  syncDraftWarning();
  editor.elements.text.focus();
});
$("write").addEventListener("click", () => editor.elements.text.focus());
$("retry-day").addEventListener("click", loadDay);
$("share-form").addEventListener("change", updateShareSelection);
$("date").addEventListener("change", () => setDay($("date").value || dateKey()));
$("prev").addEventListener("click", () => moveDay(-1));
$("next").addEventListener("click", () => moveDay(1));
$("today").addEventListener("click", () => setDay(dateKey()));
$("clear-location").addEventListener("click", () => showCoordinates(null));
$("locate").addEventListener("click", () => run($("locate"), async () => {
  if (!navigator.geolocation) throw new Error("当前浏览器无法读取位置。");
  const version = editorVersion;
  const position = await new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {timeout: 10000}));
  if (editorVersion !== version) return;
  showCoordinates({latitude: position.coords.latitude, longitude: position.coords.longitude});
  $("details").open = true;
}));
$("archive").addEventListener("click", () => run($("archive"), async () => {
  const events = [...$("events").querySelectorAll("input:checked")].map((input) => dayEvents[Number(input.value)]);
  if (!events.length) throw new Error("请先勾选要归档的日程。");
  await api("calendar/archive/", {method: "POST", body: {events, tz}});
  await loadDay();
  notice("已归档所选日程。");
}));

$("share").addEventListener("toggle", () => {
  if ($("share").open) refreshLinks().catch((error) => { $("links").textContent = error.message; });
});
$("share-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(event.submitter, async () => {
    const form = new FormData(event.currentTarget);
    const fields = form.getAll("fields");
    if (!selected.size || !fields.length) throw new Error("请至少选择一条记录和一个可见字段。");
    const {url} = await api("shares/", {method: "POST", body: {
      entry_ids: [...selected], fields, expires_in: Number(form.get("expires_in")),
    }});
    const address = new URL(url, location.origin).href;
    const link = element("a", address);
    link.href = address;
    const copy = button("复制", (control) => run(control, async () => {
      await navigator.clipboard.writeText(address);
      notice("已复制链接。");
    }));
    $("share-result").replaceChildren(link, " ", copy);
    await refreshLinks();
  }).finally(updateShareSelection);
});

$("record").addEventListener("click", async () => {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  if (recordingBusy) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    notice("当前浏览器无法录音，请检查设备与安全连接。");
    return;
  }
  const control = $("record");
  const version = editorVersion;
  let stream;
  let stopTimer;
  recordingBusy = true;
  control.disabled = true;
  notice();
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: true});
    recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
    recorder.addEventListener("error", () => notice("录音失败，请重试。"), {once: true});
    recorder.addEventListener("stop", () => {
      clearTimeout(stopTimer);
      stream.getTracks().forEach((track) => track.stop());
      control.setAttribute("aria-pressed", "false");
      control.textContent = "正在转写…";
      run(control, async () => {
        try {
          if (editorVersion !== version) return;
          const type = recorder.mimeType || chunks[0]?.type;
          const extension = type?.includes("mp4") ? "m4a" : type?.includes("ogg") ? "ogg" : "webm";
          const audio = new Blob(chunks, {type});
          if (!audio.size) throw new Error("没有录到声音，请重试。");
          const body = new FormData();
          body.append("audio", audio, "drop." + extension);
          const {text} = await api("integrations/transcribe/", {method: "POST", body});
          if (editorVersion !== version) return;
          if (!text?.trim()) throw new Error("未识别到文字。");
          const input = editor.elements.text;
          input.value = [input.value, text].filter(Boolean).join("\n");
          syncDraftWarning();
          input.focus();
        } finally {
          recordingBusy = false;
          recorder = null;
          control.textContent = "语音转文字";
        }
      });
    }, {once: true});
    recorder.start();
    stopTimer = setTimeout(() => {
      if (recorder?.state === "recording") recorder.stop();
    }, 60000);
    control.setAttribute("aria-pressed", "true");
    control.textContent = "停止录音";
    control.disabled = false;
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    recordingBusy = false;
    control.disabled = false;
    notice("无法开始录音，请检查麦克风权限。");
  }
});

$("logout").addEventListener("click", () => {
  if (!confirmDiscard()) return;
  return run($("logout"), async () => {
    await api("logout/", {method: "POST"});
    window.removeEventListener("beforeunload", preventDraftLoss);
    location.reload();
  });
});
$("dev-login").addEventListener("click", () => run($("dev-login"), async () => {
  await api("dev-login/", {method: "POST"});
  location.reload();
}));

async function start() {
  const token = document.body.dataset.shareToken || new URLSearchParams(location.search).get("share");
  if (token) {
    $("public").hidden = false;
    $("public-state").textContent = "正在读取分享…";
    try {
      const {entries} = await api("public/shares/" + encodeURIComponent(token) + "/");
      renderEntries($("public-entries"), entries, true);
      $("public-state").textContent = entries.length ? "" : "这里没有可见记录。";
    } catch (error) {
      $("public-state").textContent = error.message;
    }
    return;
  }
  const session = await api("session/");
  csrfToken = session.csrf_token;
  if (!session.authenticated) {
    $("guest").hidden = false;
    $("dev-login").hidden = !session.dev_login;
    return;
  }
  const identity = $("identity");
  identity.textContent = session.display_name || "";
  if (session.avatar_url) {
    const avatar = document.createElement("img");
    avatar.alt = "";
    avatar.referrerPolicy = "no-referrer";
    avatar.addEventListener("error", () => avatar.remove(), {once: true});
    avatar.src = session.avatar_url;
    identity.prepend(avatar);
  }
  $("grants").hidden = false;
  $("logout").hidden = false;
  $("journal").hidden = false;
  await setDay(dateKey());
}
start().catch((error) => notice(error.message));
