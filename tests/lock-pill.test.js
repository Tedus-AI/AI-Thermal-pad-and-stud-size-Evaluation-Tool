/*
 * 編輯鎖膠囊（分頁列右邊 #lock-pill）＋版本徽章（編輯鎖左邊）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 原本 Tab1/2/3/5/6 每頁頂端各有一條「密碼保護」橫幅（約 100px 高），收成分頁列右邊一顆膠囊，
 * 版本號放在膠囊左邊、字縮小（曾放標題列，但登入後標題列放不下而換行）。驗證情境：
 *   [A] 結構：頁面上沒有任何 .protect-bar；版本徽章在分頁列、編輯鎖左邊、字小；編輯鎖在 .tabnav-row 裡
 *   [B] 資料庫範圍：鎖定只顯示狀態＋「解鎖編輯」→ 按下才展開密碼框（提示文字顯示）；空白 Enter 不送；
 *       密碼錯 → 提示、清空、留在展開；Esc／點外面收起；0000 → 編輯中、儲存鈕可用；「鎖定」→ 回唯讀
 *   [C] SharePoint 取鎖中：顯示「取得鎖定中…」、按鈕停用、點外面不收起；取鎖失敗 → 回唯讀
 *   [D] 回饋頁範圍：換到「使用者建議與改善」→ 開發者密碼（0000 不行、0420 可以），不影響資料庫鎖；
 *       展開中換分頁 → 收起（不把密碼送到別的範圍）
 *   [E] 右側工具列🔒：與膠囊同一個狀態、兩個密碼框不同時開
 *   [F] 唯讀時點編輯區 → toast 指路＋膠囊閃動（琥珀，非紅）
 *   [G] 版面（最擠的實際情況：CI 戳過版本號＋✓最新、已登入（長姓名＋email）、Windows 捲軸、Thermal Via 兩位數徽章）：
 *       1920／1600／1536／1440／1366 × 鎖定／展開／已解鎖／回饋頁展開 —— 分頁列不換行、不被右側工具列蓋住、
 *       沒有橫向捲軸、標題列一行、切換狀態時分頁列高度不變；≥1536 徽章在編輯鎖左邊，以下疊到編輯鎖上方；
 *       1600 以下展開時收掉狀態字、已解鎖時「編輯中（可儲存）」收成「編輯中」
 *   [H] 版本徽章：只顯示日期時間（不含 commit），完整版本號在 tooltip；與線上相同 →「✓ 最新」
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/lock-pill.test.js
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

const INIT = () => {
  window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
  window.msal = { PublicClientApplication: class {
    async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
  window.__alerts = [];
  window.alert = (m) => { window.__alerts.push(String(m)); };
  window.confirm = () => true;
  try { localStorage.clear(); } catch (e) {}
};

async function setupDb(page) {
  await page.evaluate(() => {
    window.__db = { projects: { X: { project_name: 'P', rf_data: [], digital_data: [], pwr_data: [] } }, tim_library: {}, feedback_items: {} };
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.refresh = async () => {};
    dbAdapter.getProjectsSorted = async () => [{ id: 'X', project_name: 'P' }];
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.releaseLock = async () => { window.__released = (window.__released || 0) + 1; };
    dbAdapter.hasLock = () => false;
  });
}

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.route('**', r => r.request().url().startsWith(ORIGIN) ? r.continue() : r.abort());
  await page.addInitScript(INIT);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof lockPillSync === 'function' && typeof saveAllTabs === 'function' && document.getElementById('gm-rail'));
  await setupDb(page);

  const pill = () => page.evaluate(() => {
    const p = document.getElementById('lock-pill');
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0; };
    return {
      cls: p.className, text: document.getElementById('lock-pill-text').textContent,
      btn: document.getElementById('lock-pill-btn').textContent, btnDis: document.getElementById('lock-pill-btn').disabled,
      pwdVis: vis('lock-pill-pwd'), tipVis: vis('lock-pill-tip'), tip: document.getElementById('lock-pill-tip').textContent,
      ph: document.getElementById('lock-pill-pwd').placeholder, pwd: document.getElementById('lock-pill-pwd').value,
      focus: document.activeElement && document.activeElement.id,
      info: document.getElementById('lock-pill-info').title,
      isProtected, fbIsProtected,
    };
  });

  console.log('\n[A] 結構');
  const A = await page.evaluate(() => {
    const vb = document.getElementById('version-badge');
    return {
      bars: document.querySelectorAll('.protect-bar').length,
      oldIds: ['sg-protect-bar', 'protect-bar', 'vd-protect-bar', 'via-protect-bar', 'fb-protect-bar'].filter(id => document.getElementById(id)).length,
      badgeInRow: !!vb.closest('.tabnav-side') && !vb.closest('.header') && vb.nextElementSibling === document.getElementById('lock-pill'),
      badgeFont: parseFloat(getComputedStyle(vb).fontSize),
      pillInRow: !!document.getElementById('lock-pill').closest('.tabnav-row'),
      rowH: Math.round(document.querySelector('.tabnav-row').getBoundingClientRect().height),
    };
  });
  ok('各頁的密碼保護橫幅都拿掉了（沒有 .protect-bar、舊 id 都不在）', A.bars === 0 && A.oldIds === 0, A);
  ok('版本徽章在分頁列、編輯鎖左邊（不在標題列，登入後標題列才不會換行）、字小（≤ 10.5px）', A.badgeInRow && A.badgeFont <= 10.5, A);
  ok('編輯鎖在分頁列裡，分頁列只有一行高（≤ 50px）', A.pillInRow && A.rowH <= 50, A);

  console.log('\n[B] 資料庫範圍（EE/RF/PWR 頁）');
  let P = await pill();
  ok('預設：🔒 唯讀＋「解鎖編輯」，密碼框收著；說明在 i 的 tooltip', /locked/.test(P.cls) && !/unlocked/.test(P.cls) && P.text === '唯讀' && P.btn === '解鎖編輯' && !P.pwdVis && !P.tipVis && /請勿解鎖資料庫/.test(P.info), P);
  await page.click('#lock-pill-btn');
  await page.waitForTimeout(30);
  P = await pill();
  ok('按「解鎖編輯」→ 展開密碼框（取得焦點）、按鈕變「解鎖」、提示文字顯示', /open/.test(P.cls) && P.pwdVis && P.focus === 'lock-pill-pwd' && P.btn === '解鎖' && P.tipVis && /請勿解鎖資料庫/.test(P.tip) && P.ph === '輸入密碼', P);
  await page.press('#lock-pill-pwd', 'Enter');
  P = await pill();
  ok('空白按 Enter → 不送出、不跳「密碼錯誤」，維持展開', await page.evaluate(() => window.__alerts.length === 0) && /open/.test(P.cls) && P.isProtected, P);
  await page.fill('#lock-pill-pwd', '1234');
  await page.press('#lock-pill-pwd', 'Enter');
  await page.waitForTimeout(30);
  P = await pill();
  ok('密碼錯 → 提示錯誤、清空、留在展開並取得焦點，仍唯讀', await page.evaluate(() => /密碼錯誤/.test(window.__alerts.pop() || '')) && P.pwd === '' && /open/.test(P.cls) && P.focus === 'lock-pill-pwd' && P.isProtected, P);
  await page.fill('#lock-pill-pwd', 'abc');
  await page.press('#lock-pill-pwd', 'Escape');
  P = await pill();
  ok('Esc → 收起、清掉已輸入的字', !/open/.test(P.cls) && !P.pwdVis && P.pwd === '' && P.btn === '解鎖編輯', P);
  await page.click('#lock-pill-btn');
  await page.mouse.click(400, 600);
  P = await pill();
  ok('展開後點外面 → 收起', !/open/.test(P.cls) && !P.pwdVis, P);
  await page.click('#lock-pill-btn');
  await page.fill('#lock-pill-pwd', '0000');
  await page.click('#lock-pill-btn');
  await page.waitForTimeout(30);
  P = await pill();
  const saveOn = await page.evaluate(() => !document.getElementById('sg-comp-save-btn').disabled && !document.getElementById('save-btn').disabled && !document.getElementById('vd-save-btn').disabled);
  ok('0000 → 🔓 編輯中（可儲存）＋「鎖定」，各頁儲存鈕可用', /unlocked/.test(P.cls) && !/open/.test(P.cls) && P.text === '編輯中（可儲存）' && P.btn === '鎖定' && !P.isProtected && saveOn, P);
  ok('解鎖後工具列🔒同步為「鎖定資料庫」', await page.evaluate(() => document.getElementById('rail-lock-btn').getAttribute('data-tip') === '鎖定資料庫'));
  await page.click('#lock-pill-btn');
  await page.waitForTimeout(30);
  P = await pill();
  ok('按「鎖定」（沒有未存變更）→ 不需密碼直接回唯讀、儲存鈕停用', P.isProtected && P.text === '唯讀' && await page.evaluate(() => document.getElementById('sg-comp-save-btn').disabled), P);

  console.log('\n[C] SharePoint 取鎖中');
  await page.evaluate(() => {
    dbAdapter.isSharePointMode = () => true;
    dbAdapter.isSignedIn = () => true;
    dbAdapter.acquireLock = () => new Promise((res, rej) => { window.__lockRes = res; window.__lockRej = rej; });
  });
  await page.click('#lock-pill-btn');
  await page.fill('#lock-pill-pwd', '0000');
  await page.press('#lock-pill-pwd', 'Enter');
  await page.waitForTimeout(30);
  P = await pill();
  ok('取鎖中：顯示「取得鎖定中…」、按鈕與密碼框停用', P.text === '取得鎖定中…' && P.btnDis && /busy/.test(P.cls), P);
  await page.mouse.click(400, 600);
  P = await pill();
  ok('取鎖中點外面不收起', /open/.test(P.cls) || P.text === '取得鎖定中…', P);
  await page.evaluate(() => window.__lockRes({}));
  await page.waitForTimeout(60);
  P = await pill();
  ok('取鎖成功 → 編輯中、按鈕恢復', !P.isProtected && P.text === '編輯中（可儲存）' && !P.btnDis && !/busy/.test(P.cls), P);
  await page.click('#lock-pill-btn');
  await page.waitForTimeout(30);
  ok('SharePoint 模式按「鎖定」→ 釋放編輯鎖、回唯讀', await page.evaluate(() => isProtected && window.__released >= 1));
  await page.click('#lock-pill-btn');
  await page.fill('#lock-pill-pwd', '0000');
  await page.press('#lock-pill-pwd', 'Enter');
  await page.waitForTimeout(30);
  await page.evaluate(() => window.__lockRej(new Error('網路逾時')));
  await page.waitForTimeout(60);
  P = await pill();
  ok('取鎖失敗 → 提示原因、回到唯讀、按鈕恢復', await page.evaluate(() => /無法取得編輯鎖定：網路逾時/.test(window.__alerts.pop() || '')) && P.isProtected && P.text === '唯讀' && !P.btnDis, P);
  await page.evaluate(() => { dbAdapter.isSharePointMode = () => false; lockPillCollapse(); });

  console.log('\n[D] 回饋頁範圍（開發者密碼）');
  await page.click('#lock-pill-btn');
  await page.evaluate(() => switchTab('feedback'));
  await page.waitForTimeout(80);
  P = await pill();
  ok('展開中換分頁 → 收起（範圍變了）', !/open/.test(P.cls) && !P.pwdVis, P);
  ok('回饋頁：🔒 回饋管理唯讀、說明換成開發者專用', P.text === '回饋管理唯讀' && /開發者專用/.test(P.info), P);
  await page.click('#lock-pill-btn');
  P = await pill();
  ok('展開：placeholder「開發者密碼」、提示開發者專用', P.ph === '開發者密碼' && /開發者專用/.test(P.tip), P);
  await page.fill('#lock-pill-pwd', '0000');
  await page.press('#lock-pill-pwd', 'Enter');
  await page.waitForTimeout(30);
  P = await pill();
  ok('資料庫密碼 0000 在回饋頁無效', await page.evaluate(() => /密碼錯誤/.test(window.__alerts.pop() || '')) && P.fbIsProtected, P);
  await page.fill('#lock-pill-pwd', '0420');
  await page.press('#lock-pill-pwd', 'Enter');
  await page.waitForTimeout(60);
  P = await pill();
  ok('0420 → 開發者模式；資料庫鎖不受影響', !P.fbIsProtected && P.text === '開發者模式' && P.btn === '鎖定' && P.isProtected, P);
  await page.evaluate(() => switchTab('specgen'));
  P = await pill();
  ok('換回 EE 頁 → 顯示資料庫範圍（唯讀）', P.text === '唯讀' && /locked/.test(P.cls) && !/unlocked/.test(P.cls), P);
  await page.evaluate(() => switchTab('feedback'));
  await page.waitForTimeout(40);
  await page.click('#lock-pill-btn');
  await page.waitForTimeout(30);
  P = await pill();
  ok('回饋頁按「鎖定」→ 回饋管理唯讀', P.fbIsProtected && P.text === '回饋管理唯讀', P);
  await page.evaluate(() => switchTab('specgen'));

  console.log('\n[E] 右側工具列🔒');
  await page.click('#lock-pill-btn');
  await page.evaluate(() => railToggleLock());
  P = await pill();
  ok('開工具列密碼框 → 膠囊的密碼框收起（不同時開兩個）', !/open/.test(P.cls) && await page.evaluate(() => document.getElementById('rail-lock-popover').style.display === 'flex'), P);
  await page.fill('#rail-lock-pwd', '0000');
  await page.evaluate(() => railConfirmUnlock());
  await page.waitForTimeout(40);
  P = await pill();
  ok('工具列解鎖 → 膠囊同步顯示編輯中', !P.isProtected && P.text === '編輯中（可儲存）', P);
  await page.evaluate(() => railToggleLock());
  await page.waitForTimeout(30);
  P = await pill();
  ok('工具列鎖定 → 膠囊同步回唯讀', P.isProtected && P.text === '唯讀', P);
  await page.evaluate(() => railToggleLock());
  await page.click('#lock-pill-btn');
  ok('開膠囊密碼框 → 工具列密碼框收起', await page.evaluate(() => document.getElementById('rail-lock-popover').style.display === 'none' && document.getElementById('lock-pill').classList.contains('open')));
  await page.evaluate(() => lockPillCollapse());

  console.log('\n[F] 唯讀時點編輯區');
  await page.evaluate(() => { applyReadonlyLock(); document.getElementById('sg-project-components').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const F = await page.evaluate(() => ({
    flash: document.getElementById('lock-pill').classList.contains('ro-flash'),
    toast: (document.getElementById('ro-toast') || {}).textContent || '',
    anim: getComputedStyle(document.getElementById('lock-pill')).animationName,
  }));
  ok('toast 指路到「解鎖編輯」、膠囊閃動（roBarPulse 琥珀色）', F.flash && /解鎖編輯/.test(F.toast) && F.anim === 'roBarPulse', F);

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  await page.close();

  console.log('\n[G] 版面（CI 戳過版本號、已登入、Windows 捲軸、Thermal Via 分頁有兩位數徽章 —— 最擠的實際情況）');
  // 實際使用時：版本徽章帶「✓ 最新」、標題列有姓名＋email、Windows 有捲軸（約 15–17px）、Thermal Via 分頁常常掛著數字徽章。
  // headless 預設隱藏捲軸 → 另開一個顯示捲軸的瀏覽器量。
  const VER = '2026.10.13.1557-98063f8';
  const b2 = await chromium.launch(Object.assign(EXEC ? { executablePath: EXEC } : {}, { ignoreDefaultArgs: ['--hide-scrollbars'] }));
  const p2 = await b2.newPage();
  await p2.setViewportSize({ width: 1536, height: 800 });
  await p2.route('**', async r => {
    const u = r.request().url();
    if (!u.startsWith(ORIGIN)) return r.abort();
    if (/\/index\.html(\?|$)/.test(u)) {
      const resp = await r.fetch();
      return r.fulfill({ response: resp, body: (await resp.text()).split('__APP_VERSION__').join(VER) });
    }
    if (/\/version\.json/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: VER }) });
    return r.continue();
  });
  await p2.addInitScript(INIT);
  const errors2 = [];
  p2.on('pageerror', e => errors2.push(String(e)));
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => typeof lockPillSync === 'function' && document.getElementById('gm-rail'));
  await p2.waitForFunction(() => document.getElementById('version-badge').classList.contains('is-latest'), null, { timeout: 15000 }).catch(() => {});
  await setupDb(p2);
  await p2.evaluate(() => {
    document.documentElement.style.overflowY = 'scroll';
    dbAdapter.getAccountInfo = () => ({ name: 'TEDUS.CHEN 陳慶峰', email: 'Tedus.Chen@deltaww.com' });
    _updateSpHeaderSignedIn();
    document.getElementById('btn-pick-db').style.display = 'none';
    const vb = document.getElementById('via-tab-badge'); vb.textContent = '12'; vb.style.display = '';
  });
  ok('有捲軸（版面寬度比視窗窄）', await p2.evaluate(() => window.innerWidth - document.documentElement.clientWidth >= 10));
  for (const w of [1920, 1600, 1536, 1440, 1366]) {
    await p2.setViewportSize({ width: w, height: 800 });
    const heights = [];
    for (const mode of ['locked', 'open', 'unlocked', 'fb-open']) {
      await p2.evaluate((m) => {
        if (m === 'unlocked') { _applyUnlockedUI(); return; }
        if (isProtected === false) relock();
        switchTab(m === 'fb-open' ? 'feedback' : 'specgen');
        if (m === 'locked') lockPillCollapse(); else lockPillOpen();
      }, mode);
      await p2.waitForTimeout(60);
      const g = await p2.evaluate(() => {
        const R = (el) => el.getBoundingClientRect();
        const p = R(document.getElementById('lock-pill'));
        const b = R(document.getElementById('version-badge'));
        const n = R(document.querySelector('.tab-nav'));
        const row = R(document.querySelector('.tabnav-row'));
        const rail = R(document.getElementById('gm-rail'));
        const fab = R(document.getElementById('tc-fab'));
        const hdr = document.querySelector('.header');
        const kids = [...hdr.children].filter(e => e.offsetParent !== null).map(e => e.getBoundingClientRect());
        const clear = (r) => r.width === 0 || p.right <= r.left - 2 || p.bottom <= r.top || p.top >= r.bottom;
        const stacked = b.bottom <= p.top + 1;
        return {
          oneLine: p.top >= n.top - 4 && p.bottom <= n.bottom + 4 && b.top >= row.top - 1 && row.height <= n.height + 6,
          badgeOk: b.width > 40 && (stacked ? (b.right <= p.right + 1 && b.right >= p.right - 40) : (b.right <= p.left && p.left - b.right <= 12)),
          stacked, railClear: clear(rail) && clear(fab),
          hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headerOneLine: kids.every(r => Math.abs(r.top - kids[0].top) < 30),
          rowH: Math.round(row.height), spare: Math.round(p.left - n.right - (stacked ? 0 : b.width + 8)),
        };
      });
      heights.push(g.rowH);
      const label = { locked: '', open: '（展開密碼框）', unlocked: '（已解鎖）', 'fb-open': '（回饋頁展開密碼框）' }[mode];
      const where = g.stacked ? '徽章在編輯鎖上方' : '徽章在編輯鎖左邊';
      ok(`${w}px${label}：分頁列一行（${where}）、不被工具列蓋住、沒有橫向捲軸、標題列一行`, g.oneLine && g.badgeOk && g.railClear && g.hscroll <= 0 && g.headerOneLine, g);
      if (w >= 1536) ok(`${w}px${label}：徽章在編輯鎖左邊`, !g.stacked, g);
    }
    ok(`${w}px：鎖定／展開／解鎖切換時分頁列高度不變（內容不跳）`, Math.max(...heights) - Math.min(...heights) <= 1, heights);
  }
  await p2.evaluate(() => { relock(); switchTab('specgen'); lockPillCollapse(); });
  ok('1366px 已解鎖：文字收成「編輯中」，完整說明在 tooltip', await p2.evaluate(() => {
    _applyUnlockedUI();
    const t = document.getElementById('lock-pill-text');
    const r = t.innerText.trim() === '編輯中' && /已解鎖/.test(document.getElementById('lock-pill').title);
    relock(); return r;
  }));

  console.log('\n[H] 版本徽章');
  const H = await p2.evaluate(() => ({
    text: document.getElementById('vb-ver').textContent, title: document.getElementById('version-badge').title,
    latest: document.getElementById('version-badge').classList.contains('is-latest'),
    inRow: !!document.getElementById('version-badge').closest('.tabnav-row'), inHeader: !!document.getElementById('version-badge').closest('.header'),
  }));
  ok('徽章只顯示日期時間（不含 commit）、tooltip 有完整版本號＋「已是最新版本」', H.text === 'v2026.10.13.1557' && H.title === '軟體版本 v' + VER + '（已是最新版本）', H);
  ok('與線上版本相同 →「✓ 最新」', H.latest, H);
  ok('徽章在分頁列（編輯鎖旁），不在標題列', H.inRow && !H.inHeader, H);
  ok('沒有 JS 錯誤（版面頁）', errors2.length === 0, errors2);
  await b2.close();

  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('UNEXPECTED:', e); process.exit(1); });
