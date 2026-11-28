/* 在庫管理アプリ専用のService Worker(他のアプリのsw.jsとは別。scopeは stock.html のみ)

   バージョン管理の仕組み
   - バージョン番号は stock-version.js の1か所だけで決める(ここで importScripts して使う)
   - バージョンごとに別のキャッシュ(sedori-stock-v<番号>)にファイル一式を保存する
   - 新しいバージョンを入れても、1つ前のバージョンのキャッシュは消さずに残す → 「前のバージョンに戻す」に使う
   - 「戻す」を選ぶと、そのバージョンを「固定(pin)」して、そのキャッシュからファイルを返す
   - 非常用: アプリが開けないときは stock.html?rollback で前のバージョン、stock.html?latest で最新版に切り替わる */
importScripts('stock-version.js');
const APP_VER = self.STOCK_VERSION.version;
const PREFIX = 'sedori-stock-v';
const VER = PREFIX + APP_VER;
const META = 'sedori-stock-meta';
const META_KEY = 'meta.json';
const ASSETS = ['stock.html', 'stock.js', 'stock-version.js', 'stock.webmanifest', 'stock-icon-180.png', 'stock-icon-192.png', 'stock-icon-512.png', 'stock-icon-maskable-512.png'];
const ZX = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

/* ---- メタ情報 { current, previous, pin } (キャッシュ内にJSONで保存) ---- */
async function getMeta() {
  try {
    const r = await (await caches.open(META)).match(META_KEY);
    if (r) return await r.json();
  } catch (_) { /* ignore */ }
  return { current: null, previous: null, pin: null };
}
async function setMeta(m) {
  const c = await caches.open(META);
  await c.put(META_KEY, new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
}
const verOf = (cacheName) => (cacheName ? cacheName.slice(PREFIX.length) : null);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    // HTTPキャッシュを通さずに最新ファイルを取得(GitHub Pagesは10分ほどキャッシュされるため)
    await Promise.all(ASSETS.map(async (a) => {
      const r = await fetch(a, { cache: 'reload' });
      if (!r.ok) throw new Error('取得失敗: ' + a);
      await c.put(a, r);
    }));
    try {
      const r = await fetch(ZX);
      if (r.ok) await c.put(ZX, r);
    } catch (_) { /* オフライン時はスキップ(初回読み取り時に取得) */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const meta = await getMeta();
    // 1つ前のバージョン = これまで使っていたバージョン(この仕組みを入れる前の古い版は対象外)
    let previous = meta.previous;
    if (meta.current && meta.current !== VER) previous = meta.current;
    const keep = new Set([VER, previous, META]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('sedori-stock-') && !keep.has(k)).map((k) => caches.delete(k)));
    if (previous && !(await caches.has(previous))) previous = null;
    // 新しいバージョンが入ったら固定は解除する(固定していた版が残っていればそのまま)
    const pin = meta.current === VER && meta.pin && (await caches.has(meta.pin)) ? meta.pin : null;
    await setMeta({ current: VER, previous, pin });
    await self.clients.claim();
  })());
});

/* ---- 画面からの問い合わせ・操作 ---- */
self.addEventListener('message', (e) => {
  const port = e.ports[0];
  const reply = (v) => port && port.postMessage(v);
  e.waitUntil((async () => {
    const meta = await getMeta();
    const t = e.data && e.data.type;
    if (t === 'pin-previous' && meta.previous && (await caches.has(meta.previous))) {
      meta.pin = meta.previous;
      await setMeta(meta);
    } else if (t === 'unpin') {
      meta.pin = null;
      await setMeta(meta);
    }
    reply({ installed: APP_VER, previous: verOf(meta.previous), pinned: verOf(meta.pin) });
  })().catch((err) => reply({ error: String(err) })));
});

/* ---- ファイルを返す ---- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.searchParams.has('nocache')) return; // バージョン確認用はネットワークへ素通し
  if (url.origin !== location.origin && url.href !== ZX) return;
  e.respondWith((async () => {
    const meta = await getMeta();
    // 非常用の切り替え
    if (req.mode === 'navigate' && url.searchParams.has('rollback') && meta.previous && (await caches.has(meta.previous))) {
      meta.pin = meta.previous; await setMeta(meta);
    }
    if (req.mode === 'navigate' && url.searchParams.has('latest') && meta.pin) {
      meta.pin = null; await setMeta(meta);
    }
    const name = meta.pin && (await caches.has(meta.pin)) ? meta.pin : VER;
    const c = await caches.open(name);
    let hit = await c.match(req, { ignoreSearch: true });
    if (!hit && name !== VER) hit = await (await caches.open(VER)).match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r && r.ok && url.href === ZX) (await caches.open(VER)).put(ZX, r.clone());
      return r;
    } catch (_) {
      if (req.mode === 'navigate') return (await c.match('stock.html')) || Response.error();
      return Response.error();
    }
  })());
});
