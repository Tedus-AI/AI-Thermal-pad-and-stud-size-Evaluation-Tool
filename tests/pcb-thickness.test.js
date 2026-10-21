/*
 * PCB 板厚（`projects[id].pcb_thickness`）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 使用者要求：EE/RF/PWR 頁 RF／Digital／PWR 三個分類的標題列加 PCB 板厚下拉（常用三個＋自訂）。
 * 熱網路工具匯入專案時拿它當「板級導熱孔」元件的板厚。驗證情境：
 *   [A] 三個標題列都有：選項「未設定／1.6／2.0／2.4 mm／自訂…」；沒設定過顯示「未設定」；載入後沒有未存變更
 *   [B] 選常用值：只換標題列那一塊（元件表不重繪）、算未存變更；存檔只寫有設定的分類
 *   [C] 自訂：選了先出現數字欄並聚焦、還沒填不寫入；填 2.2 寫入；填剛好是常用值 → 下拉直接顯示那一項
 *   [D] 不合理的值（0、負數、> 10 mm）不寫入、紅框；清空 → 刪 key、留在自訂等使用者填
 *   [E] 載入已有板厚的專案：照值顯示（常用值／自訂）；選了又改回原值不算未存變更；全部改回未設定 → 寫 {}
 *   [F] 沒碰過的專案：只是載入再存檔 → 不寫 pcb_thickness；不認得的值 → 補「（未知值）」照原字顯示、存檔原樣寫回
 *   [G] 未解鎖：下拉與數字欄停用
 *   [H] Excel：每個分類表格下面空一列寫「PCB 板厚(mm)」
 *   [I] 版面：1920／1536／1366 標題列一行、板厚緊接在標題後面（不被右側浮動工具列蓋住）、沒有橫向捲軸
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/pcb-thickness.test.js
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

const comps = () => ({
  rf_data: [{ Component: 'PA-Final', Qty: 4, 'Power(W)': 60.5, 'Limit(C)': 150 }],
  digital_data: [{ Component: 'FPGA', Qty: 1, 'Power(W)': 44.85, 'Limit(C)': 100 }],
  pwr_data: [{ Component: 'DCDC', Qty: 2, 'Power(W)': 14.5, 'Limit(C)': 125 }],
});
const FRESH = { project_name: 'Fresh', ...comps() };
const SET = { project_name: 'Set', pcb_thickness: { RF: 2.2, PWR: 1.6 }, ...comps() };
const ODD = { project_name: 'Odd', pcb_thickness: { RF: 'abc', Digital: 2.4 }, ...comps() };

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.route('**', r => r.request().url().startsWith(BASE.replace(/index\.html$/, '')) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.alert = () => {}; window.confirm = () => true;
    try { localStorage.clear(); } catch (e) {}
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof projLoadAll === 'function' && typeof saveAllTabs === 'function' && document.getElementById('gm-rail'));
  await page.evaluate(([a, b, c]) => {
    window.__db = { projects: { F: a, S: b, O: c }, tim_library: {} };
    dbAdapter.isReady = () => true; dbAdapter.isSharePointMode = () => false; dbAdapter.refresh = async () => {};
    dbAdapter.getProjectsSorted = async () => Object.entries(window.__db.projects).map(([id, p]) => ({ id, project_name: p.project_name }));
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.releaseLock = async () => {};
    dbAdapter.setDoc = async (c, id, d) => { window.__db[c][id] = JSON.parse(JSON.stringify(d)); };
    window.__fields = {};
    dbAdapter.writeBatch = async (ops) => {
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      plan.forEach(({ o, f }) => {
        window.__fields[o.id] = Object.assign(window.__fields[o.id] || {}, JSON.parse(JSON.stringify(f)));
        window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f)));
      });
    };
    window._ensureLockBeforeWrite = async () => true;
    _applyUnlockedUI();
  }, [FRESH, SET, ODD]);

  const open = async (id) => {
    await page.evaluate(async (id) => { await projLoadAll(id); switchTab('specgen');
      document.getElementById('sg-project-status').style.display = 'none'; }, id);
    await page.waitForTimeout(120);
  };
  const save = () => page.evaluate(async () => { window.__fields = {}; await saveAllTabs(); return window.__fields; });
  const V = (cat) => page.evaluate((cat) => {
    const sel = document.getElementById(`sg-pcbt-${cat}-sel`), inp = document.getElementById(`sg-pcbt-${cat}-v`);
    return {
      sel: sel && sel.value, text: sel && sel.options[sel.selectedIndex].textContent,
      opts: sel ? [...sel.options].map(o => o.textContent) : [], selDis: sel && sel.disabled,
      inp: inp ? inp.value : null, inpDis: inp && inp.disabled, inpMiss: inp && inp.classList.contains('miss'),
      focus: document.activeElement && document.activeElement.id,
      data: sgProjectData.pcb_thickness === undefined ? '(none)' : JSON.parse(JSON.stringify(sgProjectData.pcb_thickness)),
      dirty: hasUnsavedEdits(),
    };
  }, cat);
  const pick = (cat, val) => page.evaluate(([cat, val]) => {
    const s = document.getElementById(`sg-pcbt-${cat}-sel`); s.value = val; s.dispatchEvent(new Event('change'));
  }, [cat, val]);
  const type = (cat, val) => page.evaluate(([cat, val]) => {
    const i = document.getElementById(`sg-pcbt-${cat}-v`); i.value = val; i.dispatchEvent(new Event('change'));
  }, [cat, val]);

  console.log('\n[A] 三個標題列');
  await open('F');
  const heads = await page.evaluate(() => [...document.querySelectorAll('.sg-comp-category-header')].map(h => ({
    name: (h.querySelector('.sg-cat-name') || {}).textContent, has: !!h.querySelector('.sg-pcbt select') })));
  ok('RF／Digital／PWR 三個標題列都有 PCB 板厚下拉', heads.length === 3 && heads.every(h => h.has)
    && /RF/.test(heads[0].name) && /Digital/.test(heads[1].name) && /PWR/.test(heads[2].name), heads);
  let v = await V('RF');
  ok('選項：未設定／1.6／2.0／2.4 mm／自訂…', v.opts.join('|') === '未設定|1.6 mm|2.0 mm|2.4 mm|自訂…', v.opts);
  ok('沒設定過 → 顯示「未設定」、沒有數字欄、沒有未存變更', v.sel === '' && v.inp === null && v.dirty === false, v);

  console.log('\n[B] 選常用值');
  await page.evaluate(() => { window.__rowEl = document.querySelector('.sg-comp-list-table tbody tr'); });
  await pick('Digital', '2.4');
  v = await V('Digital');
  ok('Digital 選 2.4 → 記在專案、算未存變更', v.sel === '2.4' && v.data.Digital === 2.4 && v.dirty === true, v);
  ok('元件表沒有重繪（同一個 DOM 節點）', await page.evaluate(() => window.__rowEl === document.querySelector('.sg-comp-list-table tbody tr')));
  let f = await save();
  ok('存檔只寫有設定的分類：pcb_thickness = { Digital: 2.4 }', f.F && JSON.stringify(f.F.pcb_thickness) === '{"Digital":2.4}', f.F && f.F.pcb_thickness);
  ok('存完沒有未存變更', (await V('Digital')).dirty === false);

  console.log('\n[C] 自訂');
  await pick('RF', 'custom');
  v = await V('RF');
  ok('選「自訂」→ 出現數字欄、聚焦、標必填；還沒填 → 不寫入、不算未存變更',
    v.sel === 'custom' && v.inp === '' && v.focus === 'sg-pcbt-RF-v' && v.inpMiss && !('RF' in v.data) && v.dirty === false, v);
  await type('RF', '2.2');
  v = await V('RF');
  ok('填 2.2 → 寫入、下拉維持自訂、數字欄 2.2', v.sel === 'custom' && v.inp === '2.2' && v.data.RF === 2.2 && !v.inpMiss && v.dirty, v);
  await type('RF', '2');
  v = await V('RF');
  ok('改成 2（剛好是常用值）→ 下拉直接顯示 2.0 mm、數字欄收起', v.sel === '2' && v.text === '2.0 mm' && v.inp === null && v.data.RF === 2, v);

  console.log('\n[D] 不合理的值');
  await pick('PWR', 'custom');
  for (const bad of ['0', '-1', '25']) {
    await type('PWR', bad);
    v = await V('PWR');
    ok(`填 ${bad} → 不寫入、紅框`, !('PWR' in v.data) && v.inpMiss && v.inp === bad, v);
  }
  await type('PWR', '1.8');
  ok('改成 1.8 → 寫入', (await V('PWR')).data.PWR === 1.8);
  await type('PWR', '');
  v = await V('PWR');
  ok('清空 → 刪 key（不寫 \'\'／0）、留在自訂等使用者填', !('PWR' in v.data) && v.sel === 'custom' && v.inp === '' && v.inpMiss, v);
  f = await save();
  ok('存檔：{ Digital: 2.4, RF: 2 }（沒有 PWR）', f.F && JSON.stringify(f.F.pcb_thickness) === '{"Digital":2.4,"RF":2}', f.F && f.F.pcb_thickness);

  console.log('\n[E] 已有板厚的專案');
  await open('S');
  const rf = await V('RF'), pwr = await V('PWR'), dg = await V('Digital');
  ok('RF 2.2 → 自訂＋數字欄 2.2；PWR 1.6 → 常用值；Digital 未設定', rf.sel === 'custom' && rf.inp === '2.2' && pwr.sel === '1.6' && pwr.inp === null && dg.sel === '', { rf, pwr, dg });
  ok('換專案：上一個專案「自訂」的暫態不帶過來', (await V('PWR')).inp === null);
  ok('載入後沒有未存變更', rf.dirty === false, rf);
  await pick('PWR', '');
  await pick('PWR', '1.6');
  v = await V('PWR');
  ok('改了又改回原值（key 順序不同）→ 不算未存變更', v.dirty === false && v.sel === '1.6', v);
  await pick('RF', ''); await pick('PWR', '');
  v = await V('RF');
  ok('全部改回未設定 → 算未存變更', v.dirty === true && JSON.stringify(v.data) === '{}', v);
  f = await save();
  ok('存檔寫 {}（shallow merge 才清得掉）', f.S && JSON.stringify(f.S.pcb_thickness) === '{}', f.S);

  console.log('\n[F] 沒碰過的專案、不認得的值');
  await page.evaluate(() => { delete window.__db.projects.F.pcb_thickness; });
  await open('F');
  f = await save();
  ok('只是載入再存檔 → 不寫 pcb_thickness', f.F && !('pcb_thickness' in f.F), f.F);
  await open('O');
  v = await V('RF');
  ok('不認得的值 abc → 補「abc（未知值）」照原字顯示', v.sel === '__unknown' && v.text === 'abc（未知值）', v);
  ok('Digital 2.4 照常顯示；載入後沒有未存變更', (await V('Digital')).sel === '2.4' && v.dirty === false);
  ok('tooltip 說明本工具不認得、請改選', await page.evaluate(() => /不認得/.test(document.getElementById('sg-pcbt-RF').title)));
  f = await save();
  ok('存檔原樣寫回（不靜默改掉）', f.O && f.O.pcb_thickness && f.O.pcb_thickness.RF === 'abc' && f.O.pcb_thickness.Digital === 2.4, f.O);

  console.log('\n[G] 未解鎖');
  await open('S');
  await page.evaluate(() => { window.__db.projects.S.pcb_thickness = { RF: 2.2 }; });
  await open('S');
  await page.evaluate(() => relock());
  v = await V('RF');
  ok('下拉與數字欄停用', v.selDis === true && v.inpDis === true, v);
  ok('tooltip 說明熱網路工具會拿去用、要按儲存', await page.evaluate(() => /熱網路工具/.test(document.getElementById('sg-pcbt-RF').title)
    && /儲存/.test(document.getElementById('sg-pcbt-RF').title)));
  await page.evaluate(() => _applyUnlockedUI());

  console.log('\n[H] Excel 匯出');
  const sheets = await page.evaluate(() => {
    // 測試環境擋掉 CDN → 沒有 SheetJS 時放一個替身（只需要這三個函式）
    if (!window.XLSX) window.XLSX = { utils: { book_new: () => ({}), aoa_to_sheet: () => ({}), book_append_sheet() {} }, writeFile() {} };
    const out = {}; const aoa = XLSX.utils.aoa_to_sheet, app = XLSX.utils.book_append_sheet, wf = XLSX.writeFile;
    let last = null;
    XLSX.utils.aoa_to_sheet = (rows) => { last = rows; return aoa(rows); };
    XLSX.utils.book_append_sheet = (wb, ws, name) => { out[name] = last; return app(wb, ws, name); };
    XLSX.writeFile = () => {};
    try { sgExportExcel(); } finally { XLSX.utils.aoa_to_sheet = aoa; XLSX.utils.book_append_sheet = app; XLSX.writeFile = wf; }
    return Object.fromEntries(Object.entries(out).map(([k, rows]) => [k, rows.slice(-2)]));
  });
  ok('表格下面空一列：RF 2.2、Digital／PWR「未設定」', JSON.stringify(sheets.RF) === '[[],["PCB 板厚(mm)",2.2]]'
    && JSON.stringify(sheets.Digital) === '[[],["PCB 板厚(mm)","未設定"]]' && JSON.stringify(sheets.PWR) === '[[],["PCB 板厚(mm)","未設定"]]', sheets);

  console.log('\n[I] 版面');
  for (const w of [1920, 1536, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(80);
    const L = await page.evaluate(() => [...document.querySelectorAll('.sg-comp-category-header')].map(h => {
      const hr = h.getBoundingClientRect(), c = h.querySelector('.sg-pcbt').getBoundingClientRect(), n = h.querySelector('.sg-cat-name').getBoundingClientRect();
      // 右側浮動工具列在 1648px 以下會蓋住標題列右端 → 板厚整顆都要點得到（左端、右端、中間都打到它自己）
      const my = (c.top + c.bottom) / 2;   // 膠囊兩端是圓角 → 取中線上離兩端 14px 的點
      const pts = [[c.left + 14, my], [c.right - 14, my], [(c.left + c.right) / 2, my]];
      h.scrollIntoView({ block: 'center' });
      const c2 = h.querySelector('.sg-pcbt').getBoundingClientRect(), dy = c2.top - c.top;
      const hit = pts.every(([x, y]) => { const e = document.elementFromPoint(x, y + dy); return e && e.closest('.sg-pcbt') === h.querySelector('.sg-pcbt'); });
      return { h: Math.round(hr.height), oneLine: Math.abs((c.top + c.bottom) / 2 - (n.top + n.bottom) / 2) < 3,
        afterTitle: c.left - n.right >= 8 && c.left - n.right <= 24, hit };
    }).concat([{ hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth }]));
    const hs = L.pop().hscroll;
    ok(`${w}px：標題列一行（≤ 44px）、板厚緊接標題、不被右側工具列蓋住、沒有橫向捲軸`, L.every(x => x.oneLine && x.h <= 44 && x.afterTitle && x.hit) && hs <= 0, { L, hs });
  }

  ok('沒有頁面錯誤', errors.length === 0, errors);
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();
