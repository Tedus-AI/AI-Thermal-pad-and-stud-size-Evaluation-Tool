/*
 * Thermal Via 計算頁（原獨立工具 thermal-via-calculator 移植）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 驗證情境：
 *   [A] 頁籤位置：在「凸台&TIM尺寸速算」與「使用者建議與改善」之間；右側工具列有切換鈕
 *   [B] 納入條件：TH Via 內徑、TH Via Qty（EE 清單）、主散熱路徑 Thermal Via（TH/ME 頁）任一個；
 *       不看 5G-RRU 的導熱方式（TH/ME 頁沒選、EE 清單 N/A、只有 5G-RRU 設了 Thermal Via → 不納入）；N/A／空白不算；
 *       不再符合條件但有 via 資料 → 列在最下面（資料保留）
 *   [C] 未完善提示：摘要計數、待完善清單（缺哪些欄位）、分頁徽章數字；點清單跳到該元件
 *   [D] 有來源的欄位：Via 數量／內徑鎖定取 EE 清單（白底黑字＋✂）；✂ → 試算值（提醒與 EE 清單不同）；
 *       ↺ 取回；EE 頁沒載入（四頁同步後只剩讀取失敗這種情況）時「寫回 EE 清單」停用，載入後可寫回（寫進 EE 頁的元件、刪掉試算值）
 *   [E] E-PAD 與 TH/ME 頁同一欄；TH/ME 頁沒填時暫用 5G-RRU 的 E-Pad 長寬（鎖定＋✂）；
 *       PCB 厚度鎖定取 EE/RF/PWR 頁該分類的 PCB 板厚（還沒存的也算、改了跟著重畫），沒設定才取 5G-RRU 參數 t_PCB，兩邊都沒有時必填
 *   [F] 計算：K_eff／R_th 與 viaCalc 一致；穿板溫降＝P × R_th；5G-RRU K_Via 比較
 *   [G] 自動間距：排得下、寫回（mil 取 0.1）、訊息；放不下時給最多顆數；手動間距太大／太小 → 干涉錯誤、徽章計數
 *   [H] 打字中不重繪表單（同一個 input、游標不跳）；提交後焦點留在下一格
 *   [I] 存檔：只看不改不算未存變更；改了算；存檔寫進 thermal_specs[元件].via；計算結果不存；
 *       在 EE 頁改名 → via 資料跟著搬、選取跟著走
 *   [J] 未解鎖（唯讀）：輸入停用、元件清單／單位切換／換算仍可用
 *   [K] 版面：1920／1536／1366 沒有橫向捲軸；匯出 Excel 有每顆元件一列＋公式工作表
 *   [L] 暫不納入熱流評估：待完善清單每列可勾選 → 移出清單／計數／徽章、歸到「暫不納入」群組，via 資料保留；
 *       原因欄打字不跳游標；取消勾選恢復；未解鎖時勾選停用；存檔寫進 via.skip；匯出狀態；鍍銅厚度選項標成孔壁電鍍銅
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/via-tab.test.js
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

const PROJ = () => ({
  project_name: 'StarKcore-12L', global_params: { K_Via: 30, Via_Eff: 0.9, t_PCB: 1.6, Draft_Angle: 1.25 },
  rf_data: [
    { Component: 'Driver-RRU', Qty: 2, 'Power(W)': 4.2, TV_ID_mil: 'N/A', TV_Qty: 'N/A', Board_Type: 'Thermal Via', Pad_L: 9.8, Pad_W: 4.8 },
    { Component: 'PreDriver', Qty: 2, 'Power(W)': 0.6, TV_ID_mil: 8, TV_Qty: 9 },
    { Component: 'PA-Final', Qty: 2, 'Power(W)': 30, TV_ID_mil: 'N/A', TV_Qty: 'N/A', Board_Type: 'Copper Coin' },
    { Component: 'Stale-BT', Qty: 1, 'Power(W)': 1, TV_ID_mil: 'N/A', TV_Qty: '', Board_Type: 'Thermal Via' },
    { Component: 'RRU-Only', Qty: 1, 'Power(W)': 1, TV_ID_mil: 'N/A', TV_Qty: 'N/A', Board_Type: 'Thermal Via', Pad_L: 3, Pad_W: 3 },
  ],
  digital_data: [
    { Component: 'U850-Si5518', Qty: 1, 'Power(W)': 3.2, TV_ID_mil: 8, TV_Qty: 134 },
    { Component: 'FPGA', Qty: 1, 'Power(W)': 25, TV_ID_mil: 'N/A', TV_Qty: 'N/A' },
    { Component: 'Was-Via', Qty: 1, 'Power(W)': 0.5, TV_ID_mil: 'N/A', TV_Qty: 'N/A' },
  ],
  pwr_data: [
    { Component: 'Q6505', Qty: 1, 'Power(W)': 1.1, TV_ID_mil: 10, TV_Qty: 'N/A' },
    { Component: 'LDO-1', Qty: 1, 'Power(W)': 0.4, TV_ID_mil: '', TV_Qty: 4 },
  ],
  thermal_specs: {
    'U850-Si5518': { heatSourceSize: '12.5×12.5', heatDirection: 'Thermal Via', epadSize: '8.6*8.6', via: { fill: 'epoxy', pitchMil: 28 } },
    'PreDriver': { heatDirection: 'Thermal Via', epadSize: '1.6*1.6' },
    'Stale-BT': { heatDirection: 'IC top' },
    'Driver-RRU': { heatDirection: 'Thermal Via' },
    'FPGA': { heatDirection: 'Copper Coin' },
    'Was-Via': { via: { fill: 'air', pitchMil: 20 } },
  },
});

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
    // SheetJS 走 CDN（測試擋外網）→ 記錄匯出內容
    window.XLSX = { utils: { book_new: () => ({ sheets: [] }), aoa_to_sheet: (a) => ({ aoa: a }),
      book_append_sheet: (wb, ws, n) => wb.sheets.push({ n, aoa: ws.aoa }) }, writeFile: (wb, fn) => { window.__xlsx = { wb, fn }; } };
    try { localStorage.clear(); } catch (e) {}
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof viaRender === 'function' && window.ViaCalc && window.CompMerge && typeof saveAllTabs === 'function');

  await page.evaluate((proj) => {
    window.__db = { projects: { X: JSON.parse(JSON.stringify(proj)), Y: { project_name: 'Other', rf_data: [] } }, tim_library: {} };
    isProtected = false;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.refresh = async () => {};
    dbAdapter.getProjectsSorted = async () => [{ id: 'X', project_name: 'StarKcore-12L' }, { id: 'Y', project_name: 'Other' }];
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.releaseLock = async () => {};
    dbAdapter.writeBatch = async (ops) => {
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      plan.forEach(({ o, f }) => { window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f))); });
    };
    window._ensureLockBeforeWrite = async () => true;
  }, PROJ());

  const st = () => page.evaluate(() => {
    const items = [...document.querySelectorAll('#via-list .via-item')].map(b => ({
      name: b.querySelector('.vi-name').textContent, st: b.querySelector('.via-st').className.replace('via-st st-', ''),
      orphan: b.classList.contains('orphan'), skip: b.classList.contains('skip'), sel: b.classList.contains('sel') }));
    const todo = [...document.querySelectorAll('.via-todo .via-todo-go')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
    const skipped = [...document.querySelectorAll('.via-skipped .via-todo-go')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
    const badge = document.getElementById('via-tab-badge');
    return { items, todo, skipped, badge: badge.style.display === 'none' ? '' : badge.textContent,
      head: (document.getElementById('via-ed-head') || {}).textContent || '', out: (document.getElementById('via-out') || {}).textContent || '',
      form: (document.getElementById('via-form') || {}).textContent || '' };
  });
  const sel = (name) => page.evaluate(n => viaSelect(sgSpecKey(n)), name);

  console.log('\n[A] 頁籤位置');
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tab-btn')].map(b => b.childNodes[0].textContent.trim()));
  ok('Thermal Via 計算在「凸台&TIM尺寸速算」與「使用者建議與改善」之間', tabs[3] === '凸台&TIM尺寸速算' && tabs[4] === 'Thermal Via 計算' && /使用者建議與改善/.test(tabs[5]), tabs);
  await page.evaluate(() => switchTab('via'));
  ok('switchTab(via) → 第 5 顆按鈕 active、頁面顯示', await page.evaluate(() => document.querySelectorAll('.tab-btn')[4].classList.contains('active') && document.getElementById('tab-via').classList.contains('active')));
  await page.evaluate(() => switchTab('feedback'));
  ok('switchTab(feedback) 仍對到第 6 顆', await page.evaluate(() => document.querySelectorAll('.tab-btn')[5].classList.contains('active')));
  ok('回饋頁「發生分頁」下拉（表單＋列表篩選）都有「Thermal Via 計算」，排在「凸台&TIM尺寸速算」後面', await page.evaluate(() => {
    const lists = [document.getElementById('fb-tab-sel'), document.querySelector('.fb-filter-item select[onchange*="fbFilters.tab"]')];
    return lists.every(sel => { const o = sel ? [...sel.options].map(x => x.text) : []; const i = o.indexOf('Thermal Via 計算'); return i > 0 && o[i - 1] === '凸台&TIM尺寸速算'; });
  }));
  ok('右側工具列有「切換到 Thermal Via 計算」', await page.evaluate(() => !!document.querySelector('#gm-rail-body [data-tip="切換到 Thermal Via 計算"]')));
  await page.evaluate(() => switchTab('via'));
  ok('沒選專案 → 空白提示、匯出／儲存停用', await page.evaluate(() => !!document.querySelector('#via-container .empty-state') && document.getElementById('via-export-excel-btn').disabled && document.getElementById('via-save-btn').disabled));

  // 載入專案（與 TH/ME 頁同一個選單）
  await page.evaluate(async () => { await viaLoadProjects(); document.getElementById('via-project-select').value = 'X'; await viaOnProjectChange(); });
  ok('選專案 → 四個功能頁（EE/RF/PWR、TH/ME、模擬與實測驗證）一起載入同一個專案', await page.evaluate(() => currentProjectId === 'X' && sgProjectId === 'X' && vdProjectId === 'X'
    && ['project-select', 'sg-project-select', 'vd-project-select', 'via-project-select'].every(id => document.getElementById(id).value === 'X')));

  console.log('\n[B] 納入條件');
  let S = await st();
  const names = S.items.filter(i => !i.orphan).map(i => i.name);
  ok('納入：內徑+Qty、只有內徑、只有 Qty、主散熱路徑 Thermal Via（EE 清單 N/A 也算）',
    ['Driver-RRU', 'PreDriver', 'U850-Si5518', 'Q6505', 'LDO-1'].every(n => names.includes(n)) && names.length === 5, names);
  ok('不納入：全部 N/A、Copper Coin；TH/ME 頁選了 IC top 時不看 5G-RRU 殘留的 Thermal Via', !names.includes('PA-Final') && !names.includes('FPGA') && !names.includes('Stale-BT'));
  ok('不納入：EE 清單 N/A、TH/ME 頁沒選、只有 5G-RRU 的導熱方式是 Thermal Via（不看 5G-RRU）', !S.items.some(i => i.name === 'RRU-Only'), S.items.map(i => i.name));
  ok('不符合條件但有 via 資料 → 列在最下面（資料保留）', S.items.some(i => i.name === 'Was-Via' && i.orphan));
  await sel('Driver-RRU');
  S = await st();
  ok('納入原因標示：主散熱路徑（EE 清單 N/A 時）', /主散熱路徑 Thermal Via/.test(S.head) && !/TH Via 內徑|TH Via Qty/.test(S.head) && !/5G-RRU）/.test(S.head), S.head);
  await sel('U850-Si5518');
  S = await st();
  ok('納入原因標示：內徑＋Qty＋主散熱路徑', /TH Via 內徑 8 mil/.test(S.head) && /TH Via Qty 134/.test(S.head) && /主散熱路徑 Thermal Via/.test(S.head), S.head);

  console.log('\n[C] 未完善提示');
  S = await st();
  const todoNames = S.todo.map(t => t.split(' ').find(w => /[A-Za-z]/.test(w)));
  ok('待完善清單：缺資料的 4 顆（U850 已完善不在內）', S.todo.length === 4 && !S.todo.some(t => /U850/.test(t)), S.todo);
  ok('列出缺哪些欄位（PreDriver 缺 中心間距、塞孔材料）', S.todo.some(t => /PreDriver/.test(t) && /缺 中心間距/.test(t) && /缺 塞孔材料/.test(t)), S.todo);
  ok('LDO-1 缺 E-PAD 尺寸、Via 內徑；Q6505 缺 Via 數量', S.todo.some(t => /LDO-1/.test(t) && /缺 E-PAD 尺寸/.test(t) && /缺 Via 內徑/.test(t)) && S.todo.some(t => /Q6505/.test(t) && /缺 Via 數量/.test(t)), S.todo);
  ok('分頁徽章 = 4', S.badge === '4', S.badge);
  ok('摘要計數', await page.evaluate(() => /納入 5 顆/.test(document.querySelector('.via-summary').textContent) && /未完善 4/.test(document.querySelector('.via-summary').textContent)));
  await page.click('.via-todo .via-todo-go:has-text("LDO-1")');
  S = await st();
  ok('點待完善清單 → 跳到該元件', S.items.find(i => i.sel).name === 'LDO-1' && /LDO-1/.test(S.head));

  console.log('\n[D] Via 數量／內徑：鎖定取 EE 清單＋✂ 試算＋寫回');
  // 四頁同步後 EE 頁一定跟著載入；「寫回停用」只剩 EE 頁沒載入成功（例如讀取失敗）時 → 這裡直接把 EE 頁清空來測
  await page.evaluate(() => { sgProjectId = null; sgProjectData = null; });
  await sel('PreDriver');
  let f = await page.evaluate(() => ({ locked: [...document.querySelectorAll('#via-form .via-locked')].map(e => e.textContent), inputs: [...document.querySelectorAll('#via-form input[data-k]')].map(e => e.dataset.k) }));
  ok('數量、內徑都是鎖定的純文字（白底黑字）＋✂，沒有輸入框', f.locked.some(t => /^9 顆/.test(t)) && f.locked.some(t => /^8 mil/.test(t)) && !f.inputs.includes('qty') && !f.inputs.includes('diaMil'), f);
  await page.click('#via-form [data-fid="qty-unlock"]');
  ok('✂ → 變成輸入框、帶入 EE 清單的值、游標在裡面', await page.evaluate(() => { const i = document.querySelector('#via-form input[data-k="qty"]'); return i && i.value === '9' && document.activeElement === i; }));
  await page.fill('#via-form input[data-k="qty"]', '16');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(30);
  S = await st();
  ok('改成 16 → 提醒「試算值，與 EE 清單不同（9 顆）」、狀態不是完成', /試算值，與EE 清單不同（9 顆）/.test(S.form) && /Via 數量用本頁試算值 16，EE 清單是 9/.test(S.out), S.form);
  ok('資料存在 thermal_specs[PreDriver].via.qty，EE 清單沒被改', await page.evaluate(() => thermalSpecs['PreDriver'].via.qty === 16 && currentProjectData.rf_data[1].TV_Qty === 9));
  const wb = await page.evaluate(() => { const b = document.querySelector('#via-form [data-fid="qty-wb"]'); return b && { dis: b.disabled, title: b.title }; });
  ok('EE 頁沒載入這個專案 → 「寫回 EE 清單」停用並說明（按「載入專案」重新載入）', wb && wb.dis && /沒有載入這個專案/.test(wb.title) && /載入專案/.test(wb.title), wb);
  await page.click('#via-form [data-fid="qty-relock"]');
  ok('↺ 取回 EE 清單值 → 刪掉試算值、回到鎖定', await page.evaluate(() => !(thermalSpecs['PreDriver'].via && 'qty' in thermalSpecs['PreDriver'].via) && !document.querySelector('#via-form input[data-k="qty"]')));
  // EE 頁載入同一個專案 → 可以寫回
  await page.evaluate(async () => {
    const s = document.getElementById('sg-project-select');
    s.innerHTML = '<option value="">--</option><option value="X">X</option>'; s.value = 'X';
    await sgOnProjectChange(); switchTab('via');
  });
  await sel('PreDriver');
  await page.click('#via-form [data-fid="diaMil-unlock"]');
  await page.fill('#via-form input[data-k="diaMil"]', '10');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(30);
  ok('EE 頁載入同一個專案 → 寫回鈕可用', await page.evaluate(() => !document.querySelector('#via-form [data-fid="diaMil-wb"]').disabled));
  await page.click('#via-form [data-fid="diaMil-wb"]');
  ok('寫回 → EE 頁那顆元件 TV_ID_mil = 10、試算值刪掉、回到鎖定顯示 10 mil', await page.evaluate(() =>
    sgProjectData.rf_data[1].TV_ID_mil === 10 && !(thermalSpecs['PreDriver'] && thermalSpecs['PreDriver'].via && 'diaMil' in thermalSpecs['PreDriver'].via)
    && [...document.querySelectorAll('#via-form .via-locked')].some(e => /^10 mil/.test(e.textContent))));
  ok('EE 頁畫面也更新（重繪過）', await page.evaluate(() => [...document.querySelectorAll('#sg-project-components-body input[data-field="TV_ID_mil"]')].some(i => i.value === '10')));
  // EE 頁改 TV 欄位 → 切回 Thermal Via 頁反映最新（還沒存）
  await page.evaluate(() => { sgProjectData.digital_data[1].TV_Qty = 4; switchTab('specgen'); switchTab('via'); });
  S = await st();
  ok('EE 頁剛填了 FPGA 的 TH Via Qty（未存）→ 切回來 FPGA 被納入', S.items.some(i => i.name === 'FPGA' && !i.orphan), S.items.map(i => i.name));
  await page.evaluate(() => { sgProjectData.digital_data[1].TV_Qty = 'N/A'; viaRender(); });

  console.log('\n[E] E-PAD 與 TH/ME 頁同一欄；5G-RRU fallback；PCB 厚度');
  await sel('Driver-RRU');
  f = await page.evaluate(() => [...document.querySelectorAll('#via-form .via-locked')].map(e => e.textContent));
  ok('TH/ME 沒填 E-PAD → 暫用 5G-RRU 的 E-Pad 長寬（鎖定＋✂）', f.some(t => /9\.8 × 4\.8 mm/.test(t)) && await page.isVisible('#via-form [data-fid="epad-unlock"]'), f);
  await page.click('#via-form [data-fid="epad-unlock"]');
  ok('✂ → 帶入成 TH/ME 頁的 E-PAD（9.8×4.8）並可編輯', await page.evaluate(() => thermalSpecs['Driver-RRU'].epadSize === '9.8×4.8' && document.querySelector('#via-form input[data-fid="epad"]').value === '9.8×4.8'));
  await sel('LDO-1');
  await page.click('#via-form input[data-fid="epad"]');
  await page.keyboard.type('3x2.5');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(40);
  ok('在本頁填 E-PAD → 寫進 thermal_specs[LDO-1].epadSize', await page.evaluate(() => thermalSpecs['LDO-1'].epadSize === '3x2.5'));
  ok('解析顯示 ＝ 3 × 2.5 mm、面積 7.5 mm²', await page.evaluate(() => /＝ 3 × 2\.5 mm/.test(document.getElementById('via-form').textContent) && /7\.5 mm²/.test(document.getElementById('via-form').textContent)));
  await page.click('#via-form input[data-fid="epad"]', { clickCount: 3 });
  await page.keyboard.type('abc');
  ok('看不懂的格式 → 紅框（不當 0 算）', await page.evaluate(() => document.querySelector('#via-form input[data-fid="epad"]').classList.contains('invalid')));
  await page.keyboard.press('Control+A'); await page.keyboard.type('3x2.5'); await page.keyboard.press('Tab'); await page.waitForTimeout(40);
  await sel('PreDriver');
  ok('PCB 厚度鎖定取 5G-RRU 參數 t_PCB（1.6 mm）', await page.evaluate(() => [...document.querySelectorAll('#via-form .via-locked')].some(e => /^1\.6 mm/.test(e.textContent)) && /5G-RRU 參數 t_PCB/.test(document.getElementById('via-form').textContent)));
  await page.evaluate(() => { delete currentProjectData.global_params.t_PCB; viaRender(); });
  S = await st();
  ok('沒有 t_PCB → PCB 厚度變必填（待完善清單出現「缺 PCB 厚度」）', S.todo.some(t => /PreDriver/.test(t) && /缺 PCB 厚度/.test(t)) && await page.isVisible('#via-form input[data-k="pcbT"]'), S.todo);
  await page.fill('#via-form input[data-k="pcbT"]', '1.6');
  await page.evaluate(() => { currentProjectData.global_params.t_PCB = 1.6; delete thermalSpecs['PreDriver'].via.pcbT; viaRender(); });
  // PCB 板厚以 AI-Thermal 為主：EE/RF/PWR 頁該分類的板厚優先於 5G-RRU 的 t_PCB（EE 頁改了、還沒存也算）
  await page.evaluate(() => { const p = viaSameAsTab1() ? sgProjectData : currentProjectData; p.pcb_thickness = { RF: 2.2 }; viaRender(); });
  ok('EE/RF/PWR 頁設了 RF PCB 板厚 → PCB 厚度鎖定取它（2.2 mm，標出來源），不用 t_PCB',
    await page.evaluate(() => [...document.querySelectorAll('#via-form .via-locked')].some(e => /^2\.2 mm/.test(e.textContent))
      && /EE\/RF\/PWR 頁 RF PCB 板厚/.test(document.getElementById('via-form').textContent)));
  await page.evaluate(() => { const p = viaSameAsTab1() ? sgProjectData : currentProjectData; sgPcbTSet('RF', 2.4); if (p !== sgProjectData) p.pcb_thickness = { RF: 2.4 }; });
  await page.waitForTimeout(60);
  ok('EE 頁改板厚 → Thermal Via 頁跟著重畫（2.4 mm）', await page.evaluate(() => [...document.querySelectorAll('#via-form .via-locked')].some(e => /^2\.4 mm/.test(e.textContent))));
  await page.evaluate(() => { const p = viaSameAsTab1() ? sgProjectData : currentProjectData; delete p.pcb_thickness; delete currentProjectData.pcb_thickness; if (sgProjectData) delete sgProjectData.pcb_thickness; viaRender(); });
  ok('沒設定的分類 → 退回 5G-RRU 參數 t_PCB（1.6 mm）', await page.evaluate(() => [...document.querySelectorAll('#via-form .via-locked')].some(e => /^1\.6 mm/.test(e.textContent)) && /5G-RRU 參數 t_PCB/.test(document.getElementById('via-form').textContent)));

  console.log('\n[F] 計算');
  await sel('U850-Si5518');
  const calc = await page.evaluate(() => {
    const d = { shape: 'rect', L: 8.6, W: 8.6, pattern: 'matrix', n: 134, dia: 8 * 0.0254, pitch: 28 * 0.0254, t: 1.6, plating: 0.0254, kFill: 2 };
    return { exp: ViaCalc.calc(d), tiles: [...document.querySelectorAll('#via-out .via-tile .v')].map(v => v.textContent), out: document.getElementById('via-out').textContent };
  });
  ok('K_eff／R_th 與 viaCalc 一致（13.11 W/m·K、1.665 °C/W）', calc.tiles[0].startsWith(String(Number(calc.exp.keff.toFixed(2)))) && calc.tiles[1].startsWith(String(Number(calc.exp.rth.toFixed(3)))), calc.tiles);
  ok('穿板溫降 = 3.2 W × R_th', calc.out.includes('3.2 W × ' + Number(calc.exp.rth.toFixed(3)) + ' °C/W ≈ ' + Number((3.2 * calc.exp.rth).toFixed(2)) + ' °C'), calc.out);
  // 5G-RRU 實際行為（兩邊都走 ViaCalc.keffForComp）：完整設計 → 用 K_eff 取代通用值 K_Via，R_int = t_PCB ÷ (K_eff × A_pad)
  const rri = 1.6 / (calc.exp.keff * 73.96) * 1000;
  ok('5G-RRU 說明照實際行為：會用這個 K_eff、取代通用值 K_Via = 30、R_int 算式與數字（t_PCB 1.6）',
    /5G-RRU 會用這個 Keff = 13\.11 W\/m·K/.test(calc.out) && /取代通用值 K_Via = 30 W\/m·K（÷ Via_Eff 0\.9）/.test(calc.out)
    && calc.out.includes('≈ ' + Number(rri.toFixed(3)) + ' °C/W') && /不加擴散面積、不除 Via_Eff/.test(calc.out) && !/偏樂觀/.test(calc.out), calc.out);
  await page.evaluate(() => { const p = viaSameAsTab1() ? sgProjectData : currentProjectData; p.pcb_thickness = { Digital: 2.4 }; viaRender(); });
  const out24 = (await st()).out;
  ok('5G-RRU 說明的板厚跟著 EE/RF/PWR 頁的 Digital PCB 板厚（2.4 mm）',
    out24.includes('2.4 mm ÷ (13.11') && out24.includes('≈ ' + Number((2.4 / (calc.exp.keff * 73.96) * 1000).toFixed(3)) + ' °C/W'), out24);
  await page.evaluate(() => { delete currentProjectData.pcb_thickness; if (sgProjectData) delete sgProjectData.pcb_thickness; viaRender(); });
  await sel('Driver-RRU');
  ok('沒有 via 設計 → 說明 5G-RRU 會用通用值＋原因', /5G-RRU 這顆的基板熱阻會用通用值 K_Via = 30 W\/m·K/.test((await st()).out) && /還沒有這顆的 via 設計/.test((await st()).out), (await st()).out);
  await sel('U850-Si5518');
  ok('示意圖畫出 134 顆 via', await page.evaluate(() => document.querySelectorAll('#via-out svg circle').length >= 134 * 1));

  console.log('\n[G] 自動間距與干涉');
  await sel('PreDriver');
  await page.click('#via-form [data-fid="fill"]').catch(() => {});
  await page.selectOption('#via-form select[data-fid="fill"]', 'copper');
  await page.click('#via-form [data-fid="auto"]');
  let a = await page.evaluate(() => ({ pitch: thermalSpecs['PreDriver'].via.pitchMil, msg: (document.querySelector('#via-form .via-msg') || {}).textContent || '' }));
  ok('1.6×1.6、9 顆 10 mil → 自動間距寫回（mil 取 0.1）、訊息寫排列', a.pitch > 0 && Math.abs(a.pitch * 10 - Math.round(a.pitch * 10)) < 1e-6 && /3 欄 × 3 列/.test(a.msg), a);
  S = await st();
  ok('自動間距後沒有干涉；PreDriver 完成（離開待完善清單）', !S.todo.some(t => /PreDriver/.test(t)) && S.items.find(i => i.name === 'PreDriver').st !== 'err', S);
  await page.fill('#via-form input[data-k="pitchMil"]', '40');
  S = await st();
  ok('間距打到 40 mil → 外圈超出焊盤 → 錯誤、進待完善清單、徽章 +1', S.items.find(i => i.name === 'PreDriver').st === 'err' && S.todo.some(t => /PreDriver/.test(t) && /超出焊盤/.test(t)), S.todo);
  ok('示意圖把超出的 via 畫成紅色', await page.evaluate(() => [...document.querySelectorAll('#via-out svg circle')].filter(c => c.getAttribute('fill') === '#dc2626').length === 8));
  await page.fill('#via-form input[data-k="pitchMil"]', '11');
  S = await st();
  ok('間距 11 mil < 孔外徑 → 孔壁重疊錯誤', /孔壁互相重疊/.test(S.out), S.out);
  await page.fill('#via-form input[data-k="pitchMil"]', '');
  await page.click('#via-form [data-fid="qty-unlock"]');
  await page.fill('#via-form input[data-k="qty"]', '40');
  await page.click('#via-form [data-fid="auto"]');
  a = await page.evaluate(() => (document.querySelector('#via-form .via-msg') || {}).textContent || '');
  ok('放不下 → 說明最多可放幾顆', /排不下/.test(a) && /最多約可放 \d+ 顆/.test(a), a);
  await page.click('#via-form [data-fid="qty-relock"]');
  await page.click('#via-form [data-fid="auto"]');

  console.log('\n[H] 打字中不重繪表單');
  const same = await page.evaluate(async () => {
    const i = document.querySelector('#via-form input[data-k="pitchMil"]');
    i.focus(); i.value = '18'; i.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.querySelector('#via-form input[data-k="pitchMil"]');
    return { same: i === after, focus: document.activeElement === i, val: thermalSpecs['PreDriver'].via.pitchMil,
             list: document.querySelector('#via-list .via-item.sel .vi-meta').textContent };
  });
  ok('輸入事件：同一個 input、焦點還在、資料已寫入、清單即時更新', same.same && same.focus && same.val === 18, same);
  await page.focus('#via-form input[data-k="pitchMil"]');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(40);
  ok('提交（Tab）後重繪，焦點落在下一格（自動計算鈕）', await page.evaluate(() => document.activeElement && document.activeElement.dataset.fid === 'auto'));
  await page.click('#via-form [data-fid="unit-mm"]');
  ok('單位切到 mm：間距顯示 0.4572', await page.evaluate(() => document.querySelector('#via-form input[data-k="pitchMil"]').value === '0.4572'));
  await page.fill('#via-form input[data-k="pitchMil"]', '0.5');
  ok('以 mm 輸入 → 換算成 mil 存（19.685039）', await page.evaluate(() => Math.abs(thermalSpecs['PreDriver'].via.pitchMil - 19.685039) < 1e-6));
  await page.click('#via-form [data-fid="unit-mil"]');

  console.log('\n[I] 存檔、未存變更、改名');
  await page.evaluate(async () => { await saveAllTabs(); });
  let db = await page.evaluate(() => window.__db.projects.X);
  ok('存檔寫進 thermal_specs[PreDriver].via（只存輸入，不存計算結果）', db.thermal_specs.PreDriver.via && db.thermal_specs.PreDriver.via.fill === 'copper' && db.thermal_specs.PreDriver.via.pitchMil > 0
    && !('keff' in db.thermal_specs.PreDriver.via) && db.thermal_specs.PreDriver.epadSize === '1.6*1.6', db.thermal_specs.PreDriver);
  ok('寫回 EE 清單的內徑一起存進元件（TV_ID_mil = 10）', db.rf_data[1].TV_ID_mil === 10, db.rf_data[1]);
  ok('E-PAD 存進 thermal_specs（LDO-1、Driver-RRU）', db.thermal_specs['LDO-1'].epadSize === '3x2.5' && db.thermal_specs['Driver-RRU'].epadSize === '9.8×4.8');
  ok('不屬於本頁的欄位原樣保留（global_params.Draft_Angle、Was-Via 的資料）', db.global_params.Draft_Angle === 1.25 && db.thermal_specs['Was-Via'].via.fill === 'air');
  ok('存完沒有未存變更', await page.evaluate(() => !hasUnsavedEdits()));
  await page.evaluate(() => { ['Driver-RRU', 'PreDriver', 'U850-Si5518', 'Q6505', 'LDO-1', 'Was-Via'].forEach(n => viaSelect(sgSpecKey(n))); });
  ok('只點選、看不同元件 → 不算未存變更（不會建立空的 via 物件）', await page.evaluate(() => !hasUnsavedEdits() && !('via' in (thermalSpecs['Q6505'] || {}))));
  await sel('Q6505');
  await page.selectOption('#via-form select[data-fid="fill"]', 'solder');
  ok('改了 → 算未存變更', await page.evaluate(() => hasUnsavedEdits()));
  await page.selectOption('#via-form select[data-fid="fill"]', '');
  ok('改回空白 → via／spec 物件清掉、不算未存變更', await page.evaluate(() => !hasUnsavedEdits() && !thermalSpecs['Q6505']));
  // 在 EE 頁改名
  await sel('PreDriver');
  await page.evaluate(() => {
    const inp = document.querySelector('#sg-project-components-body input[data-field="Component"][data-cat="RF"][data-idx="1"]');
    inp.value = 'PreDriver-B3'; sgOnCompEdit(inp); switchTab('via');
  });
  S = await st();
  ok('EE 頁改名 → via 資料跟著搬（thermal_specs key）、選取跟著走', await page.evaluate(() => !!(thermalSpecs['PreDriver-B3'] && thermalSpecs['PreDriver-B3'].via && thermalSpecs['PreDriver-B3'].via.fill === 'copper') && !thermalSpecs['PreDriver']) && /PreDriver-B3/.test(S.head), S.head);
  await page.evaluate(async () => { await saveAllTabs(); });
  db = await page.evaluate(() => window.__db.projects.X);
  ok('存檔：資料庫裡也搬到新名稱', db.thermal_specs['PreDriver-B3'] && db.thermal_specs['PreDriver-B3'].via.fill === 'copper' && !db.thermal_specs.PreDriver, Object.keys(db.thermal_specs));

  console.log('\n[J] 未解鎖（唯讀）');
  await page.evaluate(() => relock());
  const ro = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('#via-form input:not(.sg-spec-ro), #via-form select, #via-form button:not(.sg-spec-ro)')].every(e => e.disabled),
    list: [...document.querySelectorAll('#via-list .via-item')].every(e => !e.disabled),
    unit: !document.querySelector('#via-form [data-fid="unit-mm"]').disabled,
    conv: !document.querySelector('#via-form [data-fid="conv-mil"]').disabled,
    save: document.getElementById('via-save-btn').disabled, export: !document.getElementById('via-export-excel-btn').disabled,
    bar: document.getElementById('lock-pill').classList.contains('locked'),
  }));
  ok('輸入／按鈕全部停用；元件清單、單位切換、換算、匯出仍可用；儲存停用', ro.inputs && ro.list && ro.unit && ro.conv && ro.save && ro.export && ro.bar, ro);
  await page.click('#via-list .via-item:has-text("U850")');
  ok('唯讀時仍可切換元件檢視', /U850/.test((await st()).head));
  await page.fill('#via-form [data-fid="conv-mil"]', '8');
  ok('換算 8 mil → 0.2032 mm', await page.evaluate(() => document.querySelector('#via-form [data-fid="conv-mm"]').value === '0.2032'));
  await page.evaluate(() => _applyUnlockedUI());
  ok('解鎖 → 輸入可用、儲存可用', await page.evaluate(() => !document.querySelector('#via-form select[data-fid="fill"]').disabled && !document.getElementById('via-save-btn').disabled));

  console.log('\n[L] 暫不納入熱流評估');
  await sel('U850-Si5518');
  S = await st();
  const before = { todo: S.todo.length, badge: Number(S.badge || 0), inc: S.items.filter(i => !i.orphan && !i.skip).length };
  ok('待完善清單每一列都有「暫不納入」勾選＋可點的元件名稱', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.via-todo .via-todo-row')];
    return rows.length > 0 && rows.every(r => r.querySelector('.via-skip-cb input[type=checkbox]') && r.querySelector('.via-todo-go'));
  }));
  await page.evaluate(() => { viaVia('Q6505', true).fill = 'air'; viaRender(); });
  await page.click('.via-todo .via-todo-row:has-text("Q6505") .via-skip-cb input');
  S = await st();
  ok('勾選 → 移出待完善清單、徽章 −1、目前選取的元件不變', !S.todo.some(t => /Q6505/.test(t)) && Number(S.badge || 0) === before.badge - 1 && /U850/.test(S.head), { todo: S.todo, badge: S.badge, before });
  ok('資料：via.skip = true，原本的 via 資料（塞孔材料）保留', await page.evaluate(() => thermalSpecs['Q6505'].via.skip === true && thermalSpecs['Q6505'].via.fill === 'air'));
  ok('摘要：納入 −1、多一個「⏸ 暫不納入 1」', await page.evaluate((n) => {
    const t = document.querySelector('.via-summary').textContent; return t.includes('納入 ' + n + ' 顆') && /暫不納入 1/.test(t); }, before.inc - 1));
  ok('左側清單：歸到「⏸ 暫不納入熱流評估」群組', S.items.some(i => i.name === 'Q6505' && i.skip) && await page.evaluate(() => /暫不納入熱流評估（1）/.test(document.getElementById('via-list').textContent)));
  ok('「暫不納入」清單預設收合、列出 Q6505（沒寫原因）', await page.evaluate(() => { const d = document.querySelector('.via-skipped'); return d && !d.open; }) && S.skipped.some(t => /Q6505/.test(t) && /沒寫原因/.test(t)), S.skipped);
  await page.click('.via-skipped > summary');
  await page.click('.via-skipped .via-todo-go:has-text("Q6505")');
  S = await st();
  ok('點名稱 → 跳到該元件：狀態「⏸ 暫不納入熱流評估」、上方有原因欄、下面的 via 欄位照樣可填',
    /暫不納入熱流評估/.test(S.head) && await page.isVisible('#via-form input[data-fid="skipNote"]') && await page.isVisible('#via-form select[data-fid="fill"]'));
  ok('展開狀態在重繪後維持', await page.evaluate(() => document.querySelector('.via-skipped').open));
  await page.click('#via-form input[data-fid="skipNote"]');
  await page.keyboard.type('Tj 150°C 餘裕大');
  ok('打原因：游標不跳、寫進 via.skipNote、清單即時顯示原因', await page.evaluate(() =>
    document.activeElement && document.activeElement.dataset.fid === 'skipNote' && thermalSpecs['Q6505'].via.skipNote === 'Tj 150°C 餘裕大'
    && /原因：Tj 150°C 餘裕大/.test(document.querySelector('.via-skipped').textContent)));
  await page.click('#via-ed-head .via-skip-cb input');
  S = await st();
  ok('取消勾選 → 回到待完善清單、skip／skipNote 刪掉、其他 via 資料保留', S.todo.some(t => /Q6505/.test(t)) && await page.evaluate(() =>
    !('skip' in thermalSpecs['Q6505'].via) && !('skipNote' in thermalSpecs['Q6505'].via) && thermalSpecs['Q6505'].via.fill === 'air') && Number(S.badge || 0) === before.badge, S.todo);
  // 已完成的元件也能從編輯區上方勾
  await sel('U850-Si5518');
  await page.click('#via-ed-head .via-skip-cb input');
  S = await st();
  ok('已完成的元件也能在編輯區上方勾「暫不納入」', S.items.some(i => i.name === 'U850-Si5518' && i.skip) && await page.evaluate(() => thermalSpecs['U850-Si5518'].via.skip === true));
  ok('暫不納入 → 說明 5G-RRU 會改用通用值 K_Via（原因：暫不納入熱流評估）', /5G-RRU 這顆的基板熱阻會用通用值 K_Via/.test(S.out) && /暫不納入熱流評估/.test(S.out), S.out);
  await page.evaluate(() => relock());
  ok('未解鎖：「暫不納入」勾選停用，元件名稱仍可點', await page.evaluate(() =>
    [...document.querySelectorAll('.via-skip-cb input')].every(e => e.disabled) && [...document.querySelectorAll('.via-todo-go')].every(e => !e.disabled)));
  await page.evaluate(() => _applyUnlockedUI());
  await page.click('#via-ed-head .via-skip-cb input');
  await page.click('.via-todo .via-todo-row:has-text("Q6505") .via-skip-cb input');
  await page.evaluate(async () => { await saveAllTabs(); });
  db = await page.evaluate(() => window.__db.projects.X);
  ok('存檔：via.skip 寫進資料庫；U850 取消後沒有殘留 skip', db.thermal_specs.Q6505.via.skip === true && db.thermal_specs.Q6505.via.fill === 'air' && !('skip' in db.thermal_specs['U850-Si5518'].via), db.thermal_specs.Q6505);
  await sel('PreDriver-B3');
  const pl = await page.evaluate(() => ({ opts: [...document.querySelectorAll('#via-form select[data-fid="plating"] option')].map(o => o.textContent),
    hint: document.getElementById('via-form').textContent }));
  ok('鍍銅厚度：選項標成孔壁電鍍銅（20 µm Class 2／25.4 µm ≈ Class 3 預設／35 µm 加厚），說明不是表層銅箔',
    pl.opts.some(t => /20 µm/.test(t) && /Class 2/.test(t)) && pl.opts.some(t => /25\.4 µm/.test(t) && /預設/.test(t)) && pl.opts.some(t => /35 µm/.test(t) && /加厚/.test(t))
    && !pl.opts.some(t => /oz/.test(t)) && /不是表層銅箔/.test(pl.hint), pl.opts);

  console.log('\n[K] 版面與匯出');
  for (const w of [1920, 1536, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(60);
    const m = await page.evaluate(() => ({ h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tabs: (() => { const n = document.querySelector('.tab-nav'); return n.scrollWidth - n.clientWidth; })(),
      svg: document.querySelector('#via-out svg').getBoundingClientRect().width }));
    ok(`${w}px：沒有橫向捲軸（整頁＋分頁列）、示意圖有寬度`, m.h <= 0 && m.tabs <= 0 && m.svg > 200, m);
  }
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.evaluate(() => viaExportExcel());
  const xl = await page.evaluate(() => window.__xlsx);
  const sh = xl && xl.wb.sheets[0];
  ok('匯出 Excel：每顆納入元件＋不在條件內但有資料的元件各一列、有公式工作表', sh && sh.aoa.length === 1 + 6 && xl.wb.sheets[1].n === '公式與常數' && /ThermalVia/.test(xl.fn), sh && sh.aoa.map(r => r[1]));
  const u850 = sh.aoa.find(r => r[1] === 'U850-Si5518');
  ok('U850 那一列：K_eff 13.114（導熱膠 K=2）、R_th、穿板溫降', u850 && u850[23] === 13.114 && u850[24] > 0 && u850[28] > 0, u850);
  ok('最後一欄「5G-RRU 基板熱阻採用」：U850 逐顆 K_eff、Driver-RRU 通用值＋原因、LDO-1 不適用',
    sh.aoa[0][29] === '5G-RRU 基板熱阻採用' && /^逐顆 K_eff/.test(u850[29]) && /^通用值 K_Via：/.test(sh.aoa.find(r => r[1] === 'Driver-RRU')[29])
    && /^不適用/.test(sh.aoa.find(r => r[1] === 'LDO-1')[29]), sh.aoa.map(r => [r[1], r[29]]));
  const q65 = sh.aoa.find(r => r[1] === 'Q6505');
  ok('暫不納入的元件也匯出，狀態「暫不納入熱流評估」', q65 && q65[3] === '暫不納入熱流評估', q65);

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})();
