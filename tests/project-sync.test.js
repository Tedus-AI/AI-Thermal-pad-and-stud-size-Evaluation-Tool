/*
 * 四個功能頁同步開同一個專案＋右側工具列收起時常駐解鎖／儲存 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 驗證情境：
 *   [A] 任何一頁（EE/RF/PWR、TH/ME、模擬與實測驗證、Thermal Via）選專案 → 四頁一起載入同一個專案，
 *       下拉都指到同一個；下拉沒載入過專案列表的頁會補上選項
 *   [B] 「載入專案」鈕（任何一頁）→ 重讀一次資料庫、四頁的專案列表一起更新、仍開著同一個專案
 *   [C] 有未存變更時切換 → 先問（四頁一起）：取消 → 下拉還原、編輯保留；放棄 → 切換、編輯丟掉；
 *       儲存 → 先存再切換；沒存成（未解鎖）→ 不切換
 *   [D] 選「-- 請選擇專案 --」→ 四頁一起清空（TH/ME 頁不再殘留舊專案、存檔不會寫它）
 *   [E] 刪除目前的專案 → 四頁一起清空、下拉移除該專案；有未存變更時不可新增專案（新增後四頁會一起切換）
 *   [F] 右側工具列收起：只剩展開鈕＋解鎖＋儲存（常駐）；收起時點解鎖照樣開密碼框、點儲存照樣存
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/project-sync.test.js
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

const proj = (name, comp) => ({
  project_name: name, global_params: { t_PCB: 1.6 },
  rf_data: [{ Component: comp, Qty: 1, 'Power(W)': 2, TV_ID_mil: 8, TV_Qty: 9 }], digital_data: [], pwr_data: [],
  thermal_specs: { [comp]: { heatSourceSize: '5×5' } },
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
    window.__alerts = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
    window.confirm = () => true;
    try { localStorage.clear(); } catch (e) {}
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof projSelectChange === 'function' && typeof saveAllTabs === 'function' && document.getElementById('gm-rail'));

  await page.evaluate(([x, y]) => {
    window.__db = { projects: { X: x, Y: y }, tim_library: {} };
    window.__refresh = 0; window.__writes = 0;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.refresh = async () => { window.__refresh++; };
    dbAdapter.getProjectsSorted = async () => Object.entries(window.__db.projects).map(([id, p]) => ({ id, project_name: p.project_name }));
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.releaseLock = async () => {};
    dbAdapter.deleteDoc = async (c, id) => { delete window.__db[c][id]; };
    dbAdapter.setDoc = async (c, id, d) => { window.__db[c][id] = JSON.parse(JSON.stringify(d)); };
    dbAdapter.writeBatch = async (ops) => {
      window.__writes++;
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      plan.forEach(({ o, f }) => { window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f))); });
    };
    window._ensureLockBeforeWrite = async () => true;
  }, [proj('Alpha', 'U1-Alpha'), proj('Beta', 'U2-Beta')]);

  const S = () => page.evaluate(() => ({
    sg: sgProjectId, cl: currentProjectId, vd: vdProjectId,
    sel: ['sg-project-select', 'project-select', 'vd-project-select', 'via-project-select'].map(id => document.getElementById(id).value),
    opts: ['sg-project-select', 'project-select', 'vd-project-select', 'via-project-select'].map(id => document.getElementById(id).options.length),
    dis: ['sg-project-select', 'project-select', 'vd-project-select', 'via-project-select'].some(id => document.getElementById(id).disabled),
    sgComp: sgProjectData ? (sgProjectData.rf_data[0] || {}).Component : null,
    clComp: currentProjectData ? (currentProjectData.rf_data[0] || {}).Component : null,
    vdComp: (vdValidationData.rf || [])[0] ? vdValidationData.rf[0].component : null,
  }));
  // 下拉在各自的分頁裡 → 先切到那一頁（使用者也是這樣操作）
  const TAB_OF = { 'sg-project-select': 'specgen', 'project-select': 'complist', 'vd-project-select': 'validation', 'via-project-select': 'via' };
  const pick = async (selId, val) => { await page.evaluate((t) => switchTab(t), TAB_OF[selId]); await page.selectOption('#' + selId, val); };
  const same = (s, id) => s.sg === id && s.cl === id && s.vd === id && s.sel.every(v => v === (id || ''));
  const dialog = () => page.evaluate(() => document.getElementById('unsaved-lock-overlay').classList.contains('active'));
  const answer = async (cls) => { await page.waitForFunction(() => document.getElementById('unsaved-lock-overlay').classList.contains('active'), null, { timeout: 3000 });
    await page.click('#unsaved-lock-overlay ' + cls); };

  console.log('\n[A] 任何一頁選專案 → 四頁一起');
  // 只有 Tab1 的下拉有專案列表（其他頁還沒按過「載入專案」）
  await page.evaluate(async () => { await sgLoadProjects(); });
  await pick('sg-project-select', 'X');
  await page.waitForFunction(() => vdProjectId === 'X');
  let s = await S();
  ok('EE 頁選 X → TH/ME、模擬與實測驗證、Thermal Via 一起載入 X', same(s, 'X') && s.sgComp === 'U1-Alpha' && s.clComp === 'U1-Alpha' && s.vdComp === 'U1-Alpha', s);
  ok('其他頁的下拉補上專案選項、切換完沒有停用', s.opts.every(n => n === 3) && !s.dis, s);
  await pick('vd-project-select', 'Y');
  await page.waitForFunction(() => sgProjectId === 'Y' && currentProjectId === 'Y');
  s = await S();
  ok('模擬與實測驗證頁選 Y → 四頁一起切到 Y', same(s, 'Y') && s.sgComp === 'U2-Beta' && s.clComp === 'U2-Beta' && s.vdComp === 'U2-Beta', s);
  await pick('via-project-select', 'X');
  await page.waitForFunction(() => sgProjectId === 'X' && vdProjectId === 'X');
  ok('Thermal Via 頁選 X → 四頁一起切到 X', same(await S(), 'X'));
  await pick('project-select', 'Y');
  await page.waitForFunction(() => sgProjectId === 'Y' && vdProjectId === 'Y');
  ok('TH/ME 頁選 Y → 四頁一起切到 Y', same(await S(), 'Y'));

  console.log('\n[B] 載入專案鈕');
  await page.evaluate(() => { window.__db.projects.Z = { project_name: 'Gamma', rf_data: [], digital_data: [], pwr_data: [] }; window.__refresh = 0; });
  await page.evaluate(() => switchTab('validation'));
  await page.click('#vd-load-btn');
  await page.waitForFunction(() => document.getElementById('sg-project-select').options.length === 4);
  s = await S();
  ok('驗證頁按「載入專案」→ 只重讀一次資料庫、四頁的列表都有新專案、仍開著 Y', s.opts.every(n => n === 4) && same(s, 'Y') && await page.evaluate(() => window.__refresh === 1), { s, refresh: await page.evaluate(() => window.__refresh) });

  console.log('\n[C] 有未存變更時切換');
  await page.evaluate(() => { _applyUnlockedUI(); thermalSpecs['U2-Beta'].note = '改過'; });
  ok('（前提）有未存變更', await page.evaluate(() => hasUnsavedEdits()));
  await pick('sg-project-select', 'X');
  await answer('.ul-cancel');
  await page.waitForTimeout(50);
  s = await S();
  ok('問一次（說明四頁會一起換）→ 取消：四個下拉還原到 Y、編輯還在', same(s, 'Y') && await page.evaluate(() => thermalSpecs['U2-Beta'].note === '改過')
    && /四個功能頁/.test(await page.evaluate(() => document.querySelector('#unsaved-lock-overlay .unsaved-lock-msg').textContent)), s);
  await pick('sg-project-select', 'X');
  await answer('.ul-discard');
  await page.waitForFunction(() => sgProjectId === 'X' && currentProjectId === 'X' && vdProjectId === 'X');
  ok('放棄 → 四頁切到 X、資料庫沒寫、沒有未存變更', same(await S(), 'X') && await page.evaluate(() => window.__writes === 0 && !hasUnsavedEdits() && !window.__db.projects.Y.thermal_specs['U2-Beta'].note));
  await page.evaluate(() => { const r = vdValidationData.rf[0]; r.temp_meas = '88'; });
  await pick('project-select', 'Y');
  await answer('.ul-save');
  await page.waitForFunction(() => sgProjectId === 'Y' && currentProjectId === 'Y' && vdProjectId === 'Y');
  ok('儲存 → 先存（驗證頁的實測值寫進 X）再切到 Y', same(await S(), 'Y') && await page.evaluate(() => window.__writes >= 1 && window.__db.projects.X.validation_data.rf[0].temp_meas === '88'));
  await page.evaluate(() => { thermalSpecs['U2-Beta'].note = '又改'; relock(); });   // 有未存變更但已上鎖 → 存不了
  await pick('vd-project-select', 'X');
  await answer('.ul-save');
  await page.waitForTimeout(100);
  s = await S();
  ok('沒存成（未解鎖）→ 不切換、四個下拉還原、編輯保留', same(s, 'Y') && await page.evaluate(() => thermalSpecs['U2-Beta'].note === '又改'), s);
  await page.evaluate(() => { thermalSpecs['U2-Beta'] = { heatSourceSize: '5×5' }; delete thermalSpecs['U2-Beta'].note; _applyUnlockedUI(); });

  console.log('\n[D] 選「-- 請選擇專案 --」');
  await pick('via-project-select', '');
  await page.waitForFunction(() => !sgProjectId && !currentProjectId && !vdProjectId);
  s = await S();
  ok('四頁一起清空（TH/ME 頁不殘留舊專案）', same(s, null) && s.clComp === null, s);
  await page.evaluate(async () => { window.__alerts = []; await saveAllTabs(); });
  ok('存檔不會寫任何專案（提示「尚未選擇專案」）', await page.evaluate(() => /尚未選擇專案/.test(window.__alerts.join()) ));

  console.log('\n[E] 刪除／新增專案');
  await pick('sg-project-select', 'Z');
  await page.waitForFunction(() => vdProjectId === 'Z');
  await page.evaluate(async () => { await sgDeleteProject('Z', 'Gamma'); });
  s = await S();
  ok('刪除目前的專案 → 四頁一起清空、四個下拉都沒有它', same(s, null) && s.opts.every(n => n === 3)
    && await page.evaluate(() => [...document.querySelectorAll('#project-select option, #vd-project-select option, #via-project-select option, #sg-project-select option')].every(o => o.value !== 'Z')), s);
  await pick('sg-project-select', 'X');
  await page.waitForFunction(() => vdProjectId === 'X');
  await page.evaluate(() => { thermalSpecs['U1-Alpha'].note = '未存'; window.__alerts = [];
    document.getElementById('sg-new-project-id').value = 'NEW'; document.getElementById('sg-new-project-name').value = 'New'; });
  await page.evaluate(async () => { await sgCreateProject(); });
  ok('有未存變更 → 不可新增專案（提示先儲存）、不切換', await page.evaluate(() => /請先按「儲存」/.test(window.__alerts.join()) && !window.__db.projects.NEW && sgProjectId === 'X'));
  await page.evaluate(() => { delete thermalSpecs['U1-Alpha'].note; });
  await page.evaluate(async () => { await sgCreateProject(); });
  await page.waitForFunction(() => vdProjectId === 'NEW');
  ok('沒有未存變更 → 新增後四頁一起切到新專案', same(await S(), 'NEW') && await page.evaluate(() => !!window.__db.projects.NEW));

  console.log('\n[F] 右側工具列收起時常駐解鎖／儲存');
  await page.evaluate(() => { relock(); railToggleCollapse(); });
  const R = await page.evaluate(() => {
    const vis = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
    const lock = document.getElementById('rail-lock-btn'), save = document.querySelector('#gm-rail-pinned [data-tip="儲存資料"]');
    const tg = document.getElementById('gm-rail-toggle');
    const bodyBtns = [...document.querySelectorAll('#gm-rail-body button')];
    return { lock: vis(lock), save: vis(save), toggle: vis(tg), bodyHidden: bodyBtns.every(b => !vis(b)),
      order: vis(lock) && tg.getBoundingClientRect().top < lock.getBoundingClientRect().top && lock.getBoundingClientRect().top < save.getBoundingClientRect().top,
      railH: Math.round(document.getElementById('gm-rail').getBoundingClientRect().height) };
  });
  ok('收起後：展開鈕、解鎖、儲存看得到，其他按鈕收起來', R.lock && R.save && R.toggle && R.bodyHidden && R.order, R);
  await page.click('#rail-lock-btn');
  ok('收起時點解鎖 → 開出密碼框', await page.evaluate(() => document.getElementById('rail-lock-popover').style.display === 'flex'));
  await page.fill('#rail-lock-pwd', '0000');
  await page.press('#rail-lock-pwd', 'Enter');
  await page.waitForFunction(() => !isProtected);
  await page.evaluate(() => { thermalSpecs['RailSave'] = { note: '從收起的工具列存' }; window.__writes = 0; });
  await page.click('#gm-rail-pinned [data-tip="儲存資料"]');
  await page.waitForFunction(() => window.__writes >= 1);
  ok('收起時點儲存 → 存檔（目前開著的 NEW）', await page.evaluate(() => window.__db.projects.NEW.thermal_specs.RailSave.note === '從收起的工具列存' && !hasUnsavedEdits()));
  await page.evaluate(() => railToggleCollapse());
  ok('展開後所有按鈕都在、解鎖／儲存仍在最下面', await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#gm-rail button')].filter(b => b.offsetParent !== null);
    return btns.length >= 10 && btns[btns.length - 1].getAttribute('data-tip') === '儲存資料' && btns[btns.length - 2].id === 'rail-lock-btn';
  }));

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('UNEXPECTED:', e); process.exit(1); });
