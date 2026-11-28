'use strict';
(() => {
const VINFO = self.STOCK_VERSION || { version: '?', notes: '' }; // stock-version.js で定義
const VERSION = VINFO.version;
// バージョンは日付(例: 2026.11.27 / 同じ日の2回目は 2026.11.27.2)。表示は「2026-11-27」「2026-11-27 (2)」
const verLabel = (v) => { const a = String(v || '?').split('.'); return a.length >= 3 ? `${a[0]}-${a[1].padStart(2, '0')}-${a[2].padStart(2, '0')}${a[3] ? ` (${a[3]})` : ''}` : 'v' + v; };
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
function dialog({ title, body = '', buttons, onAct, noFocus = false }) {
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
    if (first && !noFocus) setTimeout(() => first.focus(), 60);
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
  return m;
}
function showLast(m) {
  const it = state.items.get(m.jan);
  const box = $('#last');
  box.hidden = false;
  box.className = 'card ' + m.type;
  box.innerHTML = `<div class="l1"><b>${m.type === 'in' ? '入庫' : '出庫'}</b> ${esc(it?.name)} <span>×${m.qty}</span></div>
    <div class="l2">${esc(locName(m.loc))}の在庫 ${stockOf(m.jan).get(m.loc) || 0} / 全体 ${totalOf(m.jan)}</div>
    ${moveDetailText(m) ? `<div class="l2">${esc(moveDetailText(m))}</div>` : ''}
    <div id="kxLine" class="kxline" data-jan="${esc(m.jan)}" hidden></div>
    <button type="button" data-undo="${m.id}">取り消し</button> <button type="button" data-edit="${m.id}">詳細を入力</button> <button type="button" data-shop="${esc(m.jan)}">店のサイトで検索</button>`;
  kxAttach(m.jan);
}
function renderLog() {
  $('#log').innerHTML = state.log.map((l) => {
    const it = state.items.get(l.jan);
    return `<li class="${l.undone ? 'undone' : ''}" data-jan="${esc(l.jan)}"><span class="${l.type === 'in' ? 'tag-in' : 'tag-out'}">${l.type === 'in' ? '入庫' : '出庫'}</span><div class="grow"><div class="nm">${esc(it?.name || l.jan)}</div><div class="muted sm">${esc(locName(l.loc))} ・ ${fmt(l.ts)}</div></div><div class="qty">×${l.qty}</div></li>`;
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
// カメラ表示の大きさ: 自動なら画面の高さで決める(iPhone SE など低い画面は小さく)
function applyCamSize() {
  const v = lsGet('camSize') || 'auto';
  document.body.dataset.cam = v !== 'auto' ? v : (innerHeight <= 720 ? 's' : innerHeight <= 860 ? 'm' : 'l');
}

/* ---------- 入出庫の詳細(任意): 日付・商品名・購入価格・ポイント・その時の買取価格 ---------- */
const detailOn = () => lsGet('detail') === '1';
const dateOf = (ts) => fmt(ts).slice(0, 10);
const numOrNull = (v) => { const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : null; };
function moveFieldsHtml(m) {
  const it = state.items.get(m.jan);
  const isIn = m.type === 'in';
  const kxMax = it?.kx && !it.kx.notFound ? it.kx.max_price : 0;
  const num = (k, label, ph = '') => `<label>${label}<input data-k="${k}" inputmode="numeric" placeholder="${esc(ph)}" value="${m[k] ?? ''}" autocomplete="off"></label>`;
  return `<div class="mvf">
    <label class="full">${isIn ? '入庫日' : '出庫日'}<input data-k="date" type="date" value="${esc(m.date || dateOf(m.ts))}"></label>
    <label class="full">商品名<input data-k="name" value="${esc(it?.name || '')}" autocomplete="off"></label>
    ${isIn ? num('cost', '購入価格(円)') + num('point', 'ポイント') : ''}
    ${num('bp', isIn ? '入庫時の買取価格(円)' : '出庫時の買取価格(円)', kxMax ? `買取X ${yen(kxMax)}` : '')}
  </div>`;
}
// 入力された詳細をその入出庫履歴に保存(空欄は未入力として消す)
async function saveMoveFields(id, f) {
  const m = state.moves.find((x) => x.id === id);
  if (!m) return;
  if (f.date && f.date !== dateOf(m.ts)) m.date = f.date; else delete m.date;
  for (const k of ['cost', 'point', 'bp']) {
    if (!(k in f)) continue;
    const n = numOrNull(f[k]);
    if (n === null) delete m[k]; else m[k] = n;
  }
  await dbPut('moves', m);
  const it = state.items.get(m.jan);
  if (it && f.name && f.name !== it.name) { it.name = f.name; await dbPut('items', it); }
  await reload();
  if (state.lastMoveId === id && !$('#last').hidden) showLast(state.moves.find((x) => x.id === id));
  renderLog();
}
function moveDetailText(m, withDate = true) {
  const a = [];
  if (m.date && withDate) a.push((m.type === 'in' ? '入庫日 ' : '出庫日 ') + m.date);
  if (m.cost != null) a.push('購入' + yen(m.cost));
  if (m.point != null) a.push('P' + m.point.toLocaleString('ja-JP'));
  if (m.bp != null) a.push('買取' + yen(m.bp));
  return a.join(' ・ ');
}
async function editMoveDialog(id) {
  const m = state.moves.find((x) => x.id === id);
  if (!m) { toast('この履歴は見つかりません', true); return; }
  const prev = locked;
  locked = true;
  try {
    const it = state.items.get(m.jan);
    const r = await dialog({
      title: `${m.type === 'in' ? '入庫' : '出庫'}の詳細`,
      body: `<div class="muted sm">${esc(it?.name || m.jan)} ・ JAN ${esc(m.jan)} ・ ${esc(locName(m.loc))} ×${m.qty}</div>${moveFieldsHtml(m)}`,
      buttons: [{ label: '保存', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null }],
    });
    if (r.value === 'ok') { await saveMoveFields(id, r.fields); toast('保存しました'); }
  } finally { locked = prev; }
}

// カメラで1つ読んだら確認画面を出して止める(設定でオフにできる)
const scanStopOn = () => lsGet('scanStop') !== '0';
async function scanResultPopup(m, errMsg) {
  if (m) {
    const it = state.items.get(m.jan);
    const r = await dialog({
      title: '読み取りOK',
      noFocus: true,
      body: `<div class="okpop ${m.type} ${detailOn() ? 'compact' : ''}"><div class="mark">✓</div>
        <div class="what">${m.type === 'in' ? '入庫' : '出庫'} ×${m.qty}</div>
        <div class="nm">${esc(it?.name || m.jan)}</div>
        <div class="muted sm">JAN ${esc(m.jan)}</div>
        <div class="muted sm">${esc(locName(m.loc))}の在庫 ${stockOf(m.jan).get(m.loc) || 0} / 全体 ${totalOf(m.jan)}</div>
        ${detailOn() ? moveFieldsHtml(m) : ''}</div>`,
      buttons: [{ label: detailOn() ? '保存して次へ' : 'OK(次を読む)', value: 'ok', cls: 'primary' }, { label: '取り消し', value: 'undo' }],
    });
    if (r.value === 'undo') await undoLast(m.id);
    else if (detailOn()) await saveMoveFields(m.id, r.fields);
    $('#last').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  } else {
    await dialog({
      title: '記録できませんでした',
      body: `<div class="okpop err"><div class="mark">!</div><div class="nm">${esc(errMsg)}</div></div>`,
      buttons: [{ label: 'OK(次を読む)', value: 'ok', cls: 'primary' }],
    });
  }
}
async function handleJan(jan, fromCam = false) {
  if (locked) return;
  locked = true;
  const popup = (fromCam && scanStopOn()) || detailOn(); // 詳細入力がオンなら手入力のときも出す
  let done = null, errMsg = '';
  const fail = (msg) => { beep('err'); if (popup) errMsg = msg; else toast(msg, true); };
  try {
    let it = state.items.get(jan);
    if (state.mode === 'in') {
      if (!it) {
        let kx = null;
        if (kxOn()) { toast('買取Xで商品名を検索中…'); kx = await kxGet(jan, { timeout: 6000 }).catch(() => null); $('#toast').classList.remove('show'); }
        const r = await dialog({
          title: '新しい商品',
          body: `<div class="muted">JAN ${esc(jan)}</div><label>商品名<input data-k="name" placeholder="商品名(空でも可)" autocomplete="off" value="${esc(kx?.name || '')}"></label>` +
            (kx ? `<div class="muted sm">${kx.name ? '商品名は買取Xから取得しました。' : ''}${kx.max_price ? `買取最高 ${yen(kx.max_price)}` : ''}</div>` : ''),
          buttons: [{ label: '登録して入庫', value: 'ok', cls: 'primary' }, { label: 'キャンセル', value: null }],
        });
        if (r.value !== 'ok') return;
        it = { jan, name: r.fields.name || `JAN ${jan}`, memo: '', created: Date.now() };
        if (kx) it.kx = kx;
        await dbPut('items', it);
        await reload();
      }
      done = await record('in', jan, state.locId, state.qty);
    } else {
      if (!it) { fail(`未登録のJANです(${jan})`); return; }
      const st = stockOf(jan);
      const need = state.qty;
      const here = st.get(state.locId) || 0;
      if (here >= need) { done = await record('out', jan, state.locId, need); return; }
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
        done = await record('out', jan, r.loc, need);
        return;
      }
      if (lsGet('allowNeg') === '1') { done = await record('out', jan, state.locId, need); return; }
      const max = Math.max(0, ...st.values());
      fail(max > 0 ? `在庫不足です(${it.name}: 最大${max})` : `${it.name} は在庫がありません`);
    }
  } catch (e) {
    console.error(e);
    fail('エラー: ' + (e.message || e));
  } finally {
    // 確認画面を閉じるまでは次を読まない(locked のまま)
    if (popup && (done || errMsg)) { try { await scanResultPopup(done, errMsg); } catch { /* ignore */ } }
    locked = false;
    lastSeen = Date.now();
  }
}
/* ---------- 各買取店のサイトでJAN検索(リンクを開くだけ。自動取得はしない) ---------- */
// 各店の検索ページにJANを入れて開く。価格は自分の目で確認する。URLの形は買取Xの商品ページのリンクを参考にした
const SHOP_SEARCH = [
  ['買取X(価格比較)', 'https://kaitorix.app/dp/{JAN}'],
  ['kaitori-search.app(価格比較)', 'https://kaitori-search.app/product/{JAN}'],
  ['kaitori.app(価格比較)', 'https://kaitori.app/item/{JAN}'],
  ['家電市場', 'https://www.kaden-ichiba.com/item/search/{JAN}'],
  ['携帯空間', 'https://www.keitaispace.co.jp/product/?kw={JAN}#list'],
  ['買取楽園', 'https://www.keitairakuen.com/?swp_form%5Bform_id%5D=1&s={JAN}'],
  ['森森買取', 'https://www.morimori-kaitori.jp/search?sk={JAN}'],
  ['買取商店', 'https://www.kaitorishouten-co.jp/products/list?name={JAN}'],
  ['買取wiki', 'https://gamekaitori.jp/search?type=&q={JAN}'],
  ['買取ルデヤ', 'https://kaitori-rudeya.com/search/index/{JAN}/'],
  ['PANDA買取', 'https://panda-kaitori.co.jp/?cpro=&s={JAN}'],
  ['買取エノキング', 'https://newenoking-kaitori.com/products?q={JAN}'],
];
async function shopSearchDialog(jan) {
  const it = state.items.get(jan);
  const body = `<div class="muted sm">JAN ${esc(jan)} を各店のサイトで検索します(ブラウザで開きます)</div>
    <ul class="shoplist">${SHOP_SEARCH.map(([n, u]) => `<li><a href="${esc(u.replace('{JAN}', encodeURIComponent(jan)))}" target="_blank" rel="noopener">${esc(n)}</a></li>`).join('')}</ul>`;
  const prev = locked;
  locked = true;
  try { await dialog({ title: it?.name || '店のサイトで検索', body, buttons: [{ label: '閉じる', value: null }] }); } finally { locked = prev; }
}

/* ---------- 買取X API(任意。設定でAPIキーを入れたときだけ動く) ---------- */
// ドキュメント: https://kaitorix.app/open/docs  無料プランは 1日30回・1秒1回まで
const KX_API = 'https://kaitorix.app/open/api/';
const KX_TTL = 6 * 3600e3; // 同じJANは6時間は保存した結果を使う(回数節約)
const kxKey = () => (lsGet('kxKey') || '').trim();
const kxOn = () => !!kxKey() && lsGet('kxOn') !== '0';
const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kxMem = new Map();
let kxQueue = Promise.resolve(), kxLastAt = 0;
function kxFetch(path) {
  const once = async () => {
    const w = kxLastAt + 1100 - Date.now();
    if (w > 0) await sleep(w);
    kxLastAt = Date.now();
    return fetch(KX_API + path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(kxKey()), { cache: 'no-store' });
  };
  const run = async () => {
    let r;
    try { r = await once(); if (r.status === 429) { await sleep(1100); r = await once(); } } // 1秒制限なら1回だけ待って再試行
    catch { throw new Error('買取Xに接続できませんでした(オフライン、またはブラウザからの直接呼び出しが許可されていない可能性があります)'); }
    if (r.status === 401) throw new Error('APIキーが正しくありません(設定画面で確認してください)');
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error('買取Xの本日の利用回数の上限に達しました(0時にリセット)');
    if (!r.ok) throw new Error(`買取Xのエラー(HTTP ${r.status})`);
    return r.json();
  };
  const p = kxQueue.then(run, run);
  kxQueue = p.catch(() => {});
  return p;
}
// JANの商品名・買取価格。{ name, max_price, prices[], fetchedAt } / 見つからなければ { notFound: true, fetchedAt }
async function kxGet(jan, { force = false, timeout = 0 } = {}) {
  const it = state.items.get(jan);
  const cached = it?.kx || kxMem.get(jan);
  if (!force && cached && Date.now() - cached.fetchedAt < KX_TTL) return cached;
  const job = (async () => {
    const d = await kxFetch('product/' + encodeURIComponent(jan));
    const v = d ? { name: d.name || '', max_price: d.max_price || 0, prices: Array.isArray(d.prices) ? d.prices : [], fetchedAt: Date.now() } : { notFound: true, fetchedAt: Date.now() };
    kxMem.set(jan, v);
    const cur = state.items.get(jan);
    if (cur) { cur.kx = v; await dbPut('items', cur); }
    return v;
  })();
  if (!timeout) return job;
  return Promise.race([job, sleep(timeout).then(() => { throw new Error('timeout'); })]);
}
function kxSummary(v) {
  if (v.notFound) return '買取X: この商品の買取価格は見つかりませんでした';
  const live = v.prices.filter((x) => !x.stopped && x.price > 0).sort((a, b) => b.price - a.price);
  const top = live[0];
  return top ? `買取最高 <b>${yen(top.price)}</b>(${esc(top.store)})・${live.length}店` : '買取X: 買取中の店舗がありません';
}
async function kxAttach(jan) {
  if (!kxOn()) return;
  const line = () => { const el = $('#kxLine'); return el && el.dataset.jan === jan ? el : null; };
  if (!line()) return;
  line().hidden = false;
  line().innerHTML = '<span class="muted sm">買取価格を取得中…</span>';
  try {
    const v = await kxGet(jan);
    const el = line();
    if (!el) return; // 別の商品を読んだ後なら表示しない
    el.innerHTML = `<span class="sm">${kxSummary(v)}</span>` + (v.notFound ? '' : ` <button type="button" data-kx="${esc(jan)}">買取価格一覧</button>`);
  } catch (e) {
    const el = line();
    if (el) el.innerHTML = `<span class="muted sm">${esc(e.message || e)}</span>`;
  }
}
async function kxDialog(jan, force = false) {
  if (!kxOn()) { toast('設定画面で買取XのAPIキーを入れると買取価格を見られます'); return; }
  if (locked) return;
  locked = true; // 一覧を開いている間はスキャン結果で画面が切り替わらないようにする
  try {
    let v;
    try { v = await kxGet(jan, { force }); } catch (e) { toast(e.message || String(e), true); return; }
    const it = state.items.get(jan);
    const rows = (v.prices || []).slice().sort((a, b) => (b.stopped ? -1 : b.price) - (a.stopped ? -1 : a.price));
    const when = (x) => (x.updated_at ? fmt(Date.parse(x.updated_at)) : (x.updated || ''));
    const body = `<div class="muted sm">JAN ${esc(jan)}${v.name && v.name !== it?.name ? `<br>買取Xの商品名: ${esc(v.name)}` : ''}</div>` +
      (v.notFound ? '<p>買取Xにこの商品のデータがありませんでした。</p>'
        : `<ul class="kxlist">${rows.map((x) => `<li class="${x.stopped ? 'stop' : ''}"><a href="${esc(x.url || '#')}" target="_blank" rel="noopener"><span class="st">${esc(x.store)}</span><span class="pr">${x.stopped ? '停止中' : yen(x.price)}</span></a><div class="muted sm">${esc(when(x))}${x.stale ? ' ・3日以上前' : ''}${x.walkin_bonus ? ` ・店頭+${yen(x.walkin_bonus)}` : ''}${x.mark_note ? ' ・' + esc(x.mark_note) : ''}</div></li>`).join('') || '<li class="muted">価格データがありません</li>'}</ul>`) +
      `<div class="muted sm">取得: ${fmt(v.fetchedAt)} ・ データ提供: <a href="https://kaitorix.app/" target="_blank" rel="noopener">買取X</a></div>`;
    const r = await dialog({ title: it?.name || v.name || '買取価格', body, buttons: [{ label: '閉じる', value: null }, { label: '最新の価格を取得', value: 'refresh' }, { label: '店のサイトで検索', value: 'shop' }] });
    if (r.value === 'refresh') { locked = false; await kxDialog(jan, true); }
    if (r.value === 'shop') { locked = false; await shopSearchDialog(jan); }
  } finally {
    locked = false;
  }
}
async function kxTest() {
  const out = $('#kxTest');
  out.hidden = false;
  out.textContent = '確認中…';
  try {
    const d = await kxFetch('usage');
    const rem = d && (d.remaining ?? d.today?.remaining ?? d.usage?.remaining);
    out.textContent = '接続できました' + (rem != null ? `(本日の残り ${rem} 回)` : '');
  } catch (e) {
    out.textContent = e.message || String(e);
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
  handleJan(jan, true);
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
function zxReaderNew() {
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  return reader;
}
function zxDecodeCanvas(reader, cv) {
  const Z = window.ZXing;
  try {
    return reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText();
  } catch {
    return null;
  } finally {
    try { reader.reset(); } catch { /* ignore */ }
  }
}

// 写真で読む: 端末のカメラで撮った静止画(高解像度・ピント合わせあり)から読む。動画で読めないときの予備
async function decodePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    if ('BarcodeDetector' in window) {
      try {
        const r = await new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] }).detect(img);
        if (r.length) return r[0].rawValue;
      } catch { /* ZXingで再挑戦 */ }
    }
    await loadZX();
    const reader = zxReaderNew();
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    // 大きさ・切り出し範囲を変えて何回か試す [長辺px, 切り出し割合]
    const tries = [[1600, 1], [1000, 1], [1600, 0.6], [2400, 1], [1200, 0.4]];
    for (const [max, part] of tries) {
      const sw = Math.round(W * part), sh = Math.round(H * part);
      const k = Math.min(1, max / Math.max(sw, sh));
      cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
      ctx.drawImage(img, Math.round((W - sw) / 2), Math.round((H - sh) / 2), sw, sh, 0, 0, cv.width, cv.height);
      const t = zxDecodeCanvas(reader, cv);
      if (t) return t;
      await sleep(0);
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeZxScanner() {
  const reader = zxReaderNew();
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
    return zxDecodeCanvas(reader, cv); // 見つからなければ null(次のフレームで再挑戦)
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
    <div class="kxline">${kxOn() ? `${it.kx && !it.kx.notFound ? `<span class="sm">${kxSummary(it.kx)}</span> ` : ''}<button type="button" data-act="kx">買取価格一覧</button>` : ''}<button type="button" data-act="shop">店のサイトで検索</button></div>
    <h4>履歴(新しい順・最大50件)</h4>
    <ul class="hist">${hist.map((m) => `<li><span class="${m.type === 'in' ? 'tag-in' : 'tag-out'}">${m.type === 'in' ? '入庫' : '出庫'}</span><span class="grow">${m.date ? esc(m.date) : fmt(m.ts)} ${esc(locName(m.loc))} ×${m.qty}${moveDetailText(m, false) ? `<span class="mvd">${esc(moveDetailText(m, false))}</span>` : ''}</span><button type="button" data-act="editmove" data-id="${m.id}">詳細</button><button type="button" data-act="delmove" data-id="${m.id}">削除</button></li>`).join('') || '<li class="muted">履歴なし</li>'}</ul>`;
  const r = await dialog({
    title: '商品の詳細',
    body,
    buttons: [{ label: '保存', value: 'save', cls: 'primary' }, { label: '閉じる', value: null }, { label: '商品を削除', value: 'del', cls: 'danger' }],
    onAct: (el, close) => {
      if (el.dataset.act === 'delmove') close({ value: 'delmove', id: Number(el.dataset.id), fields: {} });
      if (el.dataset.act === 'editmove') close({ value: 'editmove', id: Number(el.dataset.id), fields: {} });
      if (el.dataset.act === 'kx') close({ value: 'kx', fields: {} });
      if (el.dataset.act === 'shop') close({ value: 'shop', fields: {} });
    },
  });
  if (r.value === 'kx') { await kxDialog(jan); showItem(jan); return; }
  if (r.value === 'shop') { await shopSearchDialog(jan); showItem(jan); return; }
  if (r.value === 'editmove') { await editMoveDialog(r.id); renderStock(); showItem(jan); return; }
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
  return JSON.stringify({ app: 'sedori-stock', version: 1, exportedAt: new Date().toISOString(), items: [...state.items.values()].map(({ kx, ...rest }) => rest), locations: state.locs, moves: state.moves });
}
const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
function buildMovesCsv() {
  const rows = [['記録日時', '入出庫日', '種別', 'JAN', '商品名', '倉庫', '数量', '購入価格', 'ポイント', '買取価格']];
  [...state.moves].sort((a, b) => a.ts - b.ts).forEach((m) => rows.push([fmt(m.ts), m.date || dateOf(m.ts), m.type === 'in' ? '入庫' : '出庫', m.jan, state.items.get(m.jan)?.name, locName(m.loc), m.qty, m.cost ?? '', m.point ?? '', m.bp ?? '']));
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
      <label class="chk"><input type="checkbox" data-opt="detail" ${detailOn() ? 'checked' : ''}>入出庫のときに詳細(日付・商品名・購入価格・ポイント・買取価格)を入力する</label>
      <label>カメラ表示の大きさ<select data-opt="camSize">${[['auto', '自動(画面の高さに合わせる)'], ['s', '小'], ['m', '中'], ['l', '大']].map(([v, l]) => `<option value="${v}" ${(lsGet('camSize') || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="chk"><input type="checkbox" data-opt="scanStop" ${scanStopOn() ? 'checked' : ''}>カメラで1つ読んだら確認画面で止める(OKで次へ)</label>
      <label class="chk"><input type="checkbox" data-opt="sound" ${lsGet('sound') !== '0' ? 'checked' : ''}>読み取り音を鳴らす</label>
    </div>
    <div class="set"><h4>アプリ</h4>
      ${installEvt ? '<button type="button" data-do="install" class="primary">アプリをインストール</button>' : ''}
      ${guide ? `<div class="muted sm">${esc(guide)}</div>` : ''}
      <div class="muted sm">データ保護: <span id="persistState">確認中…</span></div>
    </div>
    <div class="set"><h4>買取価格(買取X・任意)</h4>
      <div class="muted sm"><a href="https://kaitorix.app/open/" target="_blank" rel="noopener">買取X Open API</a> のAPIキーを入れると、入庫・出庫したJANの商品名と買取価格一覧を表示します。キーはこの端末にだけ保存され、バックアップには含まれません。</div>
      <label>APIキー<input id="kxKeyIn" type="password" placeholder="ktx_..." autocomplete="off" value="${esc(kxKey())}"></label>
      <label class="chk"><input type="checkbox" data-opt="kxOn" ${lsGet('kxOn') !== '0' ? 'checked' : ''}>入庫・出庫のときに買取価格を取得する</label>
      <button type="button" data-do="kx-save" class="primary">保存</button>
      <button type="button" data-do="kx-test">接続テスト</button>
      <div id="kxTest" class="sm" hidden></div>
      <div class="muted sm">無料プランは1日30回まで。同じJANは6時間、保存した結果を使います。規約上、Free/Premiumは個人利用のみです。</div>
    </div>
    <div class="set" id="verBox"><h4>バージョン</h4>
      <div>使用中: <b>${esc(verLabel(VERSION))}</b> 版</div>
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
  else if (act === 'kx-save') { lsSet('kxKey', $('#kxKeyIn').value.trim()); kxMem.clear(); toast(kxKey() ? 'APIキーを保存しました' : 'APIキーを削除しました'); }
  else if (act === 'kx-test') { lsSet('kxKey', $('#kxKeyIn').value.trim()); if (!kxKey()) { toast('APIキーを入れてください', true); return; } await kxTest(); }
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
  if (i.pinned) lines.push(`前のバージョン ${verLabel(i.pinned)} 版で固定中です(最新は ${verLabel(i.installed)} 版)`);
  else lines.push(i.installed !== VERSION ? `端末には ${verLabel(i.installed)} 版が入っています。アプリを開き直すと切り替わります` : 'この端末に保存済み(オフラインでも起動できます)');
  if (!i.pinned) lines.push(i.previous ? `戻せる前のバージョン: ${verLabel(i.previous)} 版` : '戻せる前のバージョン: まだありません(次の更新から使えます)');
  st.innerHTML = lines.map(esc).join('<br>');
  btns.innerHTML = i.pinned
    ? '<button type="button" data-do="ver-latest" class="primary">最新バージョンに戻す</button>'
    : (i.previous ? `<button type="button" data-do="ver-rollback">前のバージョン(${esc(verLabel(i.previous))} 版)に戻す</button>` : '');
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
    box.innerHTML = `<b>新しいバージョン(${esc(verLabel(info.version))} 版)があります</b><br><span class="muted">${esc(info.notes || '')}</span><br><button type="button" data-do="ver-update" class="primary">更新する</button>`;
  } else if (i?.pinned) {
    box.innerHTML = `最新は ${esc(verLabel(info.version))} 版です。いまは前のバージョンで固定中です。`;
  } else {
    box.textContent = `最新バージョン(${verLabel(info.version)} 版)を使っています`;
  }
}
async function applyUpdate() {
  const box = $('#verRemote');
  box.hidden = false;
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
// スキャン画面の下にバージョンを表示し、新しい版があれば知らせる
async function showVerFoot() {
  const el = $('#verFoot');
  el.innerHTML = `バージョン ${esc(verLabel(VERSION))} 版`;
  if (!navigator.onLine) return;
  try {
    const info = await fetchLatestInfo();
    if (verCmp(info.version, VERSION) > 0) {
      el.innerHTML = `バージョン ${esc(verLabel(VERSION))} 版 ・ <b>新しい版(${esc(verLabel(info.version))})があります</b> <button type="button" id="verFootUp">更新する</button>`;
      $('#verFootUp').addEventListener('click', async () => {
        el.innerHTML = '更新しています…';
        showTab('settings');
        await applyUpdate();
      });
    }
  } catch { /* オフラインなど */ }
}
async function rollback() {
  const i = await swMsg('info');
  if (!i?.previous) { toast('戻せる前のバージョンがありません', true); return; }
  if (!(await confirmDlg('前のバージョンに戻す', `${esc(verLabel(i.previous))} 版に戻します。商品・倉庫・履歴のデータはそのまま残ります。あとから「最新バージョンに戻す」で元に戻せます。`, '戻す', false))) return;
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
  $('#photoBtn').addEventListener('click', () => { initAudio(); if (scanning) stopCam(); $('#photoIn').click(); });
  $('#photoIn').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    toast('読み取り中…');
    let code = null;
    try { code = await decodePhoto(f); } catch { code = null; }
    const jan = code && normJan(code);
    if (!jan) { toast('バーコードを読み取れませんでした。バーコードを画面いっぱい・横向きに、ピントを合わせて撮ってください', true); return; }
    $('#toast').classList.remove('show');
    handleJan(jan);
  });
  $('#manual').addEventListener('submit', (e) => {
    e.preventDefault();
    initAudio();
    const jan = normJan($('#manualJan').value);
    if (!jan) { toast('JANコードが正しくありません(8桁か13桁)', true); return; }
    $('#manualJan').value = '';
    handleJan(jan);
  });
  $('#last').addEventListener('click', (e) => {
    const b = e.target.closest('[data-undo]'); if (b) undoLast(Number(b.dataset.undo));
    const k = e.target.closest('[data-kx]'); if (k) kxDialog(k.dataset.kx);
    const sh = e.target.closest('[data-shop]'); if (sh) shopSearchDialog(sh.dataset.shop);
    const ed = e.target.closest('[data-edit]'); if (ed) editMoveDialog(Number(ed.dataset.edit));
  });
  $('#log').addEventListener('click', (e) => { const li = e.target.closest('li[data-jan]'); if (li) (kxOn() ? kxDialog(li.dataset.jan) : shopSearchDialog(li.dataset.jan)); });
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
    if (o === 'kxOn') lsSet('kxOn', e.target.checked ? '1' : '0');
    if (o === 'scanStop') lsSet('scanStop', e.target.checked ? '1' : '0');
    if (o === 'detail') lsSet('detail', e.target.checked ? '1' : '0');
    if (o === 'camSize') { lsSet('camSize', e.target.value); applyCamSize(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCam(); });
}

/* ---------- 起動 ---------- */
async function init() {
  await openDB();
  await reload();
  if (!state.locs.length) { await dbPut('locations', { name: '倉庫1' }); await reload(); }
  bind();
  applyCamSize();
  addEventListener('resize', applyCamSize);
  showVerFoot();
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
