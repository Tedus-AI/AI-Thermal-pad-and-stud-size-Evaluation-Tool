/*
 * 凸台&TIM尺寸速算（Tab4）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 驗證情境：
 *   [A] 凸台高度 t 只有 > 5W 才納入計算：≤ 5W 真的停用（不可輸入、反灰、清空）；> 5W 自動打開且必填；
 *       來回切換不丟使用者填的值
 *   [B] 輸入檢查：空白不可當 0 算（L 空白原本算出「0 × 10 mm」、> 5W 沒填 t 原本算出 45 度法則＝IC 尺寸）；
 *       負值／0 擋下；結果顯示「—」並說明要補哪一格
 *   [C] 公式：正方形／依外型／最小 6×6／Pad 分級／特殊規格／45 度法則；
 *       最小加工尺寸「每一邊」都 ≥ 6mm（8×3 → 8×6，原本給 8×3）
 *   [D] TH/ME 頁的 Pad 自動帶入與速算頁同一套公式（calcBossResult）
 *   [E] 高功率徽章不用紅色（紅色保留給 Fail/錯誤）；TH/ME 頁已移除過時的「資料庫既有／本工具新增」圖例
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/calc-tab.test.js
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
  await page.setViewportSize({ width: 1536, height: 900 });
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
  await page.waitForFunction(() => typeof calc === 'function' && typeof calcBossResult === 'function' && typeof applyPadAutoCalcData === 'function');
  await page.evaluate(() => switchTab('calc'));

  // 一次設定多格（依序 fill，與使用者逐格輸入一樣觸發 oninput）
  const set = async (vals) => { for (const [k, v] of Object.entries(vals)) await page.fill('#' + k, String(v)); };
  const state = () => page.evaluate(() => {
    const t = document.getElementById('t');
    const err = id => { const f = document.getElementById(id).closest('.field'); return f.classList.contains('invalid') ? (f.querySelector('.field-err') || {}).textContent : ''; };
    return { badge: document.getElementById('power-badge').textContent, badgeCls: document.getElementById('power-badge').className,
      boss: document.getElementById('boss-result').textContent, pad: document.getElementById('pad-result').textContent,
      note: document.getElementById('note-result').textContent, tDis: t.disabled, tVal: t.value,
      errL: err('L'), errW: err('W'), errP: err('P'), errT: err('t') };
  });

  console.log('\n[A] 凸台高度 t：≤ 5W 停用、> 5W 打開且必填');
  let S = await state();
  ok('初始 5W：t 停用、空白（不再預填 5）', S.tDis && S.tVal === '' && /低功率/.test(S.badge), S);
  await set({ P: 8 });
  S = await state();
  ok('> 5W：t 自動打開、空白 → 紅框「必填」、結果不算（—）', !S.tDis && S.errT === '必填' && S.boss === '—' && S.pad === '—' && /凸台高度 t（必填）/.test(S.note), S);
  await set({ t: 3 });
  S = await state();
  ok('填 t = 3 → 16 × 16 mm（45 度法則）、淨空 3 mm', S.boss === '16 × 16 mm（45 度法則）' && /覆蓋 10 × 10 mm/.test(S.pad) && /淨空區寬度為 3 mm/.test(S.note) && !S.errT, S);
  await set({ P: 4 });
  S = await state();
  ok('改回 ≤ 5W：t 停用並清空（不被誤認為有採用）、結果回到低功率公式', S.tDis && S.tVal === '' && S.boss === '10 × 10 mm（正方形）' && !S.errT, S);
  ok('停用時真的不能輸入', await page.evaluate(() => { const t = document.getElementById('t'); return t.disabled && getComputedStyle(t).cursor === 'not-allowed'; }));
  await set({ P: 9 });
  S = await state();
  ok('再回到 > 5W：剛剛填的 3 放回來、直接算出結果', !S.tDis && S.tVal === '3' && S.boss === '16 × 16 mm（45 度法則）', S);
  await set({ P: 5 });
  ok('P = 5 剛好算低功率（≤ 5W）、t 停用', (await state()).tDis);

  console.log('\n[B] 輸入檢查');
  await set({ L: '' });
  S = await state();
  ok('L 空白 → 紅框「必填」、結果「—」（原本算出 0 × 10 mm）', S.errL === '必填' && S.boss === '—' && /IC 長度 L（必填）/.test(S.note), S);
  await set({ L: 0 });
  ok('L = 0 → 「須大於 0」', (await state()).errL === '須大於 0');
  await set({ L: 10, P: '' });
  S = await state();
  ok('P 空白 → 「必填」、徽章「請輸入功率」（原本當 0W 算成低功率）', S.errP === '必填' && S.badge === '請輸入功率' && S.boss === '—', S);
  await set({ P: -3 });
  S = await state();
  ok('P 負值 → 「不可為負值」、t 維持停用', S.errP === '不可為負值' && S.badge === '功率不可為負值' && S.tDis, S);
  await set({ P: 8, t: -1 });
  S = await state();
  ok('t 負值 → 「須大於 0」', S.errT === '須大於 0' && S.boss === '—', S);
  await set({ t: 2 });
  ok('修正後紅框消失', await page.evaluate(() => !document.querySelector('#tab-calc .field.invalid')));

  console.log('\n[C] 低功率公式');
  const low = async (L, W) => { await set({ P: 2, L, W }); return state(); };
  S = await low(10, 10);  ok('10×10 → 10 × 10 正方形、Level B', S.boss === '10 × 10 mm（正方形）' && S.pad === 'Level B：10 × 10 mm', S);
  S = await low(10, 9);   ok('10×9（差 ≤ 1.5）→ 10 × 10 正方形', S.boss === '10 × 10 mm（正方形）', S);
  S = await low(12, 8);   ok('12×8（差 > 1.5）→ 12 × 8 依 IC 外型、Level C', S.boss === '12 × 8 mm（依 IC 外型）' && S.pad === 'Level C：14 × 14 mm', S);
  S = await low(5.5, 5);  ok('5.5×5 → 6 × 6 最小極限、Level A', S.boss === '6 × 6 mm（最小極限）' && S.pad === 'Level A：6 × 6 mm', S);
  S = await low(8, 3);    ok('8×3 → 8 × 6（短邊補到 6mm；原本給 8×3、低於最小加工尺寸）', S.boss === '8 × 6 mm（依 IC 外型，短邊補到 6mm）' && S.pad === 'Level B：10 × 10 mm', S);
  S = await low(16, 8);   ok('16×8 → 特殊規格（長邊 > 14mm）', S.boss === '16 × 8 mm（依 IC 外型）' && S.pad === '特殊規格（長邊 > 14mm）', S);

  console.log('\n[D] TH/ME 頁 Pad 自動帶入同一套公式');
  const D = await page.evaluate(() => {
    const r = [calcBossResult(10, 10), calcBossResult(8, 3), calcBossResult(5, 5), calcBossResult(12, 8), calcBossResult(20, 20)];
    currentProjectData = { digital_data: [{ Component: 'NARROW', 'Power(W)': 2 }, { Component: 'HOT', 'Power(W)': 8 }], rf_data: [], pwr_data: [] };
    thermalSpecs = { NARROW: { heatSourceSize: '8×3' }, HOT: { heatSourceSize: '10×10' } };
    applyPadAutoCalcData('NARROW'); applyPadAutoCalcData('HOT');
    return { r, narrow: thermalSpecs.NARROW, hot: thermalSpecs.HOT };
  });
  ok('calcBossResult：10×10 → 10×10／10×10、8×3 → 8×6／10×10、5×5 → 6×6／6×6、12×8 → 12×8／14×14、20×20 → 20×20／（特殊）',
    JSON.stringify(D.r) === JSON.stringify([{ bossSize: '10×10', timSize: '10×10' }, { bossSize: '8×6', timSize: '10×10' }, { bossSize: '6×6', timSize: '6×6' }, { bossSize: '12×8', timSize: '14×14' }, { bossSize: '20×20', timSize: '' }]), D.r);
  ok('TH/ME 頁 8×3、2W → 凸台自動帶入 8×6（與速算頁一致）；> 5W 不自動算', D.narrow.bossSize === '8×6' && D.narrow.bossSizeType === '自動帶入' && !D.hot.bossSize, D);

  console.log('\n[E] 顏色與圖例');
  await set({ P: 8, t: 2 });
  const E = await page.evaluate(() => {
    const b = document.getElementById('power-badge'); const c = getComputedStyle(b).color.match(/\d+/g).map(Number);
    return { cls: b.className, rgb: c, legend: !!document.getElementById('comp-legend'), legendText: /本工具新增/.test(document.body.innerHTML) };
  });
  ok('高功率徽章是琥珀色（不是 Fail 紅）', E.cls === 'power-badge high' && E.rgb[0] > 120 && E.rgb[1] > 50 && E.rgb[2] < 40, E);
  ok('TH/ME 頁已移除「資料庫既有（唯讀）／本工具新增（可編輯）」圖例', !E.legend && !E.legendText, E);

  ok('頁面無 JS 例外', errors.length === 0, errors);
  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
