/*
 * 檔案級樂觀並發（ETag/If-Match）驗證測試 — 對應 5G-RRU PR #66 的跨 repo 同步實作。
 *
 * 以 mock Graph API 驅動「實際的 graphDb.js」：模擬單一檔案＋遞增 etag，
 * PUT 強制檢查 If-Match 不符回 412。執行：node tests/optimistic-concurrency.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ── 瀏覽器環境 stub ── */
global.window = {};
global.SHAREPOINT_CONFIG = {
  clientId: 'test-client', authority: 'https://login.test', redirectUri: 'http://localhost',
  scopes: ['Files.ReadWrite.All'],
  siteHostname: 'contoso.sharepoint.com', sitePath: '/sites/thermal',
  filePath: '/Shared/thermal_db.json', lockTimeoutMinutes: 30,
};
const ACCOUNT = { name: 'Me', username: 'me@test.com' };
global.msal = {
  PublicClientApplication: class {
    async initialize() {}
    async handleRedirectPromise() { return null; }
    getAllAccounts() { return [ACCOUNT]; }
    async acquireTokenSilent() { return { accessToken: 'tok' }; }
    async loginPopup() { return { account: ACCOUNT }; }
    async logoutPopup() {}
  }
};

/* ── mock SharePoint：單一檔案＋遞增 etag ── */
const server = {
  etag: 1,
  content: JSON.stringify({ version: 1, rf_library: {}, digital_library: {}, pwr_library: {}, projects: { p1: { a: 1 } } }, null, 2),
  puts: 0,          // 成功寫入次數
  putAttempts: 0,   // PUT 嘗試次數（含 412）
  beforePut: null,  // 一次性 hook：模擬「他人在我們讀後、寫前」搶先寫入的競態
  alwaysBump: false,// 每次 PUT 前 etag 都先被別人改掉（持續衝突）
  eTagStr() { return 'W/"' + this.etag + '"'; },
  db() { return this.content.trim() === '' ? {} : JSON.parse(this.content); },
  external(mut) {   // 模擬另一個工具/使用者的成功寫入（etag 遞增）
    const db = this.db();
    mut(db);
    this.content = JSON.stringify(db, null, 2);
    this.etag++;
  },
};

global.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const ok = (json, text) => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => json,
    text: async () => (text !== undefined ? text : JSON.stringify(json)),
  });
  if (method === 'GET') {
    if (url.includes('/sites/contoso.sharepoint.com:')) return ok({ id: 'site1' });
    if (url.includes('/drive/root:'))                   return ok({ id: 'item1' });
    if (url.includes('?$select=id,eTag,cTag'))          return ok({ id: 'item1', eTag: server.eTagStr() });
    if (url.endsWith('/content'))                       return ok(null, server.content);
    throw new Error('unexpected GET ' + url);
  }
  if (method === 'PUT' && url.endsWith('/content')) {
    server.putAttempts++;
    if (server.alwaysBump) server.etag++;
    if (server.beforePut) { const h = server.beforePut; server.beforePut = null; h(); }
    const ifMatch = opts.headers && (opts.headers['If-Match'] || opts.headers['if-match']);
    if (ifMatch && ifMatch !== server.eTagStr()) {
      return { ok: false, status: 412, statusText: 'Precondition Failed',
               json: async () => ({}), text: async () => 'precondition failed' };
    }
    server.content = opts.body;
    server.etag++;
    server.puts++;
    return ok({ id: 'item1', eTag: server.eTagStr() });
  }
  throw new Error('unexpected ' + method + ' ' + url);
};

/* ── 載入實際的 graphDb.js ── */
eval(fs.readFileSync(path.join(__dirname, '..', 'graphDb.js'), 'utf8'));
const graphDb = window.graphDb;
graphDb._sleep = async () => {};   // 退避不真等，加速測試

/* ── 斷言工具 ── */
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS:', name); }
  else { fail++; console.log('  FAIL:', name); }
}
async function expectThrow(name, fn, predicate) {
  try { await fn(); check(name + '（應丟錯卻成功）', false); return null; }
  catch (e) { check(name, predicate(e)); return e; }
}

(async () => {
  await graphDb.initMsal();

  console.log('[T1] 基本讀寫：PUT 帶 If-Match、成功後 etag 前進');
  await graphDb.refresh();
  await graphDb.setDoc('projects', 'p2', { b: 2 });
  check('寫入成功（1 次 PUT、無 412）', server.puts === 1 && server.putAttempts === 1);
  check('內容含 p1+p2', !!server.db().projects.p1 && server.db().projects.p2.b === 2);

  console.log('[T2] 他人改其他 doc → 我方 412 → 重讀重試 → 雙方寫入都保留');
  let base = server.putAttempts;
  server.beforePut = () => server.external(db => { db.rf_library.amp1 = { pwr: 9 }; });
  await graphDb.setDoc('projects', 'p3', { c: 3 });
  check('經 1 次 412 後重試成功（共 2 次 PUT 嘗試）', server.putAttempts === base + 2);
  check('對方的 rf_library.amp1 保留（未被回滾）', server.db().rf_library.amp1?.pwr === 9);
  check('我方的 p3 寫入成功', server.db().projects.p3?.c === 3);
  check('既有 p1/p2 完整', !!server.db().projects.p1 && !!server.db().projects.p2);

  console.log('[T3] updateDoc 412 重試：在最新 doc 上重做 shallow merge');
  server.beforePut = () => server.external(db => { db.projects.p1.sibling_field = 'theirs'; });
  await graphDb.updateDoc('projects', 'p1', { mine: 'ours' });
  const p1 = server.db().projects.p1;
  check('對方同 doc 的新欄位保留', p1.sibling_field === 'theirs');
  check('我方欄位合併成功', p1.mine === 'ours' && p1.a === 1);

  console.log('[T4] 取鎖競態：他人在我方讀後寫前搶鎖 → LockError、不雙鎖');
  const otherLock = () => ({ lockedBy: 'Other', lockedByEmail: 'other@test.com',
    lockedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString() });
  server.beforePut = () => server.external(db => { db.lock = otherLock(); });
  const lockErr = await expectThrow('後到者得 LockError', () => graphDb.acquireLock(),
    e => e.name === 'LockError' && e.lockedBy === 'Other');
  check('鎖仍屬對方（沒被覆寫，不雙鎖）', server.db().lock.lockedByEmail === 'other@test.com');
  check('本端不誤認持鎖', graphDb.hasLock() === false);

  console.log('[T5] 過期鎖可正常接手');
  server.external(db => { db.lock = { ...otherLock(), expiresAt: new Date(Date.now() - 60000).toISOString() }; });
  const got = await graphDb.acquireLock();
  check('接手成功且鎖屬於我', got.lockedByEmail === 'me@test.com' && server.db().lock.lockedByEmail === 'me@test.com');
  check('hasLock() = true', graphDb.hasLock() === true);

  console.log('[T6] releaseLock 時鎖已被他人接手 → 完全不寫檔');
  server.external(db => { db.lock = otherLock(); });   // 模擬我方鎖過期後被接手
  base = server.putAttempts;
  const basePuts = server.puts;
  await graphDb.releaseLock();
  check('skipWrite：嘗試 1 次 PUT 即 412 收手、無成功寫入', server.putAttempts === base + 1 && server.puts === basePuts);
  check('對方的鎖原封不動', server.db().lock.lockedByEmail === 'other@test.com');
  check('本端持鎖狀態已清', graphDb.hasLock() === false);
  server.external(db => { delete db.lock; });   // 清場

  console.log('[T7] 持續 412 → 重試上限後丟出，不無限迴圈');
  await graphDb.refresh();
  server.alwaysBump = true;
  base = server.putAttempts;
  const e412 = await expectThrow('上限後丟出 412', () => graphDb.setDoc('projects', 'pX', { x: 1 }),
    e => e && e.status === 412);
  server.alwaysBump = false;
  check('共 5 次 PUT 嘗試（首次＋4 次重試）', server.putAttempts === base + 5);
  check('檔案未被我方寫入', server.db().projects.pX === undefined);

  console.log('[T8] 歸零保險絲精修：sibling 清空專案後，本端取鎖不被誤擋');
  const snapshot = server.content;
  server.external(db => { db.projects = {}; });   // sibling 刻意刪光所有專案
  await graphDb.refresh();                        // lastReadProjects → 0（磁碟現況）
  const lk = await graphDb.acquireLock();         // 舊「session 高水位」設計這裡會被誤擋
  check('projects 為空時取鎖成功（無偽陽性）', lk.lockedByEmail === 'me@test.com');
  await graphDb.releaseLock();
  check('釋放成功', server.db().lock === undefined);

  console.log('[T9] 截斷偵測：先前已有資料卻讀到 0-byte → 唯讀；修復後解除');
  server.external(db => { db.projects = JSON.parse(snapshot).projects; });  // 還原資料（sawRealData 已為 true）
  await graphDb.refresh();
  server.content = ''; server.etag++;             // 外部把檔案截斷成空
  await graphDb.refresh();
  check('進入唯讀保護', graphDb.isCorrupted() === true);
  base = server.putAttempts;
  await expectThrow('唯讀中寫入被擋（不發 PUT）', () => graphDb.setDoc('projects', 'pY', {}),
    e => /唯讀保護/.test(e.message));
  check('完全沒有 PUT 嘗試', server.putAttempts === base);
  server.content = snapshot; server.etag++;       // 修復（還原成截斷前內容）
  await graphDb.refresh();
  check('修復後自動解除唯讀', graphDb.isCorrupted() === false);

  console.log('[T10] deleteDoc：doc 已被他人先刪 → 重讀後 skipWrite');
  await graphDb.refresh();
  server.beforePut = () => server.external(db => { delete db.projects.p3; });
  base = server.putAttempts;
  const puts0 = server.puts;
  await graphDb.deleteDoc('projects', 'p3');
  check('412 後發現已不存在 → 不再寫（無成功 PUT）', server.puts === puts0 && server.putAttempts === base + 1);
  check('p3 確實不存在、其餘資料完整', server.db().projects.p3 === undefined && !!server.db().projects.p1);

  console.log('[T11] writeBatch 412 重試：整批 ops 於最新狀態重放');
  server.beforePut = () => server.external(db => { db.digital_library.fpga1 = { pwr: 20 }; });
  await graphDb.writeBatch([
    { type: 'set',    col: 'projects', id: 'p9', data: { z: 9 } },
    { type: 'update', col: 'projects', id: 'p1', fields: { batch: true } },
  ]);
  check('對方的 digital_library.fpga1 保留', server.db().digital_library.fpga1?.pwr === 20);
  check('批次 set 成功', server.db().projects.p9?.z === 9);
  check('批次 update 合併成功（既有欄位保留）', server.db().projects.p1.batch === true && server.db().projects.p1.mine === 'ours');

  console.log(`\n結果：${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('UNEXPECTED:', e); process.exit(1); });
