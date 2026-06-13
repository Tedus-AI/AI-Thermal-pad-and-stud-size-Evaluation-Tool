/*
 * 編輯鎖生命週期 — backend 行為驗證（對應 5G-RRU PR #67 的前提）。
 *
 * PR #67 的 UI 續約/驗鎖邏輯倚賴 graphDb 兩項保證：
 *   (a) 對「自己的鎖」重複 acquireLock → 延長 expiresAt、不丟錯（續約靠這個）；
 *   (b) 他人持有「有效鎖」時 acquireLock → 丟 LockError（不雙鎖，被接手時退出）。
 * 另含過期鎖可接手、releaseLock 不誤刪他人鎖（#66 樂觀寫入 skipWrite）。
 *
 * 以 mock Graph API 驅動實際的 graphDb.js。執行：node tests/lock-lifecycle.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = {};
global.SHAREPOINT_CONFIG = {
  clientId: 'c', authority: 'https://login.test', redirectUri: 'http://localhost',
  scopes: ['Files.ReadWrite.All'],
  siteHostname: 'contoso.sharepoint.com', sitePath: '/sites/thermal',
  filePath: '/Shared/thermal_db.json', lockTimeoutMinutes: 30,
};
const ME = { name: 'Me', username: 'me@test.com' };
global.msal = {
  PublicClientApplication: class {
    async initialize() {}
    async handleRedirectPromise() { return null; }
    getAllAccounts() { return [ME]; }
    async acquireTokenSilent() { return { accessToken: 'tok' }; }
    async loginPopup() { return { account: ME }; }
    async logoutPopup() {}
  }
};

/* mock SharePoint：單一檔案＋遞增 etag、PUT 強制驗 If-Match */
const server = {
  etag: 1,
  content: JSON.stringify({ version: 1, rf_library: {}, digital_library: {}, pwr_library: {}, projects: { p1: {} } }, null, 2),
  eTagStr() { return 'W/"' + this.etag + '"'; },
  db() { return this.content.trim() === '' ? {} : JSON.parse(this.content); },
  external(mut) { const d = this.db(); mut(d); this.content = JSON.stringify(d, null, 2); this.etag++; },
};
global.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const ok = (json, text) => ({ ok: true, status: 200, statusText: 'OK',
    json: async () => json, text: async () => (text !== undefined ? text : JSON.stringify(json)) });
  if (method === 'GET') {
    if (url.includes('/sites/contoso.sharepoint.com:')) return ok({ id: 'site1' });
    if (url.includes('/drive/root:'))                   return ok({ id: 'item1' });
    if (url.includes('?$select=id,eTag,cTag'))          return ok({ id: 'item1', eTag: server.eTagStr() });
    if (url.endsWith('/content'))                       return ok(null, server.content);
    throw new Error('unexpected GET ' + url);
  }
  if (method === 'PUT' && url.endsWith('/content')) {
    const ifMatch = opts.headers && (opts.headers['If-Match'] || opts.headers['if-match']);
    if (ifMatch && ifMatch !== server.eTagStr())
      return { ok: false, status: 412, statusText: 'Precondition Failed', json: async () => ({}), text: async () => '412' };
    server.content = opts.body; server.etag++;
    return ok({ id: 'item1', eTag: server.eTagStr() });
  }
  throw new Error('unexpected ' + method + ' ' + url);
};

eval(fs.readFileSync(path.join(__dirname, '..', 'graphDb.js'), 'utf8'));
const graphDb = window.graphDb;
const LockError = window.LockError;
graphDb._sleep = async () => {};

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  PASS: ' : '  FAIL: ') + name); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function expectThrow(name, fn, pred) {
  try { await fn(); check(name + '（應丟錯卻成功）', false); }
  catch (e) { check(name, pred(e)); }
}
const otherLock = (mins) => ({ lockedBy: 'Other', lockedByEmail: 'other@test.com',
  lockedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + mins * 60000).toISOString() });

(async () => {
  await graphDb.initMsal();

  console.log('[L1] 首次 acquireLock：取得鎖、屬於自己');
  const l1 = await graphDb.acquireLock();
  check('鎖屬於我', l1.lockedByEmail === 'me@test.com');
  check('hasLock() = true', graphDb.hasLock() === true);
  check('伺服器端鎖已寫入', server.db().lock.lockedByEmail === 'me@test.com');

  console.log('[L2] 對「自己的鎖」重複 acquireLock → 延長 expiresAt、不丟錯（續約）');
  const exp1 = new Date(server.db().lock.expiresAt).getTime();
  await sleep(12);
  const l2 = await graphDb.acquireLock();          // 不應丟錯
  const exp2 = new Date(server.db().lock.expiresAt).getTime();
  check('續約未丟錯且仍是我', l2.lockedByEmail === 'me@test.com');
  check('expiresAt 已往後延長 (' + exp1 + ' → ' + exp2 + ')', exp2 > exp1);
  check('仍持鎖', graphDb.hasLock() === true);

  console.log('[L3] 他人持有「有效鎖」→ acquireLock 丟 LockError、不雙鎖');
  server.external(db => { db.lock = otherLock(30); });   // 他人搶到有效鎖
  await expectThrow('丟 LockError', () => graphDb.acquireLock(),
    e => e instanceof LockError && e.lockedBy === 'Other');
  check('伺服器鎖仍是對方（沒被覆寫）', server.db().lock.lockedByEmail === 'other@test.com');

  console.log('[L4] 他人鎖已過期 → 可正常接手');
  server.external(db => { db.lock = otherLock(-5); });    // 已過期 5 分鐘
  const l4 = await graphDb.acquireLock();
  check('接手成功且鎖屬於我', l4.lockedByEmail === 'me@test.com' && server.db().lock.lockedByEmail === 'me@test.com');

  console.log('[L5] releaseLock 時鎖已被他人接手 → 不誤刪他人鎖、清本地狀態');
  server.external(db => { db.lock = otherLock(30); });    // 我方鎖被接手
  await graphDb.releaseLock();
  check('對方的鎖原封不動（skipWrite）', server.db().lock.lockedByEmail === 'other@test.com');
  check('本地持鎖狀態已清', graphDb.hasLock() === false);

  console.log('[L6] 正常 releaseLock（鎖是自己的）→ 刪除伺服器鎖');
  server.external(db => { delete db.lock; });
  await graphDb.acquireLock();
  await graphDb.releaseLock();
  check('伺服器鎖已移除', server.db().lock === undefined);
  check('hasLock() = false', graphDb.hasLock() === false);

  console.log(`\n結果：${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('UNEXPECTED:', e); process.exit(1); });
