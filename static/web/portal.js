/* Frontend pages hosted by GitHub Pages; only session data and writes use the API. */
(() => {
  'use strict';
  const api = 'https://api.drop.jyonn.space';
  const pages = {'/oauth/authorize/':'authorize','/oauth/grants/':'grants','/developer/':'developer','/developer/admin/':'admin'};
  const name = pages[location.pathname];
  if (!name || window.parent !== window) return;
  const nativeFetch = window.fetch.bind(window);
  let identity;
  window.dropApiOrigin = api;
  window.dropApiFetch = async (path, options = {}) => {
    const url = new URL(path, api);
    if (url.origin !== api) throw Error('请求地址无效');
    const headers = new Headers(options.headers || {});
    if ((options.method || 'GET').toUpperCase() !== 'GET') {
      const session = await nativeFetch(api + '/api/session/', {credentials:'include', cache:'no-store', redirect:'error', signal:AbortSignal.timeout(20000)});
      if (!session.ok) throw Error('无法确认登录状态，请刷新页面重试。');
      const value = await session.json();
      headers.set('X-CSRFToken', value.csrf_token);
      if (options.body instanceof FormData) options.body.delete('csrfmiddlewaretoken');
    }
    return nativeFetch(url.href, {...options, headers, credentials:'include', cache:'no-store', redirect:'error'});
  };
  async function load() {
    const response = await window.dropApiFetch('/api/web/' + name + '/' + location.search, {signal:AbortSignal.timeout(20000)});
    const result = await response.json();
    if (!response.ok || typeof result.html !== 'string') throw Error('授权请求无效或页面暂时不可用。请返回原应用重新连接。');
    identity = result.user_id;
    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    for (const link of doc.querySelectorAll('a[href]')) {
      const target = link.getAttribute('href');
      if (target.startsWith('/api/') || target === '/developer/login/') link.href = api + target;
    }
    // Keep frontend state and authenticated markup out of the URL and persistent storage.
    document.documentElement.lang = 'zh-CN';
    document.head.replaceChildren(...doc.head.childNodes);
    document.body.replaceChildren(...doc.body.childNodes);
    // DOMParser scripts are inert. Load only our page-specific frontend assets.
    for (const source of [...document.querySelectorAll('script[src]')]) {
      const url = new URL(source.getAttribute('src'), location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/static/web/')) { source.remove(); continue; }
      const script = document.createElement('script'); script.src = url.href; source.replaceWith(script);
    }
    for (const form of document.forms) {
      if ((form.getAttribute('method') || '').toLowerCase() !== 'post') continue;
      if (name === 'developer' || name === 'admin') continue;
      let busy = false;
      const error = document.createElement('p'); error.setAttribute('role','alert'); form.append(error);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy) return;
        busy = true; error.textContent = '';
        const data = new FormData(form);
        if (event.submitter?.name) data.append(event.submitter.name, event.submitter.value);
        const buttons = [...form.querySelectorAll('button')];buttons.forEach(button => button.disabled = true);
        try {
          const response = await window.dropApiFetch('/api/web/' + name + '/' + location.search, {method:'POST', headers:{'X-Drop-User':String(identity)}, body:data, signal:AbortSignal.timeout(20000)});
          const result = await response.json();
          if (!response.ok || typeof result.redirect_url !== 'string') throw Error(response.status === 409 ? '账号已变化，请刷新后重新确认授权。' : response.status === 403 ? '页面验证已过期，请刷新后重新确认授权。' : '授权未完成，请返回原应用重新发起连接。');
          const target = new URL(result.redirect_url, api);
          if (target.protocol !== 'https:') throw Error('回调地址无效');
          location.assign(target.href);
        } catch (failure) { error.textContent = failure.message || '网络暂时不可用，请重试。'; busy = false;buttons.forEach(button => button.disabled = false); }
      });
    }
  }
  load().catch(error => { document.getElementById('portal-status').textContent = error.message; });
})();
