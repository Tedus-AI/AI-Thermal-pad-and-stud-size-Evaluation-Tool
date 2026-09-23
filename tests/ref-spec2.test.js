/*
 * 參照也帶 TH/ME 頁的「元件大小／元件高度」 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 需求：Tab1 從資料庫快選（參照別的專案的元件）時，若來源專案在 TH/ME 頁填過
 *       「元件大小(mm)」與「元件高度(max)(mm)」，就一起抄過來；之後來源有更新也要
 *       出現在「↻ 來源有更新」清單裡逐欄套用。
 *
 * ⚠ 難點：這兩個值存在 `thermal_specs[specKey]`（Tab2 的資料），不在元件物件上，
 *   而 Tab1/Tab2 各有獨立的專案選單：
 *     (a) Tab2 正好載入同一個專案 → 直接寫進記憶體的 thermalSpecs；
 *     (b) 沒有 → 只能先暫存（寫進 Tab2 的副本就是污染「別的專案」的資料），
 *         由 saveAllTabs 讀回該專案現有的 thermal_specs、只填空格後一起寫回。
 *
 * 驗證情境：
 *   [A] 快選快取：來源專案的那兩個值掛到 comps[].spec2；沒填的元件不產生空物件；
 *       凸台／TIM 等「各專案自己的散熱設計」不會被一起帶走。
 *   [B] 兩頁同專案：快選 → thermalSpecs 立刻有值，TH/ME 頁的輸入框顯示得出來。
 *   [C] 兩頁不同專案：不可污染 Tab2 的 thermalSpecs → 進暫存；saveAllTabs 把它併進
 *       「Tab1 那個專案」的 thermal_specs（保留該專案既有內容），Tab2 的專案不受影響。
 *   [D] 只填空格：本專案已經填過的值不被覆蓋。
 *   [E] 來源沒填 → 什麼都不做（不寫 ''、不建立空的 spec 物件）。
 *   [F] ↻ 來源有更新：兩頁同專案時列出這兩欄（標「（TH/ME 頁）」）並可逐欄套用；
 *       套用元件大小會觸發原本的自動連動（Putty 自動帶入 → 凸台同步）。
 *   [G] 兩頁不同專案時，這兩欄整組不比對（不誤報「來源有更新」）。
 *   [H] Tab1 換專案 → 未存檔的暫存一起清掉。
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/ref-spec2.test.js
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
  await page.setViewportSize({ width: 1600, height: 950 });
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
  await page.waitForFunction(() => typeof sgApplySpec2 === 'function' && typeof sgBuildProjectTree === 'function');

  // 來源專案 A：Final PA 兩個都填、LNA 只填高度、Driver 沒填
  await page.evaluate(() => {
    window.__srcProjects = { A: {
      project_name: '案A', meta: { timestamp: '2026-01-01T00:00:00Z' },
      rf_data: [{ Component: 'Final PA', 'Power(W)': 52, 'Limit(C)': 110 },
                { Component: 'LNA', 'Power(W)': 3 },
                { Component: 'Driver', 'Power(W)': 9 }],
      thermal_specs: {
        'Final_PA': { heatSourceSize: '20×15', heatSourceHeight: '4.2', timType: 'Pad',
                      bossSize: '22×17', icToHSK: '1.7' },
        'LNA': { heatSourceHeight: '1.8' },
      },
    } };
    window.__mkTree = () => { sgProjectTreeCache = { RF: sgBuildProjectTree(window.__srcProjects, 'RF'), Digital: [], PWR: [] };
                              sgVariantsCache = { RF: [], Digital: [], PWR: [] }; };
    isProtected = false;
  });

  console.log('\n[A] 快選快取帶出 TH/ME 的兩個欄位');
  const a = await page.evaluate(() => {
    const tree = sgBuildProjectTree(window.__srcProjects, 'RF');
    const by = {}; tree[0].comps.forEach(c => { by[c.name] = c.spec2; });
    return by;
  });
  ok('有填的元件帶出兩個值', a['Final PA'] && a['Final PA'].heatSourceSize === '20×15'
     && a['Final PA'].heatSourceHeight === '4.2', a);
  ok('凸台／TIM／IC 距離 HSK 不會被一起帶走（那些是各專案的散熱設計）',
     a['Final PA'] && Object.keys(a['Final PA']).join(',') === 'heatSourceSize,heatSourceHeight', a);
  ok('只填一個就只帶一個（不補空字串）',
     a['LNA'] && Object.keys(a['LNA']).join(',') === 'heatSourceHeight', a);
  ok('來源沒填 → spec2 為 null（不產生空物件）', a['Driver'] === null, a);

  // 共用：把本專案 B 準備好（兩頁都載入 B）
  const setupSame = () => page.evaluate(() => {
    window.__mkTree();
    sgProjectId = 'B';
    sgProjectData = { project_name: '案B', rf_data: [], digital_data: [], pwr_data: [] };
    currentProjectId = 'B';
    currentProjectData = { project_name: '案B', rf_data: [], digital_data: [], pwr_data: [] };
    thermalSpecs = {}; hiddenComponents = {};
    sgPendingSpec2 = {};
    sgRenderProjectComponents(); renderAllCategories();
  });

  console.log('\n[B] 兩頁同專案：快選直接寫進 thermalSpecs');
  await setupSame();
  const b = await page.evaluate(() => {
    sgPickerAdd('RF', 'A', 'Final PA');
    const spec = thermalSpecs['Final_PA'];
    // 模擬存檔後 TH/ME 頁重新載入該專案（元件出現在 Tab2 的清單裡）
    currentProjectData.rf_data = JSON.parse(JSON.stringify(sgProjectData.rf_data));
    renderAllCategories();
    const row = document.querySelector('#comp-container table.comp-table tbody tr');
    const cells = row ? [...row.querySelectorAll('input.cell-input')] : [];
    const val = f => { const el = row.querySelector(`input[data-field="${f}"]`); return el ? el.value : null; };
    return { spec, pending: JSON.parse(JSON.stringify(sgPendingSpec2)),
             comp: sgProjectData.rf_data[0].Component,
             uiSize: val('heatSourceSize'), uiHeight: val('heatSourceHeight'),
             hasCells: cells.length > 0 };
  });
  ok('thermalSpecs 立刻有這兩個值', b.spec && b.spec.heatSourceSize === '20×15' && b.spec.heatSourceHeight === '4.2', b);
  ok('不進暫存（不必等存檔）', Object.keys(b.pending).length === 0, b.pending);
  ok('TH/ME 頁的輸入框顯示得出來', b.uiSize === '20×15' && b.uiHeight === '4.2', b);

  console.log('\n[D] 只填空格：本專案已填過的不覆蓋');
  await setupSame();
  const d = await page.evaluate(() => {
    thermalSpecs['Final_PA'] = { heatSourceSize: '99×99' };     // 本專案自己量到的尺寸
    sgPickerAdd('RF', 'A', 'Final PA');
    return JSON.parse(JSON.stringify(thermalSpecs['Final_PA']));
  });
  ok('已填的元件大小保持不變、空的高度才被填上',
     d.heatSourceSize === '99×99' && d.heatSourceHeight === '4.2', d);

  console.log('\n[E] 來源沒填 → 什麼都不做');
  await setupSame();
  const e = await page.evaluate(() => {
    sgPickerAdd('RF', 'A', 'Driver');
    return { has: Object.prototype.hasOwnProperty.call(thermalSpecs, 'Driver'),
             keys: Object.keys(thermalSpecs), pending: JSON.parse(JSON.stringify(sgPendingSpec2)) };
  });
  ok('不建立空的 spec 物件、也不進暫存', e.has === false && e.keys.length === 0
     && Object.keys(e.pending).length === 0, e);

  console.log('\n[C] 兩頁不同專案：先暫存，存檔時併回正確的專案');
  const c1 = await page.evaluate(() => {
    window.__mkTree();
    sgProjectId = 'B';
    sgProjectData = { project_name: '案B', rf_data: [], digital_data: [], pwr_data: [] };
    currentProjectId = 'C';                                   // TH/ME 頁載入的是別的專案
    currentProjectData = { project_name: '案C', rf_data: [], digital_data: [], pwr_data: [] };
    thermalSpecs = { 'ZZ': { heatSourceSize: '9×9' } };        // 案C 自己的資料
    hiddenComponents = {}; sgPendingSpec2 = {};
    sgRenderProjectComponents(); renderAllCategories();
    sgPickerAdd('RF', 'A', 'Final PA');
    return { tab2Specs: JSON.parse(JSON.stringify(thermalSpecs)),
             pending: JSON.parse(JSON.stringify(sgPendingSpec2)) };
  });
  ok('不可寫進 TH/ME 頁目前那個專案（案C）的 thermal_specs',
     !c1.tab2Specs['Final_PA'] && c1.tab2Specs['ZZ'].heatSourceSize === '9×9', c1.tab2Specs);
  ok('先暫存在 Tab1 那個專案底下（案B）',
     c1.pending.B && c1.pending.B['Final_PA'].heatSourceSize === '20×15'
     && c1.pending.B['Final_PA'].heatSourceHeight === '4.2', c1.pending);

  const c2 = await page.evaluate(async () => {
    // 假 DB：案B 已經有別的 thermal_specs、案C 也有自己的
    window.__db = {
      B: { project_name: '案B', thermal_specs: { 'Old_Part': { heatSourceSize: '5×5' },
                                                 'Final_PA': { icToHSK: '1.7' } } },
      C: { project_name: '案C', thermal_specs: { 'ZZ': { heatSourceSize: '9×9' } } },
    };
    window.__ops = null;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.getDoc = async (col, id) => JSON.parse(JSON.stringify(window.__db[id] || {}));
    // fields 可以是函式（在資料庫最新內容上計算，三方合併）→ 跟真的後端一樣先算出來再記錄
    dbAdapter.writeBatch = async (ops) => {
      const resolved = ops.map(o => Object.assign({}, o, { fields: typeof o.fields === 'function'
        ? o.fields(window.__db[o.id] ? JSON.parse(JSON.stringify(window.__db[o.id])) : null) : o.fields }));
      window.__ops = JSON.parse(JSON.stringify(resolved));
      resolved.forEach(o => { window.__db[o.id] = Object.assign({}, window.__db[o.id], JSON.parse(JSON.stringify(o.fields))); });
    };
    window._ensureLockBeforeWrite = async () => true;
    window.tcpNormalizeSPImages = async () => {};
    await saveAllTabs();
    const opB = (window.__ops || []).find(o => o.id === 'B');
    const opC = (window.__ops || []).find(o => o.id === 'C');
    return { opB: opB ? opB.fields.thermal_specs : null,
             opC: opC ? opC.fields.thermal_specs : null,
             pending: JSON.parse(JSON.stringify(sgPendingSpec2)),
             alerts: window.__alerts.slice() };
  });
  ok('存檔時併進「案B」的 thermal_specs',
     c2.opB && c2.opB['Final_PA'].heatSourceSize === '20×15' && c2.opB['Final_PA'].heatSourceHeight === '4.2', c2.opB);
  ok('案B 原有的內容一個都沒掉（含同一顆元件的其他欄位）',
     c2.opB && c2.opB['Old_Part'].heatSourceSize === '5×5' && c2.opB['Final_PA'].icToHSK === '1.7', c2.opB);
  ok('案C（TH/ME 頁）只寫自己的，不被污染',
     c2.opC && !c2.opC['Final_PA'] && c2.opC['ZZ'].heatSourceSize === '9×9', c2.opC);
  ok('寫回後暫存清空（不會重複併入）', Object.keys(c2.pending).length === 0, c2.pending);

  console.log('\n[F] ↻ 來源有更新：兩頁同專案時列出並可套用');
  const f1 = await page.evaluate(() => {
    window.__mkTree();
    sgProjectId = 'B'; currentProjectId = 'B';
    const comp = { Component: 'Final PA', 'Power(W)': 52, 'Limit(C)': 110,
                   _ref_origin_project: '案A', _ref_origin_id: 'A', _ref_locked: true };
    sgProjectData = { project_name: '案B', rf_data: [comp], digital_data: [], pwr_data: [] };
    currentProjectData = { project_name: '案B', rf_data: [JSON.parse(JSON.stringify(comp))], digital_data: [], pwr_data: [] };
    thermalSpecs = {}; hiddenComponents = {}; sgPendingSpec2 = {};
    sgRenderProjectComponents(); renderAllCategories();
    const diff = sgRefDiff(sgProjectData.rf_data[0], 'RF');
    const badge = sgRefSyncBadge(sgProjectData.rf_data[0], 'RF', 0);
    return { labels: diff.map(d => d.label), spec2: diff.filter(d => d.spec2).map(d => d.thText),
             badge: /↻ 來源有更新/.test(badge), n: diff.length };
  });
  ok('兩欄都列進差異並標明是 TH/ME 頁的欄位',
     f1.labels.includes('元件大小(mm)（TH/ME 頁）') && f1.labels.includes('元件高度(max)(mm)（TH/ME 頁）'), f1.labels);
  ok('來源值顯示正確、徽章出得來', f1.spec2.join(',') === '20×15,4.2' && f1.badge, f1);

  const f2 = await page.evaluate(() => {
    // 這一列是 Putty＋自動帶入 → 套用元件大小要觸發原本的連動（凸台同步元件大小）
    thermalSpecs['Final_PA'] = { timType: 'Putty', padAuto: true, bossSizeType: '自動帶入' };
    sgRefSyncOpen('RF', 0);
    sgRefSyncAll(true);
    sgRefSyncApply();
    return { spec: JSON.parse(JSON.stringify(thermalSpecs['Final_PA'] || {})),
             closed: document.getElementById('sg-refsync-modal').style.display === 'none' };
  });
  ok('勾選套用後寫進 thermalSpecs', f2.spec.heatSourceSize === '20×15' && f2.spec.heatSourceHeight === '4.2', f2);
  ok('元件大小的自動連動照舊（Putty 自動帶入 → 凸台同步）', f2.spec.bossSize === '20×15', f2);
  ok('套用後視窗關閉', f2.closed, f2);

  const f3 = await page.evaluate(() => sgRefDiff(sgProjectData.rf_data[0], 'RF').filter(d => d.spec2).length);
  ok('套用後這兩欄不再出現在差異清單', f3 === 0, f3);

  console.log('\n[G] 兩頁不同專案 → 不比對這兩欄（不誤報）');
  const g = await page.evaluate(() => {
    currentProjectId = 'C';                     // TH/ME 頁切到別的專案
    thermalSpecs = {};                          // 案C 沒有這顆元件
    const diff = sgRefDiff(sgProjectData.rf_data[0], 'RF');
    return { spec2: diff.filter(d => d.spec2).length, total: diff.length };
  });
  ok('spec2 欄位整組跳過', g.spec2 === 0, g);

  console.log('\n[H] Tab1 換專案 → 暫存一起清掉');
  const h = await page.evaluate(async () => {
    sgPendingSpec2 = { B: { 'Final_PA': { heatSourceSize: '20×15' } } };
    const sel = document.getElementById('sg-project-select');
    sel.innerHTML = '<option value="">--</option>';
    sel.value = '';
    await sgOnProjectChange();
    return Object.keys(sgPendingSpec2).length;
  });
  ok('換專案後暫存清空', h === 0, h);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
