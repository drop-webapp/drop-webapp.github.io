"use strict";

const $ = (id) => document.getElementById(id);
const apiOrigin = document.body.dataset.apiOrigin || "";
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const clockFormat = new Intl.DateTimeFormat("zh-CN", {hour: "2-digit", minute: "2-digit"});
const dayFormat = new Intl.DateTimeFormat("zh-CN", {month: "long", day: "numeric"});
const weekdayFormat = new Intl.DateTimeFormat("zh-CN", {weekday: "long"});
const selected = new Set();
const drafts = new Map();
const entryCache = new Map();
const monthCache = new Map();
const scene = document.querySelector(".voice-home");
let session, csrfToken, store, currentDraft = null, currentEntry = null;
let dayEntries = [], dayEvents = [], latestDate = null, lastEntry = null, shareContextEntry = null;
let currentPanel = null, panelTrail = [], panelOpener = null, confirmResolve;
let dayVersion = 0, monthVersion = 0, searchVersion = 0, homeVersion = 0, calendarVersion = 0;
let shownMonth, saving = false, draftWrite = Promise.resolve(), toastTimer, searchTimer;
const draftTimers = new Map();
let pendingWrites = 0, closingPanel = false, signingOut = false, startingVoice = false;
let voiceState = "idle", capture = null, pendingVoice = null, voiceProcess = 0, audioPlayer = null, audioURL = null;
let autoLocation = true, locationVersion = 0, sessionExpired = false;
let savedAudioPlayer = null, savedAudioReset = null;
let playbackVersion = 0;
const localFailures = new Set();
const refining = new Set();
let versionRecordID = null, choosingVersion = false;
const audioUploads = new Map();
const panelHistoryKey = "drop-" + Date.now();
let skipPanelPop = false;
if (history.state?.dropPanel) history.replaceState(null, "", location.href);
const errors = {
  authentication_required: "登录已过期，草稿还在。重新登录后就能保存。",
  calendar_connect_required: "连接 Chronelle 后，可以把日程和感受放在一起。",
  calendar_not_configured: "日程连接暂时不可用，请稍后再试。",
  calendar_access_denied: "需要重新选择允许读取的日程分组。",
  calendar_provider_error: "暂时读不到日程，稍后再试一次。",
  transcription_not_configured: "语音转写暂时不可用，录音仍在草稿里。",
  transcription_provider_error: "这次没能转成文字，录音还在，可以再试一次。",
  refinement_not_configured: "轻整理暂时不可用，原话可以直接保存。",
  invalid_transcript: "暂时无法整理这段声音，原始文字仍然保留。",
  audio_required: "没有收到录音，请再说一次。",
  audio_too_large: "这一段有些长，请分成短一点的片刻。",
  audio_upload_incomplete: "声音还没上传完整，原录音仍在本机，可以重试。",
  audio_storage_unavailable: "暂时无法保存声音，录音仍在本机草稿里。",
  audio_not_found: "这段录音已经移除。",
  "Sign in required.": "登录已过期，草稿还在。重新登录后就能保存。",
  "Entry not found.": "这条记录已被删除。",
  account_changed: "这个浏览器已切换账号。为保护日记，请刷新后继续；原账号草稿仍保留在本机。",
};

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon"); svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", "#i-" + name); svg.append(use); return svg;
}
function button(text, action, className = "quiet") {
  const el = node("button", text, className); el.type = "button";
  el.addEventListener("click", () => action(el)); return el;
}
function dateKey(value = new Date()) {
  const date = new Date(value);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
function dayDate(day) { return new Date(day + "T12:00:00"); }
function shiftDay(day, amount) { const date = dayDate(day); date.setDate(date.getDate() + amount); return dateKey(date); }
function relativeDay(day) { return day === dateKey() ? "今天" : day === shiftDay(dateKey(), -1) ? "昨天" : dayFormat.format(dayDate(day)); }
function momentLabel(value) { const date = new Date(value); return relativeDay(dateKey(date)) + " · " + clockFormat.format(date); }
function durationLabel(seconds) { return Math.floor(seconds / 60) + ":" + String(Math.floor(seconds % 60)).padStart(2, "0"); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }
function eventName(event) { return typeof event === "string" ? event : event?.title; }
function message(error) { return error?.message || "暂时没能完成，请再试一次。"; }

async function api(path, {method = "GET", body, timeout = 25000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {Accept: "application/json"};
  if (session?.user_id) headers["X-Drop-User"] = String(session.user_id);
  if (method !== "GET") {
    const cookie = document.cookie.split("; ").find(part => part.startsWith("csrftoken="));
    if (csrfToken || cookie) headers["X-CSRFToken"] = csrfToken || decodeURIComponent(cookie.slice(10));
  }
  if (body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  try {
    const response = await fetch(apiOrigin + "/api/" + path, {method, body, headers, credentials: "include", signal: controller.signal});
    const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const key = result.error || result.detail;
      const error = new Error(errors[key] || ({401: errors.authentication_required, 403: "暂时无法完成此操作，请刷新后再试。", 404: "这项内容已不存在。", 429: "稍等片刻，再试一次。", 503: "服务暂时没有回应，稍后再试。"})[response.status] || "暂时没能完成，请再试一次。");
      error.code = key; error.status = response.status;
      if (response.status === 401 || key === "account_changed") { sessionExpired = true; renderNetwork(); }
      throw error;
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("连接比平时慢，内容仍在。可以稍后重试。");
    if (error instanceof TypeError) throw new Error("暂时连不上网络，内容仍在。连接恢复后再试。");
    throw error;
  } finally { clearTimeout(timer); }
}
function notice(text) {
  clearTimeout(toastTimer);
  if (currentPanel) {
    const status = $(currentPanel).querySelector(".panel-status");
    if (status) { status.textContent = text; return; }
  }
  $("notice").querySelector("span").textContent = text;
  $("notice").hidden = !text;
  if (text) toastTimer = setTimeout(() => { $("notice").hidden = true; }, 7000);
}
function editorStatus(text = "", failed = false) {
  $("editor-status").textContent = text;
  $("editor-status").classList.toggle("failed", failed);
}
async function run(control, action) {
  control.disabled = true;
  const status = control.closest("dialog")?.querySelector(".panel-status");
  if (status) status.textContent = "";
  try { return await action(); }
  catch (error) { if (status) status.textContent = message(error); else notice(message(error)); }
  finally { control.disabled = false; }
}

// Only one modal surface is presented. Going back restores the previous context.
function holdPanelHistory() {
  if (history.state?.dropPanel !== panelHistoryKey) history.pushState({dropPanel: panelHistoryKey}, "", location.href);
}
function releasePanelHistory() {
  if (history.state?.dropPanel === panelHistoryKey) { skipPanelPop = true; history.back(); }
}
function openPanel(id, {root = false, focus = false} = {}) {
  if (closingPanel || signingOut) return;
  if (id === "compose" && currentDraft?.pendingVersionID) { openVersion(currentDraft, currentDraft.pendingVersionID); return; }
  if (id !== "confirm" && (voiceState === "starting" || voiceState === "recording" || voiceState === "paused")) return;
  if (currentPanel === id) return;
  if (!currentPanel) panelOpener = document.activeElement;
  if (currentPanel) { stopPlayback(); $(currentPanel).close(); if (!root) panelTrail.push(currentPanel); }
  if (root) panelTrail = [];
  currentPanel = id;
  holdPanelHistory();
  const panel = $(id);
  panel.showModal(); document.body.classList.add("has-panel");
  $("notice").hidden = true;
  if (id === "compose") {
    renderEditor();
    (focus ? $("text") : $("capture-title")).focus({preventScroll: true});
  } else {
    panel.querySelector("h2")?.focus({preventScroll: true});
  }
  if (id === "history") { renderWeek(); if (!$("date").value) void setDay(dateKey()); }
  if (id === "search") { $("search-text").focus(); if ($("search-text").value.trim()) void searchEntries(); }
  if (id === "calendar") void loadCalendar();
  if (id === "share") renderShare();
  if (id === "links") void refreshLinks();
  if (id === "voice-version") { versionRecordID = currentDraft?.pendingVersionID || versionRecordID; renderVersion(); }
  if (id === "drafts") renderDrafts();
  if (id === "read") renderReader();
  if (id === "install") renderInstall();
}
function closePanels() {
  if (currentPanel) $(currentPanel).close();
  currentPanel = null; panelTrail = []; document.body.classList.remove("has-panel");
  stopPlayback();
  releasePanelHistory();
  if (panelOpener?.isConnected && !panelOpener.closest("dialog")) panelOpener.focus({preventScroll: true});
}
async function backPanel() {
  if (saving || closingPanel) return;
  if (currentPanel === "confirm") { resolveConfirm(false); return; }
  if (currentPanel === "compose" && currentDraft) {
    closingPanel = true;
    $("text").readOnly = true;
    readEditor();
    currentDraft.suppressAutoOpen = true;
    const saved = await persistDraft(currentDraft);
    closingPanel = false;
    $("text").readOnly = false;
    if (!saved && meaningful(currentDraft)) {
      editorStatus("本机暂时无法保存草稿，请先保存日记，或删除这份草稿后再离开。", true); return;
    }
    stopPlayback();
  }
  if (currentPanel === "voice-version" && currentDraft) {
    currentDraft.suppressAutoOpen = true;
    await persistDraft(currentDraft);
  }
  if (!currentPanel) return;
  stopPlayback();
  $(currentPanel).close();
  const previous = panelTrail.pop(); currentPanel = null;
  if (previous) { const trail = [...panelTrail]; openPanel(previous); panelTrail = trail; }
  else { document.body.classList.remove("has-panel"); releasePanelHistory(); panelOpener?.focus?.({preventScroll: true}); }
  renderDraftSummary();
}
function ask(title, copy, accept = "删除", cancel = "保留") {
  if (confirmResolve) return Promise.resolve(false);
  $("confirm-title").textContent = title; $("confirm-copy").textContent = copy;
  $("confirm-accept").textContent = accept; $("confirm-cancel").textContent = cancel;
  openPanel("confirm"); $("confirm-cancel").focus();
  return new Promise(resolve => { confirmResolve = resolve; });
}
function resolveConfirm(value) {
  const resolve = confirmResolve; confirmResolve = null;
  if (currentPanel === "confirm") {
    $("confirm").close(); currentPanel = null;
    const previous = panelTrail.pop();
    if (previous) { const trail = [...panelTrail]; openPanel(previous); panelTrail = trail; }
    else { document.body.classList.remove("has-panel"); releasePanelHistory(); }
  }
  resolve?.(value);
}
window.addEventListener("popstate", () => {
  if (skipPanelPop) { skipPanelPop = false; if (currentPanel) holdPanelHistory(); return; }
  if (currentPanel) { holdPanelHistory(); void backPanel(); }
});
$("confirm-accept").addEventListener("click", () => resolveConfirm(true));
$("confirm-cancel").addEventListener("click", () => resolveConfirm(false));
document.querySelectorAll("[data-open]").forEach(control => control.addEventListener("click", () => {
  if (control.dataset.open === "share") { shareContextEntry = null; selected.clear(); $("share-result").replaceChildren(); }
  openPanel(control.dataset.open);
}));
document.querySelectorAll("[data-back]").forEach(control => control.addEventListener("click", () => { void backPanel(); }));
document.querySelectorAll("dialog").forEach(panel => {
  panel.addEventListener("cancel", event => { event.preventDefault(); void backPanel(); });
  panel.addEventListener("click", event => {
    if (event.target !== panel) return;
    const rect = panel.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void backPanel();
  });
});
$("dismiss-notice").addEventListener("click", () => { $("notice").hidden = true; });

// Installation is a quiet, optional account action; never interrupt a recording.
const installEntry = button("", () => openPanel("install"), "install-entry");
installEntry.append(icon("install"), node("span", "放在主屏幕"), icon("next"));
$("grants").before(installEntry);
function renderInstall() {
  const installed = DropWebApp.isInstalled();
  document.querySelectorAll(".install-entry").forEach(control => { control.hidden = installed; });
  $("install-copy").textContent = installed ? "一滴已经安放好了。以后轻点它的图标，就能回来。" : "把一滴放在主屏幕。想说的时候，轻点就能回来。";
  $("install-steps").replaceChildren(...(installed ? [] : DropWebApp.installSteps()).map(step => node("li", step)));
  $("install-steps").hidden = installed || DropWebApp.canInstall();
  $("install-footer").hidden = !DropWebApp.canInstall();
}
window.addEventListener("drop:install-state", renderInstall);
$("install-now").addEventListener("click", () => void run($("install-now"), async () => {
  const result = await DropWebApp.install();
  if (result === "dismissed") notice("没关系，想装的时候再回来。");
}));
renderInstall();

async function copyText(value, control) {
  const panel = currentPanel;
  if (await DropWebApp.copy(value)) { control.textContent = "已复制"; return; }
  if (panel !== currentPanel || !control.isConnected) return;
  // A deliberate selection surface remains available even when clipboard
  // permission is denied. Ordinary app labels stay unselectable.
  $("copy-value").value = value;
  openPanel("copy-text");
  $("copy-value").focus({preventScroll: true}); $("copy-value").select();
}
const copyEntry = button("复制正文", control => void copyText(currentEntry.text, control));
copyEntry.id = "read-copy";
$("read").querySelector(".reader-extras").prepend(copyEntry);

function meaningful(draft) {
  if (!draft) return false;
  if (draft.audio || draft.pendingVersionID) return true;
  if (draft.entry) return draft.text !== draft.entry.text || JSON.stringify((draft.voiceTranscripts || []).map(row => [row.id, row.refined_text])) !== JSON.stringify((draft.entry.voice_transcripts || []).map(row => [row.id, row.refined_text])) || JSON.stringify(draft.coordinates) !== JSON.stringify(entryCoordinates(draft.entry)) || (!draft.entry.archived && (draft.occurredAt !== draft.entry.occurred_at || JSON.stringify(draft.event) !== JSON.stringify(draft.entry.event)));
  return Boolean(draft.text?.trim());
}
function persistDraft(draft) {
  if (!draft || draft.deleted || signingOut) return Promise.resolve(false);
  clearTimeout(draftTimers.get(draft.id)); draftTimers.delete(draft.id);
  draft.updatedAt = Date.now();
  const snapshot = {...draft};
  delete snapshot.transcribing;
  if (meaningful(snapshot)) drafts.set(draft.id, draft); else drafts.delete(draft.id);
  renderDraftSummary();
  if (!store) { localFailures.add(draft.id); return Promise.resolve(false); }
  pendingWrites++;
  const operation = draftWrite.catch(() => {}).then(async () => {
    try {
      if (draft.deleted || signingOut) return false;
      if (meaningful(snapshot)) await store.put(snapshot); else await store.remove(snapshot.id);
      localFailures.delete(snapshot.id);
      return true;
    } catch {
      localFailures.add(snapshot.id); return false;
    } finally { pendingWrites--; }
  });
  draftWrite = operation;
  return operation;
}
async function removeDraft(draft) {
  draft.deleted = true;
  audioUploads.get(draft.id)?.controller?.abort();
  clearTimeout(draftTimers.get(draft.id)); draftTimers.delete(draft.id);
  if (pendingVoice?.id === draft.id) { ++voiceProcess; pendingVoice = null; setVoiceState("idle"); }
  await draftWrite.catch(() => {});
  try {
    if (!draft.saved) {
      const saved = new Set((draft.entry?.recordings || []).map(row => row.id));
      const ids = new Set([...(draft.recordings || []).map(row => row.id), draft.pendingUpload?.recording_id].filter(Boolean));
      for (const id of ids) if (!saved.has(id)) {
        try { await api("integrations/audio/" + id + "/", {method: "DELETE"}); }
        catch (error) { if (error.status !== 404) throw error; }
      }
    }
    await store?.remove(draft.id);
  }
  catch (error) { draft.deleted = false; throw error; }
  drafts.delete(draft.id); localFailures.delete(draft.id); renderDraftSummary();
}
function newDraft({text = "", event = null, day, source = "text"} = {}) {
  const now = new Date();
  if (day && day !== dateKey()) {
    const target = dayDate(day); target.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
    now.setTime(target.getTime());
  }
  return {id: uuid(), clientId: uuid(), text, occurredAt: now.toISOString(), coordinates: null, city: "", place: "", event, source, updatedAt: Date.now(), audio: null, audioApplied: false, locationDisabled: false};
}
function renderDraftSummary() {
  const count = drafts.size;
  $("draft-resume").hidden = !count;
  $("draft-label").textContent = count === 1 ? "还有一段没写完，接着记" : `还有 ${count} 段没写完`;
}
function renderDrafts() {
  const list = [...drafts.values()].sort((a,b) => b.updatedAt - a.updatedAt);
  $("draft-list").replaceChildren(...list.map(draft => {
    const row = node("div", undefined, "draft-item");
    const resume = button("", () => { currentDraft = draft; openPanel("compose"); });
    resume.append(node("strong", draft.text?.trim() || "一段还没转成文字的声音"), node("small", momentLabel(draft.occurredAt) + (draft.entry ? " · 未完成的修改" : draft.audio ? " · 语音草稿" : " · 文字草稿")));
    const discard = button("", async () => {
      if (!await ask("删除这份草稿？", "草稿中的文字和录音会从这个浏览器移除。已保存的日记不受影响。")) return;
      await run(discard, async () => { await removeDraft(draft); if (currentDraft?.id === draft.id) currentDraft = null; renderDrafts(); });
    }, "icon-button destructive");
    discard.append(icon("trash")); discard.setAttribute("aria-label", "删除草稿");
    row.append(resume, discard); return row;
  }));
  if (!list.length) $("draft-list").append(node("p", "写到一半的片刻，会在这里等你。", "supporting"));
}
function entryCoordinates(entry) { return entry.latitude != null && entry.longitude != null ? {latitude: Number(entry.latitude), longitude: Number(entry.longitude)} : null; }

async function monthData(month, fresh = false) {
  if (!fresh && monthCache.has(month)) return monthCache.get(month);
  const result = await api("entries/days/?" + new URLSearchParams({month, tz}));
  monthCache.set(month, result); latestDate = result.latest_date; return result;
}
function dateCount(day) { return monthCache.get(day.slice(0,7))?.days.find(item => item.date === day)?.count || 0; }
async function loadDay() {
  const day = $("date").value || dateKey();
  const version = ++dayVersion;
  const date = dayDate(day);
  $("day-title").textContent = dayFormat.format(date);
  $("day-subtitle").textContent = date.getFullYear() + " · " + weekdayFormat.format(date) + (day === dateKey() ? " · 今天" : day === shiftDay(dateKey(), -1) ? " · 昨天" : "");
  $("today").hidden = day === dateKey();
  $("entry-state").textContent = "正在翻到这一天…";
  $("entries").setAttribute("aria-busy", "true");
  $("retry-day").hidden = true; $("empty-day").hidden = true;
  $("entries").replaceChildren();
  dayEntries = [];
  renderWeek();
  try {
    const {entries} = await api("entries/?" + new URLSearchParams({date: day, tz}));
    entryCache.set(day, entries);
    if (version !== dayVersion) return;
    dayEntries = entries; renderEntries($("entries"), entries);
    $("entry-state").textContent = entries.length ? `这一天，留下了 ${entries.length} 个片刻` : "";
    $("empty-day").hidden = entries.length > 0;
    $("latest-day").hidden = !latestDate || latestDate === day;
  } catch (error) {
    if (version !== dayVersion) return;
    $("entry-state").textContent = message(error); $("retry-day").hidden = false;
  } finally {
    if (version === dayVersion) $("entries").setAttribute("aria-busy", "false");
  }
}
function setDay(day) {
  if (day > dateKey()) day = dateKey();
  $("date").value = day;
  selected.clear(); shareContextEntry = null;
  if (!$("date-panel").hidden) void renderMonth(dayDate(day));
  return loadDay();
}
function renderWeek() {
  const day = $("date").value || dateKey();
  const start = shiftDay(day, -(dayDate(day).getDay() + 6) % 7);
  const days = Array.from({length: 7}, (_, i) => shiftDay(start, i));
  $("week-days").replaceChildren(...days.map((value, i) => {
    const count = dateCount(value);
    const cell = button("", () => { void setDay(value); }, "week-day" + (count ? " has-entries" : ""));
    cell.append(node("span", value === dateKey() ? "今" : "一二三四五六日"[i]), node("strong", dayDate(value).getDate()));
    cell.setAttribute("aria-pressed", String(value === day));
    cell.setAttribute("aria-label", value + (count ? `，${count} 条记录` : ""));
    cell.disabled = value > dateKey(); return cell;
  }));
  $("next").disabled = shiftDay(start, 7) > dateKey();
  const missing = [...new Set(days.map(value => value.slice(0,7)))].filter(month => !monthCache.has(month));
  for (const month of missing) {
    // Pending markers avoid duplicate requests while rendering another week.
    monthCache.set(month, {days: [], latest_date: latestDate});
    void monthData(month, true).then(() => { if ($("date").value === day) renderWeek(); }).catch(() => { monthCache.delete(month); });
  }
}
async function renderMonth(date) {
  shownMonth = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  const month = dateKey(shownMonth).slice(0,7), version = ++monthVersion;
  $("month-label").textContent = shownMonth.getFullYear() + " 年 " + (shownMonth.getMonth() + 1) + " 月";
  $("next-month").disabled = month >= dateKey().slice(0,7);
  $("month-status").textContent = "";
  const draw = () => {
    const nodes = [..."一二三四五六日"].map(day => node("span", day));
    const offset = (shownMonth.getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) nodes.push(node("span", ""));
    const count = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 0).getDate();
    for (let i = 1; i <= count; i++) {
      const value = month + "-" + String(i).padStart(2,"0"), amount = dateCount(value);
      const cell = button(String(i), () => { toggleDate(false); void setDay(value); $("open-date").focus(); }, amount ? "has-entries" : "");
      cell.disabled = value > dateKey();
      cell.setAttribute("aria-label", value + (amount ? `，${amount} 条记录` : ""));
      cell.setAttribute("aria-pressed", String(value === $("date").value));
      if (value === dateKey()) cell.setAttribute("aria-current", "date");
      nodes.push(cell);
    }
    $("month-days").replaceChildren(...nodes);
  };
  draw();
  try { await monthData(month, true); if (version === monthVersion) draw(); }
  catch { if (version === monthVersion) $("month-status").textContent = "日期仍可选择，记录标点暂时没有载入。"; }
}
function toggleDate(open) {
  $("date-panel").hidden = !open; $("open-date").setAttribute("aria-expanded", String(open));
  if (open) void renderMonth(dayDate($("date").value));
}
function renderEntries(target, entries, {publicView = false, search = false} = {}) {
  target.replaceChildren(...entries.map(entry => {
    const card = node("article", undefined, "note");
    const content = publicView ? node("div", undefined, "note-open") : button("", () => viewEntry(entry), "note-open");
    if (entry.occurred_at) {
      const time = node("time", search || publicView ? momentLabel(entry.occurred_at) : clockFormat.format(new Date(entry.occurred_at)));
      time.dateTime = entry.occurred_at; content.append(time);
    }
    if (entry.text || entry.event || !publicView) content.append(node("p", entry.text || eventName(entry.event) || (entry.recordings?.length ? "一段留下的声音" : "一个日程片刻"), "note-text"));
    const meta = node("div", undefined, "note-meta");
    const place = [entry.city, entry.place].filter(Boolean).join(" · ");
    if (place || entry.latitude != null || entry.longitude != null) {
      const location = node("span", place || (publicView ? [entry.latitude != null ? `纬度 ${entry.latitude}` : "", entry.longitude != null ? `经度 ${entry.longitude}` : ""].filter(Boolean).join(" · ") : "此刻的位置"));
      location.prepend(icon("pin")); meta.append(location);
    }
    if (entry.event) { const event = node("span", eventName(entry.event)); event.prepend(icon("calendar")); meta.append(event); }
    if (meta.childElementCount) content.append(meta);
    if (!publicView) content.setAttribute("aria-label", `${entry.occurred_at ? momentLabel(entry.occurred_at) : ""}，${(entry.text || eventName(entry.event) || (entry.recordings?.length ? "一段留下的声音" : "日程")).slice(0, 100)}，打开记录`);
    card.append(content);
    if (publicView && entry.text) card.append(button("复制文字", control => void copyText(entry.text, control)));
    return card;
  }));
}
function viewEntry(entry) { currentEntry = entry; openPanel("read"); }
function renderReader() {
  if (!currentEntry) return;
  const entry = currentEntry;
  $("read-copy").hidden = !entry.text; $("read-copy").textContent = "复制正文";
  $("read-date").textContent = new Date(entry.occurred_at).toLocaleDateString("zh-CN", {year: "numeric", month: "long", day: "numeric", weekday: "short"}) + " · " + clockFormat.format(new Date(entry.occurred_at));
  $("read-content").textContent = entry.text || (entry.recordings?.length ? "那一刻的声音，留在这里。" : "这段日程已留下，还可以写一点当时的感受。");
  $("read-meta").replaceChildren();
  renderSavedRecordings($("read-meta"), entry.recordings || []);
  if (entry.event) { const el = node("p", eventName(entry.event)); el.prepend(icon("calendar")); $("read-meta").append(el); }
  if (entry.city || entry.place) { const el = node("p", [entry.city, entry.place].filter(Boolean).join(" · ")); el.prepend(icon("pin")); $("read-meta").append(el); }
  if (entry.latitude != null && entry.longitude != null) {
    const details = node("details"); details.append(node("summary", "此刻留下的位置"), node("p", `纬度 ${Number(entry.latitude).toFixed(5)} · 经度 ${Number(entry.longitude).toFixed(5)}`)); $("read-meta").append(details);
  }
  if (entry.voice_transcripts?.length) {
    const sources = node("div", undefined, "voice-transcripts");
    renderVoiceTranscripts(sources, entry.voice_transcripts);
    $("read-meta").append(sources);
  }
  $("read").querySelector(".panel-status").textContent = "";
}
async function refreshHome() {
  const version = ++homeVersion;
  try {
    const result = await monthData(dateKey().slice(0,7), true);
    if (version !== homeVersion) return;
    latestDate = result.latest_date;
    $("latest-day").hidden = !latestDate || latestDate === $("date").value;
    if (!latestDate) { lastEntry = null; $("last-entry").hidden = true; return; }
    const data = await api("entries/?" + new URLSearchParams({date: latestDate, tz}));
    if (version !== homeVersion) return;
    entryCache.set(latestDate, data.entries); lastEntry = data.entries[0] || null;
    $("last-entry").hidden = !lastEntry;
    if (lastEntry) {
      $("last-entry-label").textContent = "上次留下的 · " + momentLabel(lastEntry.occurred_at);
      $("last-entry-text").textContent = lastEntry.text || eventName(lastEntry.event) || (lastEntry.recordings?.length ? "一段留下的声音" : "一个日程片刻");
    }
  } catch { /* The private capture surface remains usable when history cannot load. */ }
}
$("last-entry").addEventListener("click", () => { if (lastEntry) viewEntry(lastEntry); });
$("open-date").addEventListener("click", () => toggleDate($("date-panel").hidden));
$("date-panel").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); toggleDate(false); $("open-date").focus(); } });
$("prev-month").addEventListener("click", () => void renderMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() - 1, 1)));
$("next-month").addEventListener("click", () => void renderMonth(new Date(shownMonth.getFullYear(), shownMonth.getMonth() + 1, 1)));
$("prev").addEventListener("click", () => void setDay(shiftDay($("date").value, -7)));
$("next").addEventListener("click", () => void setDay(shiftDay($("date").value, 7)));
$("today").addEventListener("click", () => void setDay(dateKey()));
$("latest-day").addEventListener("click", () => { if (latestDate) void setDay(latestDate); });
$("retry-day").addEventListener("click", () => void loadDay());
$("view-day").addEventListener("click", () => { void setDay(dateKey(currentEntry.occurred_at)); openPanel("history", {root: true}); });

function readEditor() {
  if (!currentDraft || currentPanel !== "compose") return;
  window.DropVoiceVersions.updateText(currentDraft, $("text").value);
}
function resizeEditor() {
  $("text").style.height = "auto";
  $("text").style.height = Math.max(180, $("text").scrollHeight) + "px";
}
function renderEditor() {
  if (!currentDraft) return;
  const draft = currentDraft;
  $("text").value = draft.text || "";
  $("capture-title").textContent = draft.entry ? "再写一点" : draft.source === "voice" ? "刚刚说的" : "写几句";
  $("save").querySelector("span").textContent = draft.entry ? "保存修改" : "留下这一滴";
  $("capture-context").textContent = momentLabel(draft.occurredAt) + (draft.event ? " · " + eventName(draft.event) : "");
  $("capture-time").textContent = "记录于 " + new Date(draft.occurredAt).toLocaleString("zh-CN");
  $("backdate").hidden = Boolean(draft.entry) || !$("date").value || $("date").value >= dateKey() || dateKey(draft.occurredAt) === $("date").value;
  $("backdate").textContent = "改为补记 " + dayFormat.format(dayDate($("date").value || dateKey()));
  $("coordinates").textContent = draft.coordinates ? "已附上此刻的位置" : "未附位置";
  $("clear-location").hidden = !draft.coordinates;
  $("locate").hidden = Boolean(draft.coordinates);
  $("details").hidden = true; $("capture-details").setAttribute("aria-expanded", "false");
  renderEventOptions();
  setupPlayback();
  $("compose-recordings").replaceChildren();
  renderSavedRecordings($("compose-recordings"), (draft.recordings || []).filter(row => !draft.audio || row.id !== draft.pendingUpload?.recording_id), draft);
  renderTranscriptionState();
  renderRefinementState();
  editorStatus(localFailures.has(draft.id) ? "本机草稿未能保存，请不要关闭页面。" : drafts.has(draft.id) ? "草稿留在本机 · 仅自己可见" : "仅自己可见", localFailures.has(draft.id));
  $("save").disabled = saving || (pendingVoice?.id === draft.id && voiceState === "processing");
  $("record").disabled = voiceState === "processing";
  resizeEditor();
}
function renderTranscriptionState() {
  const draft = currentDraft;
  const pending = Boolean(draft?.audio && !draft.audioApplied);
  $("draft-transcription").hidden = !pending;
  if (pending) {
    const busy = pendingVoice?.id === draft.id && voiceState === "processing";
    $("draft-transcription-status").textContent = busy ? "正在把声音写下来…" : "这段声音还没转成文字，录音仍保留在草稿里。";
    $("retry-transcription").disabled = busy;
  }
}
async function openNewEditor(options = {}) {
  updateHomeDate();
  currentDraft = newDraft(options);
  openPanel("compose", {focus: true});
  if (!options.day || options.day === dateKey()) void locateDraft(currentDraft, false);
}
function editEntry(entry) {
  const existing = drafts.get("edit-" + entry.id);
  currentDraft = existing || {
    id: "edit-" + entry.id, clientId: uuid(), text: entry.text, occurredAt: entry.occurred_at,
    coordinates: entryCoordinates(entry), city: entry.city || "", place: entry.place || "", event: entry.event || null,
    entry: {...entry}, source: "text", updatedAt: Date.now(), audio: null, audioApplied: false, locationDisabled: false,
    voiceTranscripts: structuredClone(entry.voice_transcripts || []),
    recordings: structuredClone(entry.recordings || []),
  };
  openPanel("compose", {focus: true});
}
function renderEventOptions() {
  const draft = currentDraft;
  $("event-options").replaceChildren();
  if (!draft) return;
  const snapshots = [...dayEvents, ...dayEntries.filter(entry => entry.event).map(entry => entry.event)];
  if (draft.event) snapshots.push(draft.event);
  const events = [...new Map(snapshots.map(event => [event.id, event])).values()];
  $("event-label").hidden = !events.length;
  if (!events.length) return;
  for (const event of [null, ...events]) {
    const choice = button(event ? eventName(event) : "不关联", () => { draft.event = event; renderEventOptions(); void persistDraft(draft); });
    choice.setAttribute("aria-pressed", String((event?.id || null) === (draft.event?.id || null)));
    choice.disabled = Boolean(draft.entry?.archived);
    $("event-options").append(choice);
  }
}
async function locateDraft(draft, explicit) {
  if (!draft || draft.locationDisabled || (!explicit && (!autoLocation || draft.entry || dateKey(draft.occurredAt) !== dateKey()))) return;
  const version = locationVersion;
  try {
    if (!navigator.geolocation) throw new Error("这个浏览器暂时无法读取位置，仍可以正常写日记。");
    if (!explicit) {
      if (!navigator.permissions) return;
      const permission = await navigator.permissions.query({name: "geolocation"});
      if (permission.state !== "granted") return;
    }
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {timeout: explicit ? 10000 : 2500, maximumAge: 30000, enableHighAccuracy: false}));
    if (version !== locationVersion || draft.locationDisabled || draft.saved || draft.deleted || signingOut) return;
    draft.coordinates = {latitude: position.coords.latitude, longitude: position.coords.longitude};
    if (meaningful(draft)) await persistDraft(draft);
    if (currentDraft?.id === draft.id && currentPanel === "compose") {
      $("coordinates").textContent = "已附上此刻的位置"; $("locate").hidden = true; $("clear-location").hidden = false;
    }
  } catch (error) {
    if (explicit) {
      const copy = error.code === 1 ? "没有获得位置权限，仍可以正常写日记。" : error.code === 3 ? "暂时找不到位置，可以稍后再试。" : message(error);
      if (currentPanel === "compose") editorStatus(copy, true); else $("location-setting-status").textContent = copy;
    }
  }
}
$("quick-write").addEventListener("click", () => void openNewEditor());
$("write").addEventListener("click", () => void openNewEditor({day: $("date").value}));
$("write-day").addEventListener("click", () => void openNewEditor({day: $("date").value}));
$("read-edit").addEventListener("click", () => editEntry(currentEntry));
$("text").addEventListener("input", () => {
  readEditor(); resizeEditor(); clearTimeout(draftTimers.get(currentDraft.id));
  currentDraft.textRevision = (currentDraft.textRevision || 0) + 1;
  editorStatus("正在留存草稿…");
  const draft = currentDraft;
  draftTimers.set(draft.id, setTimeout(async () => {
    const saved = await persistDraft(draft);
    if (currentDraft?.id === draft.id && currentPanel === "compose") editorStatus(saved ? "草稿留在本机 · 仅自己可见" : "本机草稿未能保存，请不要关闭页面。", !saved);
  }, 200));
});
$("text").addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault(); if (!event.repeat && !saving) $("editor").requestSubmit();
  }
});
$("capture-details").addEventListener("click", () => {
  $("details").hidden = !$("details").hidden;
  $("capture-details").setAttribute("aria-expanded", String(!$("details").hidden));
  if (!$("details").hidden) $("details").scrollIntoView({block: "nearest"});
});
$("backdate").addEventListener("click", () => {
  if (!currentDraft || currentDraft.entry) return;
  const target = dayDate($("date").value), clock = new Date(currentDraft.occurredAt);
  target.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), 0);
  currentDraft.occurredAt = target.toISOString();
  currentDraft.coordinates = null; currentDraft.locationDisabled = true;
  void persistDraft(currentDraft); renderEditor();
});
$("locate").addEventListener("click", () => {
  if (currentDraft) { currentDraft.locationDisabled = false; void run($("locate"), () => locateDraft(currentDraft, true)); }
});
$("clear-location").addEventListener("click", () => {
  if (!currentDraft) return;
  currentDraft.coordinates = null; currentDraft.locationDisabled = true; locationVersion++;
  $("coordinates").textContent = "未附位置"; $("clear-location").hidden = true; $("locate").hidden = false;
  void persistDraft(currentDraft);
});
$("discard-draft").addEventListener("click", async () => {
  if (!currentDraft || saving || (voiceState === "processing" && pendingVoice?.id === currentDraft.id)) return;
  readEditor();
  const draft = currentDraft;
  if (meaningful(draft) && !await ask("删除这份草稿？", "草稿中的文字和录音会移除。已保存的日记不受影响。")) return;
  try { await removeDraft(draft); currentDraft = null; stopPlayback(); await backPanel(); }
  catch { editorStatus("没能移除草稿，请再试一次。", true); }
});

$("editor").addEventListener("submit", async event => {
  event.preventDefault();
  if (saving || !currentDraft || (voiceState === "processing" && pendingVoice?.id === currentDraft.id)) return;
  readEditor();
  const draft = currentDraft;
  if (draft.pendingVersionID) { openVersion(draft, draft.pendingVersionID); return; }
  if (!draft.text.trim() && !draft.entry?.archived && !draft.audio && !draft.recordings?.length) { editorStatus("说一点，或写下一句话，就可以留下这一刻。", true); return; }
  saving = true; $("save").disabled = true; $("text").readOnly = true; $("record").disabled = true;
  editorStatus("正在收好这一刻…");
  await persistDraft(draft);
  try {
    if (draft.audio && !draft.audioUploaded) { editorStatus("正在把声音一起收好…"); await ensureAudioUploaded(draft); }
    const body = {
      text: draft.text.trim(), occurred_at: draft.occurredAt, city: draft.city || "", place: draft.place || "",
      latitude: draft.coordinates?.latitude ?? null, longitude: draft.coordinates?.longitude ?? null, event: draft.event || null,
      transcript_receipts: (draft.voiceTranscripts || []).map(record => record.receipt).filter(Boolean),
      audio_ids: (draft.recordings || []).map(record => record.id),
    };
    if (draft.entry?.archived) { delete body.occurred_at; delete body.event; }
    if (!draft.entry) body.client_id = draft.clientId;
    // Keep the first payload for a transport retry; the server deduplicates its client ID.
    if (!draft.entry && !draft.submitted) { draft.submitted = {...body}; await persistDraft(draft); }
    let saved = await api(draft.entry ? "entries/" + draft.entry.id + "/" : "entries/", {method: draft.entry ? "PATCH" : "POST", body: draft.entry ? body : draft.submitted});
    // If a user improved a draft after a lost response, reconcile those improvements onto the same entry.
    if (!draft.entry && JSON.stringify(body) !== JSON.stringify(draft.submitted)) {
      const update = {...body}; delete update.client_id;
      saved = await api("entries/" + saved.id + "/", {method: "PATCH", body: update});
    }
    draft.saved = true;
    try { await removeDraft(draft); } catch {
      // A saved tombstone prevents a local cleanup failure from reviving this draft after reload.
      await persistDraft(draft); drafts.delete(draft.id); localFailures.delete(draft.id); renderDraftSummary();
    }
    currentDraft = null; pendingVoice = null; stopPlayback(); setVoiceState("idle");
    monthCache.clear(); entryCache.clear();
    if (draft.entry) {
      currentEntry = saved; openPanel("read", {root: true}); notice("修改已保存。");
    } else {
      closePanels();
      $("home-title").textContent = "这一刻，收好了。";
      $("home-caption").textContent = "以后再读，还能遇见现在的自己。";
      notice("已留在日记里，仅自己可见。");
    }
    void setDay(dateKey(saved.occurred_at)); void refreshHome();
  } catch (error) {
    editorStatus(message(error) + (localFailures.has(draft.id) ? " 内容仅在当前页面，请不要关闭。" : " 草稿已留在本机，可以重试。"), true);
  } finally {
    saving = false; $("save").disabled = false; $("text").readOnly = false; $("record").disabled = false;
  }
});

$("read-delete").addEventListener("click", async () => {
  if (!currentEntry) return;
  const entry = currentEntry;
  if (!await ask("让这一刻离开日记？", "删除后无法恢复，这条记录也会从已分享的链接中移除。", "删除记录", "留着")) return;
  await run($("read-delete"), async () => {
    await api("entries/" + entry.id + "/", {method: "DELETE"});
    const draft = drafts.get("edit-" + entry.id);
    if (draft) await removeDraft(draft);
    selected.delete(entry.id); monthCache.clear(); entryCache.clear();
    currentEntry = null; openPanel("history", {root: true});
    await loadDay(); void refreshHome(); notice("这条记录已删除。");
  });
});

function setVoiceState(state, detail) {
  voiceState = state; scene.dataset.state = state;
  const live = state === "recording" || state === "paused";
  const busy = state === "starting" || state === "processing";
  $("voice-drop").disabled = busy;
  $("voice-drop").setAttribute("aria-pressed", String(live));
  $("voice-drop").setAttribute("aria-label", live ? "说好了，结束录音" : state === "error" ? "开始一段新录音" : "开始语音记录");
  $("recording-meter").hidden = !live;
  $("recording-actions").hidden = !live;
  $("live-transcript").hidden = !live;
  $("voice-recovery").hidden = state !== "error" || !pendingVoice?.audio;
  $("home-actions").hidden = live || busy;
  document.querySelector(".home-keepsakes").hidden = live || busy;
  $("account-button").disabled = live || busy;
  const statuses = {
    idle: ["轻点水滴，记下此刻", "边说边留下文字，说完再轻点一下"],
    starting: ["正在打开麦克风…", "第一次使用，需要允许麦克风访问"],
    recording: ["在听了，慢慢来", "声音和文字，都会为你留下"],
    paused: ["停一停，也没关系", "继续说，或轻点水滴结束这一段"],
    processing: ["正在把声音写下来…", "稍等一下，马上就好"],
    error: ["这段话还可以继续", "可以重试转写，也可以先留在草稿里"],
  };
  $("voice-status").textContent = detail || statuses[state][0];
  $("voice-hint").textContent = statuses[state][1];
  if (live) {
    $("home-title").textContent = "此刻，慢慢说。";
    $("home-caption").textContent = state === "paused" ? "等你想好了，再接着说。" : "一点心情，一件小事，都可以。";
  } else if (state === "idle") {
    $("home-title").textContent = "今天，想留下什么？";
    $("home-caption").textContent = "不用组织语言，想到什么就说什么。";
  }
  $("pause-recording").querySelector("span").textContent = state === "paused" ? "继续说" : "暂停一下";
  $("pause-recording").querySelector("use").setAttribute("href", state === "paused" ? "#i-play" : "#i-pause");
  if (!live) scene.style.setProperty("--level", 0);
}
async function startRecording(draft = null) {
  if (startingVoice || capture || voiceState === "starting" || voiceState === "processing" || signingOut) return;
  updateHomeDate();
  if (!navigator.mediaDevices?.getUserMedia || (!window.MediaRecorder && !window.AudioWorkletNode)) {
    setVoiceState("error", "这个浏览器暂时无法录音，可以先写几句。");
    $("voice-hint").textContent = "也可以在 Safari 或 Chrome 中打开一滴"; return;
  }
  if (draft?.audio && !draft.audioUploaded) {
    editorStatus("上一段声音还没上传完成。先重试保存声音，再接着说。", true);
    return;
  }
  startingVoice = true;
  if (draft) {
    readEditor();
    if (!await persistDraft(draft) && meaningful(draft)) { startingVoice = false; editorStatus("本机草稿暂时无法保存，请先留下当前文字，再接着说。", true); return; }
  }
  currentDraft = draft || newDraft({source: "voice"});
  pendingVoice = null;
  closePanels(); setVoiceState("starting");
  const recordDraft = currentDraft;
  recordDraft.skipVersionChoice = false; recordDraft.suppressAutoOpen = false;
  let stream, meterContext;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) { meterContext = new Context(); void meterContext.resume().catch(() => {}); }
    stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, channelCount: 1}});
    // A backgrounded permission prompt must not start an invisible recording.
    if (document.hidden) { stream.getTracks().forEach(track => track.stop()); await meterContext?.close(); setVoiceState("idle"); return; }
    let media, pcm = false;
    try { media = await window.DropAudio.createRecorder(meterContext, stream); pcm = true; }
    catch {
      const types = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
      const type = types.find(value => MediaRecorder.isTypeSupported?.(value));
      media = new MediaRecorder(stream, type ? {mimeType: type} : undefined);
    }
    const recording = {id: uuid(), media, pcm, stream, draft: recordDraft, context: meterContext, chunks: [], elapsed: 0, started: performance.now(), active: true, keepOnly: false, discard: false, frame: null, tick: null, wakeLock: null, queued: [], queuedBytes: 0};
    capture = recording;
    let analyser, samples;
    if (meterContext) {
      try { analyser = meterContext.createAnalyser(); analyser.fftSize = 256; meterContext.createMediaStreamSource(stream).connect(analyser); samples = new Uint8Array(analyser.fftSize); } catch { /* Recording remains available without a visual meter. */ }
    }
    let lastFrame = 0;
    const animate = now => {
      if (!recording.active) return;
      if (now - lastFrame > 70) {
        let amplitude = 0;
        if (analyser && media.state === "recording") {
          analyser.getByteTimeDomainData(samples);
          let total = 0; for (const sample of samples) total += ((sample - 128) / 128) ** 2;
          amplitude = Math.min(1, Math.sqrt(total / samples.length) * 5);
        }
        scene.style.setProperty("--level", amplitude.toFixed(3)); lastFrame = now;
      }
      recording.frame = requestAnimationFrame(animate);
    };
    media.addEventListener("dataavailable", event => { if (event.data.size) recording.chunks.push(event.data); });
    media.addEventListener("pcm", event => {
      if (recording.live) recording.live.push(event.detail);
      else if (!recording.streamDisabled) {
        recording.queuedBytes += event.detail.byteLength;
        if (recording.queuedBytes > 1024 * 1024) { recording.streamDisabled = true; recording.queued = []; }
        else recording.queued.push(event.detail);
      }
    });
    media.addEventListener("error", () => { recording.keepOnly = true; finishRecording(); }, {once: true});
    media.addEventListener("stop", () => { void completeRecording(recording); }, {once: true});
    stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => { if (recording.active) { recording.keepOnly = true; finishRecording(); } }, {once: true}));
    media.start(1000);
    recording.started = performance.now();
    if (!draft) recordDraft.occurredAt = new Date().toISOString();
    void locateDraft(recordDraft, false);
    setVoiceState("recording"); $("recording-time").textContent = "0:00";
    $("live-final").textContent = ""; $("live-partial").textContent = ""; $("live-placeholder").hidden = false;
    $("live-transcript-label").textContent = pcm ? "正在连接实时转写…" : "录音结束后，会为你转成文字";
    recording.grantPromise = prepareRealtime(recording);
    recording.frame = requestAnimationFrame(animate);
    recording.tick = setInterval(() => {
      const elapsed = recording.elapsed + (media.state === "recording" ? performance.now() - recording.started : 0);
      $("recording-time").textContent = durationLabel(elapsed / 1000);
      if (elapsed >= (window.DropAudio.maxDuration - 1) * 1000) finishRecording();
    }, 150);
    if (navigator.wakeLock) {
      void navigator.wakeLock.request("screen").then(lock => { if (recording.active) recording.wakeLock = lock; else void lock.release(); }).catch(() => {});
    }
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    void meterContext?.close().catch(() => {}); capture = null;
    const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
    setVoiceState("error", denied ? "还没有麦克风权限，也可以先写几句。" : "暂时没能打开麦克风，请再点一次试试。");
    $("voice-hint").textContent = denied ? "在浏览器的网站设置中允许麦克风后，就可以开始" : "检查麦克风是否被其他应用占用";
    if (draft) { currentDraft = draft; openPanel("compose"); editorStatus(denied ? "没有麦克风权限，刚才写的还在。" : "暂时没能开始录音，刚才写的还在。", true); }
  } finally { startingVoice = false; }
}
function finishRecording({keepOnly = false, discard = false} = {}) {
  const recording = capture;
  if (!recording || !recording.active || recording.media.state === "inactive") return;
  if (recording.media.state === "recording") recording.elapsed += performance.now() - recording.started;
  recording.keepOnly ||= keepOnly; recording.discard ||= discard;
  recording.media.stop();
  setVoiceState("processing", discard ? "正在结束录音…" : "把刚才的话留住…");
}
async function completeRecording(recording) {
  recording.active = false;
  clearInterval(recording.tick); cancelAnimationFrame(recording.frame);
  if (capture === recording) capture = null;
  recording.stream.getTracks().forEach(track => track.stop());
  void recording.context?.close().catch(() => {});
  void recording.wakeLock?.release().catch(() => {});
  if (recording.discard) {
    recording.live?.cancel();
    void recording.grantPromise.then(() => discardRecordingGrant(recording));
    setVoiceState("idle"); if (meaningful(recording.draft)) { currentDraft = recording.draft; openPanel("compose"); } return;
  }
  const blob = new Blob(recording.chunks, {type: recording.media.mimeType || recording.chunks[0]?.type || "audio/webm"});
  if (!blob.size) { setVoiceState("error", "这一段没有录到声音，再试一次就好。"); return; }
  const draft = recording.draft;
  draft.audio = blob; draft.audioApplied = false; draft.audioUploaded = false;
  draft.audioIsPcm = recording.pcm; draft.audioUploadAttempted = false;
  draft.pendingUpload = recording.upload || null; draft.uploadIssuedAt = recording.uploadIssuedAt || 0;
  draft.audioSession = recording.id;
  draft.audioDuration = Number.isFinite(recording.media.duration) ? recording.media.duration : recording.elapsed / 1000;
  draft.source = "voice";
  pendingVoice = draft; currentDraft = draft;
  const stored = await persistDraft(draft);
  if (recording.keepOnly || document.hidden) {
    recording.keepOnly = true; recording.live?.cancel();
    setVoiceState("idle");
    if (!document.hidden) notice(stored ? "录音已留在本机草稿，随时可以继续。" : "录音暂时只能保留在当前页面，请不要关闭。");
    return;
  }
  const streamingFinished = recording.grantPromise.then(live => live?.finish()).catch(() => ({ok: false}));
  await recording.grantPromise;
  await transcribeDraft(draft, streamingFinished);
}

async function discardRecordingGrant(recording) {
  if (!recording.upload?.recording_id) return;
  try { await api("integrations/audio/" + recording.upload.recording_id + "/", {method: "DELETE"}); }
  catch { /* No audio was uploaded; a cancelled ticket cannot start another stream. */ }
}

async function prepareRealtime(recording) {
  try {
    const grant = await api("integrations/audio-upload/", {method: "POST", body: {extension: "wav"}, timeout: 12000});
    recording.upload = grant; recording.uploadIssuedAt = Date.now();
    if (recording.discard || recording.draft.deleted || signingOut) { await discardRecordingGrant(recording); return null; }
    if (recording.draft.audioSession === recording.id) {
      recording.draft.pendingUpload = grant; recording.draft.uploadIssuedAt = recording.uploadIssuedAt;
      await persistDraft(recording.draft);
    }
    if (!recording.pcm || !grant.stream_ticket || recording.keepOnly || recording.streamDisabled) return null;
    const live = window.DropLiveAudio.connect(grant, {
      onStatus(state) {
        if (capture !== recording || !recording.active) return;
        $("live-transcript-label").textContent = state === "listening" ? "正在听你说" : "实时转写暂时断开，录音仍在继续";
      },
      onText(result) {
        recording.liveText = result.text;
        if (capture !== recording || !recording.active) return;
        const scroll = $("live-transcript-scroll"), atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 36;
        $("live-final").textContent = result.final_text ? result.final_text + (result.partial_text ? "\n" : "") : "";
        $("live-partial").textContent = result.partial_text || "";
        $("live-placeholder").hidden = Boolean(result.text);
        if (atBottom) scroll.scrollTop = scroll.scrollHeight;
      },
    });
    recording.live = live;
    for (const chunk of recording.queued) live.push(chunk);
    recording.queued = [];
    if (recording.media.state === "paused") live.pause();
    return live;
  } catch {
    recording.streamDisabled = true; recording.queued = [];
    if (capture === recording) $("live-transcript-label").textContent = "连接暂时慢了些，录音仍在继续";
    return null;
  }
}
$("voice-drop").addEventListener("click", () => { if (capture) finishRecording(); else void startRecording(); });
$("history-record").addEventListener("click", () => { closePanels(); void startRecording(); });
$("record").addEventListener("click", () => { readEditor(); void startRecording(currentDraft); });
$("pause-recording").addEventListener("click", () => {
  if (!capture?.active) return;
  if (capture.media.state === "recording") {
    capture.elapsed += performance.now() - capture.started; capture.media.pause(); capture.live?.pause(); setVoiceState("paused");
  } else if (capture.media.state === "paused") {
    capture.started = performance.now(); capture.media.resume(); capture.live?.resume(); setVoiceState("recording");
  }
});
$("cancel-recording").addEventListener("click", async () => {
  const recording = capture;
  if (!recording) return;
  const wasRecording = recording.media.state === "recording";
  if (wasRecording) { recording.elapsed += performance.now() - recording.started; recording.media.pause(); recording.live?.pause(); setVoiceState("paused"); }
  if (await ask("不留下这段声音？", "刚才这一段录音会被删除，已经写下的文字会保留。", "删除录音", "接着说")) finishRecording({discard: true});
  else if (wasRecording && capture === recording && recording.active && recording.media.state === "paused") { recording.started = performance.now(); recording.media.resume(); recording.live?.resume(); setVoiceState("recording"); }
});

function ensureAudioUploaded(draft) {
  if (audioUploads.has(draft.id)) return audioUploads.get(draft.id).promise;
  const state = {};
  state.promise = uploadDraftAudio(draft, state).finally(() => audioUploads.delete(draft.id));
  audioUploads.set(draft.id, state);
  return state.promise;
}

async function uploadDraftAudio(draft, state) {
  if (draft.audioUploaded) return draft.recordings.find(row => row.id === draft.pendingUpload.recording_id);
  const current = () => { if (draft.saved || draft.deleted || signingOut) throw Error("录音处理已结束。"); };
  current();
  if (!draft.pendingUpload || Date.now() - (draft.uploadIssuedAt || 0) > 600000) {
    const grant = await api("integrations/audio-upload/", {method: "POST", body: {
      extension: "wav", ...(draft.pendingUpload?.recording_id ? {recording_id: draft.pendingUpload.recording_id} : {}),
    }});
    draft.pendingUpload = grant; draft.uploadIssuedAt = Date.now();
    if (draft.deleted || signingOut) {
      await api("integrations/audio/" + grant.recording_id + "/", {method: "DELETE"}).catch(() => {});
    }
    current(); await persistDraft(draft);
  }
  const grant = draft.pendingUpload;
  let confirmed;
  if (draft.audioUploadAttempted) {
    try { confirmed = await api("integrations/audio-complete/", {method: "POST", body: {ticket: grant.ticket}}); }
    catch (error) { if (error.code !== "audio_upload_incomplete") throw error; }
  }
  current();
  if (!confirmed) {
    const prepared = draft.audioIsPcm ? {blob: draft.audio, extension: "wav"} : await window.DropAudio.prepare(draft.audio);
    current();
    const body = new FormData(); body.append("key", grant.key); body.append("token", grant.token); body.append("file", prepared.blob, "drop.wav");
    state.controller = new AbortController();
    const timer = setTimeout(() => state.controller.abort(), 60000);
    draft.audioUploadAttempted = true; await persistDraft(draft);
    try {
      const response = await fetch(grant.url, {method: "POST", body, signal: state.controller.signal});
      if (!response.ok) throw Error("录音没能上传完整，原录音还在，可以再试一次。");
    } finally { clearTimeout(timer); }
    current();
    confirmed = await api("integrations/audio-complete/", {method: "POST", body: {ticket: grant.ticket}});
  }
  current();
  draft.recordings ||= [];
  const index = draft.recordings.findIndex(row => row.id === confirmed.recording.id);
  if (index < 0) draft.recordings.push(confirmed.recording); else draft.recordings[index] = confirmed.recording;
  draft.audioUploaded = true;
  await persistDraft(draft);
  return confirmed.recording;
}

async function transcribeDraft(draft, streamingFinished = null) {
  if (!draft?.audio || draft.deleted || draft.saved || draft.transcribing || signingOut) return;
  const version = ++voiceProcess;
  pendingVoice = draft; draft.transcribing = true;
  setVoiceState("processing");
  if (currentPanel === "compose") { renderTranscriptionState(); $("save").disabled = true; $("record").disabled = true; }
  try {
    $("voice-status").textContent = "正在把声音一起收好…";
    const uploaded = await ensureAudioUploaded(draft);
    if (streamingFinished) await streamingFinished;
    $("voice-status").textContent = "正在把声音写下来…";
    $("voice-hint").textContent = localFailures.has(draft.id) ? "请暂时不要关闭页面" : "录音已留在本机，转写后还能修改";
    const result = await api("integrations/transcribe/", {method: "POST", body: {recording_id: uploaded.id}, timeout: 95000});
    if (version !== voiceProcess || draft.saved || draft.deleted || signingOut) return;
    if (!result.text?.trim()) throw new Error("没有听清这一段。可以再转一次，也可以听着录音写几句。");
    if (currentPanel === "compose" && currentDraft?.id === draft.id) readEditor();
    if (result.transcript) {
      draft.voiceTranscripts ||= [];
      const record = {...result.transcript, versionFlow: true, previewVersion: "refined",
        receipts: [result.transcript.receipt], refinementStatus: result.refinement_available ? "pending" : "unavailable"};
      draft.voiceTranscripts.push(record);
      if (!draft.skipVersionChoice) draft.pendingVersionID = record.id;
    } else {
      // A server response without a signed transcript is still a selectable local candidate.
      const record = {id: uuid(), original_text: result.text.trim(), refined_text: "", versionFlow: true,
        previewVersion: "original", refinementStatus: "unavailable"};
      (draft.voiceTranscripts ||= []).push(record);
      if (!draft.skipVersionChoice) draft.pendingVersionID = record.id;
    }
    draft.audioApplied = true; delete draft.transcribing;
    if (result.recording) draft.recordings = draft.recordings.map(row => row.id === result.recording.id ? result.recording : row);
    await persistDraft(draft);
    setVoiceState("idle"); pendingVoice = null;
    if (!document.hidden) {
      if (currentDraft?.id === draft.id && currentPanel === "compose") {
        if (draft.pendingVersionID && !draft.suppressAutoOpen) openVersion(draft, draft.pendingVersionID);
        else renderEditor();
      } else if (!currentPanel && !draft.suppressAutoOpen) {
        currentDraft = draft;
        if (draft.pendingVersionID) openVersion(draft, draft.pendingVersionID);
        else openPanel("compose");
      } else if (currentPanel === "drafts") renderDrafts();
    }
    if (result.transcript && result.refinement_available) void refineDraft(draft, draft.voiceTranscripts.at(-1));
  } catch (error) {
    if (version !== voiceProcess || draft.deleted || signingOut) return;
    delete draft.transcribing;
    await persistDraft(draft);
    const text = error.name === "AbortError" || error instanceof TypeError ? "连接中断了，录音还在，可以再试一次。" : message(error);
    setVoiceState("error", text);
    if (currentPanel === "compose" && currentDraft?.id === draft.id) {
      renderTranscriptionState(); $("draft-transcription-status").textContent = text;
    }
  } finally {
    delete draft.transcribing;
    if (version === voiceProcess && currentPanel === "compose") { $("save").disabled = false; $("record").disabled = false; }
  }
}
$("voice-retry").addEventListener("click", () => { if (pendingVoice) void transcribeDraft(pendingVoice); });
$("voice-later").addEventListener("click", () => { currentDraft = pendingVoice; setVoiceState("idle"); if (currentDraft) { currentDraft.skipVersionChoice = true; void persistDraft(currentDraft); openPanel("compose"); } });
$("retry-transcription").addEventListener("click", () => { readEditor(); if (currentDraft) void transcribeDraft(currentDraft); });

function renderVoiceTranscripts(container, records, draft = null) {
  container.hidden = !records?.length;
  if (!records?.length) { container.replaceChildren(); return; }
  const expanded = container.dataset.expanded === "true";
  const toggle = button(`原始转写${records.length > 1 ? ` · ${records.length} 段` : ""}`, () => {
    const open = container.dataset.expanded !== "true";
    container.dataset.expanded = String(open); content.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  }, "quiet transcript-toggle");
  toggle.append(icon("next")); toggle.setAttribute("aria-expanded", String(expanded));
  const content = node("div", undefined, "transcript-sources");
  content.hidden = !expanded;
  records.forEach((record, index) => {
    const part = node("section", undefined, "transcript-source");
    part.append(node("p", records.length > 1 ? `第 ${index + 1} 段 · 原始转写` : "原始转写", "eyebrow"));
    part.append(node("p", record.original_text, "transcript-text"));
    part.append(button("复制原话", control => void copyText(record.original_text, control)));
    if (record.refined_text) {
      part.append(node("p", "轻整理版本", "eyebrow"), node("p", record.refined_text, "transcript-text"));
      part.append(button("复制整理版本", control => void copyText(record.refined_text, control)));
    } else if (draft && record.receipt) {
      const retry = button(refining.has(record.id) ? "正在轻整理…" : "再试一次轻整理", () => void refineDraft(draft, record));
      retry.disabled = refining.has(record.id); part.append(retry);
    }
    if (draft) part.append(button("选择原文 / 改写", () => { readEditor(); openVersion(draft, record.id); }));
    content.append(part);
  });
  container.replaceChildren(toggle, content);
}

function renderRefinementState() {
  const records = currentDraft?.voiceTranscripts || [];
  renderVoiceTranscripts($("compose-transcripts"), records, currentDraft);
  const status = $("refinement-status"), last = records.at(-1);
  status.hidden = !last;
  if (!last) return;
  status.textContent = refining.has(last.id) ? "正在轻轻整理，原话已保留。现在也可以保存。"
    : last.refined_text ? (last.refinementStatus === "suggestion" ? "整理版本已放在原始转写里，正文保留你的修改。" : "原始转写已保留，可以随时展开查看。")
    : "原话已保留，可以直接保存，也可以稍后再整理。";
}

function openVersion(draft, id) {
  const record = draft?.voiceTranscripts?.find(row => row.id === id);
  if (!record || draft.saved || draft.deleted) return;
  if (!record.versionFlow && !record.selectedVersion) {
    // Older drafts already inserted ASR/refinement. Locate that existing segment instead of duplicating it.
    const start = typeof record.prefix === "string" ? record.prefix.length : -1;
    const version = record.refinementStatus === "applied" ? "refined" : "original";
    const text = version === "refined" ? record.refined_text : record.original_text;
    record.selectedVersion = version; record.appliedText = text;
    if (start >= 0 && draft.text.startsWith(record.prefix) && draft.text.slice(start, start + text.length) === text) {
      record.bodyRange = {start, end: start + text.length};
    } else { record.rangeLost = true; record.bodyEdited = true; }
  }
  currentDraft = draft; versionRecordID = id;
  openPanel("voice-version", {root: true}); renderVersion();
  if (record.refinementStatus === "pending" && !refining.has(record.id) && record.receipt) void refineDraft(draft, record);
}
function versionRecord() {
  return currentDraft?.voiceTranscripts?.find(row => row.id === (versionRecordID || currentDraft.pendingVersionID));
}
function renderVersion() {
  const record = versionRecord();
  if (!record) return;
  const version = record.previewVersion || (record.refined_text ? "refined" : "original");
  const rewritten = version === "refined", busy = refining.has(record.id) || record.refinementStatus === "pending";
  $("version-original").setAttribute("aria-selected", String(!rewritten));
  $("version-refined").setAttribute("aria-selected", String(rewritten));
  $("version-preview").setAttribute("aria-labelledby", rewritten ? "version-refined" : "version-original");
  $("version-preview").textContent = rewritten ? record.refined_text || (busy ? "正在把这段话轻轻整理成文…" : "改写暂时没有完成。原文和声音仍然保留着。") : record.original_text;
  $("version-status").textContent = record.refined_text ? "两个版本都留着，由你决定这一段。" : busy ? "改写正在生成，也可以先用原文继续。" : "可以重试改写，也可以直接用原文编辑。";
  $("version-use").textContent = rewritten ? "用改写编辑" : "用原文编辑";
  $("version-use").disabled = choosingVersion || (rewritten && !record.refined_text);
  $("version-use-original").disabled = choosingVersion;
  $("version-use-original").hidden = !rewritten;
  $("version-copy").disabled = rewritten && !record.refined_text;
  $("version-retry").hidden = Boolean(record.refined_text) || !record.receipt;
  $("version-retry").disabled = busy;
  $("version-retry").textContent = busy ? "正在生成改写…" : "重新生成改写";
}
async function chooseVersion(version) {
  const draft = currentDraft, record = versionRecord(), owner = String(session?.user_id || "");
  if (!draft || !record || saving || choosingVersion) return;
  choosingVersion = true; renderVersion();
  try {
    const lost = Boolean(record.selectedVersion && (!record.bodyRange || record.rangeLost));
    if (lost) {
      if (!await ask("追加到正文末尾？", "这段已和其他正文一起修改，无法可靠区分。追加所选版本，保留已有正文。", "追加到末尾", "先不替换")) return;
    } else if (window.DropVoiceVersions.needsConfirmation(draft, record)) {
      if (!await ask("替换这一段的修改？", "你改过这一段。仅替换这段正文，其他段落保持原样。", "替换这一段", "保留修改")) return;
    }
    if (draft.saved || draft.deleted || signingOut || currentDraft !== draft || String(session?.user_id || "") !== owner
        || !draft.voiceTranscripts?.includes(record)) return;
    if (lost) { delete record.selectedVersion; delete record.bodyRange; record.rangeLost = false; }
    window.DropVoiceVersions.apply(draft, record, version);
    await persistDraft(draft);
    openPanel("compose", {root: true, focus: true});
  } catch (error) { notice(message(error)); }
  finally { choosingVersion = false; if (currentPanel === "voice-version") renderVersion(); }
}
for (const version of ["original", "refined"]) $("version-" + version).addEventListener("click", () => {
  const record = versionRecord(); if (!record) return;
  record.previewVersion = version; renderVersion(); void persistDraft(currentDraft);
});
document.querySelector(".version-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === "Home" ? "original" : event.key === "End" ? "refined" : versionRecord()?.previewVersion === "original" ? "refined" : "original";
  $("version-" + target).click(); $("version-" + target).focus();
});
$("version-use").addEventListener("click", () => void chooseVersion(versionRecord()?.previewVersion || "original"));
$("version-use-original").addEventListener("click", () => void chooseVersion("original"));
$("version-retry").addEventListener("click", () => { const record = versionRecord(); if (record) void refineDraft(currentDraft, record); });
$("version-copy").addEventListener("click", control => {
  const record = versionRecord(); if (record) void copyText(record.previewVersion === "refined" ? record.refined_text : record.original_text, control.currentTarget);
});

async function refineDraft(draft, record) {
  if (refining.has(record.id) || draft.saved || draft.deleted || signingOut || saving) return;
  refining.add(record.id); record.refinementStatus = "pending"; void persistDraft(draft);
  if (currentPanel === "voice-version" && currentDraft?.id === draft.id) renderVersion();
  if (currentPanel === "compose" && currentDraft?.id === draft.id) renderRefinementState();
  try {
    const result = await api("integrations/refine-transcript/", {
      method: "POST", body: {receipt: record.receipt}, timeout: 35000,
    });
    if (draft.saved || draft.deleted || signingOut || saving) return;
    if (currentPanel === "compose" && currentDraft?.id === draft.id) readEditor();
    if (result.status !== "ready" || !result.transcript?.refined_text) throw Error("refinement unavailable");
    record.receipts = [...new Set([...(record.receipts || []), record.receipt].filter(Boolean))];
    Object.assign(record, result.transcript);
    record.receipts = [...new Set([...(record.receipts || []), record.receipt].filter(Boolean))];
    record.refinementStatus = "suggestion";
    await persistDraft(draft);
  } catch {
    if (!draft.saved && !draft.deleted && !signingOut) {
      record.refinementStatus = "unavailable"; await persistDraft(draft);
    }
  } finally {
    refining.delete(record.id);
    if (currentPanel === "voice-version" && currentDraft?.id === draft.id) renderVersion();
    if (!draft.saved && !draft.deleted && currentPanel === "compose" && currentDraft?.id === draft.id) renderRefinementState();
  }
}

function stopPlayback() {
  playbackVersion += 1;
  if (savedAudioPlayer) { savedAudioPlayer.pause(); savedAudioPlayer.removeAttribute("src"); savedAudioPlayer.load(); savedAudioPlayer = null; }
  savedAudioReset?.(); savedAudioReset = null;
  if (audioPlayer) { audioPlayer.pause(); audioPlayer.removeAttribute("src"); audioPlayer.load(); audioPlayer = null; }
  if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null; }
}
function setupPlayback() {
  stopPlayback();
  const draft = currentDraft;
  $("audio-preview").hidden = !draft?.audio; $("audio-note").hidden = !draft?.audio;
  if (!draft?.audio) return;
  audioURL = URL.createObjectURL(draft.audio); audioPlayer = new Audio(audioURL);
  const player = audioPlayer;
  $("audio-play").setAttribute("aria-label", "播放这段录音"); $("audio-play").querySelector("use").setAttribute("href", "#i-play");
  $("audio-seek").value = 0; $("audio-duration").textContent = durationLabel(draft.audioDuration || 0);
  player.addEventListener("timeupdate", () => {
    const duration = Number.isFinite(player.duration) ? player.duration : draft.audioDuration || 0;
    $("audio-seek").value = duration ? String(player.currentTime / duration * 100) : 0;
    $("audio-duration").textContent = durationLabel(player.currentTime || duration);
  });
  const sync = () => { $("audio-play").setAttribute("aria-label", player.paused ? "播放这段录音" : "暂停播放"); $("audio-play").querySelector("use").setAttribute("href", player.paused ? "#i-play" : "#i-pause"); };
  player.addEventListener("play", sync); player.addEventListener("pause", sync); player.addEventListener("ended", sync);
  player.addEventListener("error", () => editorStatus("这段录音暂时无法播放，仍可尝试转写。", true));
}
$("audio-play").addEventListener("click", () => { if (!audioPlayer) setupPlayback(); if (!audioPlayer) return; if (audioPlayer.paused) void audioPlayer.play().catch(() => editorStatus("暂时无法播放，请再点一次。", true)); else audioPlayer.pause(); });
$("audio-seek").addEventListener("input", () => { if (audioPlayer) { const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : currentDraft?.audioDuration || 0; audioPlayer.currentTime = Number($("audio-seek").value) / 100 * duration; } });

function renderSavedRecordings(container, recordings, draft = null) {
  recordings.forEach((record, index) => {
    const row = node("div", undefined, "audio-preview saved-recording");
    const play = button("", async control => {
      if (savedAudioPlayer && row.player === savedAudioPlayer && !savedAudioPlayer.error) {
        if (!savedAudioPlayer.paused) savedAudioPlayer.pause();
        else await savedAudioPlayer.play().catch(() => notice("暂时没能播放这段声音，请再点一次。"));
        return;
      }
      stopPlayback();
      const version = playbackVersion;
      control.disabled = true;
      try {
        const result = await api("integrations/audio/" + record.id + "/");
        if (version !== playbackVersion || !row.isConnected) return;
        const player = new Audio(result.url); row.player = player; savedAudioPlayer = player;
        savedAudioReset = () => { play.replaceChildren(icon("play")); play.setAttribute("aria-label", "播放这段录音"); };
        const sync = () => { play.replaceChildren(icon(player.paused ? "play" : "pause")); play.setAttribute("aria-label", player.paused ? "播放这段录音" : "暂停播放"); };
        player.addEventListener("play", sync); player.addEventListener("pause", sync); player.addEventListener("ended", sync);
        player.addEventListener("timeupdate", () => {
          const total = Number.isFinite(player.duration) ? player.duration : record.duration_seconds || 0;
          seek.value = total ? String(player.currentTime / total * 100) : "0";
          time.textContent = durationLabel(player.currentTime || total);
        });
        player.addEventListener("error", () => notice("暂时没能播放这段声音，请再点一次。"));
        await player.play();
      } catch (error) { notice(message(error)); }
      finally { control.disabled = false; }
    }, "icon-button");
    play.append(icon("play")); play.setAttribute("aria-label", "播放这段录音");
    const track = node("div", undefined, "audio-track");
    track.append(node("span", recordings.length > 1 ? `第 ${index + 1} 段声音` : "听听那一刻"));
    const seek = node("input"); seek.type = "range"; seek.min = "0"; seek.max = "100"; seek.value = "0"; seek.setAttribute("aria-label", "录音播放进度");
    seek.addEventListener("input", () => {
      if (row.player && Number.isFinite(row.player.duration)) row.player.currentTime = Number(seek.value) / 100 * row.player.duration;
    });
    track.append(seek);
    const time = node("time", durationLabel(record.duration_seconds || 0));
    row.append(play, track, time); container.append(row);
    if (draft && !record.original_text && !(draft.voiceTranscripts || []).some(part => part.recording_id === record.id)) {
      container.append(button("把这段声音转成文字", control => run(control, async () => {
        const result = await api("integrations/transcribe/", {method: "POST", body: {recording_id: record.id}, timeout: 95000});
        if (draft.deleted || draft.saved || signingOut || saving) return;
        if (!result.text?.trim()) throw Error("这一段没有识别到文字，声音仍然保留。");
        if (currentDraft === draft && currentPanel === "compose") readEditor();
        const prefix = draft.text.trim() ? draft.text.trim() + "\n" : "";
        draft.text = prefix + result.text;
        draft.voiceTranscripts ||= [];
        const part = {...result.transcript, prefix, insertedRevision: draft.textRevision || 0};
        draft.voiceTranscripts.push(part);
        Object.assign(record, result.recording);
        await persistDraft(draft);
        if (currentDraft === draft && currentPanel === "compose") renderEditor();
        if (result.refinement_available) void refineDraft(draft, part);
      })));
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (capture?.active) finishRecording({keepOnly: true});
    if (currentPanel === "compose" && currentDraft) { readEditor(); void persistDraft(currentDraft); }
    for (const id of [...draftTimers.keys()]) { const draft = drafts.get(id) || (currentDraft?.id === id ? currentDraft : null); if (draft) void persistDraft(draft); }
    audioPlayer?.pause();
    savedAudioPlayer?.pause();
  } else {
    updateHomeDate();
  }
});
window.addEventListener("beforeunload", event => {
  if (capture?.active || startingVoice || saving || pendingWrites || localFailures.size || draftTimers.size) {
    if (currentPanel === "compose" && currentDraft) { readEditor(); void persistDraft(currentDraft); }
    event.preventDefault(); event.returnValue = "";
  }
});

async function searchEntries() {
  const term = $("search-text").value.trim(), version = ++searchVersion;
  $("clear-search").hidden = !term;
  if (!term) { $("search-results").replaceChildren(); $("search-status").textContent = "记得的一个词，也能找到那一天。"; return; }
  $("search-status").textContent = "正在找回那个片刻…";
  try {
    const {entries} = await api("entries/?" + new URLSearchParams({q: term}));
    if (version !== searchVersion) return;
    renderEntries($("search-results"), entries, {search: true});
    $("search-status").textContent = entries.length === 60 ? "找到最近 60 个片刻，可以换一个更具体的词。" : entries.length ? `找到了 ${entries.length} 个片刻` : "还没有找到，试试更短的词或当时的地点。";
  } catch (error) { if (version === searchVersion) { $("search-results").replaceChildren(); $("search-status").textContent = message(error); } }
}
$("search-form").addEventListener("submit", event => { event.preventDefault(); clearTimeout(searchTimer); void searchEntries(); $("search-text").blur(); });
$("search-text").addEventListener("input", () => { ++searchVersion; clearTimeout(searchTimer); searchTimer = setTimeout(searchEntries, 280); $("clear-search").hidden = !$("search-text").value; });
$("clear-search").addEventListener("click", () => { $("search-text").value = ""; clearTimeout(searchTimer); void searchEntries(); $("search-text").focus(); });

async function loadCalendar() {
  const day = $("date").value || dateKey(), version = ++calendarVersion;
  $("calendar-date").textContent = dayFormat.format(dayDate(day)) + " · " + weekdayFormat.format(dayDate(day));
  $("events").replaceChildren(node("p", "正在读取这一天的日程…", "supporting"));
  $("archive-footer").hidden = true;
  try {
    const {events} = await api("integrations/calendar/?" + new URLSearchParams({date: day, tz}));
    if (version !== calendarVersion) return;
    dayEvents = events;
    $("events").replaceChildren(...events.map((event, index) => {
      const row = node("div", undefined, "calendar-event");
      const label = node("label"), check = node("input"); check.type = "checkbox"; check.value = index;
      const archived = dayEntries.some(entry => entry.archived && entry.event?.id === event.id);
      check.disabled = archived;
      const text = node("span");
      text.append(node("span", event.title, "event-title"), node("small", (event.all_day ? "全天" : clockFormat.format(new Date(event.start))) + (archived ? " · 已留在日记里" : "")));
      label.append(check, text);
      check.addEventListener("change", () => { $("archive").disabled = !$("events").querySelector("input:checked"); });
      const write = button("写感受", () => { void openNewEditor({event}); });
      row.append(label, write); return row;
    }));
    if (!events.length) $("events").append(node("p", "这一天没有日程。那些计划之外的片刻，也值得留下。", "supporting"));
    $("archive-footer").hidden = !events.length; $("archive").disabled = true;
  } catch (error) {
    if (version !== calendarVersion) return;
    const connect = error.code === "calendar_connect_required" || error.code === "calendar_access_denied";
    const box = node("div", undefined, "calendar-connect");
    box.append(node("h3", connect ? "把日程带进日记" : "日程暂时没有载入"), node("p", message(error)));
    if (connect) {
      const link = node("a", "连接 Chronelle", "primary"); link.href = apiOrigin + "/api/integrations/chronelle/connect/"; box.append(link);
      box.append(node("p", "仅申请只读权限，你可以选择允许读取的分组。", "supporting"));
    } else box.append(button("再试一次", () => void loadCalendar(), "soft"));
    $("events").replaceChildren(box);
  }
}
$("archive").addEventListener("click", () => void run($("archive"), async () => {
  const events = [...$("events").querySelectorAll("input:checked")].map(input => dayEvents[Number(input.value)]);
  if (!events.length) return;
  await api("calendar/archive/", {method: "POST", body: {events, tz}});
  monthCache.clear(); await loadDay(); await loadCalendar(); void refreshHome(); notice("日程已留在日记里，可以慢慢补上感受。");
}));

function sharePool() {
  const entries = [...dayEntries];
  if (shareContextEntry) entries.unshift(shareContextEntry);
  return [...new Map(entries.map(entry => [entry.id, entry])).values()];
}
function updateShareSelection() {
  $("share-count").textContent = selected.size ? `已选 ${selected.size} 个片刻` : "还没有选择记录";
  $("create-share").disabled = !selected.size || !$("share-form").querySelector('input[name="fields"]:checked');
  $("select-all").textContent = sharePool().length && selected.size === sharePool().length ? "取消全选" : "全选";
}
function renderShare() {
  const entries = sharePool();
  const valid = new Set(entries.map(entry => entry.id));
  for (const id of selected) if (!valid.has(id)) selected.delete(id);
  $("share-entries").replaceChildren(...entries.map(entry => {
    const label = node("label", undefined, "share-choice"), check = node("input");
    check.type = "checkbox"; check.checked = selected.has(entry.id);
    check.addEventListener("change", () => { if (check.checked) selected.add(entry.id); else selected.delete(entry.id); updateShareSelection(); });
    const text = node("span"); text.append(node("p", entry.text || eventName(entry.event) || "日程片刻"), node("small", momentLabel(entry.occurred_at)));
    label.append(check, text); return label;
  }));
  if (!entries.length) $("share-entries").append(node("p", "这一天还没有记录。先留下一个片刻，再决定分享给谁。", "supporting"));
  $("select-all").hidden = !entries.length;
  updateShareSelection();
}
$("read-share").addEventListener("click", () => { shareContextEntry = currentEntry; selected.clear(); selected.add(currentEntry.id); $("share-result").replaceChildren(); openPanel("share"); });
$("select-all").addEventListener("click", () => {
  const entries = sharePool(), all = selected.size === entries.length;
  selected.clear(); if (!all) entries.forEach(entry => selected.add(entry.id)); renderShare();
});
$("share-form").addEventListener("change", updateShareSelection);
async function copyAddress(url, control) {
  await copyText(url, control);
}
$("share-form").addEventListener("submit", event => {
  event.preventDefault();
  void run($("create-share"), async () => {
    const form = new FormData($("share-form"));
    const fields = form.getAll("fields").flatMap(field => field === "coordinates" ? ["latitude", "longitude"] : [field]);
    if (!selected.size || !fields.length) return;
    const result = await api("shares/", {method: "POST", body: {entry_ids: [...selected], fields, expires_in: Number(form.get("expires_in"))}});
    const url = new URL(result.url, location.origin).href;
    const link = node("a", url); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const copy = button("复制链接", control => void copyAddress(url, control), "primary");
    const nodes = [node("h3", "分享链接准备好了"), node("p", `有效至 ${new Date(result.expires_at).toLocaleString("zh-CN")}`, "supporting"), link, copy];
    if (navigator.share) nodes.push(button("分享给…", async () => { try { await navigator.share({title: "一滴 · 生活的片刻", url}); } catch (error) { if (error.name !== "AbortError") notice("可以复制链接后分享。"); } }));
    $("share-result").replaceChildren(...nodes); $("share-result").scrollIntoView({block: "nearest"});
  }).finally(updateShareSelection);
});
async function refreshLinks() {
  $("links-list").textContent = "正在读取分享链接…";
  const names = {text: "正文", occurred_at: "时间", city: "城市", place: "地点", latitude: "纬度", longitude: "经度", event: "日程"};
  try {
    const {shares} = await api("shares/");
    $("links-list").replaceChildren(...shares.map(share => {
      const expired = new Date(share.expires_at) <= new Date();
      const row = node("div", undefined, "link-row");
      row.append(node("p", share.fields.map(field => names[field] || field).join(" · ")), node("p", expired ? "已到期" : "有效至 " + new Date(share.expires_at).toLocaleString("zh-CN"), "supporting"));
      const actions = node("div", undefined, "link-actions");
      if (!expired) {
        const open = node("a", "查看分享"); open.href = share.url; open.target = "_blank"; open.rel = "noopener noreferrer";
        actions.append(open, button("复制", control => void copyAddress(share.url, control)));
      }
      const revoke = button(expired ? "移除" : "撤销链接", async control => {
        if (!expired && !await ask("撤销这个分享链接？", "撤销后，持有这个链接的人将无法再查看这些记录。你的日记会保留。", "撤销链接", "保留链接")) return;
        await run(control, async () => { await api("shares/" + share.id + "/", {method: "DELETE"}); $("share-result").replaceChildren(); await refreshLinks(); notice("这个链接已撤销。"); });
      }, "quiet destructive");
      actions.append(revoke); row.append(actions); return row;
    }));
    if (!shares.length) $("links-list").append(node("p", "还没有分享链接。想分享时，从一条记录开始就好。", "supporting"));
  } catch (error) { $("links-list").textContent = message(error); }
}

function updateHomeDate() {
  const today = new Date();
  $("home-date").textContent = today.getFullYear() + " 年 · " + dayFormat.format(today) + " · " + weekdayFormat.format(today);
}
function renderNetwork() {
  $("network-state").hidden = navigator.onLine && !sessionExpired;
  if (sessionExpired) {
    const link = node("a", "重新登录"); link.href = apiOrigin + "/api/integrations/frienden/login/";
    $("network-state").replaceChildren(node("span", "登录状态有变化，本机草稿还在。 "), link);
  } else $("network-state").textContent = "暂时离线，写下的话会保留为本机草稿";
}
window.addEventListener("online", renderNetwork); window.addEventListener("offline", renderNetwork);
$("auto-location").addEventListener("change", async () => {
  autoLocation = $("auto-location").checked;
  try { localStorage.setItem("drop-location:" + session.user_id, String(autoLocation)); } catch { /* Session preference still works. */ }
  if (!autoLocation) { locationVersion++; $("location-setting-status").textContent = "之后的记录将不再自动附上位置。"; return; }
  $("location-setting-status").textContent = "请允许浏览器使用位置；不允许也不影响记录。";
  if (!navigator.geolocation) { $("location-setting-status").textContent = "这个浏览器暂时无法获取位置。"; return; }
  navigator.geolocation.getCurrentPosition(() => { $("location-setting-status").textContent = "已允许，之后记录时会自动附上位置。"; }, () => { $("location-setting-status").textContent = "还没有获得位置权限。随时可以再开启。"; }, {timeout: 10000});
});
$("logout").addEventListener("click", async () => {
  if (saving || signingOut) return;
  if (drafts.size && !await ask("退出并清除本机草稿？", `还有 ${drafts.size} 份草稿只在这个浏览器里。退出会清除这些草稿，已保存的日记仍在账号中。`, "退出并清除", "继续留着")) return;
  await run($("logout"), async () => {
    closingPanel = true;
    locationVersion++; voiceProcess++;
    for (const draft of drafts.values()) delete draft.transcribing;
    for (const id of [...draftTimers.keys()]) { const draft = drafts.get(id) || (currentDraft?.id === id ? currentDraft : null); if (draft) await persistDraft(draft); }
    await draftWrite.catch(() => {});
    for (const draft of [...drafts.values()]) await removeDraft(draft);
    signingOut = true; closingPanel = false;
    try {
      await api("logout/", {method: "POST"});
      let cleared = true;
      try { await store?.clear(); } catch { cleared = false; }
      localFailures.clear(); drafts.clear(); currentDraft = null; pendingVoice = null; closePanels();
      if (cleared) location.reload();
      else {
        $("journal").hidden = true; $("account-button").hidden = true; $("guest").hidden = false;
        notice("已退出登录，但本机草稿没能清除。可在浏览器设置中清除此站点的数据。");
      }
    } catch (error) { signingOut = false; setVoiceState("idle"); throw error; }
  });
});
$("dev-login").addEventListener("click", () => void run($("dev-login"), async () => { await api("dev-login/", {method: "POST"}); location.reload(); }));
let booting = false;
async function start() {
  if (booting) return;
  booting = true;
  $("loading").hidden = false; $("retry-session").hidden = true;
  $("loading-text").textContent = "正在打开你的一滴…";
  try {
    const token = document.body.dataset.shareToken || new URLSearchParams(location.search).get("share");
    if (token) {
      $("loading").hidden = true; $("public").hidden = false;
      $("public-state").textContent = "正在打开分享的片刻…";
      try {
        const {entries} = await api("public/shares/" + encodeURIComponent(token) + "/");
        renderEntries($("public-entries"), entries, {publicView: true});
        $("public-state").textContent = entries.length ? "" : "这里暂时没有可见的记录。";
      } catch (error) { $("public-state").textContent = error.status === 404 ? "这个分享已结束，或链接已被撤销。" : message(error); }
      return;
    }
    session = await api("session/"); csrfToken = session.csrf_token; sessionExpired = false;
    $("loading").hidden = true;
    if (!session.authenticated) { $("guest").hidden = false; $("dev-login").hidden = !session.dev_login; return; }
    $("guest").hidden = true;
    $("identity").textContent = session.display_name || "我的一滴";
    if (session.avatar_url) {
      const avatar = node("img"); avatar.alt = ""; avatar.referrerPolicy = "no-referrer";
      avatar.addEventListener("error", () => avatar.remove(), {once: true}); avatar.src = session.avatar_url;
      $("identity").prepend(avatar);
      const small = avatar.cloneNode(); small.addEventListener("error", () => { small.replaceWith(icon("user")); }, {once: true});
      $("account-button").replaceChildren(small);
    }
    $("account-button").hidden = false; $("journal").hidden = false;
    try {
      store = await window.DropDrafts.open(String(session.user_id || ""));
      const saved = await store.all();
      saved.forEach(draft => { if (!draft.saved) { delete draft.transcribing; drafts.set(draft.id, draft); } else void store.remove(draft.id); });
    } catch { notice("这个浏览器暂时无法读取本机草稿，写完后请及时保存。" ); }
    try { autoLocation = localStorage.getItem("drop-location:" + session.user_id) !== "false"; } catch { autoLocation = true; }
    $("auto-location").checked = autoLocation;
    renderDraftSummary(); updateHomeDate(); renderNetwork();
    $("date").value = dateKey();
    void loadDay(); void refreshHome();
    const url = new URL(location.href), outcome = url.searchParams.get("chronelle");
    if (outcome) {
      url.searchParams.delete("chronelle"); history.replaceState(null, "", url);
      openPanel("calendar");
      $("calendar").querySelector(".panel-status").textContent = {connected: "Chronelle 已连接，可以把日程留进日记了。", denied: "这次没有连接，随时可以再试。", failed: "暂时没能连接，请重新授权。"}[outcome] || "";
    }
  } catch (error) {
    $("loading").hidden = false; $("loading-text").textContent = message(error); $("retry-session").hidden = false;
  } finally { booting = false; }
}
$("retry-session").addEventListener("click", () => void start());
if (window.visualViewport) {
  const adjustViewport = () => {
    document.documentElement.style.setProperty("--visual-height", window.visualViewport.height + "px");
    document.documentElement.style.setProperty("--keyboard-offset", Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop) + "px");
  };
  window.visualViewport.addEventListener("resize", adjustViewport); window.visualViewport.addEventListener("scroll", adjustViewport); adjustViewport();
}
// Swiping the header down is an alternative to its visible back/close control.
document.querySelectorAll(".panel-header").forEach(header => {
  let startPoint;
  header.addEventListener("touchstart", event => {
    startPoint = !event.target.closest("button, a, input, textarea, summary, [contenteditable]") && event.touches.length === 1
      ? {x: event.touches[0].clientX, y: event.touches[0].clientY} : null;
  }, {passive: true});
  header.addEventListener("touchmove", event => { if (event.touches.length !== 1) startPoint = null; }, {passive: true});
  header.addEventListener("touchcancel", () => { startPoint = null; }, {passive: true});
  header.addEventListener("touchend", event => {
    const end = event.changedTouches[0];
    if (startPoint && end && end.clientY - startPoint.y > 85 && Math.abs(end.clientX - startPoint.x) < 70) void backPanel();
    startPoint = null;
  }, {passive: true});
});
void start();
