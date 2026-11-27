'use strict';
(() => {
const VINFO = self.STOCK_VERSION || { version: '?', date: '', notes: '' }; // stock-version.js で定義
const VERSION = VINFO.version;
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
let scanning = false, detTimer = null, wl = null, zxP = null;
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
const camConstraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };

// ZXing(iPhone用)の読み取り。
// ライブラリ付属の「映像から連続読み取り」(BrowserMultiFormatReader.decodeFromConstraints)は、
// フレームを1枚おきに白黒反転して読む仕組みと、TRY_HARDER の回転読み取りが干渉して、
// 横向きのバーコードが毎回「反転した画像」で読まれてしまい、ほぼ読めなくなる不具合がある。
// そのため映像の取り込みはアプリ側で行い、反転なしの画像をデコーダーに直接渡す。
function makeZxScanner() {
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let n = 0;
  return () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    // 偶数回: 画面中央(読み取り枠のあたり)を切り出して読む / 奇数回: 映像全体を読む
    const crop = n++ % 2 === 0;
    const sw = crop ? Math.round(vw * 0.9) : vw;
    const sh = crop ? Math.round(vh * 0.6) : vh;
    const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
    const k = Math.min(1, 1600 / Math.max(sw, sh)); // 大きすぎる映像は縮小して処理を軽くする
    const dw = Math.round(sw * k), dh = Math.round(sh * k);
    if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh; }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    try {
      const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)));
      return reader.decodeWithState(bmp).getText();
    } catch {
      return null; // 見つからない・読み取り失敗は次のフレームで再挑戦
    } finally {
      try { reader.reset(); } catch { /* ignore */ }
    }
  };
}
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
    let detect;
    if (native) {
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      detect = async () => { const r = await det.detect(video); return r.length ? r[0].rawValue : null; };
    } else {
      await loadZX();
      const zx = makeZxScanner();
      detect = async () => zx();
    }
    const stream = await navigator.mediaDevices.getUserMedia(camConstraints);
    video.srcObject = stream;
    await video.play();
    scanning = true;
    let busy = false;
    detTimer = setInterval(async () => {
      if (busy || !scanning || video.readyState < 2) return;
      busy = true;
      try { const code = await detect(); if (code && scanning) onCode(code); } catch { /* ignore */ }
      busy = false;
    }, native ? 200 : 120);
    try { wl = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
    setCamUI();
  } catch (e) {
    stopCam();
    const msg = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
      ? 'カメラが許可されていません。ブラウザ/端末の設定でカメラを許可してください'
      : (e && e.message) || 'カメラを起動できませんでした';
    setCamUI(msg);
    $('#camMsg').hidden = false;
  }
}
function stopCam() {
  clearInterval(detTimer); detTimer = null;
  try { video.srcObject?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  video.srcObject = null;
  try { wl?.release(); } catch { /* ignore */ }
  wl = null;
  const was = scanning;
  scanning = false;
  if (was || $('#camMsg').textContent) setCamUI('カメラは停止中');
  $('#camMsg').hidden = false;
}

/* ---------- スキャン画面 ---------- */
function setMode(m) {
  state.mode = m;
  lsSet('mode', m);
  document.body.dataset.mode = m;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#camTag').textContent = m === 'in' ? '入庫' : '出庫';
}
function updateQty() { $('#qty').textContent = state.qty; }
function refreshLocSel() {
  $('#locSel').innerHTML = state.locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  $('#locSel').value = String(state.locId);
}
function updateBanner() {
  const b = $('#bkBanner');
  if (!state.moves.length) { b.hidden = true; return; }
  const last = Number(lsGet('lastBackup')) || 0;
  const first = state.moves.reduce((a, m) => Math.min(a, m.ts), Infinity);
  const ref = last || first;
  b.hidden = Date.now() - ref < 7 * DAY;
  b.textContent = last
    ? `最後のバックアップから${Math.floor((Date.now() - last) / DAY)}日たっています。タップして書き出し`
    : 'まだバックアップがありません。タップして書き出し';
}

/* ---------- 在庫画面 ---------- */
function renderStock() {
  const v = $('#v-stock');
  if (!v.dataset.built) {
    v.dataset.built = '1';
    v.innerHTML = `<h2>在庫</h2><input id="sq" type="search" placeholder="商品名・JANで検索"><div class="row"><select id="sloc"></select><label class="chk"><input type="checkbox" id="szero">在庫0も表示</label></div><div id="ssum" class="muted sm"></div><ul id="slist" class="list"></ul>`;
    $('#sq').addEventListener('input', (e) => { state.q = e.target.value; refreshStock(); });
    $('#sloc').addEventListener('change', (e) => { state.stockLoc = e.target.value; refreshStock(); });
    $('#szero').addEventListener('change', (e) => { state.showZero = e.target.checked; refreshStock(); });
    $('#slist').addEventListener('click', (e) => { const li = e.target.closest('[data-jan]'); if (li) showItem(li.dataset.jan); });
  }
  $('#sloc').innerHTML = '<option value="all">すべての倉庫</option>' + state.locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  if (state.stockLoc !== 'all' && !state.locs.some((l) => String(l.id) === state.stockLoc)) state.stockLoc = 'all';
  $('#sloc').value = state.stockLoc;
  refreshStock();
}
function refreshStock() {
  const q = state.q.trim().toLowerCase();
  const lf = state.stockLoc;
  const rows = [];
  for (const it of state.items.values()) {
    if (q && !(it.name.toLowerCase().includes(q) || it.jan.includes(q) || (it.memo || '').toLowerCase().includes(q))) continue;
    const st = stockOf(it.jan);
    const n = lf === 'all' ? totalOf(it.jan) : (st.get(Number(lf)) || 0);
    if (n === 0 && !state.showZero) continue;
    rows.push({ it, n, st });
  }
  rows.sort((a, b) => (state.lastTs.get(b.it.jan) || 0) - (state.lastTs.get(a.it.jan) || 0));
  const kinds = rows.filter((r) => r.n > 0).length;
  const sum = rows.reduce((a, r) => a + r.n, 0);
  $('#ssum').textContent = `${kinds}商品 / 合計 ${sum}点`;
  const LIMIT = 500;
  $('#slist').innerHTML = rows.slice(0, LIMIT).map(({ it, n, st }) => {
    const chips = lf === 'all'
      ? [...st].filter(([, q2]) => q2 !== 0).map(([l, q2]) => `<span class="chip">${esc(locName(l))} ${q2}</span>`).join('')
      : '';
    return `<li class="item" data-jan="${esc(it.jan)}"><div class="grow"><div class="nm">${esc(it.name)}</div><div class="muted sm">JAN ${esc(it.jan)}${it.memo ? ' ・ ' + esc(it.memo) : ''}</div>${chips ? `<div class="chips">${chips}</div>` : ''}</div><div class="qty ${n < 0 ? 'neg' : ''}">${n}</div></li>`;
  }).join('') + (rows.length > LIMIT ? `<li class="muted">${LIMIT}件まで表示しています。検索で絞り込んでください</li>` : '')
    || '<li class="muted">該当する商品がありません</li>';
}
async function showItem(jan) {
  const it = state.items.get(jan);
  if (!it) return;
  const st = [...stockOf(jan)].filter(([, q]) => q !== 0);
  const hist = state.moves.filter((m) => m.jan === jan).sort((a, b) => b.ts - a.ts).slice(0, 50);
  const body = `<label>商品名<input data-k="name" value="${esc(it.name)}"></label>
    <label>メモ<input data-k="memo" value="${esc(it.memo || '')}"></label>
    <div class="muted sm">JAN ${esc(jan)}</div>
    <div class="chips">${st.map(([l, q]) => `<span class="chip">${esc(locName(l))} ${q}</span>`).join('') || '<span class="muted">在庫なし</span>'}</div>
    <h4>履歴(新しい順・最大50件)</h4>
    <ul class="hist">${hist.map((m) => `<li><span class="${m.type === 'in' ? 'tag-in' : 'tag-out'}">${m.type === 'in' ? '入庫' : '出庫'}</span><span>${fmt(m.ts)} ${esc(locName(m.loc))} ×${m.qty}</span><button type="button" data-act="delmove" data-id="${m.id}">削除</button></li>`).join('') || '<li class="muted">履歴なし</li>'}</ul>`;
  const r = await dialog({
    title: '商品の詳細',
    body,
    buttons: [{ label: '保存', value: 'save', cls: 'primary' }, { label: '閉じる', value: null }, { label: '商品を削除', value: 'del', cls: 'danger' }],
    onAct: (el, close) => { if (el.dataset.act === 'delmove') close({ value: 'delmove', id: Number(el.dataset.id), fields: {} }); },
  });
  if (r.value === 'save') {
    it.name = r.fields.name || it.name;
    it.memo = r.fields.memo || '';
    await dbPut('items', it);
    await reload();
    renderStock();
    toast('保存しました');
  } else if (r.value === 'delmove') {
    if (await confirmDlg('履歴を削除', 'この入出庫履歴を削除します。在庫数が変わります。', '削除')) {
      await dbDel('moves', r.id);
      await reload();
      renderStock();
      toast('削除しました');
    }
    showItem(jan);
  } else if (r.value === 'del') {
    if (await confirmDlg('商品を削除', `「${esc(it.name)}」と、その入出庫履歴をすべて削除します。`, '削除')) {
      await dbDelMany('moves', state.moves.filter((m) => m.jan === jan).map((m) => m.id));
      await dbDel('items', jan);
      await reload();
      renderStock();
      toast('削除しました');
    }
  }
}

/* ---------- 倉庫画面 ---------- */
function renderLocs() {
  const tot = new Map();
  for (const s of state.stock.values()) for (const [l, q] of s) tot.set(l, (tot.get(l) || 0) + q);
  $('#v-locs').innerHTML = `<h2>倉庫</h2><ul class="list">${state.locs.map((l) => `<li><div class="grow"><div class="nm">${esc(l.name)}</div><div class="muted sm">在庫 ${tot.get(l.id) || 0}点</div></div><button type="button" data-act="rename" data-id="${l.id}">名前変更</button><button type="button" class="danger" data-act="del" data-id="${l.id}">削除</button></li>`).join('')}</ul>
    <form id="locForm" class="row"><input id="locName" placeholder="新しい倉庫名" maxlength="30" autocomplete="off"><button type="submit" class="primary">追加</button></form>
    <p class="muted sm">履歴のある倉庫は削除できません(名前変更をご利用ください)。</p>`;
}
async function locAction(act, id) {
  const l = state.locs.find((x) => x.id === id);
  if (!l) return;
  if (act === 'rename') {
    const r = await dialog({ title: '倉庫名の変更', body: `<label>倉庫名<input data-k="name" value="${esc(l.name)}" maxlength="30"></label>`, buttons: [{ label: '保存', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null }] });
    if (r.value === 'ok' && r.fields.name) { l.name = r.fields.name; await dbPut('locations', l); await reload(); refreshLocSel(); renderLocs(); }
  } else {
    if (state.locs.length <= 1) { toast('最後の倉庫は削除できません', true); return; }
    if (state.moves.some((m) => m.loc === id)) { toast('履歴があるため削除できません', true); return; }
    if (await confirmDlg('倉庫を削除', `「${esc(l.name)}」を削除します。`, '削除')) { await dbDel('locations', id); await reload(); refreshLocSel(); renderLocs(); }
  }
}

/* ---------- 設定・バックアップ ---------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (state.tab === 'settings') renderSettings(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function buildBackup() {
  return JSON.stringify({ app: 'sedori-stock', version: 1, exportedAt: new Date().toISOString(), items: [...state.items.values()], locations: state.locs, moves: state.moves });
}
const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
function buildMovesCsv() {
  const rows = [['日時', '種別', 'JAN', '商品名', '倉庫', '数量']];
  [...state.moves].sort((a, b) => a.ts - b.ts).forEach((m) => rows.push([fmt(m.ts), m.type === 'in' ? '入庫' : '出庫', m.jan, state.items.get(m.jan)?.name, locName(m.loc), m.qty]));
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
function buildStockCsv() {
  const rows = [['JAN', '商品名', '倉庫', '在庫数']];
  for (const it of state.items.values()) for (const [l, q] of stockOf(it.jan)) if (q !== 0) rows.push([it.jan, it.name, locName(l), q]);
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
async function saveFile(name, mime, text) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`; };
async function importJSON(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch { toast('ファイルを読めません', true); return; }
  if (d?.app !== 'sedori-stock' || !Array.isArray(d.items) || !Array.isArray(d.locations) || !Array.isArray(d.moves)) { toast('このアプリのバックアップではありません', true); return; }
  if (!(await confirmDlg('バックアップを読み込む', `現在のデータをすべて置き換えます。(商品${d.items.length}件・履歴${d.moves.length}件)`, '置き換える'))) return;
  if (!d.locations.length) d.locations.push({ id: 1, name: '倉庫1' });
  await dbReplaceAll(d);
  await reload();
  refreshLocSel(); renderSettings(); updateBanner();
  state.log = []; renderLog(); $('#last').hidden = true;
  toast('読み込みました');
}
function renderSettings() {
  const v = $('#v-settings');
  const last = Number(lsGet('lastBackup')) || 0;
  const guide = isStandalone() ? 'ホーム画面から起動中です。' : (installEvt ? '' : 'iPhone: 共有ボタン →「ホーム画面に追加」 / Android: ブラウザのメニュー →「アプリをインストール」');
  v.innerHTML = `<h2>設定</h2>
    <div class="set"><h4>バックアップ</h4>
      <div class="muted sm">最終: ${last ? fmt(last) : 'なし'} ・ データはこの端末内にのみ保存されます</div>
      <button type="button" data-do="export-json" class="primary">JSONで書き出し</button>
      <button type="button" data-do="import-json">JSONを読み込み</button>
      <button type="button" data-do="export-moves">履歴CSV</button>
      <button type="button" data-do="export-stock">在庫CSV</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>
    <div class="set"><h4>動作</h4>
      <label class="chk"><input type="checkbox" data-opt="allowNeg" ${lsGet('allowNeg') === '1' ? 'checked' : ''}>在庫0でも出庫を許可する(マイナス在庫)</label>
      <label class="chk"><input type="checkbox" data-opt="sound" ${lsGet('sound') !== '0' ? 'checked' : ''}>読み取り音を鳴らす</label>
    </div>
    <div class="set"><h4>アプリ</h4>
      ${installEvt ? '<button type="button" data-do="install" class="primary">アプリをインストール</button>' : ''}
      ${guide ? `<div class="muted sm">${esc(guide)}</div>` : ''}
      <div class="muted sm">データ保護: <span id="persistState">確認中…</span></div>
    </div>
    <div class="set" id="verBox"><h4>バージョン</h4>
      <div>使用中: <b>v${esc(VERSION)}</b> <span class="muted sm">${esc(VINFO.date)}</span></div>
      ${VINFO.notes ? `<div class="muted sm">${esc(VINFO.notes)}</div>` : ''}
      <div class="muted sm" id="verState">確認中…</div>
      <div id="verRemote" class="sm" hidden></div>
      <button type="button" data-do="ver-check" class="primary">最新バージョンを確認</button>
      <span id="verBtns"></span>
      <div class="muted sm">アプリが開けなくなったときは、アドレスの最後に <code>?rollback</code>(前の版)/ <code>?latest</code>(最新版)を付けて開くと切り替わります。</div>
    </div>
    <div class="set"><button type="button" class="danger" data-do="wipe">全データを削除</button></div>`;
  refreshVerState();
  navigator.storage?.persisted?.().then((p) => { const e = $('#persistState'); if (e) e.textContent = p ? '保護されています' : '未保護(定期的にバックアップしてください)'; }).catch(() => {});
}
async function settingsDo(act) {
  if (act === 'export-json') { if (await saveFile(`sedori-stock-${stamp()}.json`, 'application/json', buildBackup())) { lsSet('lastBackup', String(Date.now())); renderSettings(); updateBanner(); } }
  else if (act === 'export-moves') await saveFile(`moves-${stamp()}.csv`, 'text/csv', buildMovesCsv());
  else if (act === 'export-stock') await saveFile(`stock-${stamp()}.csv`, 'text/csv', buildStockCsv());
  else if (act === 'import-json') $('#importFile').click();
  else if (act === 'ver-check') await checkLatest();
  else if (act === 'ver-update') await applyUpdate();
  else if (act === 'ver-rollback') await rollback();
  else if (act === 'ver-latest') await backToLatest();
  else if (act === 'install' && installEvt) { installEvt.prompt(); installEvt = null; renderSettings(); }
  else if (act === 'wipe') {
    if (await confirmDlg('全データを削除', '商品・倉庫・履歴をすべて削除します。元に戻せません。先にバックアップを書き出してください。', '削除する')) {
      await dbReplaceAll({ items: [], locations: [{ id: 1, name: '倉庫1' }], moves: [] });
      await reload(); refreshLocSel(); state.log = []; renderLog(); $('#last').hidden = true; renderSettings(); updateBanner();
      toast('削除しました');
    }
  }
}

/* ---------- バージョン管理 ---------- */
// Service Worker(stock-sw.js)に問い合わせる。返事: { installed, previous, pinned }
function swMsg(type) {
  return new Promise((res) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) { res(null); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => res(null), 3000);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data); };
    sw.postMessage({ type }, [ch.port2]);
  });
}
const swReg = () => navigator.serviceWorker?.getRegistration('./stock.html') ?? Promise.resolve(null);
async function refreshVerState() {
  const st = $('#verState'), btns = $('#verBtns');
  if (!st) return;
  const i = await swMsg('info');
  if (!$('#verState')) return;
  if (!i || i.error) {
    st.textContent = 'オフライン用の保存がまだありません(一度オンラインで開き直すと準備されます)';
    btns.innerHTML = '';
    return;
  }
  const lines = [];
  if (i.pinned) lines.push(`前のバージョン v${i.pinned} で固定中です(最新は v${i.installed})`);
  else lines.push(i.installed !== VERSION ? `端末には v${i.installed} が入っています。アプリを開き直すと切り替わります` : 'この端末に保存済み(オフラインでも起動できます)');
  if (!i.pinned) lines.push(i.previous ? `戻せる前のバージョン: v${i.previous}` : '戻せる前のバージョン: まだありません(次の更新から使えます)');
  st.innerHTML = lines.map(esc).join('<br>');
  btns.innerHTML = i.pinned
    ? '<button type="button" data-do="ver-latest" class="primary">最新バージョンに戻す</button>'
    : (i.previous ? `<button type="button" data-do="ver-rollback">前のバージョン(v${esc(i.previous)})に戻す</button>` : '');
}
async function fetchLatestInfo() {
  const r = await fetch(`stock-version.js?nocache=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const m = (await r.text()).match(/STOCK_VERSION\s*=\s*(\{[\s\S]*\})/);
  return JSON.parse(m[1]);
}
const verNum = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
const verCmp = (a, b) => { const x = verNum(a), y = verNum(b); for (let k = 0; k < Math.max(x.length, y.length); k++) { const d = (x[k] || 0) - (y[k] || 0); if (d) return d; } return 0; };
async function checkLatest() {
  const box = $('#verRemote');
  box.hidden = false;
  box.textContent = '確認中…';
  let info;
  try { info = await fetchLatestInfo(); } catch { box.textContent = 'サーバーに接続できませんでした(オフラインかもしれません)'; return; }
  const i = await swMsg('info');
  if (verCmp(info.version, VERSION) > 0) {
    box.innerHTML = `<b>新しいバージョン v${esc(info.version)} があります</b>(${esc(info.date || '')})<br><span class="muted">${esc(info.notes || '')}</span><br><button type="button" data-do="ver-update" class="primary">更新する</button>`;
  } else if (i?.pinned) {
    box.innerHTML = `最新は v${esc(info.version)} です。いまは前のバージョンで固定中です。`;
  } else {
    box.textContent = `最新バージョン(v${info.version})を使っています`;
  }
}
async function applyUpdate() {
  const box = $('#verRemote');
  box.textContent = '更新しています…';
  stopCam();
  try {
    await swMsg('unpin');
    const reg = await swReg();
    if (!reg) { location.reload(); return; }
    await reg.update();
    const sw = reg.installing || reg.waiting;
    if (sw) {
      await new Promise((res, rej) => {
        if (sw.state === 'activated') { res(); return; }
        sw.addEventListener('statechange', () => { if (sw.state === 'activated') res(); if (sw.state === 'redundant') rej(new Error('更新に失敗しました')); });
      });
      location.reload();
      return;
    }
    const i = await swMsg('info');
    const latest = await fetchLatestInfo().catch(() => null);
    if (i && latest && verCmp(i.installed, latest.version) >= 0) { location.reload(); return; }
    box.textContent = 'サーバー側の反映待ちのようです。数分おいてからもう一度お試しください';
  } catch (e) {
    box.textContent = '更新できませんでした: ' + (e.message || e);
  }
}
async function rollback() {
  const i = await swMsg('info');
  if (!i?.previous) { toast('戻せる前のバージョンがありません', true); return; }
  if (!(await confirmDlg('前のバージョンに戻す', `v${esc(i.previous)} に戻します。商品・倉庫・履歴のデータはそのまま残ります。あとから「最新バージョンに戻す」で元に戻せます。`, '戻す', false))) return;
  stopCam();
  const r = await swMsg('pin-previous');
  if (!r?.pinned) { toast('切り替えできませんでした', true); return; }
  location.reload();
}
async function backToLatest() {
  stopCam();
  await swMsg('unpin');
  location.reload();
}

/* ---------- タブ ---------- */
function showTab(t) {
  state.tab = t;
  if (t !== 'scan') stopCam();
  ['scan', 'stock', 'locs', 'settings'].forEach((n) => { $('#v-' + n).hidden = n !== t; });
  $$('#tabs button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === t)));
  if (t === 'stock') renderStock();
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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('stock-sw.js', { scope: './stock.html', updateViaCache: 'none' }).catch(() => {});
  if (!('BarcodeDetector' in window)) loadZX().catch(() => {});
}
init().catch((e) => { document.body.innerHTML = `<p style="padding:20px">起動に失敗しました: ${esc(e.message || e)}</p>`; });
})();
