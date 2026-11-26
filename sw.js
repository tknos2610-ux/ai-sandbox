/* Service Worker: アプリ本体をキャッシュしてオフラインで使えるようにする */
const VER = 'sedori-stock-v1.0.0';
const ASSETS = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const ZX = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    await c.addAll(ASSETS);
    try {
      const r = await fetch(ZX);
      if (r.ok) await c.put(ZX, r);
    } catch (_) { /* オフライン時はスキップ(次回起動時に再取得) */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// キャッシュ優先 + 裏で更新(更新は次回起動時に反映)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && url.href !== ZX) return;
  e.respondWith((async () => {
    const c = await caches.open(VER);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((r) => {
      if (r && r.ok) c.put(req, r.clone());
      return r;
    }).catch(() => null);
    if (hit) return hit;
    const r = await net;
    if (r) return r;
    if (req.mode === 'navigate') return (await c.match('index.html')) || Response.error();
    return Response.error();
  })());
});
