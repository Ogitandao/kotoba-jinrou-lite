// ことば人狼 Service Worker
// キャッシュはしない（開発中は常に最新版を届けるため）。PWAのインストール条件を満たすための最小構成。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// Web Push（0059）：本文・名前はサーバー側で付けない方針のため、
// ここでは届いた文言をそのまま出すだけ
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  event.waitUntil(self.registration.showNotification(d.title || 'ことば人狼', {
    body: d.body || '',
    icon: 'icons/pwa-icon-192.png',
    badge: 'icons/badge-96.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      c.postMessage({ type: 'kl-push-open', url });
      if ('focus' in c) { await c.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
