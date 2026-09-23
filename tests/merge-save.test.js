/*
 * 存檔三方合併＋第三批修正（AI-Thermal 端）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 標準流程：AI-Thermal 先建資料 → 5G-RRU 讀同一個專案算體積；使用者會在兩個工具之間來回補欄位。
 * 兩個工具存檔時都把整份元件清單寫回共用 DB，原本後存的一方會把對方剛存的修改整批蓋掉。
 *
 * 驗證情境（假 DB 的 writeBatch 跟真的後端一樣：fields 可以是函式，在最新內容上計算）：
 *   [A] 5G-RRU 在我們載入後補了高度／導熱方式 → 我們改瓦數存檔 → 兩邊的修改都在。
 *   [B] 兩邊改到同一格 → 存檔前跳衝突視窗，照使用者選擇寫入。
 *   [C] 衝突視窗按取消 → 不寫入、狀態列說明。
 *   [D] 本機檔模式的版本衝突（ConflictError）→ 重算合併後自動再存。
 *   [E] 元件改名：TH/ME 頁的 thermal_specs／hidden_components 跟著搬
 *       （兩頁同專案 → 直接搬；不同專案 → 存檔時在資料庫最新內容上搬；新名稱已有資料 → 不覆蓋）。
 *   [F] θJC 依主散熱路徑取用：IC top → θJC,top；Thermal Via → θJC,bottom；沒有對應 → 暫用另一筆並提示。
 *   [G] 共用欄位空值不寫 key：新增元件沒有 Power(W)；清空瓦數／數量 → 刪 key；每顆有 _cid。
 *   [H] EE 匯入元件大小 → 跟手動輸入一樣觸發凸台／TIM 連動。
 *   [I] 標註圖片清孤兒：只列「完全相同專案 id」的圖（不會刪到 id 以同樣字開頭的另一個專案）。
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/merge-save.test.js
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

const PROJ = {
  project_name: 'X 案', meta: { timestamp: '2026-09-01T00:00:00Z' }, global_params: { T_amb: 55 },
  rf_data: [{ Component: 'PA', Type: 'Final PA', Qty: 2, 'Power(W)': 30, 'Limit(C)': 200,
              Rth: [{ type: 'JC_bot', value: '0.5', primary: true }, { type: 'JC_top', value: '3.2' }] },
            { Component: 'LNA', Qty: 1, 'Power(W)': 1 }],
  digital_data: [{ Component: 'U1', Qty: 1, 'Power(W)': 5 }], pwr_data: [],
  thermal_specs: { PA: { heatDirection: 'IC top', heatSourceSize: '10×10' }, LNA: { heatSourceSize: '3×3' } },
  hidden_components: { LNA: true },
};

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.route('**', r => r.request().url().startsWith(BASE.replace(/index\.html$/, '')) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof saveAllTabs === 'function' && typeof sgOnProjectChange === 'function' && window.CompMerge);

  // 假 DB（行為比照 graphDb）：getDoc／getCollection 回複本；writeBatch 的 fields 可以是函式，
  // 先整批算完再寫；window.__interfere 在「第一次計算之後、寫入之前」插入別人的寫入並丟出版本衝突
  const seed = (projects) => page.evaluate((projects) => {
    window.__db = { projects: JSON.parse(JSON.stringify(projects)) };
    window.__writes = 0; window.__interfere = null;
    isProtected = false;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.getProjectsSorted = async () => Object.entries(window.__db.projects).map(([id, d]) => Object.assign({ id }, d));
    dbAdapter.releaseLock = async () => {};
    dbAdapter.writeBatch = async (ops) => {
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      if (window.__interfere) { const fn = window.__interfere; window.__interfere = null; fn(window.__db);
        throw new ConflictError('版本衝突：資料已被他人更新'); }
      plan.forEach(({ o, f }) => { window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f))); });
      window.__writes++;
    };
    window._ensureLockBeforeWrite = async () => true;
    window.tcpNormalizeSPImages = async () => {};
    const opts = '<option value="">--</option>' + Object.keys(window.__db.projects).map(id => '<option value="' + id + '">' + id + '</option>').join('');
    document.getElementById('sg-project-select').innerHTML = opts;
    document.getElementById('project-select').innerHTML = opts;
    sgProjectId = null; sgProjectData = null; currentProjectId = null; currentProjectData = null; vdProjectId = null;
  }, projects);
  const loadTab1 = (id) => page.evaluate(async (id) => { const s = document.getElementById('sg-project-select'); s.value = id; await sgOnProjectChange(); }, id);
  const loadTab2 = (id) => page.evaluate(async (id) => { const s = document.getElementById('project-select'); s.value = id; await onProjectChange(); }, id);
  const status = () => page.evaluate(() => (document.getElementById('sg-comp-save-status') || {}).textContent || '');
  const dbX = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__db.projects.X)));

  console.log('\n[A] 5G-RRU 在我們載入後補了欄位 → 我們存檔不會蓋掉');
  await seed({ X: PROJ });
  await loadTab1('X');
  const a0 = await page.evaluate(() => ({ cids: CompMerge.CATS.every(f => (sgProjectData[f] || []).every(c => c._cid)), base: !!sgProjectBase }));
  ok('載入時補發元件 id、取載入時快照', a0.cids && a0.base, a0);
  await page.evaluate(() => {
    Object.assign(window.__db.projects.X.rf_data[0], { 'Height(mm)': 77, Board_Type: 'Copper Coin' });   // 5G-RRU 剛存檔
    sgProjectData.rf_data[0]['Power(W)'] = 33;                                                          // 我們改瓦數
  });
  await page.evaluate(() => saveAllTabs());
  const a = await dbX();
  ok('5G-RRU 補的高度／導熱方式保留', a.rf_data[0]['Height(mm)'] === 77 && a.rf_data[0].Board_Type === 'Copper Coin', a.rf_data[0]);
  ok('我們改的瓦數寫入', a.rf_data[0]['Power(W)'] === 33, a.rf_data[0]);
  ok('5G-RRU 的欄位（global_params、meta）與 TH/ME 資料保留', a.global_params.T_amb === 55 && !!a.meta && a.thermal_specs.PA.heatDirection === 'IC top');
  ok('畫面換成合併後的內容（看得到 5G-RRU 的高度）', await page.evaluate(() => sgProjectData.rf_data[0]['Height(mm)'] === 77));
  ok('狀態列寫出合併了幾項', /全部儲存成功/.test(await status()) && /已合併/.test(await status()), await status());

  console.log('\n[B] 兩邊改到同一格 → 先問再存');
  await seed({ X: PROJ }); await loadTab1('X');
  await page.evaluate(() => { window.__db.projects.X.rf_data[0]['Power(W)'] = 40; sgProjectData.rf_data[0]['Power(W)'] = 33;
                              window.__saveP = saveAllTabs(); });
  await page.waitForSelector('.cm-mask', { timeout: 5000 });
  const b1 = await page.evaluate(() => ({ text: document.querySelector('.cm-mask tbody').textContent.replace(/\s+/g, ' '),
                                          title: document.querySelector('.cm-title').textContent, writes: window.__writes }));
  ok('衝突視窗：PA／瓦數／我的 33／資料庫的 40／載入時 30，且還沒寫入',
     /PA/.test(b1.text) && /瓦數/.test(b1.text) && /33/.test(b1.text) && /40/.test(b1.text) && /載入時：30/.test(b1.text) && b1.writes === 0, b1);
  ok('標題說明可能是 5G-RRU 剛存檔', /5G-RRU/.test(b1.title), b1.title);
  await page.click('.cm-opt[data-side="theirs"]'); await page.click('[data-act="ok"]');
  await page.evaluate(() => window.__saveP);
  ok('選「用資料庫的」→ 40，畫面也是 40', (await dbX()).rf_data[0]['Power(W)'] === 40 && await page.evaluate(() => sgProjectData.rf_data[0]['Power(W)'] === 40));

  console.log('\n[C] 衝突視窗按取消');
  await seed({ X: PROJ }); await loadTab1('X');
  await page.evaluate(() => { window.__db.projects.X.rf_data[0]['Power(W)'] = 40; sgProjectData.rf_data[0]['Power(W)'] = 33;
                              window.__saveP = saveAllTabs(); });
  await page.waitForSelector('.cm-mask'); await page.click('[data-act="cancel"]');
  await page.evaluate(() => window.__saveP);
  const c = await page.evaluate(() => ({ writes: window.__writes, mine: sgProjectData.rf_data[0]['Power(W)'] }));
  ok('不寫入、畫面上我的 33 還在', c.writes === 0 && c.mine === 33, c);
  ok('狀態列說明已取消、沒有寫入', /已取消儲存/.test(await status()), await status());

  console.log('\n[D] 本機檔模式的版本衝突 → 重算合併後自動再存');
  await seed({ X: PROJ }); await loadTab1('X');
  await page.evaluate(() => {
    sgProjectData.rf_data[1]['Power(W)'] = 1.5;
    window.__interfere = (db) => { db.projects.X.rf_data[0]['Limit(C)'] = 175; };   // 另一個工具剛寫進同一個檔
  });
  await page.evaluate(() => saveAllTabs());
  const d = await dbX();
  ok('自動重試成功：對方的限溫 175 與我的瓦數 1.5 都在、沒有跳視窗',
     d.rf_data[0]['Limit(C)'] === 175 && d.rf_data[1]['Power(W)'] === 1.5 && !(await page.$('.cm-mask')), d.rf_data);

  console.log('\n[E] 元件改名 → TH/ME 頁的資料跟著搬');
  const rename = (to) => page.evaluate((to) => sgOnCompEdit({ dataset: { cat: 'RF', idx: '1', field: 'Component' }, value: to, type: 'text' }), to);
  await seed({ X: PROJ, Y: { project_name: 'Y 案', rf_data: [], digital_data: [], pwr_data: [] } });
  await loadTab1('X'); await loadTab2('X');
  await rename('LNA_main');
  const e1 = await page.evaluate(() => ({ spec: thermalSpecs['LNA_main'], old: thermalSpecs['LNA'], hidden: hiddenComponents['LNA_main'],
    tab2Name: currentProjectData.rf_data[1].Component }));
  ok('兩頁同專案：thermalSpecs 的 key 搬到新名稱、舊的不留', e1.spec && e1.spec.heatSourceSize === '3×3' && !e1.old, e1);
  ok('隱藏清單跟著搬、TH/ME 頁的元件名稱也改了', e1.hidden === true && e1.tab2Name === 'LNA_main', e1);
  await page.evaluate(() => saveAllTabs());
  const e1db = await dbX();
  ok('存檔後資料庫：元件名稱與 thermal_specs／hidden_components 一致', e1db.rf_data[1].Component === 'LNA_main' &&
     e1db.thermal_specs.LNA_main && !e1db.thermal_specs.LNA && e1db.hidden_components.LNA_main === true, e1db.thermal_specs);

  await seed({ X: PROJ, Y: { project_name: 'Y 案', rf_data: [], digital_data: [], pwr_data: [], thermal_specs: {} } });
  await loadTab1('X'); await loadTab2('Y');
  await rename('LNA_main');
  const e2 = await page.evaluate(() => ({ pending: JSON.parse(JSON.stringify(sgPendingRenames)), ySpecs: Object.keys(thermalSpecs) }));
  ok('兩頁不同專案：先記下來、不動 TH/ME 頁（別的專案）的資料', e2.pending.X && e2.pending.X[0].from === 'LNA' && e2.pending.X[0].to === 'LNA_main' && e2.ySpecs.length === 0, e2);
  await page.evaluate(() => { window.__db.projects.X.thermal_specs.PA.timType = 'Pad'; });   // 存檔前別人又改了 thermal_specs
  await page.evaluate(() => saveAllTabs());
  const e2db = await dbX();
  ok('存檔時在資料庫最新的 thermal_specs 上搬（別人剛改的 PA 也保留）',
     e2db.thermal_specs.LNA_main && e2db.thermal_specs.LNA_main.heatSourceSize === '3×3' && !e2db.thermal_specs.LNA &&
     e2db.thermal_specs.PA.timType === 'Pad' && e2db.hidden_components.LNA_main === true, e2db.thermal_specs);
  ok('存完清掉待搬清單', await page.evaluate(() => !sgPendingRenames.X));

  await seed({ X: Object.assign({}, PROJ, { thermal_specs: { PA: { heatDirection: 'IC top' }, LNA: { heatSourceSize: '3×3' }, LNA_main: { heatSourceSize: '7×7' } } }) });
  await loadTab1('X'); await loadTab2('X');
  await rename('LNA_main');
  const e3 = await page.evaluate(() => ({ a: thermalSpecs.LNA, b: thermalSpecs.LNA_main }));
  ok('新名稱已經有自己的資料 → 不覆蓋（兩份都保留）', e3.a && e3.a.heatSourceSize === '3×3' && e3.b.heatSourceSize === '7×7', e3);

  console.log('\n[F] θJC 依主散熱路徑取用');
  await seed({ X: PROJ }); await loadTab1('X'); await loadTab2('X');
  const f = await page.evaluate(() => {
    const pa = sgProjectData.rf_data[0];
    const icTop = sgRjcFromRth(pa);                                   // Tab2：IC top
    thermalSpecs.PA.heatDirection = 'Thermal Via';
    const via = sgRjcFromRth(pa);
    thermalSpecs.PA.heatDirection = 'IC top';
    const onlyBot = sgRjcFromRth({ Component: 'PA', Rth: [{ type: 'JC_bot', value: '0.5' }] });
    const noPath = sgRjcFromRth({ Component: 'NoSpec', Rth: [{ type: 'JC_top', value: '4', primary: true }, { type: 'JC_bot', value: '0.6' }] });
    sgSyncRjc(pa);
    return { icTop, via, onlyBot, noPath, rjc: pa.R_jc, from: pa._rjc_from };
  });
  ok('IC top → θJC,top（3.2），不是標「主要」的 θJC,bottom', f.icTop.type === 'JC_top' && f.icTop.value === 3.2 && !f.icTop.fallback, f.icTop);
  ok('Thermal Via → θJC,bottom（0.5）', f.via.type === 'JC_bot' && f.via.value === 0.5, f.via);
  ok('IC top 但只有 θJC,bottom → 暫用並標 fallback', f.onlyBot.type === 'JC_bot' && f.onlyBot.fallback === true && f.onlyBot.want === 'JC_top', f.onlyBot);
  ok('沒選主散熱路徑 → 維持原本順序（標「主要」的優先）', f.noPath.type === 'JC_top' && f.noPath.value === 4, f.noPath);
  ok('寫進元件的 R_jc 與來源標記跟著路徑', f.rjc === 3.2 && f.from === 'JC_top', f);
  const fHint = await page.evaluate(() => {
    sgProjectData.rf_data[0].Rth = [{ type: 'JC_bot', value: '0.5', primary: true }];
    sgRthOpen('RF', 0);
    const t = document.getElementById('sg-rth-rjc').textContent;
    sgRthClose();
    return t;
  });
  ok('熱阻視窗：IC top 只有 θJC,bottom → 琥珀色提示要補 θJC,top', /主散熱路徑「IC top」應該用/.test(fHint) && /θJC,top/.test(fHint), fHint);

  console.log('\n[G] 共用欄位空值不寫 key');
  await seed({ X: PROJ }); await loadTab1('X');
  const g = await page.evaluate(() => {
    const nc = sgMakeComp('RF');
    sgProjectData.rf_data.push(sgMakeComp('RF', { Component: 'New' }));
    const i = sgProjectData.rf_data.length - 1;
    sgProjectData.rf_data[i]['Power(W)'] = 3; sgProjectData.rf_data[i].Qty = 2;
    sgOnCompEdit({ dataset: { cat: 'RF', idx: String(i), field: 'Power(W)' }, value: '', type: 'number' });
    sgOnCompEdit({ dataset: { cat: 'RF', idx: String(i), field: 'Qty' }, value: '', type: 'number' });
    const c = sgProjectData.rf_data[i];
    return { hasPw: 'Power(W)' in nc, cid: !!nc._cid, cid2: sgMakeComp('RF')._cid !== nc._cid, pwGone: !('Power(W)' in c), qtyGone: !('Qty' in c) };
  });
  ok('新增元件：沒有 Power(W) key、有 _cid（每顆不同）', !g.hasPw && g.cid && g.cid2, g);
  ok('清空瓦數／數量 → 刪 key（不寫 \'\'）', g.pwGone && g.qtyGone, g);

  console.log('\n[H] EE 匯入元件大小 → 觸發凸台／TIM 連動');
  await seed({ X: PROJ }); await loadTab2('X');
  const h = await page.evaluate(async () => {
    thermalSpecs.U1 = { padAuto: true, timType: 'Putty', bossSizeType: '自動帶入', bossSize: '' };
    window.XLSX = window.XLSX || {};
    XLSX.utils = XLSX.utils || {};
    XLSX.read = () => ({ SheetNames: ['S'], Sheets: { S: {} } });
    XLSX.utils.sheet_to_json = () => [['#', '元件名稱', '元件大小', '元件高度'], [1, 'U1', '12×12', '1.2']];
    eeImportExcel({ files: [new File(['x'], 'ee.xlsx')], value: '' });
    await new Promise(r => setTimeout(r, 300));
    return JSON.parse(JSON.stringify(thermalSpecs.U1));
  });
  ok('匯入後元件大小寫入、凸台同步（Putty＋自動帶入）', h.heatSourceSize === '12×12' && h.bossSize === '12×12', h);

  console.log('\n[I] 標註圖片清孤兒：只列完全相同的專案 id');
  const i = await page.evaluate(async () => {
    const realFetch = window.fetch, tok = graphDb._getAccessToken, res = graphDb._resolveDriveItemId;
    graphDb._getAccessToken = async () => 'tok'; graphDb._resolveDriveItemId = async () => 'item';
    window.fetch = async () => new Response(JSON.stringify({ value: [
      { name: 'FDD_4T4R_60W_rf_1700000000000.jpg' }, { name: 'FDD_4T4R_60W_v2_rf_1700000000001.jpg' },
      { name: 'FDD_4T4R_60W_digital_1700000000002.jpg' }, { name: 'notes.txt' } ] }), { status: 200 });
    const list = await graphDb.listTcpImages('FDD_4T4R_60W');
    window.fetch = realFetch; graphDb._getAccessToken = tok; graphDb._resolveDriveItemId = res;
    return list.map(p => p.split('/').pop());
  });
  ok('只列出 FDD_4T4R_60W 自己的 2 張（v2 的圖不會被當成孤兒刪掉、不認得的檔不列）',
     JSON.stringify(i) === JSON.stringify(['FDD_4T4R_60W_rf_1700000000000.jpg', 'FDD_4T4R_60W_digital_1700000000002.jpg']), i);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));
  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
