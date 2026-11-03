/*
 * 快選參照的「來源專案名稱」跟著來源改名、來源不存在就清掉 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 問題 1：快選時元件上抄的是來源專案「當時的名稱」（_ref_origin_project、規格書 _from、_pd_meas_from），
 *   來源專案之後改名（本工具或 5G-RRU 改都一樣：只動 project_name、id 不變），元件上的
 *   「↩ 參照自 X」「曾參照自 X」還是舊名稱。
 * 問題 2：來源專案被刪、或來源裡已經沒有同名元件（多半是這顆在本專案改了名、已經是另一顆料），
 *   畫面還寫著「曾參照自 X・來源已不存在」。
 * 修正：判斷在兩個工具共用的 CompMerge.refOrigin／refTidy。顯示用 _ref_origin_id 查目前名稱；參照失效 → 不顯示、
 *       瓦數不鎖；存檔時換成目前名稱、清掉失效的參照標記（5G-RRU 也顯示 _ref_origin_project）。
 *
 * 驗證情境：
 *   [A] 來源已改名 → 載入參照它的專案，元件顯示目前名稱；tooltip 寫出快選當時的名稱；規格書提示也是新名稱
 *   [B] 在本工具改名（_sgApplyRenameToUI）→ 名稱表、快選面板群組名稱即時換掉，參照它的元件顯示新名稱
 *   [C] 存檔 → 元件上的 _ref_origin_project／規格書 _from／_pd_meas_from 換成目前名稱；
 *       參照失效的拿掉三個參照標記（瓦數照留、規格書 _from 照留）並在狀態列說一聲；
 *       沒有參照 id 的、_from 不是當時來源名稱的都不動；不跳衝突、不算未存變更
 *   [D] 載入之後別的工具（5G-RRU）才改名 → 存檔前重讀名稱，寫入最新的名稱
 *   [E] 「↻ 來源有更新」套用規格書 → _from 標的是來源目前的名稱
 *
 * 執行：
 *   python3 -m http.server 8125 --bind 127.0.0.1 &   # 於 repo 根目錄（或 npx http-server . -p 8125 -c-1）
 *   node tests/ref-origin-name.test.js               # 可用 TEST_URL 指定網址、CHROMIUM_PATH 指定瀏覽器
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

const OLD = 'FDD 4T4R 60W';
const SPEC_PATH = '/SPEC/' + OLD + '/RF/BTS6201U__ds.pdf';
const PROJECTS = () => ({
  // 來源專案：id 不變，名稱已經改過
  A: { project_name: 'FDD B1B3 4T4R 480W', meta: { timestamp: '2026-10-01T00:00:00Z' },
       rf_data: [{ Component: 'BTS6201U-PreDriver', 'Power(W)': 1.2, 'Limit(C)': 150,
                   SpecFile: { path: SPEC_PATH, name: 'BTS6201U__ds.pdf', at: '2026-01-01T00:00:00Z' } },
                 { Component: 'Circulators', 'Power(W)': 2 },
                 { Component: 'WGC18630-Final-B3', 'Power(W)': 40 }],
       digital_data: [], pwr_data: [] },
  // 參照它的專案
  B: { project_name: 'FDD B8B20B28 4T4R 480W', meta: { timestamp: '2026-10-02T00:00:00Z' },
       global_params: { T_amb: 55 },
       rf_data: [
         { Component: 'BTS6201U-PreDriver', 'Power(W)': 1.2, 'Limit(C)': 150,
           SpecFile: { path: SPEC_PATH, name: 'BTS6201U__ds.pdf', at: '2026-01-01T00:00:00Z', _from: OLD },
           _ref_origin_project: OLD, _ref_origin_id: 'A', _ref_locked: true, _pd_meas_from: OLD },
         { Component: 'Circulators', 'Power(W)': 2,
           _ref_origin_project: OLD, _ref_origin_id: 'A', _ref_locked: false },          // 曾參照（已解除）
         { Component: 'GTRB097152NCV1-Final', 'Power(W)': 40,                              // 從 WGC18630 快選後改名成另一顆料
           SpecFile: { path: '/SPEC/' + OLD + '/RF/WGC__ds.pdf', name: 'WGC__ds.pdf', _from: OLD },
           _ref_origin_project: OLD, _ref_origin_id: 'A', _ref_locked: true },
         { Component: 'Old-Driver', 'Power(W)': 3,
           _ref_origin_project: '已刪除的專案', _ref_origin_id: 'Z', _ref_locked: true },  // 來源專案已刪除
         { Component: 'Local-LNA', 'Power(W)': 0.5,
           SpecFile: { path: '/SPEC/別的專案/RF/x.pdf', name: 'x.pdf', _from: '別的專案' } }, // 沒有參照 id
       ],
       digital_data: [], pwr_data: [] },
});

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.route('**', r => r.request().url().startsWith(BASE.replace(/index\.html$/, '')) ? r.continue() : r.abort());
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
  await page.waitForFunction(() => typeof saveAllTabs === 'function' && typeof sgRefOriginName === 'function' && window.CompMerge);

  // 假 DB（比照 graphDb：getDoc／getCollection 回複本；writeBatch 的 fields 可以是函式）
  const seed = (projects) => page.evaluate((projects) => {
    window.__db = { projects: JSON.parse(JSON.stringify(projects)) };
    isProtected = false;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => false;
    dbAdapter.refresh = async () => {};
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.getProjectsSorted = async () => Object.entries(window.__db.projects).map(([id, d]) => Object.assign({ id }, d));
    dbAdapter.updateDoc = async (c, id, f) => { window.__db[c][id] = Object.assign({}, window.__db[c][id], JSON.parse(JSON.stringify(f))); };
    dbAdapter.releaseLock = async () => {};
    dbAdapter.writeBatch = async (ops) => {
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      plan.forEach(({ o, f }) => { window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f))); });
    };
    window._ensureLockBeforeWrite = async () => true;
    window.tcpNormalizeSPImages = async () => {};
    sgProjectId = null; sgProjectData = null; currentProjectId = null; currentProjectData = null; vdProjectId = null;
    sgVariantsCache = null; sgProjectTreeCache = null;
  }, projects);
  const loadB = () => page.evaluate(async () => {
    await sgLoadProjects({ noRefresh: true, want: 'B' });
    // 快選快取（背景讀）讀完會再重繪一次
    for (let i = 0; i < 40 && !sgProjectTreeCache; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 30));
  });
  const rowInfo = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#sg-project-components-body tbody tr')]
      .filter(tr => tr.querySelector('.sg-cell-input, .sg-locked-val'));
    return rows.map(tr => {
      const o = tr.querySelector('.sg-ref-origin');
      const view = tr.querySelector('.sg-spec-view');
      return { origin: o ? o.textContent.trim() : '', tip: o ? o.getAttribute('title') : '',
               specTip: view ? view.getAttribute('title') : '',
               gone: !!tr.querySelector('.sg-ref-gone'), locked: !!tr.querySelector('.sg-locked-val'),
               text: tr.querySelector('td').textContent };
    });
  });

  console.log('\n[A] 來源已改名 → 顯示目前名稱');
  await seed(PROJECTS());
  await loadB();
  const a = await rowInfo();
  ok('參照中的元件顯示來源目前的名稱（↩ 參照自 FDD B1B3 4T4R 480W）',
     a[0] && a[0].origin === '↩ 參照自 FDD B1B3 4T4R 480W', a[0]);
  ok('tooltip 寫出快選當時的名稱（追溯用）', a[0] && /快選當時名稱：FDD 4T4R 60W/.test(a[0].tip), a[0] && a[0].tip);
  ok('已解除參照的也顯示目前名稱（曾參照自 FDD B1B3 4T4R 480W）',
     a[1] && a[1].origin === '曾參照自 FDD B1B3 4T4R 480W', a[1]);
  ok('規格書 👁 的提示也是目前名稱', a[0] && /參照自專案「FDD B1B3 4T4R 480W」/.test(a[0].specTip) && !/FDD 4T4R 60W/.test(a[0].specTip), a[0] && a[0].specTip);
  ok('來源裡沒有同名元件（本專案改了名）→ 參照失效：不顯示、沒有「來源已不存在」字樣、瓦數不鎖',
     a[2] && a[2].origin === '' && !a[2].gone && !a[2].text.includes('參照自') && !a[2].locked, a[2]);
  ok('來源專案已刪除 → 一樣不顯示、瓦數不鎖', a[3] && a[3].origin === '' && !a[3].gone && !a[3].locked, a[3]);
  ok('沒有參照的元件不顯示參照標記；規格書 _from 不是當時來源 → 照原字顯示',
     a[4] && a[4].origin === '' && /參照自專案「別的專案」/.test(a[4].specTip), a[4]);
  const a2 = await page.evaluate(() => {
    sgSpecListOpen('RF', 0);
    const t = document.getElementById('sg-speclist-body').textContent;
    sgSpecListClose();
    return { t, data: sgProjectData.rf_data[0]._ref_origin_project };
  });
  ok('規格書清單也顯示目前名稱', /參照自專案「FDD B1B3 4T4R 480W」/.test(a2.t), a2.t);
  ok('只是顯示：記憶體裡的資料沒被改（不會變成未存變更）', a2.data === 'FDD 4T4R 60W', a2);
  ok('載入後沒有未存變更', await page.evaluate(() => !hasUnsavedEdits()));

  console.log('\n[B] 在本工具改名 → 參照它的元件立刻跟著變');
  const b = await page.evaluate(() => {
    _sgApplyRenameToUI('A', 'FDD B1B3 4T4R 520W');
    sgRenderProjectComponents();
    const o = document.querySelector('#sg-project-components-body .sg-ref-origin');
    const g = (sgProjectTreeCache.RF || []).find(x => x.projId === 'A');
    return { origin: o ? o.textContent.trim() : '', group: g && g.projName, map: sgProjDocs.A.project_name,
             dbUntouched: true };
  });
  ok('名稱表更新', b.map === 'FDD B1B3 4T4R 520W', b);
  ok('參照它的元件顯示新名稱', b.origin === '↩ 參照自 FDD B1B3 4T4R 520W', b);
  ok('快選面板的群組名稱也換掉（之後快選帶入的就是新名稱）', b.group === 'FDD B1B3 4T4R 520W', b);
  await page.evaluate(() => { window.__db.projects.A.project_name = 'FDD B1B3 4T4R 520W'; });   // 實際改名寫入的那一筆

  console.log('\n[C] 存檔 → 換成目前名稱、清掉失效的參照');
  await page.evaluate(() => saveAllTabs());
  const c = await page.evaluate(() => JSON.parse(JSON.stringify(window.__db.projects.B.rf_data)));
  const c0 = c.find(x => x.Component === 'BTS6201U-PreDriver') || {};
  const c1 = c.find(x => x.Component === 'Circulators') || {};
  const cg = c.find(x => x.Component === 'GTRB097152NCV1-Final') || {};
  const c2 = c.find(x => x.Component === 'Old-Driver') || {};
  const c3 = c.find(x => x.Component === 'Local-LNA') || {};
  const noRef = x => !('_ref_origin_project' in x) && !('_ref_origin_id' in x) && !('_ref_locked' in x);
  ok('_ref_origin_project 換成目前名稱', c0._ref_origin_project === 'FDD B1B3 4T4R 520W' && c1._ref_origin_project === 'FDD B1B3 4T4R 520W', [c0._ref_origin_project, c1._ref_origin_project]);
  ok('規格書 _from 一起換（路徑不動：實體檔沒有搬）',
     c0.SpecFile && c0.SpecFile._from === 'FDD B1B3 4T4R 520W' && c0.SpecFile.path === SPEC_PATH, c0.SpecFile);
  ok('_pd_meas_from 一起換', c0._pd_meas_from === 'FDD B1B3 4T4R 520W', c0._pd_meas_from);
  ok('id 與鎖定狀態不動', c0._ref_origin_id === 'A' && c0._ref_locked === true && c1._ref_locked === false, c0);
  ok('來源裡沒有同名元件 → 拿掉三個參照標記；瓦數照留；規格書 _from 照留（刪除保護）並換成目前名稱',
     noRef(cg) && cg['Power(W)'] === 40 && cg.SpecFile && cg.SpecFile._from === 'FDD B1B3 4T4R 520W', cg);
  ok('來源專案已刪除 → 拿掉三個參照標記、瓦數照留', noRef(c2) && c2['Power(W)'] === 3, c2);
  ok('沒有參照 id 的元件：規格書 _from 不動', c3.SpecFile && c3.SpecFile._from === '別的專案' && noRef(c3), c3);
  const st = await page.evaluate(() => (document.getElementById('sg-comp-save-status') || {}).textContent || '');
  ok('狀態列說一聲清掉了幾顆失效參照', /清掉 2 顆元件的失效參照/.test(st), st);
  const c4 = await page.evaluate(() => ({
    mem: sgProjectData.rf_data[0]._ref_origin_project,
    conflictOpen: !!document.querySelector('.cm-mask'),
    clean: !hasUnsavedEdits(),
  }));
  // 有衝突的話存檔會停在衝突視窗、什麼都不寫 → 上面的寫入結果本身就證明沒有衝突
  ok('畫面換成寫入的內容、沒有跳衝突、存完沒有未存變更', c4.mem === 'FDD B1B3 4T4R 520W' && !c4.conflictOpen && c4.clean, c4);

  console.log('\n[D] 載入之後別的工具才改名 → 存檔寫入最新名稱');
  await seed(PROJECTS());
  await loadB();
  await page.evaluate(() => {
    window.__db.projects.A.project_name = '5G-RRU 改的名字';                 // 5G-RRU 改名（我們手上的名稱表還是舊的）
    window.__db.projects.B.rf_data[0]['Height(mm)'] = 2.1;                   // 5G-RRU 同時補了同一顆元件的高度
    sgProjectData.rf_data[0].note = '我們改的備註';
  });
  await page.evaluate(() => saveAllTabs());
  const d = await page.evaluate(() => ({ db: JSON.parse(JSON.stringify(window.__db.projects.B.rf_data[0])),
                                          shown: (document.querySelector('#sg-project-components-body .sg-ref-origin') || {}).textContent }));
  ok('寫入最新的名稱', d.db._ref_origin_project === '5G-RRU 改的名字' && d.db.SpecFile._from === '5G-RRU 改的名字', d.db);
  ok('三方合併照常：5G-RRU 補的高度保留、我們的備註寫入、沒有衝突',
     d.db['Height(mm)'] === 2.1 && d.db.note === '我們改的備註', d);
  ok('畫面也換成最新名稱', /5G-RRU 改的名字/.test(d.shown || ''), d.shown);

  console.log('\n[E] 「↻ 來源有更新」套用規格書 → _from 是來源目前的名稱');
  await seed(PROJECTS());
  await page.evaluate(() => {
    // 來源補了第二份規格書 → B 的規格書與來源不同
    window.__db.projects.A.rf_data[0].SpecFile = [
      { path: '/SPEC/FDD 4T4R 60W/RF/BTS6201U__ds.pdf', name: 'BTS6201U__ds.pdf', at: '2026-01-01T00:00:00Z' },
      { path: '/SPEC/FDD B1B3 4T4R 480W/RF/BTS6201U__an.pdf', name: 'BTS6201U__an.pdf', at: '2026-10-01T00:00:00Z' },
    ];
  });
  await loadB();
  const e = await page.evaluate(() => {
    const diff = sgRefDiff(sgProjectData.rf_data[0], 'RF').map(x => x.key);
    sgRefSyncOpen('RF', 0);
    const who = document.getElementById('sg-refsync-who').textContent;
    const body = document.getElementById('sg-refsync-body');
    [...body.querySelectorAll('tbody tr')].forEach(tr => { tr.querySelector('input').checked = /規格書/.test(tr.children[1].textContent); });
    sgRefSyncApply();
    const sf = sgProjectData.rf_data[0].SpecFile;
    return { diff, who, froms: (Array.isArray(sf) ? sf : [sf]).map(s => s._from) };
  });
  ok('差異包含規格書', e.diff.includes('SpecFile'), e.diff);
  ok('視窗標題的來源專案是目前名稱', /來源專案：FDD B1B3 4T4R 480W/.test(e.who), e.who);
  ok('套用後每一份規格書的 _from 都是目前名稱', e.froms.length === 2 && e.froms.every(f => f === 'FDD B1B3 4T4R 480W'), e.froms);

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
