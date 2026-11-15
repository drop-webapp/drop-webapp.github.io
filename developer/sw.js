// Never cache administrator pages, credentials, API responses or email codes.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>一滴管理</title><p>当前离线。连接网络后重新打开应用管理。</p><button onclick="location.reload()">重新连接</button>', {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})));
});
