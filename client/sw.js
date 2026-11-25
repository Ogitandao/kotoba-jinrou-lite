// ことば人狼 Service Worker
// キャッシュはしない（開発中は常に最新版を届けるため）。PWAのインストール条件を満たすための最小構成。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
