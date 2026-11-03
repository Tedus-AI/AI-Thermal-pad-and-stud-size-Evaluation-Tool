/*
 * TH/ME 頁：TIM Type 選 None → 凸台大小／凸台表面處理／TIM 厚度／TIM Size 反灰「不適用」—— headless 驗證
 * ---------------------------------------------------------------------------
 * 使用者要求：元件的 TIM Type 選 None（不使用介面材料）時，這四欄直接屏蔽反灰。
 *
 * 驗證情境：
 *   [A] None 的那一列：四格 td.tim-na-cell、顯示「不適用」、沒有任何輸入框／下拉；滑過列時仍是灰底
 *   [B] tooltip 寫出保留下來的原值；沒有原值就不提
 *   [C] 其他 TIM 類型（Pad／Grease）、還沒選（—）照舊可編輯；IC 距離 HSK 在 None 時仍可編輯
 *   [D] 從 Pad 改選 None → 立刻反灰、原值留在 thermal_specs（不刪）；再改回 Grease → 恢復可編輯
 *   [E] 匯出（Excel／PDF 共用的 collectExportDataByCategory）：四欄寫「不適用」，與畫面一致
 *   [F] 只是顯示：載入 None 的專案不會變成未存變更；1536 寬沒有橫向捲軸
 *
 * 執行：
 *   python3 -m http.server 8125 --bind 127.0.0.1 &   # 於 repo 根目錄（或 npx http-server . -p 8125 -c-1）
 *   node tests/tim-none-na.test.js                   # 可用 TEST_URL 指定網址、CHROMIUM_PATH 指定瀏覽器
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const BASE = process.env.TEST_URL || 'http://127.0.0.1:8125/index.html';
const EXEC = process.env.CHROMIUM_PATH || '';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const PROJ = () => ({
  project_name: 'TIM None', global_params: {},
  rf_data: [
    { Component: 'Cavity Filter', Qty: 1, 'Power(W)': 8 },          // None，有舊值
    { Component: 'Circulator', Qty: 4, 'Power(W)': 1.5 },           // None，沒有舊值
    { Component: 'Final PA', Qty: 2, 'Power(W)': 30 },              // Pad
    { Component: 'LNA', Qty: 4, 'Power(W)': 0.3 },                  // 還沒選 TIM
  ],
  digital_data: [{ Component: 'DDR4', Qty: 2, 'Power(W)': 0.8 }],  // Pad → 測試中改 None
  pwr_data: [],
  thermal_specs: {
    'Cavity_Filter': { heatSourceSize: '120×80', timType: 'None', bossSizeType: '自訂', bossSize: '100×60',
                       bossSurface: '表面刻花', timThickness: '0.5', heatDirection: 'Metal Face', icToHSK: '直觸' },
    'Circulator':    { heatSourceSize: '10×10', timType: 'None', heatDirection: 'Metal Face' },
    'Final_PA':      { heatSourceSize: '20×10', timType: 'Pad', padAuto: true, bossSizeType: '自訂', bossSize: '22×12',
                       bossSurface: '表面光滑', timThickness: '2.5', timSize: '22×12', heatDirection: 'Copper Coin', icToHSK: '1.7' },
    'DDR4':          { heatSourceSize: '7.5×13.5', timType: 'Pad', padAuto: true, bossSizeType: '自動帶入', bossSize: '8×14',
                       bossSurface: '表面光滑', timThickness: '2.5', timSize: '8×14', heatDirection: 'IC top', icToHSK: '1.7' },
  },
});

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 900 });
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
  await page.waitForFunction(() => typeof renderAllCategories === 'function' && typeof timNaFor === 'function');

  await page.evaluate((proj) => {
    window.__db = { projects: { X: proj }, tim_library: {} };
    isProtected = false;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    sgProjectId = null; sgProjectData = null; currentProjectId = null; currentProjectData = null;
  }, PROJ());
  await page.evaluate(async () => {
    const s = document.getElementById('project-select');
    s.innerHTML = '<option value="">--</option><option value="X">X</option>'; s.value = 'X';
    await onProjectChange(); switchTab('complist');
    await new Promise(r => setTimeout(r, 50));
  });

  const COLS = ['boss-size-col', 'boss-surface-col', 'tim-thickness-col', 'tim-size-col'];
  const rowOf = (key) => page.evaluate(([key, COLS]) => {
    const tr = document.querySelector('#comp-container tr[data-speckey="' + key + '"]');
    if (!tr) return null;
    const cell = (cls) => {
      const td = tr.querySelector('td.' + cls);
      return { na: td.classList.contains('tim-na-cell'), text: td.textContent.trim(),
               inputs: td.querySelectorAll('input, select, button').length, tip: td.getAttribute('title') || '',
               bg: getComputedStyle(td).backgroundColor };
    };
    const ic = tr.querySelector('td.ic-hsk-col');
    return { cells: COLS.map(cell), icInputs: ic.querySelectorAll('select, input, button').length,
             timType: tr.querySelector('select[data-field="timType"]').value };
  }, [key, COLS]);

  console.log('\n[A] None 的列：四欄反灰「不適用」');
  const a = await rowOf('Cavity_Filter');
  ok('四格都是 tim-na-cell、顯示「不適用」', a && a.cells.every(c => c.na && c.text === '不適用'), a && a.cells);
  ok('四格裡沒有任何輸入框／下拉／✂', a && a.cells.every(c => c.inputs === 0), a && a.cells.map(c => c.inputs));
  ok('灰底（反灰）', a && a.cells.every(c => c.bg === 'rgb(238, 240, 243)'), a && a.cells.map(c => c.bg));
  await page.hover('#comp-container tr[data-speckey="Cavity_Filter"] td.name-cell');
  const aHover = await page.evaluate(() => getComputedStyle(document.querySelector('#comp-container tr[data-speckey="Cavity_Filter"] td.boss-size-col')).backgroundColor);
  ok('滑過那一列時仍是灰底（不被 hover 底色蓋掉）', aHover === 'rgb(238, 240, 243)', aHover);
  ok('IC 距離 HSK 不在此列（仍可編輯）', a && a.icInputs > 0, a);

  console.log('\n[B] tooltip 寫出保留的原值');
  ok('凸台大小 tooltip 寫出原值 100×60、說明沒有刪除', /None/.test(a.cells[0].tip) && /100×60/.test(a.cells[0].tip) && /沒有刪除/.test(a.cells[0].tip), a.cells[0].tip);
  ok('表面處理／TIM 厚度 tooltip 寫出原值', /表面刻花/.test(a.cells[1].tip) && /「0\.5」/.test(a.cells[2].tip), [a.cells[1].tip, a.cells[2].tip]);
  const b = await rowOf('Circulator');
  ok('沒有原值的列：反灰、tooltip 不提原值', b && b.cells.every(c => c.na && !/原本的值/.test(c.tip) && /不適用/.test(c.tip)), b && b.cells.map(c => c.tip));

  console.log('\n[C] 其他 TIM 類型照舊');
  const c1 = await rowOf('Final_PA');
  ok('Pad：四欄都不是 tim-na-cell、仍有輸入或鎖定值', c1 && c1.cells.every(c => !c.na) && c1.cells.some(c => c.inputs > 0), c1 && c1.cells);
  const c2 = await rowOf('LNA');
  ok('還沒選 TIM（—）：不反灰（只有 None 才屏蔽）', c2 && c2.cells.every(c => !c.na), c2 && c2.cells);

  console.log('\n[D] Pad → None → Grease');
  await page.evaluate(() => {
    const sel = document.querySelector('#comp-container tr[data-speckey="DDR4"] select[data-field="timType"]');
    sel.value = 'None'; onTimTypeChange(sel);
  });
  const d1 = await rowOf('DDR4');
  const d1s = await page.evaluate(() => JSON.parse(JSON.stringify(thermalSpecs.DDR4)));
  ok('改選 None 立刻反灰', d1 && d1.timType === 'None' && d1.cells.every(c => c.na && c.inputs === 0), d1 && d1.cells);
  ok('原值留在 thermal_specs（凸台大小／表面處理／TIM 厚度不刪）',
     d1s.bossSize === '8×14' && d1s.bossSurface === '表面光滑' && d1s.timThickness === '2.5', d1s);
  await page.evaluate(() => {
    const sel = document.querySelector('#comp-container tr[data-speckey="DDR4"] select[data-field="timType"]');
    sel.value = 'Grease'; onTimTypeChange(sel);
  });
  const d2 = await rowOf('DDR4');
  ok('改回 Grease → 恢復可編輯（不再反灰）', d2 && d2.timType === 'Grease' && d2.cells.every(c => !c.na) && d2.cells.some(c => c.inputs > 0), d2 && d2.cells);

  console.log('\n[E] 匯出與畫面一致');
  const e = await page.evaluate(() => {
    const cats = collectExportDataByCategory();
    const rows = cats.flatMap(c => c.rows);
    const pick = (n) => { const r = rows.find(x => x.component === n); return r && [r.bossSize, r.bossSurface, r.timThickness, r.timSize, r.timType, r.icToHSK]; };
    return { cf: pick('Cavity Filter'), cir: pick('Circulator'), pa: pick('Final PA') };
  });
  ok('None：四欄匯出「不適用」（不輸出保留的舊值）', e.cf && e.cf.slice(0, 4).every(v => v === '不適用') && e.cf[4] === 'None', e.cf);
  ok('None：IC 距離 HSK 照常匯出', e.cf && e.cf[5] === '直觸', e.cf);
  ok('None（沒有舊值）也是「不適用」', e.cir && e.cir.slice(0, 4).every(v => v === '不適用'), e.cir);
  ok('Pad 照常匯出原值', e.pa && e.pa[0] === '22×12' && e.pa[1] === '表面光滑' && e.pa[2] === '2.5' && e.pa[3] === '22×12', e.pa);

  console.log('\n[F] 只是顯示：不產生未存變更；1536 寬沒有橫向捲軸');
  const f = await page.evaluate(async () => {
    const s = document.getElementById('project-select');
    s.value = 'X'; await onProjectChange();
    return { dirty: hasUnsavedEdits(), filter: JSON.parse(JSON.stringify(thermalSpecs.Cavity_Filter)) };
  });
  ok('重新載入 None 的專案 → 沒有未存變更', f.dirty === false, f);
  ok('資料原封不動', f.filter.bossSize === '100×60' && f.filter.timThickness === '0.5', f.filter);
  await page.setViewportSize({ width: 1536, height: 864 });
  await page.waitForTimeout(80);
  const over = await page.evaluate(() => {
    const de = document.documentElement;
    const wraps = [...document.querySelectorAll('#comp-container .comp-table-wrap')].filter(w => w.offsetParent);
    return { page: de.scrollWidth - de.clientWidth, wraps: wraps.map(w => w.scrollWidth - w.clientWidth).filter(d => d > 0) };
  });
  ok('1536：頁面與表格都沒有橫向捲軸', over.page <= 0 && over.wraps.length === 0, over);

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
