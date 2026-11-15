(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const fieldInputs = {name: "app-name", description: "app-description", redirect_uris: "app-redirects", allowed_origins: "app-origins"};
  const fields = ["name", "description", "redirect_uris", "allowed_origins", "allowed_scopes"];
  const scopes = ["diary.picker", "shares.create", "diary.read"];
  const pending = new Set(), blockedRotations = new Set();
  let config, applications = [], editing = null, createOperation = null, busy = false, locked = false;
  let generation = 0, listing = false, listVersion = 0, confirmation;
  const element = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value; if (className) el.className = className; return el; };
  const button = (label, action, className = "text-button") => { const el = element("button", label, className); el.type = "button"; el.addEventListener("click", () => void action(el)); return el; };
  class Failure extends Error { constructor(code, status = 0, field = null) { super(code); this.status = status; this.field = fields.includes(field) ? field : null; } }
  function copyError(error) {
    switch (error.message) {
      case "authentication_required": return "登录已过期。请重新登录，当前表单输入仍保留在页面中。";
      case "account_changed": return "浏览器已切换账号。为保护应用信息，请重新登录或刷新整个页面；当前输入未被覆盖。";
      case "request_expired": return "请求校验已过期。请先保留或复制未保存的配置，再刷新页面后重试；不会自动重新提交。";
      case "stale_revision": return "应用已在别处更新。请刷新列表，再重新打开配置核对。当前表单输入仍保留。";
      case "idempotency_conflict": return "这次创建操作的内容发生冲突。请刷新列表核对，当前输入仍保留。";
      case "application_limit": return "应用数量已达上限，请先检查现有应用。";
      case "resource_not_found": return "找不到这个应用，或它不属于当前账号。请刷新列表核对。";
      case "invalid_configuration": return "请检查配置字段。回调须为 HTTPS，来源只包含协议与域名，权限须满足依赖。";
      case "invalid_request": case "invalid_operation_id": case "invalid_action": return "请求配置不完整。请检查输入，或刷新页面后再试。";
      case "page_hidden": return "离开页面时操作尚未确认。请刷新列表核对结果，当前输入仍保留。";
      case "invalid_response": return "服务返回的信息不完整。请刷新列表核对，当前输入仍保留。";
      default: return "暂时没有收到结果。当前输入仍保留，可以稍后重试。";
    }
  }
  function clearSecret() {
    $("secret-value").value = ""; $("secret-client-id").value = "";
    $("secret-copy-status").textContent = "";
    $("copy-secret").textContent = "复制密钥"; $("copy-secret-id").textContent = "复制 Client ID";
    if ($("secret-dialog").open) $("secret-dialog").close();
  }
  function invalidatePage() {
    generation++; clearSecret();
    for (const controller of pending) controller.abort();
  }
  window.addEventListener("pagehide", invalidatePage);
  document.addEventListener("visibilitychange", () => { if (document.hidden) invalidatePage(); });
  $("secret-dialog").addEventListener("close", clearSecret);
  $("close-secret").addEventListener("click", clearSecret);
  function lockAccount() {
    locked = true; clearSecret(); $("new-app").disabled = true; $("form-fields").disabled = true; $("submit-app").disabled = true;
    $("reauthenticate").hidden = false; renderApplications();
  }
  async function api(path, body) {
    if (locked) throw new Failure("authentication_required", 401);
    const controller = new AbortController(), epoch = generation;
    const timer = setTimeout(() => controller.abort(), 20000); pending.add(controller);
    const headers = {Accept: "application/json", [config.adminMode ? "X-Drop-Admin" : "X-Drop-User"]: String(config.userId)};
    if (config.adminMode) path = path.replace("/api/developer/", "/api/admin/");
    if (body !== undefined) { headers["Content-Type"] = "application/json"; headers["X-CSRFToken"] = config.csrfToken; }
    try {
      const response = await (window.dropApiFetch || fetch)(path, {method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", cache: "no-store", headers,
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: controller.signal});
      const result = await response.json().catch(() => ({}));
      if (epoch !== generation || document.hidden) { if (result && typeof result === "object") delete result.client_secret; throw new Failure("page_hidden"); }
      if (!response.ok) {
        const code = response.status === 403 ? "request_expired" : typeof result.error === "string" ? result.error : response.status === 401 ? "authentication_required" : "unavailable";
        if (response.status === 401 || code === "account_changed") lockAccount();
        throw new Failure(code, response.status, result.field);
      }
      return result;
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(epoch !== generation ? "page_hidden" : "unavailable");
    } finally { clearTimeout(timer); pending.delete(controller); }
  }
  function validApplication(app) {
    return app && typeof app.client_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(app.client_id)
      && typeof app.name === "string" && typeof app.description === "string" && typeof app.active === "boolean"
      && Number.isSafeInteger(app.revision) && app.revision > 0
      && [app.redirect_uris, app.allowed_origins, app.allowed_scopes].every(array => Array.isArray(array) && array.every(value => typeof value === "string"));
  }
  function acceptApplication(result) {
    if (!validApplication(result.application)) { delete result.client_secret; throw new Failure("invalid_response"); }
    const index = applications.findIndex(app => app.client_id === result.application.client_id);
    if (index < 0) applications.push(result.application); else applications[index] = result.application;
    renderApplications(); return result.application;
  }
  function pageError(error) { $("page-error-copy").textContent = copyError(error); $("page-error").hidden = false; }
  function notify(copy) { $("page-message").textContent = copy; $("page-message").hidden = false; }
  async function loadApplications(explicit = false) {
    if (listing || locked) return;
    const version = ++listVersion; listing = true; $("loading").hidden = false; $("page-error").hidden = true;
    try {
      const result = await api("/api/developer/apps/");
      if (version !== listVersion) return;
      if (!Array.isArray(result.applications) || !result.applications.every(validApplication)) throw new Failure("invalid_response");
      applications = result.applications;
      if (explicit) blockedRotations.clear();
      renderApplications();
    } catch (error) { pageError(error); }
    finally { if (version === listVersion) { listing = false; $("loading").hidden = true; renderApplications(); } }
  }
  function renderApplications() {
    $("applications").replaceChildren(...applications.filter(app => !config.adminMode || (app.name + " " + app.client_id).toLowerCase().includes($("admin-search").value.toLowerCase())).map(app => {
      const row = element("article", "", "application"); row.dataset.clientId = app.client_id;
      const heading = element("div", "", "application-head");
      heading.append(element("h3", app.name), element("span", app.active ? "使用中" : "已停用", "app-state" + (app.active ? "" : " inactive")));
      row.append(heading); if (app.description) row.append(element("p", app.description, "description"));
      const meta = element("div", "", "app-meta");
      meta.append(element("span", app.redirect_uris.length + " 个回调"), element("span", app.allowed_origins.length + " 个宿主来源"), element("span", app.allowed_scopes.includes("diary.picker") ? "日记选择器" : "指定日记读取"));
      if (app.allowed_scopes.includes("shares.create")) meta.append(element("span", "可申请创建分享"));
      const actions = element("div", "", "app-actions");
      const controls = [button("接入信息", () => openIntegration(app)), button("编辑配置", () => openForm(app)),
        button("重新生成密钥", () => action(app, "rotate_secret")), button(app.active ? "停用应用" : "启用应用", () => action(app, app.active ? "disable" : "enable"), "text-button" + (app.active ? " danger" : ""))];
      controls.forEach((control, index) => { control.disabled = busy || locked || (index === 2 && blockedRotations.has(app.client_id)); actions.append(control); });
      if (config.adminMode) row.append(element("p", app.client_id + " · " + (app.owner_id ? "账户 " + app.owner_id : "命令行注册"), "supporting"));
      row.append(meta, actions); return row;
    }));
    $("empty-apps").hidden = applications.length > 0 || listing;
  }
  function clearErrors() {
    for (const field of fields) { $("error-" + field).hidden = true; const input = $(fieldInputs[field]); if (input) input.removeAttribute("aria-invalid"); }
    $("form-error").hidden = true; $("form-refresh").hidden = true;
  }
  function fieldError(field, copy) {
    $("error-" + field).textContent = copy; $("error-" + field).hidden = false;
    const input = $(fieldInputs[field]); if (input) { input.setAttribute("aria-invalid", "true"); input.focus(); }
  }
  for (const [field, inputID] of Object.entries(fieldInputs)) {
    $(inputID).addEventListener("input", () => {
      $("error-" + field).hidden = true; $(inputID).removeAttribute("aria-invalid");
    });
  }
  function openForm(app = null) {
    if (busy || locked) return;
    clearSecret(); editing = app; createOperation = null; clearErrors();
    $("app-name").value = app?.name || ""; $("app-description").value = app?.description || "";
    $("app-redirects").value = (app?.redirect_uris || []).join("\n"); $("app-origins").value = (app?.allowed_origins || []).join("\n");
    $("scope-picker").checked = app ? app.allowed_scopes.includes("diary.picker") : true;
    $("scope-share").checked = app?.allowed_scopes.includes("shares.create") || false;
    $("scope-read").checked = app?.allowed_scopes.includes("diary.read") || false;
    $("scope-read").closest("details").open = $("scope-read").checked;
    $("scope-share").disabled = !$("scope-picker").checked;
    $("form-title").textContent = app ? "编辑应用配置" : "创建应用";
    $("submit-app").textContent = app ? "保存配置" : "创建并领取凭据";
    $("form-note").textContent = app ? "仅更改名称和说明，不影响现有授权。" : "创建后，请保存只展示一次的密钥。";
    $("form-fields").disabled = false; $("app-form-dialog").showModal(); $("app-name").focus();
  }
  function closeForm() { if (!busy) $("app-form-dialog").close(); }
  $("app-form-dialog").addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  $("close-form").addEventListener("click", closeForm);
  $("new-app").addEventListener("click", () => openForm());
  $("scope-picker").addEventListener("change", () => { if (!$("scope-picker").checked) $("scope-share").checked = false; $("scope-share").disabled = !$("scope-picker").checked; });
  function configuration() {
    clearErrors();
    const value = {name: $("app-name").value.trim(), description: $("app-description").value.trim(),
      redirect_uris: $("app-redirects").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      allowed_origins: $("app-origins").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      allowed_scopes: scopes.filter((scope, index) => $( ["scope-picker", "scope-share", "scope-read"][index]).checked).sort()};
    if (!value.name || [...value.name].length > 100) { fieldError("name", "请填写 1–100 字的应用名称。"); return; }
    if ([...value.description].length > 500) { fieldError("description", "用途说明请控制在 500 字以内。"); return; }
    if (!value.redirect_uris.length || value.redirect_uris.length > 10 || new Set(value.redirect_uris).size !== value.redirect_uris.length) { fieldError("redirect_uris", "请填写 1–10 个不重复的 HTTPS 回调，每行一个。"); return; }
    for (const callback of value.redirect_uris) {
      try {
        const url = new URL(callback);
        if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || callback.includes("#") || [...url.searchParams.keys()].some(key => ["code", "state", "error"].includes(key))) throw Error();
      } catch { fieldError("redirect_uris", "请输入完整 HTTPS 回调，不含片段、登录结果参数或账号密码。"); return; }
    }
    if (value.allowed_origins.length > 10) { fieldError("allowed_origins", "最多登记 10 个宿主来源。"); return; }
    for (const origin of value.allowed_origins) {
      try { const url = new URL(origin); if (url.protocol !== "https:" || url.origin !== origin) throw Error(); }
      catch { fieldError("allowed_origins", "只填写 HTTPS 来源，例如 https://your.app，不含路径或末尾斜线。"); return; }
    }
    value.allowed_origins = [...new Set(value.allowed_origins)].sort();
    if (!value.allowed_scopes.length) { fieldError("allowed_scopes", "至少选择一种应用能力。"); return; }
    if (value.allowed_scopes.includes("diary.picker") && !value.allowed_origins.length) { fieldError("allowed_origins", "日记资源选择器需要至少一个宿主来源。"); return; }
    return value;
  }
  function ask(title, copy, accept = "确认更改") {
    if (confirmation) return Promise.resolve(false);
    $("confirm-title").textContent = title; $("confirm-copy").textContent = copy; $("confirm-accept").textContent = accept;
    $("confirm-dialog").showModal(); $("confirm-cancel").focus();
    return new Promise(resolve => { confirmation = resolve; });
  }
  function finishConfirmation(value) { const resolve = confirmation; confirmation = null; $("confirm-dialog").close(); resolve?.(value); }
  $("confirm-accept").addEventListener("click", () => finishConfirmation(true)); $("confirm-cancel").addEventListener("click", () => finishConfirmation(false));
  $("confirm-dialog").addEventListener("cancel", event => { event.preventDefault(); finishConfirmation(false); });
  function setBusy(value) {
    busy = value; $("form-fields").disabled = value || locked; $("submit-app").disabled = value || locked; $("close-form").disabled = value; $("new-app").disabled = value || locked;
    if (!value) $("scope-share").disabled = !$("scope-picker").checked;
    renderApplications();
  }
  function showSecret(result) {
    const secret = result.client_secret;
    delete result.client_secret;
    if (typeof secret !== "string" || !secret || document.hidden || locked) return false;
    clearSecret(); $("secret-client-id").value = result.application.client_id; $("secret-value").value = secret;
    $("secret-dialog").showModal(); return true;
  }
  function formError(error) {
    $("form-error-copy").textContent = copyError(error); $("form-error").hidden = false;
    $("form-refresh").hidden = locked || ![409, 404].includes(error.status);
    if (error.field) fieldError(error.field, copyError(error));
  }
  $("app-form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy || locked) return;
    const value = configuration(); if (!value) return;
    const app = editing;
    const authChanged = app && ["redirect_uris", "allowed_origins", "allowed_scopes"].some(key => JSON.stringify([...value[key]].sort()) !== JSON.stringify([...app[key]].sort()));
    setBusy(true);
    try {
      if (authChanged && !await ask("更新授权配置？", "回调、来源或能力变化后，现有用户授权会失效。用户需要重新连接。应用名称与说明不受影响。", "更新配置")) return;
      let result;
      if (app) result = await api("/api/developer/apps/" + encodeURIComponent(app.client_id) + "/", {action: "configure", revision: app.revision, ...value});
      else {
        const fingerprint = JSON.stringify(value);
        if (!createOperation || createOperation.fingerprint !== fingerprint) createOperation = {fingerprint, id: crypto.randomUUID()};
        result = await api("/api/developer/apps/", {...value, operation_id: createOperation.id});
      }
      acceptApplication(result); $("app-form-dialog").close();
      if (!app && !showSecret(result)) notify(result.secret_unavailable ? "应用已经创建，本次重试不会重复创建。密钥无法再次展示，请主动重新生成。" : "应用已创建。若没有保存密钥，请重新生成。");
      else if (app) notify("应用配置已保存。");
      // No reference to a one-time secret is kept in application state.
      delete result.client_secret;
    } catch (error) { formError(error); }
    finally { setBusy(false); }
  });
  async function action(app, name) {
    if (busy || locked || (name === "rotate_secret" && blockedRotations.has(app.client_id))) return;
    const details = name === "rotate_secret" ? ["重新生成 Client Secret？", "旧密钥会立即失效，现有用户授权也会失效。请准备更新服务端配置，再让用户重新连接。", "重新生成"]
      : name === "disable" ? ["停用这个应用？", "应用将无法继续访问一滴，现有用户授权会失效。之后启用也不会恢复这些授权。", "停用应用"]
      : ["启用这个应用？", "应用可以重新发起授权。此前失效的授权不会自动恢复，用户需要重新连接。", "启用应用"];
    setBusy(true); clearSecret();
    try {
      if (!await ask(...details)) return;
      if (name === "rotate_secret") blockedRotations.add(app.client_id);
      const result = await api("/api/developer/apps/" + encodeURIComponent(app.client_id) + "/", {action: name, revision: app.revision});
      acceptApplication(result);
      if (name === "rotate_secret") { blockedRotations.delete(app.client_id); if (!showSecret(result)) notify("密钥已更新。若未能保存，请刷新列表后再次主动生成。"); }
      else notify(name === "disable" ? "应用已停用，现有授权已失效。" : "应用已启用，需要用户重新授权。");
      delete result.client_secret;
    } catch (error) {
      if (name === "rotate_secret" && !error.status) {
        $("page-error-copy").textContent = "密钥重置结果尚未确认，不会自动重试。请刷新列表核对，再决定是否重新生成；再次生成会让先前密钥失效。";
        $("page-error").hidden = false;
      } else { blockedRotations.delete(app.client_id); pageError(error); }
    } finally { setBusy(false); }
  }
  async function copy(input, status) {
    const epoch = generation;
    try {
      await navigator.clipboard.writeText($(input).value);
      if (epoch === generation) $(status).textContent = "已复制，请妥善保管。";
    } catch {
      if (epoch !== generation) return;
      $(input).focus(); $(input).select(); $(status).textContent = "浏览器没有允许复制，已选中文字，可以手动复制。";
    }
  }
  $("copy-secret").addEventListener("click", () => void copy("secret-value", "secret-copy-status"));
  $("copy-secret-id").addEventListener("click", () => void copy("secret-client-id", "secret-copy-status"));
  $("copy-client-id").addEventListener("click", () => void copy("integration-client-id", "integration-copy-status"));
  $("copy-iframe").addEventListener("click", () => void copy("iframe-example", "integration-copy-status"));
  function openIntegration(app) {
    if (busy || locked) return;
    $("integration-client-id").value = app.client_id;
    const pickerEnabled = app.allowed_scopes.includes("diary.picker") && app.allowed_origins.length > 0;
    $("iframe-example").closest("label").hidden = !pickerEnabled; $("copy-iframe").hidden = !pickerEnabled;
    $("iframe-example").value = "";
    if (pickerEnabled) {
      const params = new URLSearchParams({mode: "oauth", client_id: app.client_id, origin: app.allowed_origins[0]});
      $("iframe-example").value = '<iframe title="从一滴选择日记" src="' + (window.dropApiOrigin || location.origin) + '/picker/embed/?' + params.toString().replace(/&/g, "&amp;") + '"\n  style="width:100%;height:580px;border:0"\n  sandbox="allow-scripts allow-same-origin"></iframe>\n<!-- 在设置 src 前监听 drop.picker.* 消息，并按接入文档实现服务端转发。 -->';
    }
    $("integration-copy-status").textContent = pickerEnabled ? "示例不含密钥或令牌。完整握手与响应校验请见接入文档。"
      : "此应用使用指定日记读取，按接入文档发起 diary.read 授权；启用日记选择器并登记来源后可获取 iframe 示例。";
    $("integration-dialog").showModal();
  }
  $("close-integration").addEventListener("click", () => $("integration-dialog").close());
  $("refresh-apps").addEventListener("click", () => void loadApplications(true));
  $("form-refresh").addEventListener("click", async () => { await loadApplications(true); if (!locked) $("form-error-copy").textContent = "列表已刷新，当前输入未改变。请取消后重新打开最新配置，核对后再修改。"; });
  function setupAdmin() {
    const manifest = document.createElement("link"); manifest.rel = "manifest"; manifest.href = "/static/web/admin.webmanifest"; document.head.append(manifest);
    let sending = false, loginBusy = false, nextSend = 0, installPrompt;
    const status = $("admin-login-status");
    const messages = {invalid_admin_login: "验证码无效或已过期，请检查后重试。", rate_limit_exceeded: "尝试次数较多，请稍后再试。", admin_mail_unavailable: "邮件暂时无法发送，请稍后重试。"};
    async function auth(path, body) {
      const response = await (window.dropApiFetch || fetch)(path, {method:"POST", credentials:"same-origin", cache:"no-store", redirect:"error", headers:{"Content-Type":"application/json", "X-CSRFToken":config.csrfToken}, body:JSON.stringify(body), signal:AbortSignal.timeout(20000)});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(response.status === 403 ? "页面已过期，请刷新后重试。" : messages[data.error] || "暂时无法登录，请稍后重试。");
      return data;
    }
    $("admin-send-code").addEventListener("click", async () => {
      if (sending || Date.now() < nextSend) return;
      sending = true; $("admin-send-code").disabled = true;
      try { await auth("/api/admin/email-code/", {email:$("admin-email").value.trim()}); nextSend = Date.now() + 60000; status.textContent = "验证码已请求。请查看管理员邮箱，10 分钟内有效。"; $("admin-code").focus(); }
      catch(error) {status.textContent = error.message;}
      finally {sending = false; $("admin-send-code").disabled = false;}
    });
    $("admin-login-form").addEventListener("submit", async event => {
      event.preventDefault(); if (loginBusy) return;
      if (!/^[0-9]{6}$/.test($("admin-code").value)) { status.textContent = "请输入 6 位邮箱验证码。"; return; }
      loginBusy = true; $("admin-login-submit").disabled = true;
      try {await auth("/api/admin/login/", {email:$("admin-email").value.trim(), code:$("admin-code").value}); $("admin-code").value = ""; location.replace("/developer/admin/");}
      catch(error) {status.textContent = error.message;}
      finally {loginBusy = false; $("admin-login-submit").disabled = false;}
    });
    $("admin-logout").addEventListener("click", async () => {try {await api("/api/admin/logout/", {}); invalidatePage(); location.replace("/developer/admin/");} catch(error) {pageError(error);} });
    $("admin-search").addEventListener("input", renderApplications);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/developer/sw.js", {scope:"/developer/"}).catch(() => {});
    window.addEventListener("beforeinstallprompt", event => {event.preventDefault(); installPrompt = event;});
    $("admin-install").addEventListener("click", async () => {if (installPrompt) {await installPrompt.prompt(); installPrompt = null;} else $("admin-install-help").hidden = false;});
  }
  try {
    config = JSON.parse($("developer-config").textContent);
    if (window.parent !== window) { $("sign-in").hidden = false; $("sign-in").replaceChildren(element("h2", "请在独立页面打开开发者平台"), element("p", "为保护应用凭据，这个页面不能嵌入其他应用。")); return; }
    if (config.adminMode) {
      document.title = "应用管理 · 一滴";
      document.querySelector(".intro h1").textContent = "让每一次连接，妥善安放。";
      document.querySelector(".intro > p:last-child").textContent = "管理 OAuth 应用的配置、权限与使用状态。";
      document.querySelector(".section-heading h2").textContent = "全部应用";
      $("new-app").hidden = true;
      document.querySelector(".section-heading .supporting").textContent = "查看全部开发者及命令行注册的应用。";
      document.querySelector(".eyebrow").textContent = "DROP / ADMIN";
      $("reauthenticate").href = "/developer/admin/";
      setupAdmin();
      if (!config.authenticated) { $("admin-sign-in").hidden = false; return; }
      $("admin-tools").hidden = false;
      $("admin-identity").textContent = config.displayName;
    }
    if (!config.authenticated) { $("sign-in").hidden = false; return; }
    if (!["string", "number"].includes(typeof config.userId) || !String(config.userId) || typeof config.csrfToken !== "string" || !config.csrfToken) throw Error();
    $("dashboard").hidden = false; void loadApplications();
  } catch { $("sign-in").hidden = false; $("sign-in").replaceChildren(element("h2", "暂时无法打开开发者平台"), element("p", "请刷新页面，或重新登录后再试。")); }
})();
