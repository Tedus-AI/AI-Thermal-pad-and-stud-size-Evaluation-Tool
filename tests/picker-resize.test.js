/*
 * 「從資料庫快選」面板可調整大小 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 清單長的時候在小框裡捲很久 → 面板要能手動調整大小（主要是拉長）。
 *
 * 兩個使用者回報的問題（本檔的主要契約）：
 *   (1) 面板底部整片看不到、也按不到 → 外層 `.sg-panel` 是 overflow:hidden，
 *       絕對定位的面板被它的下邊界剪掉，連 CSS resize:both 的原生角落把手一起沒了
 *       （「沒有可以手動調整視窗大小的地方」）→ 面板改 position:fixed ＋ 夾在視窗內。
 *   (2) 面板的 markup 少一個 </div>，`.sg-actionbar-right`（📍元件位置標註／👁檢視）
 *       被吃進 `.sg-picker` 裡面，整組按鈕從動作列最右邊跑到中間、換到下一行。
 *
 * 驗證情境：
 *   [A] 兩個把手都在、看得見、而且真的按得到（elementFromPoint 命中把手本身）；
 *       面板 flex 直排、清單 flex:1 自己捲 → 拉高面板時變長的是清單。
 *   [B] 預設 360×420（比原本固定 max-height:340px 大）；有 min/max 夾住。
 *   [C] 真的用滑鼠拖底部把手 → 只變高、清單跟著變長、尺寸寫進 localStorage；
 *       重繪＋重新開啟套用得回來。
 *   [D] 右下角格柵拖 → 寬高一起變；「重設大小」點下去不會被當成拖曳（回預設、清記憶、面板不關）。
 *   [E] 面板永遠完整落在視窗內、不被 `.sg-panel` 裁切；上限 92vw/82vh；下方放得下時就貼在
 *       觸發鈕下面；捲動時跟著觸發鈕重算，關閉後不留監聽。
 *   [F] 搜尋、點選加入元件等原有行為不受影響。
 *   [G] 動作列版面：六個直接子元素、📍元件位置標註／👁檢視 在最右邊那一組裡（回歸防護）。
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
  const openPicker = async () => {
    await page.evaluate(() => {
      sgPickerToggle('RF');
      // 專案群組預設收合 → 先展開，清單才會長到需要捲動（就是使用者抱怨的情境）
      const head = document.querySelector('#sg-picker-list-RF .sg-pk-head');
      if (head) head.click();
    });
    await page.waitForTimeout(120);
  };
  const rect = sel => page.evaluate(s => {
    const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  }, sel);
  await openPicker();

  console.log('\n[A] 兩個看得見、按得到的把手 + 清單吃剩餘高度');
  const a = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    const list = document.getElementById('sg-picker-list-RF');
    const search = document.getElementById('sg-picker-search-RF');
    const foot = document.getElementById('sg-pk-footer-RF');
    const grip = pop.querySelector('.sg-pk-grip');
    const cp = getComputedStyle(pop), cl = getComputedStyle(list), cs = getComputedStyle(search);
    const hit = el => { const r = el.getBoundingClientRect();
      const t = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return t ? (t === el || el.contains(t)) : false; };
    return {
      pos: cp.position, display: cp.display, dir: cp.flexDirection, overflow: cp.overflow,
      listFlex: cl.flexGrow + '/' + cl.minHeight, listOverflow: cl.overflowY, searchFlex: cs.flexGrow,
      listScrolls: list.scrollHeight > list.clientHeight,
      hasFoot: !!foot, hasGrip: !!grip,
      footCursor: foot && getComputedStyle(foot).cursor, gripCursor: grip && getComputedStyle(grip).cursor,
      gripW: grip ? Math.round(grip.getBoundingClientRect().width) : 0,
      gripPaint: grip ? getComputedStyle(grip).backgroundImage.slice(0, 26) : '',
      grabber: !!pop.querySelector('.sg-pk-grabber'),
      footHit: foot ? hit(foot) : false, gripHit: grip ? hit(grip) : false,
      footText: foot ? foot.textContent.replace(/\s+/g, '') : '',
    };
  });
  ok('底部把手存在且是 ns-resize（往下拖＝拉高）', a.hasFoot && a.footCursor === 'ns-resize', a);
  ok('右下角格柵存在、≥14px、有斜線紋、nwse-resize',
     a.hasGrip && a.gripW >= 14 && /gradient/.test(a.gripPaint) && a.gripCursor === 'nwse-resize', a);
  ok('把手真的按得到（不被 .sg-panel 的 overflow:hidden 裁掉）', a.footHit && a.gripHit, a);
  ok('底部把手有文案與抓握紋路 + 重設鈕',
     /拖曳/.test(a.footText) && a.grabber && /重設大小/.test(a.footText), a.footText);
  ok('面板 position:fixed（絕對定位會被外層 overflow:hidden 剪掉）', a.pos === 'fixed', a);
  ok('面板是 flex 直排、overflow 非 visible', a.display === 'flex' && a.dir === 'column' && a.overflow !== 'visible', a);
  ok('清單 flex:1 + min-height:0 + 自己捲', /^1\//.test(a.listFlex) && a.listOverflow === 'auto', a);
  ok('搜尋框不跟著伸縮（flex-grow 0）', a.searchFlex === '0', a.searchFlex);
  ok('清單內容確實超出可視高度（需要捲動的情境）', a.listScrolls === true, a);

  console.log('\n[B] 預設尺寸與上下限');
  const b = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    const cp = getComputedStyle(pop);
    return { w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight),
             minW: cp.minWidth, minH: cp.minHeight, maxW: cp.maxWidth, maxH: cp.maxHeight,
             listH: Math.round(document.getElementById('sg-picker-list-RF').clientHeight) };
  });
  ok('預設 360×420（清單可視高度比原本的 340px 大）', b.w === 360 && b.h === 420 && b.listH > 300, b);
  ok('有 min/max 夾住（260/200 ~ 92vw/82vh）',
     b.minW === '260px' && b.minH === '200px' && /vw|px/.test(b.maxW) && /vh|px/.test(b.maxH), b);

  console.log('\n[C] 滑鼠拖底部把手 → 變高、記得住');
  const f0 = await rect('#sg-pk-footer-RF');
  const before = await rect('#sg-picker-pop-RF');
  const listBefore = await rect('#sg-picker-list-RF');
  await page.mouse.move(f0.l + 60, f0.cy);
  await page.mouse.down();
  await page.mouse.move(f0.l + 60, f0.cy + 110, { steps: 5 });
  const mid = await page.evaluate(() => ({ body: document.body.classList.contains('sg-pk-resizing'),
      cursor: document.body.style.cursor, cls: document.getElementById('sg-pk-footer-RF').className }));
  await page.mouse.move(f0.l + 60, f0.cy + 220, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const after = await rect('#sg-picker-pop-RF');
  const listAfter = await rect('#sg-picker-list-RF');
  const savedC = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('sgThermal.pickerSize')); } catch (e) { return null; } });
  ok('往下拖 220px → 高度 +220、寬度不動',
     after.h === before.h + 220 && after.w === before.w, { before, after });
  ok('拉高之後變長的是清單本身', listAfter.h === listBefore.h + 220, { listBefore, listAfter });
  ok('拖曳中整頁換游標＋把手變色（看得出正在拖）',
     mid.body && mid.cursor === 'ns-resize' && /dragging/.test(mid.cls), mid);
  ok('放手後游標還原', (await page.evaluate(() => document.body.style.cursor)) === '', 1);
  ok('尺寸寫進 localStorage', savedC && savedC.h === after.h && savedC.w === after.w, savedC);

  const c2 = await page.evaluate(() => {
    sgPickerClose('RF');
    sgRenderProjectComponents();          // 重繪 → 面板重建（尺寸要套回來）
    sgPickerToggle('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    return { w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight), open: pop.style.display === 'flex' };
  });
  ok('重繪＋重新開啟後尺寸套用得回來', c2.open && c2.w === after.w && c2.h === after.h, { c2, after });

  console.log('\n[D] 角落格柵拖寬高／重設大小');
  await page.evaluate(() => { const h = document.querySelector('#sg-picker-list-RF .sg-pk-head'); if (h) h.click(); });
  const g0 = await rect('#sg-picker-pop-RF .sg-pk-grip');
  const d0 = await rect('#sg-picker-pop-RF');
  await page.mouse.move(g0.cx, g0.cy);
  await page.mouse.down();
  await page.mouse.move(g0.cx + 120, g0.cy + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const d1 = await rect('#sg-picker-pop-RF');
  const savedD = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('sgThermal.pickerSize')); } catch (e) { return null; } });
  ok('右下角拖 +120/+60 → 寬高一起變', d1.w === d0.w + 120 && d1.h === d0.h + 60, { d0, d1 });
  ok('角落拖完也記下來', savedD && savedD.w === d1.w && savedD.h === d1.h, savedD);

  const rb = await rect('#sg-pk-footer-RF .sg-pk-reset');
  await page.mouse.click(rb.cx, rb.cy);      // 點在把手列裡面，不可被當成拖曳
  await page.waitForTimeout(100);
  const d2 = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    let saved = 'x'; try { saved = localStorage.getItem('sgThermal.pickerSize'); } catch (e) {}
    return { w: pop.offsetWidth, h: pop.offsetHeight, saved, open: pop.style.display };
  });
  ok('點「重設大小」→ 回預設 360×420、清掉記憶、面板不會被關掉',
     d2.w === 360 && d2.h === 420 && d2.saved === null && d2.open === 'flex', d2);

  console.log('\n[E] 永遠完整落在視窗內（不被 .sg-panel 裁掉）');
  const e1 = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    const r = pop.getBoundingClientRect();
    const panel = pop.closest('.sg-panel');
    const pr = panel.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
             vw: window.innerWidth, vh: window.innerHeight,
             panelOverflow: getComputedStyle(panel).overflow,
             outOfPanel: Math.round(r.bottom - pr.bottom) };
  });
  ok('預設尺寸整片在視窗內（含底部把手）',
     e1.top >= 0 && e1.bottom <= e1.vh && e1.left >= 0 && e1.right <= e1.vw, e1);
  ok('外層 .sg-panel 仍是 overflow:hidden，但面板已不受它裁切（超出也沒關係）',
     e1.panelOverflow === 'hidden' && e1.outOfPanel > -10000, e1);

  const e2 = await page.evaluate(async () => {
    try { localStorage.setItem('sgThermal.pickerSize', JSON.stringify({ w: 5000, h: 5000 })); } catch (er) {}
    sgPickerClose('RF'); sgPickerToggle('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    const r = pop.getBoundingClientRect();
    return { w: Math.round(pop.offsetWidth), h: Math.round(pop.offsetHeight),
             top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
             vw: window.innerWidth, vh: window.innerHeight };
  });
  ok('超大記憶值被夾到 ≤ 92vw / ≤ 82vh',
     e2.w <= Math.round(e2.vw * 0.92) + 1 && e2.h <= Math.round(e2.vh * 0.82) + 1, e2);
  ok('放到最大也還是整片在視窗內',
     e2.top >= 0 && e2.bottom <= e2.vh && e2.left >= 0 && e2.right <= e2.vw, e2);

  // 下方放得下時要貼在觸發鈕底下（不要無條件往上飄）
  const e3 = await page.evaluate(() => {
    try { localStorage.setItem('sgThermal.pickerSize', JSON.stringify({ w: 320, h: 200 })); } catch (er) {}
    sgPickerClose('RF');
    const wrap = document.getElementById('sg-picker-RF');
    wrap.scrollIntoView({ block: 'center' });
    sgPickerToggle('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    return { gap: Math.round(pop.getBoundingClientRect().top - wrap.getBoundingClientRect().bottom),
             left: Math.round(pop.getBoundingClientRect().left - wrap.getBoundingClientRect().left) };
  });
  ok('下方空間夠時貼在觸發鈕下方（gap≈4、左邊對齊）', e3.gap >= 0 && e3.gap <= 8 && Math.abs(e3.left) <= 2, e3);

  // fixed 定位不會跟著頁面捲動 → 捲動時要重算，面板才不會飄掉
  await page.evaluate(() => window.scrollBy(0, 140));
  await page.waitForTimeout(120);
  const e4 = await page.evaluate(() => {
    const pop = document.getElementById('sg-picker-pop-RF');
    const wrap = document.getElementById('sg-picker-RF');
    const r = pop.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    return { gap: Math.round(r.top - wr.bottom), left: Math.round(r.left - wr.left),
             inView: r.top >= 0 && r.bottom <= window.innerHeight };
  });
  ok('捲動頁面後面板仍跟著觸發鈕、仍在視窗內', Math.abs(e4.gap) <= 8 && Math.abs(e4.left) <= 2 && e4.inView, e4);

  // 關閉後不可留下 scroll/resize 監聽（捲動不該再動到面板、也不該噴錯）
  const e5 = await page.evaluate(async () => {
    sgPickerClose('RF');
    const pop = document.getElementById('sg-picker-pop-RF');
    const before = pop.style.top;
    window.scrollBy(0, -140); window.dispatchEvent(new Event('resize'));
    await new Promise(r => setTimeout(r, 60));
    return { display: pop.style.display, topUnchanged: pop.style.top === before };
  });
  ok('關閉後捲動／改視窗大小不再動到面板（監聽已移除）', e5.display === 'none' && e5.topUnchanged, e5);

  console.log('\n[F] 原有行為不受影響');
  const f = await page.evaluate(() => {
    try { localStorage.removeItem('sgThermal.pickerSize'); } catch (er) {}
    sgPickerClose('RF'); sgPickerToggle('RF');
    const s = document.getElementById('sg-picker-search-RF');
    s.value = 'PA-7'; sgPickerFilter('RF');
    const list = document.getElementById('sg-picker-list-RF');
    const rows = [...list.querySelectorAll('.sg-pk-comp')].map(x => x.textContent.trim());
    const before = sgProjectData.rf_data.length;
    const first = list.querySelector('.sg-pk-comp');
    if (first) first.click();
    return { rows, added: sgProjectData.rf_data.length - before,
             name: sgProjectData.rf_data[0] && sgProjectData.rf_data[0].Component,
             closed: document.getElementById('sg-picker-pop-RF').style.display === 'none' };
  });
  ok('搜尋仍然過濾得到（PA-7）', f.rows.length >= 1 && f.rows.some(t => /PA-7/.test(t)), f.rows);
  ok('點選仍然加入元件並關閉面板', f.added === 1 && /PA-7/.test(f.name || '') && f.closed, f);

  console.log('\n[G] 動作列版面（📍元件位置標註／👁檢視 必須在最右邊）');
  const g = await page.evaluate(() => {
    const bar = document.querySelector('.sg-comp-actionbar');
    const kids = [...bar.children].map(e => (e.className || e.tagName).toString().split(' ')[0]);
    const right = bar.querySelector('.sg-actionbar-right');
    const tcp = bar.querySelector('.tcp-placement-btn'), view = bar.querySelector('.tcp-view-btn');
    const pk = bar.querySelector('.sg-picker');
    const br = bar.getBoundingClientRect(), rr = right.getBoundingClientRect(), pr = pk.getBoundingClientRect();
    return { kids, lastIsRight: bar.lastElementChild === right,
             tcpInRight: right.contains(tcp), viewInRight: right.contains(view),
             tcpInPicker: pk.contains(tcp),
             pickerH: Math.round(pr.height), barH: Math.round(br.height),
             rightAligned: Math.round(br.right - rr.right), sameLine: Math.abs(Math.round(rr.top - pr.top)) <= 2 };
  });
  ok('動作列六個直接子元素、順序正確',
     g.kids.length === 6 && g.kids[0] === 'sg-add-label' && g.kids[4] === 'sg-picker' && g.kids[5] === 'sg-actionbar-right',
     g.kids);
  ok('📍元件位置標註／👁檢視 在 .sg-actionbar-right 裡、不在 .sg-picker 裡',
     g.tcpInRight && g.viewInRight && !g.tcpInPicker, g);
  ok('.sg-actionbar-right 是最後一個子元素並靠到動作列最右邊',
     g.lastIsRight && g.rightAligned <= 1, g);
  ok('快選與右側按鈕同一行、動作列沒被撐高（picker 高度 30 / 列高 ≤ 50）',
     g.sameLine && g.pickerH <= 34 && g.barH <= 50, g);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
