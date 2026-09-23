/*
 * 一顆元件多份規格書 + TH/ME 頁的規格書檢視欄 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 需求：
 *   1) 規格書一顆元件可以存多份，但**外層按鈕數量不變**（仍是 👁 ↑ ↓ 🗑 🕘 五顆）；
 *      已上傳的可以「刪除」或「上傳新的取代」；瀏覽時可以選要看哪一份。
 *   2) TH/ME 頁（Tab2）元件名稱右邊加一個規格書欄，只搬 Tab1 的 👁（線上瀏覽）。
 *
 * 資料形狀（共用 DB，5G-RRU 原樣保留）：comp.SpecFile
 *   1 份 → 單一物件（＝舊格式，既有專案的 DB 內容完全不變）
 *   ≥2 份 → 陣列
 *   讀一律 sgSpecList()、寫一律 sgSpecStore()；0 份 delete key（不可寫 '' 或 []）。
 *
 * 驗證情境：
 *   [A] 舊資料（單一物件）照舊：五顆按鈕、無數量徽章、↓ 直接下載、🗑 直接問
 *   [B] 多份：👁 有數量徽章；預覽視窗出現檔案切換列，點了就換看那一份
 *   [C] 上傳可多選並附加；同檔名取代該筆（不產生重複）；到達上限會擋
 *   [D] 🔄 取代第 k 份：位置不動、其餘不受影響；舊檔「存檔成功後」才刪
 *   [E] 刪除其中一份：剩 1 份要寫回「單一物件」形狀；刪光要 delete key；實體檔存檔後才刪
 *   [J] 延後刪檔：沒存就換專案 → 不刪；存檔時還有別的專案指著同一個檔 → 不刪
 *   [F] 快選參照：多份都標 _from；刪除參照只解除、不刪來源檔
 *   [G] 唯讀（未解鎖）：清單只剩 👁／↓，上傳／取代／刪除鍵不畫出來；👁 仍可用
 *   [H] Tab2：規格書欄在元件名稱右邊、只有一顆 👁、讀 Tab2 自己的專案副本
 *   [I] 頁面無 JS 例外
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/spec-multi.test.js
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
    window.__confirms = []; window.confirm = m => { window.__confirms.push(String(m)); return window.__confirmAnswer !== false; };
    window.__confirmAnswer = true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('filechooser', fc => { fc.setFiles([]).catch(() => {}); });   // 沒人餵檔就取消，不要卡住
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sgSpecList === 'function' && typeof th2SpecCell === 'function');

  // ── 共用 stub：把 SharePoint 檔案操作換成記錄用的假的 ────────────────────
  await page.evaluate(() => {
    window.__io = { uploads: [], deletes: [], meta: [] };
    dbAdapter.isSharePointMode = () => true;
    dbAdapter.getAccountInfo = () => ({ name: '測試者' });
    dbAdapter.uploadSpec = async (proj, cat, comp, file) => {
      window.__io.uploads.push({ proj, cat, comp, name: file.name });
      return '/SPEC/' + proj + '/' + cat + '/' + comp + '__' + file.name;
    };
    dbAdapter.deleteSpec = async (path) => { window.__io.deletes.push(path); };
    dbAdapter.getSpecSrc = async (path) => 'blob:fake/' + path;
    dbAdapter.getSpecMeta = async (path) => { window.__io.meta.push(path); return { downloadUrl: 'x', webUrl: 'w', name: path, size: 10 }; };
    window.roToast = window.roToast || (() => {});
  });

  const mkSpec = (n, extra) => Object.assign({ path: '/SPEC/P/RF/PA__' + n, name: n, at: '2026-09-01T00:00:00.000Z', by: '甲' }, extra || {});
  const setup = async (specFile, protectedMode) => page.evaluate(([sf, prot]) => {
    isProtected = !!prot;
    sgProjectId = 'P1';
    sgProjectData = { project_name: '專案A', rf_data: [{ Component: 'PA', Qty: 4, 'Power(W)': 52 }], digital_data: [], pwr_data: [] };
    if (sf !== null) sgProjectData.rf_data[0].SpecFile = sf;
    // 模擬真的載入：資料庫裡的樣子、補發元件 id、載入時快照（存檔三方合併用）
    CompMerge.ensureProjectCids(sgProjectData);
    window.__db = { projects: { P1: JSON.parse(JSON.stringify(sgProjectData)) } };
    sgProjectBase = sgBaseFrom(sgProjectData);
    sgPendingSpecDeletes = [];
    window.__io.deletes.length = 0;
    sgVariantsCache = { RF: [], Digital: [], PWR: [] };
    sgProjectTreeCache = { RF: [], Digital: [], PWR: [] };
    sgRenderProjectComponents();
    window.__alerts.length = 0; window.__confirms.length = 0;
  }, [specFile, protectedMode]);

  // 按「儲存元件變更」：假 DB（writeBatch 跟真的後端一樣，fields 可以是函式）
  const saveNow = () => page.evaluate(async () => {
    dbAdapter.isReady = () => true;
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.writeBatch = async (ops) => ops.forEach(o => {
      const cur = (window.__db[o.col] || {})[o.id];
      const f = typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields;
      window.__db[o.col] = window.__db[o.col] || {};
      window.__db[o.col][o.id] = Object.assign({}, cur || {}, JSON.parse(JSON.stringify(f)));
    });
    dbAdapter.releaseLock = async () => {};
    window._ensureLockBeforeWrite = async () => true;
    window.tcpNormalizeSPImages = async () => {};
    window.tcpAuditImages = async () => ({});
    window.relock = () => {};
    await saveAllTabs();
    await new Promise(r => setTimeout(r, 80));   // 刪檔是存檔成功後 fire-and-forget
    return window.__io.deletes.slice();
  });

  const cellInfo = () => page.evaluate(() => {
    const cell = document.querySelector('#sg-project-components .sg-spec-cell .sg-spec-btns');
    if (!cell) return null;
    const btns = [...cell.querySelectorAll('button')];
    return {
      count: btns.length,
      labels: btns.map(b => b.textContent.trim()),
      disabled: btns.map(b => b.disabled),
      badge: (cell.querySelector('.sg-spec-n') || {}).textContent || '',
      viewTip: btns[0].title, upTip: btns[1].title, downTip: btns[2].title,
      delTip: btns[3].title, listTip: btns[4].title,
    };
  });

  console.log('\n[A] 舊資料（單一物件）完全照舊');
  await setup(mkSpec('PA.pdf'));
  const a = await cellInfo();
  const a2 = await page.evaluate(() => ({
    list: sgSpecList(sgProjectData.rf_data[0]).length,
    shape: Array.isArray(sgProjectData.rf_data[0].SpecFile) ? 'array' : 'object',
  }));
  ok('外層仍是五顆按鈕 👁 ↑ ↓ 🗑 🕘', a.count === 5 && /👁/.test(a.labels[0]) && a.labels[1] === '↑'
     && a.labels[2] === '↓' && a.labels[3] === '🗑' && a.labels[4] === '🕘', a.labels);
  ok('單一物件讀成 1 份、沒有數量徽章', a2.list === 1 && a2.shape === 'object' && a.badge === '', { a2, badge: a.badge });
  ok('tooltip 是單份語意（不提「共 N 份」）', /線上瀏覽：PA\.pdf/.test(a.viewTip) && !/共/.test(a.viewTip), a.viewTip);
  const aDown = await page.evaluate(async () => {
    window.__clicks = []; const _c = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__clicks.push(this.download); };
    await sgSpecDownload('RF', 0);
    HTMLAnchorElement.prototype.click = _c;
    return { clicks: window.__clicks, listOpen: document.getElementById('sg-speclist-modal').style.display };
  });
  ok('1 份時 ↓ 直接下載（不開清單）', aDown.clicks[0] === 'PA.pdf' && aDown.listOpen !== 'flex', aDown);

  console.log('\n[B] 多份：數量徽章 + 預覽視窗可切換');
  await setup([mkSpec('PA_datasheet.pdf'), mkSpec('PA_appnote.pdf'), mkSpec('PA_errata.pdf')]);
  const b = await cellInfo();
  ok('👁 上出現數量徽章 3、按鈕數仍是 5', b.badge === '3' && b.count === 5, b);
  ok('tooltip 列出全部三份', /共 3 份/.test(b.viewTip) && /1\. PA_datasheet\.pdf/.test(b.viewTip)
     && /3\. PA_errata\.pdf/.test(b.viewTip), b.viewTip);
  ok('↑ tooltip 說明「可多選、同檔名取代」', /可一次選多個檔案/.test(b.upTip) && /同檔名/.test(b.upTip), b.upTip);
  ok('↓／🗑 tooltip 說明會開清單挑', /開啟清單/.test(b.downTip) && /開啟清單/.test(b.delTip), { d: b.downTip, x: b.delTip });
  const bView = await page.evaluate(async () => {
    await sgSpecView('RF', 0);
    await new Promise(r => setTimeout(r, 60));
    const tabs = document.getElementById('sg-specview-tabs');
    const chips = [...tabs.querySelectorAll('.sg-sv-tab')];
    return { shown: getComputedStyle(tabs).display, n: chips.length,
             active: chips.findIndex(c => c.classList.contains('active')),
             texts: chips.map(c => c.textContent.trim()),
             title: document.getElementById('sg-specview-title').textContent,
             sub: document.getElementById('sg-specview-sub').textContent };
  });
  ok('預覽視窗出現三個檔案頁籤、第一個為 active', bView.n === 3 && bView.active === 0 && bView.shown === 'flex', bView);
  ok('標題與副標顯示「第 1 / 3 份」', bView.title === 'PA_datasheet.pdf' && /第 1 \/ 3 份/.test(bView.sub), bView);
  const bSwitch = await page.evaluate(async () => {
    document.querySelectorAll('#sg-specview-tabs .sg-sv-tab')[2].click();
    await new Promise(r => setTimeout(r, 60));
    return { title: document.getElementById('sg-specview-title').textContent,
             active: [...document.querySelectorAll('#sg-specview-tabs .sg-sv-tab')].findIndex(c => c.classList.contains('active')),
             k: _sgSpecViewState && _sgSpecViewState.k,
             sub: document.getElementById('sg-specview-sub').textContent };
  });
  ok('點第三個頁籤 → 換看第三份', bSwitch.title === 'PA_errata.pdf' && bSwitch.active === 2
     && bSwitch.k === 2 && /第 3 \/ 3 份/.test(bSwitch.sub), bSwitch);
  const bDl = await page.evaluate(() => {
    window.__clicks = []; const _c = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__clicks.push(this.download); };
    sgSpecViewDownload();
    return new Promise(r => setTimeout(() => { HTMLAnchorElement.prototype.click = _c; r(window.__clicks); }, 60));
  });
  ok('預覽視窗的「⬇ 下載」抓的是「現在看的那一份」', bDl[0] === 'PA_errata.pdf', bDl);
  await page.evaluate(() => sgSpecViewClose());
  const bDown = await page.evaluate(async () => {
    await sgSpecDownload('RF', 0);
    const rows = [...document.querySelectorAll('#sg-speclist-body tbody tr')];
    return { open: document.getElementById('sg-speclist-modal').style.display,
             rows: rows.length,
             names: rows.map(r => r.querySelector('.fname').textContent.trim()),
             acts: rows[0] ? [...rows[0].querySelectorAll('.acts button')].map(b => b.textContent.trim()) : [],
             who: document.getElementById('sg-speclist-who').textContent };
  });
  ok('多份時 ↓ 開清單，列出三份與每份的動作鍵', bDown.open === 'flex' && bDown.rows === 3
     && bDown.acts.join('') === '👁↓🔄🗑' && /共 3 份/.test(bDown.who), bDown);

  console.log('\n[C] 上傳：可多選、附加、同檔名取代');
  await setup([mkSpec('PA_datasheet.pdf')]);
  const c1 = await page.evaluate(async () => {
    sgSpecUpload('RF', 0);
    const input = document.getElementById('sg-spec-file-input');
    const multiple = input.multiple, target = JSON.parse(JSON.stringify(_sgSpecTarget || {}));
    await sgSpecOnFilePicked({ files: [new File(['a'], 'PA_appnote.pdf'), new File(['b'], 'PA_errata.pdf')] });
    const comp = sgProjectData.rf_data[0];
    return { multiple, target, shape: Array.isArray(comp.SpecFile) ? 'array' : 'object',
             names: sgSpecList(comp).map(s => s.name), by: sgSpecList(comp)[1].by,
             uploads: window.__io.uploads.map(u => u.name), deletes: window.__io.deletes.slice() };
  });
  ok('↑ 設定 multiple=true 並標記 append 模式', c1.multiple === true && c1.target.mode === 'append', c1);
  ok('兩個新檔附加到清單尾巴（共 3 份、形狀轉成陣列）',
     c1.shape === 'array' && c1.names.join(',') === 'PA_datasheet.pdf,PA_appnote.pdf,PA_errata.pdf', c1);
  ok('上傳者記到每一筆、沒有誤刪任何檔', c1.by === '測試者' && c1.deletes.length === 0, c1);
  const c2 = await page.evaluate(async () => {
    window.__io.uploads.length = 0;
    _sgSpecTarget = { cat: 'RF', idx: 0, mode: 'append' };
    await sgSpecOnFilePicked({ files: [new File(['z'], 'PA_APPNOTE.pdf')] });   // 同名（不分大小寫）
    const list = sgSpecList(sgProjectData.rf_data[0]);
    return { n: list.length, names: list.map(s => s.name), pos: list.findIndex(s => /appnote/i.test(s.name)),
             deletes: window.__io.deletes.slice() };
  });
  ok('同檔名再上傳 → 取代原本那一筆、不新增重複項（位置不動）',
     c2.n === 3 && c2.pos === 1 && c2.names[1] === 'PA_APPNOTE.pdf', c2);
  const c3 = await page.evaluate(async () => {
    const comp = sgProjectData.rf_data[0];
    const many = []; for (let i = 0; i < SG_SPEC_MAX; i++) many.push({ path: '/p/' + i, name: 'f' + i + '.pdf' });
    sgSpecStore(comp, many);
    sgRenderProjectComponents();
    window.__alerts.length = 0;
    sgSpecUpload('RF', 0);
    return { alerts: window.__alerts.slice(), target: _sgSpecTarget };
  });
  ok('到達上限（' + 20 + ' 份）會擋下並說明', /上限/.test(c3.alerts[0] || '') && !c3.target, c3);

  console.log('\n[D] 🔄 取代某一份');
  await setup([mkSpec('a.pdf'), mkSpec('b.pdf'), mkSpec('c.pdf')]);
  const d = await page.evaluate(async () => {
    window.__io.deletes.length = 0;
    sgSpecUpload('RF', 0, 'replace', 1);
    const input = document.getElementById('sg-spec-file-input');
    const multiple = input.multiple;
    await sgSpecOnFilePicked({ files: [new File(['n'], 'b_rev2.pdf')] });
    const list = sgSpecList(sgProjectData.rf_data[0]);
    return { multiple, names: list.map(s => s.name), deletes: window.__io.deletes.slice() };
  });
  ok('取代模式 multiple=false、就地換掉第 2 份（順序不變）',
     d.multiple === false && d.names.join(',') === 'a.pdf,b_rev2.pdf,c.pdf', d);
  ok('取代後還沒存 → 舊檔先不刪（沒存就離開，資料庫還指著它）', d.deletes.length === 0, d.deletes);
  const dSaved = await saveNow();
  ok('按「儲存元件變更」成功後才從 SharePoint 刪掉舊檔（只刪那一份）',
     dSaved.length === 1 && /b\.pdf$/.test(dSaved[0]), dSaved);

  console.log('\n[E] 刪除一份 / 刪到剩一份 / 刪光');
  await setup([mkSpec('a.pdf'), mkSpec('b.pdf'), mkSpec('c.pdf')]);
  const e1 = await page.evaluate(async () => {
    await sgSpecDeleteAt('RF', 0, 1);
    const comp = sgProjectData.rf_data[0];
    return { names: sgSpecList(comp).map(s => s.name), shape: Array.isArray(comp.SpecFile) ? 'array' : 'object',
             deletes: window.__io.deletes.slice(), confirms: window.__confirms.length };
  });
  ok('刪掉第 2 份 → 其餘保留、問了兩次確認、實體檔先不刪（存檔後才刪）',
     e1.names.join(',') === 'a.pdf,c.pdf' && e1.deletes.length === 0 && e1.confirms === 2, e1);
  const e1Saved = await saveNow();
  ok('存檔成功後才刪實體檔', e1Saved.length === 1 && /b\.pdf$/.test(e1Saved[0]), e1Saved);
  const e2 = await page.evaluate(async () => {
    await sgSpecDeleteAt('RF', 0, 1);
    const comp = sgProjectData.rf_data[0];
    return { shape: Array.isArray(comp.SpecFile) ? 'array' : 'object', name: comp.SpecFile && comp.SpecFile.name };
  });
  ok('剩 1 份 → 寫回舊的「單一物件」形狀（共用 DB 形狀不變）', e2.shape === 'object' && e2.name === 'a.pdf', e2);
  const e3 = await page.evaluate(async () => {
    await sgSpecDeleteAt('RF', 0, 0);
    const comp = sgProjectData.rf_data[0];
    return { has: Object.prototype.hasOwnProperty.call(comp, 'SpecFile'), val: comp.SpecFile,
             cell: document.querySelector('#sg-project-components .sg-spec-cell .sg-spec-btns button').disabled };
  });
  ok('全部刪光 → delete key（不是 \'\' 也不是 []）、👁 變回停用', e3.has === false && e3.cell === true, e3);

  console.log('\n[J] 延後刪檔的保護');
  await setup([mkSpec('a.pdf'), mkSpec('b.pdf')]);
  const g1 = await page.evaluate(async () => {
    window.__io.deletes.length = 0;
    await sgSpecDeleteAt('RF', 0, 1);
    const pending = sgPendingSpecDeletes.length;
    const sel = document.getElementById('sg-project-select');
    if (sel) sel.value = '';
    await sgOnProjectChange();                          // 沒存就換專案
    await sgFlushSpecDeletes('P1');
    return { pending, after: sgPendingSpecDeletes.length, deletes: window.__io.deletes.slice() };
  });
  ok('沒存就換專案 → 待刪清單清掉、檔案不刪（資料庫還指著它）', g1.pending === 1 && g1.after === 0 && g1.deletes.length === 0, g1);
  await setup([mkSpec('a.pdf'), mkSpec('b.pdf')]);
  await page.evaluate(async () => {
    window.__io.deletes.length = 0;
    // 別的專案（快選參照）也指著 b.pdf
    window.__db.projects.OTHER = { project_name: '別案', rf_data: [{ Component: 'PA', SpecFile: { path: '/SPEC/P/RF/PA__b.pdf', name: 'b.pdf', _from: '專案A' } }] };
    await sgSpecDeleteAt('RF', 0, 1);
  });
  const g2 = await saveNow();
  ok('存檔時還有別的專案指著同一個檔 → 不刪', g2.length === 0, g2);

  console.log('\n[F] 快選參照：每一份都標 _from');
  const f = await page.evaluate(() => {
    const o = { SpecFile: [{ path: '/x/1', name: '1.pdf' }, { path: '/x/2', name: '2.pdf' }] };
    sgSpecMarkFrom(o, '來源案');
    const single = { SpecFile: { path: '/y/1', name: 'y.pdf' } };
    sgSpecMarkFrom(single, '來源案');
    return { arr: o.SpecFile.map(s => s._from), one: single.SpecFile._from };
  });
  ok('多份與單份都標到 _from（刪除時才知道只能解除參照）',
     f.arr.join(',') === '來源案,來源案' && f.one === '來源案', f);
  await setup([mkSpec('a.pdf'), mkSpec('ref.pdf', { _from: '來源案' })]);
  const f2 = await page.evaluate(async () => {
    window.__io.deletes.length = 0; window.__confirms.length = 0;
    await sgSpecDeleteAt('RF', 0, 1);
    return { names: sgSpecList(sgProjectData.rf_data[0]).map(s => s.name),
             deletes: window.__io.deletes.slice(), confirm: window.__confirms[0] || '' };
  });
  ok('刪除「參照」那一份只解除參照、不刪來源檔',
     f2.names.join(',') === 'a.pdf' && f2.deletes.length === 0 && /不會刪除來源專案/.test(f2.confirm), f2);

  console.log('\n[G] 唯讀（未解鎖）');
  await setup([mkSpec('a.pdf'), mkSpec('b.pdf')], true);
  const g = await page.evaluate(async () => {
    sgSpecInfo('RF', 0);
    const rows = [...document.querySelectorAll('#sg-speclist-body tbody tr')];
    const acts = rows[0] ? [...rows[0].querySelectorAll('.acts button')].map(b => b.textContent.trim()) : [];
    const add = document.getElementById('sg-speclist-add');
    const hint = document.getElementById('sg-speclist-hint');
    window.__alerts.length = 0;
    sgSpecUpload('RF', 0);            // 硬呼叫寫入動作也要被擋
    await sgSpecDeleteAt('RF', 0, 0);
    return { acts, addHidden: add.style.display === 'none', hint: hint.textContent,
             hintShown: hint.style.display !== 'none',
             alerts: window.__alerts.slice(), n: sgSpecList(sgProjectData.rf_data[0]).length };
  });
  ok('唯讀時清單只給 👁／↓，上傳鍵隱藏並說明原因',
     g.acts.join('') === '👁↓' && g.addHidden && g.hintShown && /解鎖/.test(g.hint), g);
  ok('唯讀時硬呼叫上傳／刪除都會被擋（資料不變）',
     g.alerts.length === 2 && g.alerts.every(a => /解鎖/.test(a)) && g.n === 2, g);
  const gView = await page.evaluate(async () => {
    sgSpecListClose();
    const btn = document.querySelector('#sg-project-components .sg-spec-cell .sg-spec-btns button');
    return { roClass: btn.classList.contains('sg-spec-ro'), disabled: btn.disabled };
  });
  ok('唯讀時 👁 仍可用（sg-spec-ro，未被唯讀鎖停用）', gView.roClass === true && gView.disabled === false, gView);

  console.log('\n[H] TH/ME 頁（Tab2）的規格書欄');
  const h = await page.evaluate(() => {
    isProtected = false;
    currentProjectData = { project_name: '專案B', rf_data: [
      { Component: 'PA', Qty: 4, 'Power(W)': 52, SpecFile: [{ path: '/s/1', name: 'd1.pdf' }, { path: '/s/2', name: 'd2.pdf' }] },
      { Component: 'LNA', Qty: 2, 'Power(W)': 3 },
    ], digital_data: [], pwr_data: [] };
    thermalSpecs = {}; hiddenComponents = {};
    renderAllCategories();
    const ths = [...document.querySelectorAll('#comp-container table.comp-table thead th')].map(t => t.textContent.trim());
    const row = document.querySelector('#comp-container table.comp-table tbody tr');
    const tds = [...row.children];
    const specTd = tds[3];
    const btns = [...specTd.querySelectorAll('button')];
    const row2 = document.querySelectorAll('#comp-container table.comp-table tbody tr')[1];
    const btn2 = row2.children[3].querySelector('button');
    return {
      ths, afterName: ths[3], nameIdx: ths.indexOf('元件名稱'),
      btnCount: btns.length, label: btns[0].textContent.trim(),
      badge: (specTd.querySelector('.sg-spec-n') || {}).textContent || '',
      ro: btns[0].classList.contains('sg-spec-ro'), tip: btns[0].title,
      emptyDisabled: btn2.disabled, emptyTip: btn2.title,
      onclick: btns[0].getAttribute('onclick'),
    };
  });
  ok('規格書欄就在「元件名稱」右邊', h.nameIdx === 2 && h.afterName === '規格書', h.ths);
  ok('只有一顆 👁（沒有把上傳／刪除也搬過來）', h.btnCount === 1 && /👁/.test(h.label), h);
  ok('多份時同樣顯示數量徽章、tooltip 列出各份', h.badge === '2' && /共 2 份/.test(h.tip), h);
  ok('讀的是 Tab2 自己的專案副本（src=tab2）', /sgSpecView\('RF',0,0,'tab2'\)/.test(h.onclick || ''), h.onclick);
  ok('沒有規格書的元件 👁 停用並指路回 Tab1', h.emptyDisabled === true && /EE\/RF\/PWR/.test(h.emptyTip), h);
  const h2 = await page.evaluate(async () => {
    sgProjectData = { project_name: '專案A', rf_data: [{ Component: 'PA' }], digital_data: [], pwr_data: [] };  // Tab1 是別的專案、沒規格書
    await sgSpecView('RF', 0, 0, 'tab2');
    await new Promise(r => setTimeout(r, 60));
    const t = document.getElementById('sg-specview-title').textContent;
    const state = { k: _sgSpecViewState && _sgSpecViewState.k, src: _sgSpecViewState && _sgSpecViewState.src };
    sgSpecViewClose();
    return { t, state };
  });
  ok('Tab1 載入別的專案時，Tab2 的 👁 仍看得到 Tab2 那顆元件的規格書',
     h2.t === 'd1.pdf' && h2.state.src === 'tab2', h2);
  const h3 = await page.evaluate(() => {
    isProtected = true; applyReadonlyLock();
    const b = document.querySelector('#comp-container table.comp-table tbody tr').children[3].querySelector('button');
    const ret = { disabled: b.disabled };
    isProtected = false; applyReadonlyLock();
    return ret;
  });
  ok('Tab2 的 👁 在未解鎖時也不會被唯讀鎖停用', h3.disabled === false, h3);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
