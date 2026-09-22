/*
 * 「從資料庫快選」面板可調整大小 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 清單長的時候在 340px 的框裡捲很久 → 面板改成可拖曳右下角調整大小（主要是拉長），
 * 並把尺寸記在 localStorage（面板每次重繪都會重建，不記就會跳回預設）。
 *
 * 驗證情境：
 *   [A] 面板可 resize（CSS resize:both、overflow 非 visible）、flex 直排，
 *       清單 flex:1 且自己有捲軸 → 拉高面板時變長的是清單本身。
 *   [B] 預設尺寸比原本高（420px，原本清單固定 max-height:340px）；有 min/max 夾住。
 *   [C] 拖大之後尺寸寫進 localStorage；重新繪製、重新開啟都套用得回來。
 *   [D] 「重設大小」清掉記憶並回到預設；面板開合（display:none）不會把 0×0 存進去。
 *   [E] 記下來的尺寸大於視窗時會被夾回 92vw / 82vh（換小螢幕不會爆出畫面）。
 *   [F] 搜尋、點選加入元件等原有行為不受影響。
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/picker-resize.test.js      # 可用 TEST_URL 指定網址
 */

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const BASE = process.env.TEST_URL || 'http://127.0.0.1:8125/index.html';
const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.route('**', r => {
    const u = r.request().url();
    if (u.startsWith(BASE.replace(/index\.html$/, ''))) return r.continue();
    return r.abort();
  });
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.XLSX = { utils:{book_new:()=>({}),aoa_to_sheet:()=>({}),book_append_sheet(){}}, writeFile(){} };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sgPickerToggle === 'function' && typeof sgPickerApplySize === 'function');

  // 一個有很多元件的來源專案（讓清單確實需要捲動）
  const setup = () => {
    isProtected = false;
    try { localStorage.removeItem('sgThermal.pickerSize'); } catch (e) {}
    const comps = [];
    for (let i = 1; i <= 40; i++) comps.push({ name: 'PA-' + i, power: i, power_rt: i, src: { 'Power(W)': i } });
    sgVariantsCache = { RF: [], Digital: [], PWR: [] };
    sgProjectTreeCache = { RF: [{ projId: 'A', projName: '專案A', ts: 1, comps }], Digital: [], PWR: [] };
    sgProjectId = 'B';
    sgProjectData = { project_name: '專案B', rf_data: [], digital_data: [], pwr_data: [] };
    sgRenderProjectComponents();
  };
  await page.evaluate(setup);
  await page.evaluate(() => {
    sgPickerToggle('RF');
    // 專案群組預設收合 → 先展開，清單才會長到需要捲動（就是使用者抱怨的情境）
    const head = document.querySelector('#sg-picker-list-RF .sg-pk-head');
    if (head) head.click();
  });

  console.log('\n[A] 面板可調整大小、清單吃剩餘高度');
  const a = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    const list = document.getElementById('sg-picker-list-RF');
    const search = document.getElementById('sg-picker-search-RF');
    const cp = getComputedStyle(pop), cl = getComputedStyle(list), cs = getComputedStyle(search);
    return {
      resize: cp.resize, overflow: cp.overflow, display: cp.display, dir: cp.flexDirection,
      listFlex: cl.flexGrow + '/' + cl.minHeight, listOverflow: cl.overflowY, searchFlex: cs.flexGrow,
      listScrolls: list.scrollHeight > list.clientHeight,
      footer: !!pop.querySelector('.sg-pk-footer'),
      footerText: (pop.querySelector('.sg-pk-footer') || {}).textContent || '',
    };
  });
  ok('面板 resize:both 且 overflow 非 visible（原生把手才會出現）',
     a.resize === 'both' && a.overflow !== 'visible', a);
  ok('面板是 flex 直排', a.display === 'flex' && a.dir === 'column', a);
  ok('清單 flex:1 + min-height:0 + 自己捲', /^1\//.test(a.listFlex) && a.listOverflow === 'auto', a);
  ok('搜尋框不跟著伸縮（flex-grow 0）', a.searchFlex === '0', a.searchFlex);
  ok('清單內容確實超出可視高度（需要捲動的情境）', a.listScrolls === true, a);
  ok('底部有「拖曳右下角可調整大小」提示與重設鈕',
     a.footer && /拖曳右下角/.test(a.footerText) && /重設大小/.test(a.footerText), a.footerText);

  console.log('\n[B] 預設尺寸與上下限');
  const b = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    const cp = getComputedStyle(pop);
    return { w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight),
             minW: cp.minWidth, minH: cp.minHeight, maxW: cp.maxWidth, maxH: cp.maxHeight,
             listH: Math.round(document.getElementById('sg-picker-list-RF').clientHeight) };
  });
  ok('預設 360×420（清單可視高度比原本的 340px 大）', b.w === 360 && b.h === 420 && b.listH > 340, b);
  ok('有 min/max 夾住（260/200 ~ 92vw/82vh）',
     b.minW === '260px' && b.minH === '200px' && /vw|px/.test(b.maxW) && /vh|px/.test(b.maxH), b);

  console.log('\n[C] 拖大之後記得住');
  const c1 = await page.evaluate(async () => {
    const pop = document.getElementById('sg-picker-pop-RF');
    pop.style.width = '520px'; pop.style.height = '700px';     // 模擬拖曳結果
    await new Promise(r => setTimeout(r, 120));                 // 等 ResizeObserver
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('sgThermal.pickerSize')); } catch (e) {}
    return { saved, listH: Math.round(document.getElementById('sg-picker-list-RF').clientHeight) };
  });
  ok('尺寸寫進 localStorage（520×700）', c1.saved && c1.saved.w === 520 && c1.saved.h === 700, c1);
  ok('拉高之後變長的是清單本身（可視高度 > 560px）', c1.listH > 560, c1);

  const c2 = await page.evaluate(() => {
    sgPickerClose('RF');
    sgRenderProjectComponents();          // 重繪 → 面板重建（尺寸要套回來）
    sgPickerToggle('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    return { w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight),
             open: pop.style.display === 'flex' };
  });
  ok('重繪＋重新開啟後尺寸套用得回來', c2.open && c2.w === 520 && c2.h === 700, c2);

  console.log('\n[D] 重設大小／開合不污染記憶');
  const d1 = await page.evaluate(async () => {
    sgPickerResetSize('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    await new Promise(r => setTimeout(r, 120));
    let saved = 'x';
    try { saved = localStorage.getItem('sgThermal.pickerSize'); } catch (e) {}
    return { saved, w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight) };
  });
  ok('「重設大小」清掉記憶並回到預設 360×420', d1.saved === null && d1.w === 360 && d1.h === 420, d1);

  const d2 = await page.evaluate(async () => {
    const pop = document.getElementById('sg-picker-pop-RF');
    pop.style.width = '480px'; pop.style.height = '620px';
    await new Promise(r => setTimeout(r, 120));
    sgPickerClose('RF');                       // display:none → 0×0，不可被存進去
    await new Promise(r => setTimeout(r, 150));
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('sgThermal.pickerSize')); } catch (e) {}
    return saved;
  });
  ok('關閉面板不會把 0×0 存進記憶', d2 && d2.w === 480 && d2.h === 620, d2);

  console.log('\n[E] 小螢幕夾回視窗內');
  const e = await page.evaluate(async () => {
    try { localStorage.setItem('sgThermal.pickerSize', JSON.stringify({ w: 5000, h: 5000 })); } catch (er) {}
    sgPickerToggle('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    return { w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight),
             vw: window.innerWidth, vh: window.innerHeight };
  });
  ok('超大記憶值被夾到 ≤ 92vw / ≤ 82vh', e.w <= Math.round(e.vw * 0.92) + 1 && e.h <= Math.round(e.vh * 0.82) + 1, e);

  console.log('\n[F] 原有行為不受影響');
  const f = await page.evaluate(() => {
    try { localStorage.removeItem('sgThermal.pickerSize'); } catch (er) {}
    sgPickerClose('RF'); sgPickerToggle('RF');
    const s = document.getElementById('sg-picker-search-RF');
    s.value = 'PA-7'; sgPickerFilter('RF');
    const list = document.getElementById('sg-picker-list-RF');
    const rows = [...list.querySelectorAll('.sg-pk-comp')].map(x => x.textContent.trim());
    // 點第一個加入
    const before = sgProjectData.rf_data.length;
    const first = list.querySelector('.sg-pk-comp');
    if (first) first.click();
    return { rows, added: sgProjectData.rf_data.length - before,
             name: sgProjectData.rf_data[0] && sgProjectData.rf_data[0].Component,
             closed: document.getElementById('sg-picker-pop-RF').style.display === 'none' };
  });
  ok('搜尋仍然過濾得到（PA-7）', f.rows.length >= 1 && f.rows.some(t => /PA-7/.test(t)), f.rows);
  ok('點選仍然加入元件並關閉面板', f.added === 1 && /PA-7/.test(f.name || '') && f.closed, f);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
