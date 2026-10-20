/*
 * 系統管理員面板的「使用者登入紀錄」—— 兩個工具都寫 login_history 之後 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 5G-RRU 也有同一套「🛡 管理」面板，也把自己的登入寫進共用的 login_history（tool: '5G-RRU'）。
 *   [A] 本工具記登入：tool 寫 'AI-Thermal'；同一個人剛在 5G-RRU 登入過 → 本工具照樣記（節流只看本工具）
 *   [B] 本工具 60 分鐘內已有紀錄 → 不重複記；沒有 tool 的舊紀錄算本工具的（原本只有本工具會寫）
 *   [C] 面板列表：每列標出哪個工具（5G-RRU 青綠／AI-Thermal 藍；沒有 tool → AI-Thermal）、新→舊、email 在 title
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/admin-loginhist.test.js
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const BASE = process.env.TEST_URL || 'http://127.0.0.1:8125/index.html';
const ORIGIN = BASE.replace(/index\.html$/, '');
const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.route('**', r => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.alert = () => {}; window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof recordLoginHistory === 'function' && typeof adminShowLoginHistory === 'function');
  // 共用 DB 換成頁面裡的物件：只用到 login_history
  await page.evaluate(() => {
    window.__db = { login_history: {} };
    dbAdapter.isSharePointMode = () => true;
    dbAdapter.isSignedIn = () => true;
    dbAdapter.getAccountInfo = () => ({ name: 'Me', email: 'me@x.com' });
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.setDoc = async (c, id, d) => { (window.__db[c] = window.__db[c] || {})[id] = JSON.parse(JSON.stringify(d)); };
    dbAdapter.deleteDoc = async (c, id) => { delete (window.__db[c] || {})[id]; };
    dbAdapter.peekLock = async () => null;
  });
  const hist = () => page.evaluate(() => Object.values(window.__db.login_history));
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

  console.log('\n[A] 本工具記登入：剛在 5G-RRU 登入過照樣記');
  await page.evaluate((at) => { window.__db.login_history = { r1: { name: 'Me', email: 'me@x.com', at, tool: '5G-RRU' } }; }, ago(5));
  await page.evaluate(() => recordLoginHistory());
  let h = await hist();
  ok('多一筆本工具的登入（tool: AI-Thermal）', h.length === 2 && h.some(r => r.email === 'me@x.com' && r.tool === 'AI-Thermal'), h);

  console.log('\n[B] 本工具 60 分鐘內已有紀錄 → 不重複記');
  await page.evaluate(() => recordLoginHistory());
  ok('不重複記', (await hist()).length === 2);
  await page.evaluate((at) => { window.__db.login_history = { old: { name: 'Me', email: 'me@x.com', at } }; }, ago(10));
  await page.evaluate(() => recordLoginHistory());
  ok('沒有 tool 的舊紀錄算本工具的 → 也不重複記', (await hist()).length === 1);
  await page.evaluate((at) => { window.__db.login_history = { old: { name: 'Me', email: 'me@x.com', at } }; }, ago(90));
  await page.evaluate(() => recordLoginHistory());
  ok('超過 60 分鐘 → 記一筆', (await hist()).length === 2);

  console.log('\n[C] 面板列表標出工具');
  await page.evaluate(() => {
    window.__db.login_history = {
      a: { name: 'RRU 使用者', email: 'rru@x.com', at: '2026-10-20T07:31:40.000Z', tool: '5G-RRU' },
      b: { name: 'AIT 使用者', email: 'ait@x.com', at: '2026-10-19T07:00:00.000Z', tool: 'AI-Thermal' },
      c: { name: '舊紀錄', email: 'old@x.com', at: '2026-10-15T08:32:48.000Z' },
    };
  });
  await page.evaluate(() => adminOpen());
  await page.fill('#admin-pwd', '0420');
  await page.evaluate(() => adminVerify());
  await page.evaluate(() => adminShowLoginHistory());
  const rows = await page.evaluate(() => [...document.querySelectorAll('#admin-loginhist .admin-lh-row')].map(r => {
    const t = r.querySelector('.admin-lh-tool'), e = r.querySelector('.admin-lh-email');
    return { tool: t && t.textContent, cls: t && t.className, email: e.textContent, title: e.title, bg: t && getComputedStyle(t).backgroundColor };
  }));
  ok('新→舊', rows.map(r => r.email).join() === 'rru@x.com,ait@x.com,old@x.com', rows);
  ok('5G-RRU 標青綠、AI-Thermal 標藍、沒有 tool 標 AI-Thermal', rows[0].tool === '5G-RRU' && /t-rru/.test(rows[0].cls) &&
     rows[1].tool === 'AI-Thermal' && /t-ait/.test(rows[1].cls) && rows[2].tool === 'AI-Thermal' && /t-ait/.test(rows[2].cls) &&
     rows[0].bg !== rows[1].bg, rows);
  ok('email 在 title（被截斷時滑過看得到）', rows.every(r => r.title === r.email), rows);

  ok('沒有頁面錯誤', errors.length === 0, errors.slice(0, 3));
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
