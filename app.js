'use strict';
(() => {
const VERSION = '1.0.0';
const ZX_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

/* ---------- ユーティリティ ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const p2 = (n) => String(n).padStart(2, '0');
const fmt = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const DAY = 864e5;

/* ---------- JANコード ---------- */
function checkDigitOk(s) {
  const d = [...s].map(Number);
  const chk = d.pop();
  let sum = 0;
  d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === chk;
}
function normJan(raw) {
  let s = String(raw ?? '').replace(/\D/g, '');
  if (s.length === 12) s = '0' + s; // UPC-A → EAN-13
  if ((s.length === 13 || s.length === 8) && checkDigitOk(s)) return s;
  return null;
}

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sedori-stock', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('items', { keyPath: 'jan' });
      d.createObjectStore('locations', { keyPath: 'id', autoIncrement: true });
      const m = d.createObjectStore('moves', { keyPath: 'id', autoIncrement: true });
      m.createIndex('jan', 'jan');
      m.createIndex('loc', 'loc');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = (n, mode = 'readonly') => db.transaction(n, mode).objectStore(n);
const dbAll = (n) => req(store(n).getAll());
const dbPut = (n, v) => req(store(n, 'readwrite').put(v));
const dbDel = (n, k) => req(store(n, 'readwrite').delete(k));
const dbDelMany = (n, keys) => new Promise((res, rej) => {
  const tx = db.transaction(n, 'readwrite');
  const s = tx.objectStore(n);
  keys.forEach((k) => s.delete(k));
  tx.oncomplete = res;
  tx.onerror = () => rej(tx.error);
});
const dbReplaceAll = (data) => new Promise((res, rej) => {
  const names = ['items', 'locations', 'moves'];
  const tx = db.transaction(names, 'readwrite');
  names.forEach((n) => tx.objectStore(n).clear());
  data.items.forEach((x) => tx.objectStore('items').put(x));
  data.locations.forEach((x) => tx.objectStore('locations').put(x));
  data.moves.forEach((x) => tx.objectStore('moves').put(x));
  tx.oncomplete = res;
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error);
});

/* ---------- 状態 ---------- */
const state = {
  mode: lsGet('mode') === 'out' ? 'out' : 'in',
  locId: Number(lsGet('loc')) || null,
  qty: 1,
  items: new Map(), locs: [], moves: [],
  stock: new Map(), lastTs: new Map(),
  lastMoveId: null,
  q: '', stockLoc: 'all', showZero: false,
  tab: 'scan',
  log: [],
};
async function reload() {
  const [items, locs, moves] = await Promise.all([dbAll('items'), dbAll('locations'), dbAll('moves')]);
  state.items = new Map(items.map((i) => [i.jan, i]));
  state.locs = locs.sort((a, b) => a.id - b.id);
  state.moves = moves;
  state.stock = new Map();
  state.lastTs = new Map();
  for (const m of moves) {
    const d = m.type === 'in' ? m.qty : -m.qty;
    let s = state.stock.get(m.jan);
    if (!s) { s = new Map(); state.stock.set(m.jan, s); }
    s.set(m.loc, (s.get(m.loc) || 0) + d);
    if ((state.lastTs.get(m.jan) || 0) < m.ts) state.lastTs.set(m.jan, m.ts);
  }
  if (!state.locs.some((l) => l.id === state.locId)) state.locId = state.locs[0]?.id ?? null;
}
const stockOf = (jan) => state.stock.get(jan) || new Map();
const totalOf = (jan) => [...stockOf(jan).values()].reduce((a, b) => a + b, 0);
const locName = (id) => state.locs.find((l) => l.id === id)?.name ?? '(削除済み)';

/* ---------- 通知(音・振動・トースト) ---------- */
let actx = null;
function initAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { /* ignore */ }
}
function beep(kind) {
  try { navigator.vibrate?.(kind === 'err' ? [80, 60, 80] : 40); } catch { /* ignore */ }
  if (lsGet('sound') === '0' || !actx) return;
  try {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.value = { in: 880, out: 660, err: 220 }[kind] || 880;
    g.gain.value = 0.15;
    o.connect(g); g.connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + (kind === 'err' ? 0.3 : 0.12));
  } catch { /* ignore */ }
}
let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err show' : 'show';
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- ダイアログ ---------- */
function dialog({ title, body = '', buttons, onAct }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet" role="dialog"><h3>${esc(title)}</h3><div>${body}</div><div class="btns">${buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
    m.hidden = false;
    const collect = () => { const f = {}; $$('[data-k]', m).forEach((e) => { f[e.dataset.k] = e.value.trim(); }); return f; };
    const close = (v) => { m.hidden = true; m.innerHTML = ''; m.onclick = null; m.onkeydown = null; resolve(v); };
    m.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      if (a && onAct) { onAct(a, close); return; }
      const b = e.target.closest('button[data-i]');
      if (b) { close({ value: buttons[Number(b.dataset.i)].value, fields: collect() }); return; }
      if (e.target === m) close({ value: null, fields: {} });
    };
    m.onkeydown = (e) => {
      if (e.key === 'Enter' && e.target.matches('input')) {
        e.preventDefault();
        $('button.primary', m)?.click();
      }
    };
    const first = $('[data-k]', m);
    if (first) setTimeout(() => first.focus(), 60);
  });
}
const confirmDlg = async (title, body, label = 'OK', danger = true) =>
  (await dialog({ title, body, buttons: [{ label, value: 'ok', cls: danger ? 'danger' : 'primary' }, { label: 'キャンセル', value: null }] })).value === 'ok';

/* ---------- 記録 ---------- */
async function record(type, jan, loc, qty) {
  const m = { ts: Date.now(), type, jan, loc, qty };
  m.id = await dbPut('moves', m);
  state.lastMoveId = m.id;
  await reload();
  beep(type);
  state.log.unshift({ id: m.id, type, jan, loc, qty, ts: m.ts, undone: false });
  state.log = state.log.slice(0, 8);
  showLast(m);
  renderLog();
  state.qty = 1;
  updateQty();
}
function showLast(m) {
  const it = state.items.get(m.jan);
  const box = $('#last');
  box.hidden = false;
  box.className = 'card ' + m.type;
  box.innerHTML = `<div class="l1"><b>${m.type === 'in' ? '入庫' : '出庫'}</b> ${esc(it?.name)} <span>×${m.qty}</span></div>
    <div class="l2">${esc(locName(m.loc))}の在庫 ${stockOf(m.jan).get(m.loc) || 0} / 全体 ${totalOf(m.jan)}</div>
    <button type="button" data-undo="${m.id}">取り消し</button>`;
}
function renderLog() {
  $('#log').innerHTML = state.log.map((l) => {
    const it = state.items.get(l.jan);
    return `<li class="${l.undone ? 'undone' : ''}"><span class="${l.type === 'in' ? 'tag-in' : 'tag-out'}">${l.type === 'in' ? '入庫' : '出庫'}</span><div class="grow"><div class="nm">${esc(it?.name || l.jan)}</div><div class="muted sm">${esc(locName(l.loc))} ・ ${fmt(l.ts)}</div></div><div class="qty">×${l.qty}</div></li>`;
  }).join('') || '<li class="muted">まだありません</li>';
}
async function undoLast(id) {
  await dbDel('moves', id);
  await reload();
  const l = state.log.find((x) => x.id === id);
  if (l) l.undone = true;
  if (state.lastMoveId === id) state.lastMoveId = null;
  $('#last').hidden = true;
  renderLog();
  toast('取り消しました');
}

/* ---------- スキャン処理 ---------- */
let locked = false;
let lastCode = '';
let lastSeen = 0;
async function handleJan(jan) {
  if (locked) return;
  locked = true;
  try {
    let it = state.items.get(jan);
    if (state.mode === 'in') {
      if (!it) {
        const r = await dialog({
          title: '新しい商品',
          body: `<div class="muted">JAN ${esc(jan)}</div><label>商品名<input data-k="name" placeholder="商品名(空でも可)" autocomplete="off"></label>`,
          buttons: [{ label: '登録して入庫', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null }],
        });
        if (r.value !== 'ok') return;
        it = { jan, name: r.fields.name || `JAN ${jan}`, memo: '', created: Date.now() };
        await dbPut('items', it);
        await reload();
      }
      await record('in', jan, state.locId, state.qty);
    } else {
      if (!it) { beep('err'); toast(`未登録のJANです(${jan})`, true); return; }
      const st = stockOf(jan);
      const need = state.qty;
      const here = st.get(state.locId) || 0;
      if (here >= need) { await record('out', jan, state.locId, need); return; }
      const cands = [...st].filter(([, q]) => q >= need).sort((a, b) => b[1] - a[1]);
      if (cands.length) {
        const r = await dialog({
          title: it.name,
          body: `<div class="muted">${esc(locName(state.locId))}の在庫は ${here} です。どの倉庫から出庫しますか?</div>` +
            cands.map(([l, q]) => `<button type="button" class="pick" data-act="pick" data-loc="${l}">${esc(locName(l))}(在庫 ${q})</button>`).join(''),
          buttons: [{ label: 'キャンセル', value: null }],
          onAct: (el, close) => close({ value: 'pick', loc: Number(el.dataset.loc), fields: {} }),
        });
        if (r.value !== 'pick') return;
        await record('out', jan, r.loc, need);
        return;
      }
      if (lsGet('allowNeg') === '1') { await record('out', jan, state.locId, need); return; }
      beep('err');
      const max = Math.max(0, ...st.values());
      toast(max > 0 ? `在庫不足です(${it.name}: 最大${max})` : `${it.name} は在庫がありません`, true);
    }
  } catch (e) {
    console.error(e);
    toast('エラー: ' + (e.message || e), true);
  } finally {
    locked = false;
    lastSeen = Date.now();
  }
}
function onCode(raw) {
  const jan = normJan(raw);
  if (!jan || /^19[12]/.test(jan)) return; // 書籍の2段目バーコード(191/192)は無視
  if (locked) return;
  const now = Date.now();
  // 同じバーコードは、一度カメラから外れて1.5秒たつまで再記録しない
  if (jan === lastCode && now - lastSeen < 1500) { lastSeen = now; return; }
  lastCode = jan;
  lastSeen = now;
  handleJan(jan);
}

/* ---------- カメラ ---------- */
let scanning = false, detTimer = null, zxReader = null, zxCtl = null, wl = null, zxP = null;
const video = $('#video');
function loadZX() {
  if (window.ZXing) return Promise.resolve();
  if (zxP) return zxP;
  zxP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = ZX_URL;
    s.onload = res;
    s.onerror = () => { zxP = null; rej(new Error('読み取りライブラリを読み込めませんでした(初回はオンラインで開いてください)')); };
    document.head.appendChild(s);
  });
  return zxP;
}
const camConstraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
function setCamUI(msg) {
  $('#camMsg').hidden = scanning && !msg;
  if (msg) $('#camMsg').textContent = msg;
  const b = $('#camBtn');
  b.textContent = scanning ? 'カメラを停止' : 'カメラを開始';
  b.className = scanning ? 'big' : 'big primary';
}
async function startCam() {
  if (scanning) return;
  initAudio();
  if (!navigator.mediaDevices?.getUserMedia) { setCamUI('このブラウザはカメラに対応していません。手入力を使ってください'); return; }
  setCamUI('カメラを起動中…');
  $('#camMsg').hidden = false;
  try {
    let native = false;
    if ('BarcodeDetector' in window) {
      try { native = (await BarcodeDetector.getSupportedFormats()).includes('ean_13'); } catch { native = false; }
    }
    if (native) {
      const stream = await navigator.mediaDevices.getUserMedia(camConstraints);
      video.srcObject = stream;
      await video.play();
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      let busy = false;
      scanning = true;
      detTimer = setInterval(async () => {
        if (busy || video.readyState < 2) return;
        busy = true
  if (t === 'locs') renderLocs();
  if (t === 'settings') renderSettings();
  if (t === 'scan') { refreshLocSel(); updateBanner(); }
  window.scrollTo(0, 0);
}

/* ---------- イベント登録 ---------- */
function bind() {
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('#modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#locSel').addEventListener('change', (e) => { state.locId = Number(e.target.value); lsSet('loc', String(state.locId)); });
  $('#qtyMinus').addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); updateQty(); });
  $('#qtyPlus').addEventListener('click', () => { state.qty = Math.min(999, state.qty + 1); updateQty(); });
  $('#qty').addEventListener('click', async () => {
    const r = await dialog({ title: '数量', body: `<input data-k="n" type="number" inputmode="numeric" min="1" max="999" value="${state.qty}">`, buttons: [{ label: 'OK', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null }] });
    if (r.value === 'ok') { const n = Math.floor(Number(r.fields.n)); if (n >= 1 && n <= 999) { state.qty = n; updateQty(); } }
  });
  $('#camBtn').addEventListener('click', () => (scanning ? (stopCam(), setCamUI('カメラは停止中')) : startCam()));
  $('#manual').addEventListener('submit', (e) => {
    e.preventDefault();
    initAudio();
    const jan = normJan($('#manualJan').value);
    if (!jan) { toast('JANコードが正しくありません(8桁か13桁)', true); return; }
    $('#manualJan').value = '';
    handleJan(jan);
  });
  $('#last').addEventListener('click', (e) => { const b = e.target.closest('[data-undo]'); if (b) undoLast(Number(b.dataset.undo)); });
  $('#bkBanner').addEventListener('click', () => showTab('settings'));
  $('#v-locs').addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (b) locAction(b.dataset.act, Number(b.dataset.id)); });
  $('#v-locs').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#locName').value.trim();
    if (!name) return;
    await dbPut('locations', { name });
    await reload(); refreshLocSel(); renderLocs();
  });
  const sv = $('#v-settings');
  sv.addEventListener('click', (e) => { const b = e.target.closest('button[data-do]'); if (b) settingsDo(b.dataset.do); });
  sv.addEventListener('change', (e) => {
    if (e.target.id === 'importFile') { const f = e.target.files[0]; e.target.value = ''; if (f) importJSON(f); return; }
    const o = e.target.dataset.opt;
    if (o === 'allowNeg') lsSet('allowNeg', e.target.checked ? '1' : '0');
    if (o === 'sound') lsSet('sound', e.target.checked ? '1' : '0');
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCam(); });
}

/* ---------- 起動 ---------- */
async function init() {
  await openDB();
  await reload();
  if (!state.locs.length) { await dbPut('locations', { name: '倉庫1' }); await reload(); }
  bind();
  setMode(state.mode);
  refreshLocSel();
  updateQty();
  renderLog();
  showTab('scan');
  setCamUI('カメラは停止中');
  try { navigator.storage?.persist?.()?.catch(() => {}); } catch { /* ignore */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!('BarcodeDetector' in window)) loadZX().catch(() => {});
}
init().catch((e) => { document.body.innerHTML = `<p style="padding:20px">起動に失敗しました: ${esc(e.message || e)}</p>`; });
})();
