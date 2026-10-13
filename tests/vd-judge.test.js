/*
 * 模擬與實驗驗證（Tab3）誤差判定 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 規則與 Thermal-Test-Report-Builder「比對頁」相同：
 *   溫度以溫升為基準：溫升誤差% = (模擬校正 − 實測) ÷ (實測 − Ta) × 100
 *     ✅ |%| ≤ 10% 或 |溫差| ≤ 2°C；⚠ ≤ 20% 或 ≤ 4°C；❌ 其餘（實測溫升 ≤ 0 → 只看溫差）
 *   Pd：Pd 誤差% = (估值 − 實測) ÷ 實測 × 100；對溫度影響 ≈ Pd 誤差% × 實測溫升
 *     ✅ |%| ≤ 10% 或 影響 ≤ 2°C；⚠ ≤ 20% 或 ≤ 4°C；❌ 其餘（沒有實測溫升 → 只看 %）
 * 驗證情境：
 *   [A] 計算與判定（含低溫升下限、實測不高於 Ta、Pd 對溫度影響、Pd 來源 常溫/高溫）
 *   [B] 比對環溫 Ta：預設取專案環溫（含自訂、Tab1 同專案記憶體值）；✂ 手動指定 → 存成 vd_ta；↺ 改回 → 寫 null 清掉
 *   [C] 未解鎖時 Ta 的按鈕跟著鎖
 *   [D] 匯出 Excel：計算欄有值、Pd 依選的來源、附「判定規則」工作表
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/vd-judge.test.js
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
const near = (a, b, tol = 0.05) => a !== null && Math.abs(a - b) <= tol;

// [名稱, Pd估, Pd實測, 初始模擬, 實測, 模擬校正]
const ROWS = [
  ['U5000', 23, 23.8, 87.4, 84.4, 87.4],     // 溫差 3.0、溫升 29.4 → 10.2% → ⚠（舊規則 3.6% 綠）
  ['U3009', 23, 23.8, 88.7, 86.1, 88.7],     // 2.6 / 31.1 → 8.4% → ✅
  ['U2200', 1.94, 1.668, 83.9, 82.2, 83.9],  // Pd 16.3%、影響 4.4°C → ⚠
  ['U2250', 2.85, 2.112, 90.3, 86.2, 90.3],  // Pd 34.9% → ❌；溫度 4.1 / 31.2 → 13.1% → ⚠
  ['U2202', 0.06, 0.05, '', '', ''],         // Pd 20% 沒溫度 → ⚠（舊規則紅）
  ['LOWRISE', 1, 1, 60, 60, 61.5],           // 溫升 5、溫差 1.5 → 30% 但 ≤ 2°C → ✅
  ['COLD', 1, 1, 50, 50, 54],                // 實測 ≤ Ta → 沒有 %，溫差 4 → ⚠
  ['SMALLP', 0.2, 0.15, 70, 62, 62.5],       // Pd 33% 但影響 33%×7 = 2.3°C → ⚠（不是 ❌）
];
const PROJ = () => ({
  project_name: 'Demo', param_temp: '55', rf_data: [], pwr_data: [],
  digital_data: ROWS.map(r => ({ Component: r[0], Qty: 1, 'Power(W)': r[1], ...(r[0] === 'U2202' ? { 'Power_RT(W)': 0.05 } : {}) })),
  validation_data: { digital: ROWS.map(r => ({ component: r[0], qty: 1, pd_est: r[1], pd_est_rt: 0, pd_source: 'hot', pd_meas: r[2],
    temp_sim: r[3], temp_meas: r[4], temp_sim_cal: r[5], note: '' })) },
  vd_hidden_components: Object.fromEntries(ROWS.map(r => ['digital|' + r[0], false])),
});

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.route('**', r => r.request().url().startsWith(BASE.replace(/index\.html$/, '')) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.alert = () => {}; window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof vdRowCalc === 'function' && typeof saveAllTabs === 'function' && window.CompMerge);

  const seed = (projects) => page.evaluate((projects) => {
    window.__db = { projects: JSON.parse(JSON.stringify(projects)) };
    isProtected = false;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.releaseLock = async () => {};
    dbAdapter.writeBatch = async (ops) => {
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      plan.forEach(({ o, f }) => { window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f))); });
    };
    window._ensureLockBeforeWrite = async () => true;
    sgProjectId = null; sgProjectData = null; currentProjectId = null; currentProjectData = null;
  }, projects);
  const loadTab3 = () => page.evaluate(async () => {
    const s = document.getElementById('vd-project-select');
    s.innerHTML = '<option value="">--</option><option value="X">X</option>'; s.value = 'X';
    await vdOnProjectChange(); switchTab('validation');
  });
  const calc = () => page.evaluate(() => Object.fromEntries(vdValidationData.digital.map(i => [i.component, vdRowCalc(i, vdTa())])));
  const cell = (name, col) => page.evaluate(([name, col]) => {
    const tr = [...document.querySelectorAll('#vd-container .vd-table tbody tr')].find(r => r.cells[0].textContent.trim() === name);
    return tr ? { text: tr.cells[col].textContent.trim(), cls: tr.cells[col].className } : null;
  }, [name, col]);

  console.log('\n[A] 計算與判定');
  await seed({ X: PROJ() });
  await loadTab3();
  let C = await calc();
  ok('U5000：溫升 29.4、溫差 3.0 → 溫升誤差 10.2% → ⚠', near(C.U5000.measRise, 29.4) && near(C.U5000.tempDiff, 3.0) && near(C.U5000.tempErr, 10.2, 0.05) && C.U5000.tempJudge === 'warn', C.U5000);
  ok('U3009：8.4% → ✅', near(C.U3009.tempErr, 8.36, 0.05) && C.U3009.tempJudge === 'good', C.U3009);
  ok('U2250：溫度 13.1% → ⚠、Pd 34.9% → ❌', near(C.U2250.tempErr, 13.14, 0.05) && C.U2250.tempJudge === 'warn' && near(C.U2250.pdErr, 34.94, 0.05) && C.U2250.pdJudge === 'bad', C.U2250);
  ok('Pd 誤差%＝(估值−實測)÷實測：U5000 −3.4%、對溫度影響 −1.0°C → ✅', near(C.U5000.pdErr, -3.36, 0.05) && near(C.U5000.pdImpact, -0.99, 0.05) && C.U5000.pdJudge === 'good', C.U5000);
  ok('U2200：Pd 16.3%、影響 ≈ 4.4°C → ⚠', near(C.U2200.pdErr, 16.31, 0.05) && near(C.U2200.pdImpact, 4.44, 0.05) && C.U2200.pdJudge === 'warn', C.U2200);
  ok('U2202：沒有溫度 → 只看 %：20% → ⚠（不是 ❌）', near(C.U2202.pdErr, 20, 0.01) && C.U2202.pdImpact === null && C.U2202.pdJudge === 'warn' && C.U2202.tempJudge === null, C.U2202);
  ok('低溫升：30% 但溫差 1.5°C ≤ 2°C → ✅', near(C.LOWRISE.tempErr, 30, 0.01) && C.LOWRISE.tempJudge === 'good', C.LOWRISE);
  ok('實測不高於 Ta：不算 %，只看溫差 4°C → ⚠', C.COLD.tempErr === null && near(C.COLD.tempDiff, 4) && C.COLD.tempJudge === 'warn', C.COLD);
  ok('小功率：Pd 33% 但對溫度影響 2.3°C → ⚠（不是 ❌）', near(C.SMALLP.pdErr, 33.3, 0.1) && near(C.SMALLP.pdImpact, 2.33, 0.05) && C.SMALLP.pdJudge === 'warn', C.SMALLP);
  let c1 = await cell('U5000', 7), c2 = await cell('U5000', 8), c3 = await cell('U2250', 3);
  ok('畫面：溫升誤差格顯示 % 與溫升、兩個溫度格同色（⚠ 橘）', /10\.2%/.test(c1.text) && /溫升 29\.4°C/.test(c1.text) && /vd-err-orange/.test(c1.cls) && /vd-err-orange/.test(c2.cls), { c1, c2 });
  ok('畫面：Pd 格顯示對溫度影響、❌ 紅', /34\.9%/.test(c3.text) && /≈ \+10\.9°C/.test(c3.text) && /vd-err-red/.test(c3.cls), c3);
  ok('判定規則在表格容器裡、寫出與比對頁相同', await page.evaluate(() => { const r = document.querySelector('#vd-container .vd-rules'); return !!r && /比對頁/.test(r.textContent) && /溫升為基準/.test(r.textContent); }));
  await page.evaluate(() => { const it = vdValidationData.digital.find(i => i.component === 'U2202'); it.pd_est_rt = 0.05; it.pd_source = 'rt'; });
  C = await calc();
  ok('Pd 來源選「常溫」→ 用常溫估值', near(C.U2202.pdErr, 0, 0.001) && C.U2202.pdJudge === 'good', C.U2202);

  console.log('\n[B] 比對環溫 Ta');
  ok('預設取專案環溫 55°C（沒有手動值）', await page.evaluate(() => vdTa() === 55 && vdTaManual === null));
  await page.click('#vd-container .vd-ta-btn');
  ok('✂ 手動指定：出現輸入框、帶入目前的 55', await page.evaluate(() => document.getElementById('vd-ta-input')?.value === '55' && vdTaManual === 55));
  await page.fill('#vd-ta-input', '25'); await page.dispatchEvent('#vd-ta-input', 'change');
  C = await calc();
  ok('改成 25°C → 溫升重算（U5000：59.4°C、5.1% → ✅）', near(C.U5000.measRise, 59.4) && near(C.U5000.tempErr, 5.05, 0.05) && C.U5000.tempJudge === 'good', C.U5000);
  ok('算成有未存變更', await page.evaluate(() => hasUnsavedEdits()));
  await page.evaluate(() => saveAllTabs());
  let db = await page.evaluate(() => window.__db.projects.X);
  ok('存檔：vd_ta = 25 寫進專案', db.vd_ta === 25, db.vd_ta);
  await loadTab3();
  ok('重新載入：還是 25（手動）', await page.evaluate(() => vdTaManual === 25 && vdTa() === 25));
  await page.click('#vd-container .vd-ta-btn');   // ↺ 取專案環溫
  ok('↺ 取專案環溫：回到 55', await page.evaluate(() => vdTaManual === null && vdTa() === 55 && !document.getElementById('vd-ta-input')));
  await page.evaluate(() => saveAllTabs());
  db = await page.evaluate(() => window.__db.projects.X);
  ok('存檔：vd_ta 寫 null 清掉舊值', db.vd_ta === null, db.vd_ta);
  await page.evaluate(() => { window.__db.projects.X.param_temp = 'custom'; window.__db.projects.X.param_temp_custom = '45'; });
  await loadTab3();
  ok('專案環溫是自訂 45°C → Ta = 45', await page.evaluate(() => vdTa() === 45));
  await page.evaluate(async () => { sgProjectId = 'X'; sgProjectData = await dbAdapter.getDoc('projects', 'X'); sgProjectData.param_temp = '35'; vdRender(); });
  ok('Tab1 同專案、環溫還沒存 → 用 Tab1 記憶體裡的 35', await page.evaluate(() => vdTa() === 35 && /35°C/.test(document.querySelector('.vd-ta-val').textContent)));
  await page.evaluate(() => { sgProjectId = null; sgProjectData = null; });

  console.log('\n[C] 未解鎖時 Ta 的按鈕跟著鎖');
  await page.evaluate(() => { isProtected = true; vdRender(); });
  ok('未解鎖：✂ 手動指定 停用', await page.evaluate(() => document.querySelector('#vd-container .vd-ta-btn').disabled));
  await page.evaluate(() => { isProtected = false; vdRender(); });

  console.log('\n[D] 匯出 Excel');
  await seed({ X: PROJ() });
  await loadTab3();
  const xl = await page.evaluate(() => {
    const sheets = {};
    const keep = window.XLSX;
    window.XLSX = { utils: { book_new: () => ({}), aoa_to_sheet: (aoa) => aoa, book_append_sheet: (wb, ws, n) => { sheets[n] = ws; } }, writeFile() {} };
    try { vdExportExcel(); } finally { window.XLSX = keep; }
    return sheets;
  });
  const dg = xl.Digital || [], hdr = dg[0] || [], u = dg.find(r => r[0] === 'U2250') || [];
  const col = n => u[hdr.indexOf(n)];
  ok('計算欄有值（原本匯出是空白）：Pd誤差% 34.9、溫升誤差% 13.1、判定文字', col('Pd誤差%') === 34.9 && col('溫升誤差%') === 13.1 && col('實測溫升(°C)') === 31.2 && /❌/.test(col('Pd判定')) && /⚠/.test(col('溫度判定')), u);
  ok('附「判定規則」工作表（含 Ta 來源）', Array.isArray(xl['判定規則']) && xl['判定規則'].some(r => /55°C/.test(r[1]) && /專案環溫/.test(r[1])), xl['判定規則']);

  ok('頁面無 JS 例外', errors.length === 0, errors);
  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
