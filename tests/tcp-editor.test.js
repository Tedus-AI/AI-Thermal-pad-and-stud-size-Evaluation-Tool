/*
 * 元件位置標註編輯器（tcp-*，Tab1「📍 元件位置標註」）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 驗證情境：
 *   [A] 舊資料轉換：imgFrame（工作區 px）＋相對圖的標籤 ＋ 更舊的相對工作區標籤 ＋ 非破壞裁切
 *       → v2（畫布座標 imgBox / crop / lx,ly）。點在畫面上的位置不變；開啟不算「有未存變更」。
 *   [B] 全新分類：自動建一頁、顯示放圖區；放入照片 → 有圖框、新增模式。
 *   [C] 標註：點清單元件再點照片＝直接帶好名稱；依序標註（需散熱優先）；沒指定 → 自動開選擇器、打字＋Enter。
 *   [D] 拖曳標籤／Ctrl+Z／Ctrl+Y／Ctrl+D／Del／雙擊開選擇器／Esc 只關最上層。
 *   [E] 照片工具：旋轉（點跟著轉、轉回還原）、翻轉、裁切（範圍外的點確認後移除）、還原裁切、復原。
 *   [F] 檢視：+／0、框選放大（不會誤新增點）、選取模式拖曳照片整組移動、四角等比縮放、一鍵排版不重疊。
 *   [G] 存檔：標註視窗內的 💾 → 資料庫是 v2、沒有舊欄位；存檔對帳不刪「復原紀錄還指著」的圖。
 *   [H] 連動：Tab1 改名 → 標註參照換名；刪除元件 → 標註一起刪。
 *   [I] 唯讀：只剩檢視工具、點照片不會新增；解鎖時可「切換為編輯」；開著時被上鎖 → 立刻唯讀。
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/tcp-editor.test.js
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
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

const NAMES = ['XCZU67DR-FFVE1156', 'U850-Si5518', '2GB_DDR', 'SFP', 'Q6505-PSMQC094N10NS2', 'U1451-LM706A0', 'L1452-TMPA1004S'];
const PROJ = (tcp) => ({
  project_name: 'StarKcore-12L', meta: { timestamp: '2026-09-01T00:00:00Z' }, global_params: { T_amb: 55 },
  rf_data: [], pwr_data: [],
  digital_data: NAMES.map(n => ({ Component: n, Qty: 1, 'Power(W)': 2 })),
  hidden_components: { 'L1452-TMPA1004S': true },
  ...(tcp ? { tcPlacement: tcp } : {}),
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
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof saveAllTabs === 'function' && typeof tcpOpenModal === 'function' && window.CompMerge);

  // 測試用的 PCB 圖（1000×625，和 v1 工作區同比例方便驗算）
  const IMG = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1000; c.height = 625;
    const g = c.getContext('2d');
    g.fillStyle = '#0d6b1f'; g.fillRect(0, 0, 1000, 625);
    g.fillStyle = '#aab0bb'; g.fillRect(330, 220, 120, 120);
    g.fillStyle = '#d9a520'; g.fillRect(370, 530, 50, 80);
    return c.toDataURL('image/jpeg', 0.9);
  });

  const seed = (projects) => page.evaluate((projects) => {
    window.__db = { projects: JSON.parse(JSON.stringify(projects)) };
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
      plan.forEach(({ o, f }) => { window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f))); });
    };
    window._ensureLockBeforeWrite = async () => true;
    window.tcpNormalizeSPImages = async () => {};
    const opts = '<option value="">--</option>' + Object.keys(window.__db.projects).map(id => '<option value="' + id + '">' + id + '</option>').join('');
    document.getElementById('sg-project-select').innerHTML = opts;
    sgProjectId = null; sgProjectData = null; currentProjectId = null; currentProjectData = null;
  }, projects);
  const loadTab1 = (id) => page.evaluate(async (id) => { const s = document.getElementById('sg-project-select'); s.value = id; await sgOnProjectChange(); }, id);
  const stageXY = (sx, sy) => page.evaluate(([sx, sy]) => { const r = document.getElementById('tcp-stage').getBoundingClientRect(), k = r.width / 1280; return { x: r.left + sx * k, y: r.top + sy * k }; }, [sx, sy]);
  const imgPt = async (u, v) => { const B = await page.evaluate(() => tcpPage().imgBox); return stageXY(B.x + u * B.w, B.y + v * B.h); };
  const lblCenter = (id) => page.evaluate((id) => { const r = document.querySelector(`[data-tcp-lbl="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);

  console.log('\n[A] 舊資料（v1）開啟時轉成 v2，畫面位置不變、不算未存變更');
  // v1：工作區 1000×625（→ 畫布 ×1.28 剛好填滿）；圖框 600×400 在 (100,50)，裁掉圖的左/上 60/40 px
  const V1 = { digital: { pages: [{ id: 'p1', title: '', isCustomTitle: false, imageData: IMG,
    imgFrame: { x: 100, y: 50, fw: 600, fh: 400, ix: -60, iy: -40, iw: 720, ih: 480, wsW0: 1000, wsH0: 625 },
    history: [{}], historyIndex: 0,
    annotations: [
      { id: 'a1', x: 50, y: 50, componentRef: '2GB_DDR', labelX: 110, labelY: 40, lc: 1 },   // 相對圖
      { id: 'a2', x: 20, y: 30, componentRef: 'SFP', labelX: 5, labelY: 10 },                // 更舊：相對工作區
      { id: 'a3', x: 60, y: 70, componentRef: 'U850-Si5518', labelX: null, labelY: null, lc: 1 },
    ] }] } };
  await seed({ X: PROJ(V1) });
  await loadTab1('X');
  await page.evaluate(() => tcpOpenModal('Digital'));
  await page.waitForTimeout(300);
  const A = await page.evaluate(() => ({ p: JSON.parse(JSON.stringify(Object.assign({}, tcpPage(), { imageData: 'x' }))), dirty: hasUnsavedEdits(),
    dot: tcpDot(tcpPage(), tcpPage().annotations[0]) }));
  ok('圖框 → imgBox（畫布 px，×1.28）', near(A.p.imgBox.x, 128) && near(A.p.imgBox.y, 64) && near(A.p.imgBox.w, 768) && near(A.p.imgBox.h, 512), A.p.imgBox);
  ok('非破壞裁切 → crop（相對整張圖 0~1）', A.p.crop && near(A.p.crop.x, 0.0833, 0.001) && near(A.p.crop.w, 0.8333, 0.001), A.p.crop);
  ok('點的畫面位置不變（v1 工作區 400,250 × 1.28）', near(A.dot.x, 512) && near(A.dot.y, 320), A.dot);
  const a1 = A.p.annotations.find(a => a.id === 'a1'), a2 = A.p.annotations.find(a => a.id === 'a2'), a3 = A.p.annotations.find(a => a.id === 'a3');
  ok('相對圖的標籤 → 畫布 px（51.2＋1.1×921.6）', near(a1.lx, 1065) && near(a1.ly, 258.6), a1);
  ok('更舊的相對工作區標籤 → 畫布 px', near(a2.lx, 64) && near(a2.ly, 80), a2);
  ok('沒有標籤位置的點 → 自動擺一個', a3.lx != null && a3.ly != null, a3);
  ok('舊欄位清掉（imgFrame／labelX／lc／history）、v=2', A.p.v === 2 && !('imgFrame' in A.p) && !('history' in A.p) && A.p.annotations.every(a => !('labelX' in a) && !('lc' in a)), A.p);
  ok('只是打開來看：不算有未存變更', A.dirty === false);
  await page.evaluate(() => tcpCloseModal());

  console.log('\n[B] 全新分類：自動一頁、放圖區、放入照片');
  await seed({ X: PROJ() });
  await loadTab1('X');
  await page.evaluate(() => tcpOpenModal('Digital'));
  ok('自動建一頁、顯示放圖區、不算未存變更', await page.evaluate(() => tcpPages().length === 1 && !!document.getElementById('tcp-drop') && !hasUnsavedEdits()));
  await page.evaluate(async (img) => { const b = await fetch(img).then(r => r.blob()); await tcpSetPhoto(tcpPage(), new File([b], 'pcb.jpg', { type: 'image/jpeg' })); }, IMG);
  const B1 = await page.evaluate(() => ({ box: tcpPage().imgBox, mode: tcpUI.mode, src: !!document.querySelector('#tcp-photo-img[src]'), edited: tcpUI.edited }));
  ok('放入照片：圖框兩側留白給標籤、新增模式、顯示「有未儲存的修改」', B1.box && B1.box.x > 150 && B1.mode === 'add' && B1.src && B1.edited, B1);

  console.log('\n[C] 標註：清單點元件 → 點照片；依序標註；選擇器');
  await page.click('[data-tcp-comp="2GB_DDR"]');
  let pt = await imgPt(0.22, 0.4);
  await page.mouse.click(pt.x, pt.y);
  let C = await page.evaluate(() => tcpPage().annotations.map(a => ({ r: a.componentRef, x: a.x, lx: a.lx })));
  ok('點照片 → 直接帶好元件名稱、標籤自動擺好、不開選擇器', C.length === 1 && C[0].r === '2GB_DDR' && near(C[0].x, 22, 0.3) && C[0].lx != null && !(await page.$('.tcp-picker')), C);
  await page.click('#tcp-seq');
  const first = await page.evaluate(() => tcpUI.armed);
  ok('依序標註：需散熱的優先（隱藏的 L1452 排最後）', first && first !== 'L1452-TMPA1004S' && first !== '2GB_DDR', first);
  for (const [u, v] of [[0.4, 0.45], [0.61, 0.78]]) { pt = await imgPt(u, v); await page.mouse.click(pt.x, pt.y); }
  C = await page.evaluate(() => ({ refs: tcpPage().annotations.map(a => a.componentRef), next: tcpUI.armed }));
  ok('放好一顆自動換下一顆', C.refs.length === 3 && C.refs[1] === first && C.refs[2] && C.refs[2] !== first && !!C.next, C);
  await page.keyboard.press('Escape');
  ok('Esc 結束依序標註（視窗還開著）', await page.evaluate(() => !tcpUI.armed && !tcpUI.seq && tcpIsOpen()));
  pt = await imgPt(0.4, 0.9);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.tcp-picker');
  await page.keyboard.type('sfp');
  await page.keyboard.press('Enter');
  ok('沒指定元件 → 自動開選擇器，輸入＋Enter 指定', await page.evaluate(() => tcpPage().annotations[3].componentRef === 'SFP' && !document.querySelector('.tcp-picker')));
  ok('右側進度：4 / 7', await page.evaluate(() => /4 \/ 7/.test(document.querySelector('#tcp-side-comps .tcp-count').textContent)));

  console.log('\n[D] 編輯操作與復原');
  const id0 = await page.evaluate(() => tcpPage().annotations[0].id);
  const ly0 = await page.evaluate(() => tcpPage().annotations[0].ly);
  let lb = await lblCenter(id0);
  await page.mouse.move(lb.x, lb.y); await page.mouse.down(); await page.mouse.move(lb.x + 10, lb.y + 60, { steps: 5 }); await page.mouse.up();
  const ly1 = await page.evaluate(() => tcpPage().annotations[0].ly);
  ok('拖曳標籤移動', ly1 > ly0 + 40, { ly0, ly1 });
  await page.keyboard.press('Control+z');
  ok('Ctrl+Z 復原', await page.evaluate((y) => tcpPage().annotations[0].ly === y, ly0));
  await page.keyboard.press('Control+y');
  ok('Ctrl+Y 取消復原', await page.evaluate((y) => tcpPage().annotations[0].ly === y, ly1));
  await page.evaluate((id) => tcpSelect(id), id0);
  await page.keyboard.press('Control+d');
  ok('Ctrl+D 複製（同元件）', await page.evaluate(() => tcpPage().annotations.length === 5 && tcpPage().annotations[1].componentRef === '2GB_DDR'));
  await page.keyboard.press('Delete');
  ok('Del 刪除選取的點', await page.evaluate(() => tcpPage().annotations.length === 4));
  lb = await lblCenter(id0);
  await page.mouse.click(lb.x, lb.y); await page.mouse.click(lb.x, lb.y);
  ok('雙擊標籤 → 選擇器', !!(await page.waitForSelector('.tcp-picker', { timeout: 1500 }).catch(() => null)));
  await page.keyboard.press('Escape');
  ok('Esc 只關選擇器', await page.evaluate(() => !document.querySelector('.tcp-picker') && tcpIsOpen()));

  console.log('\n[E] 照片工具');
  const P0 = await page.evaluate(() => tcpPage().annotations.map(a => [a.x, a.y]));
  await page.click('[data-tcp-tool="rotr"]');
  const R1 = await page.evaluate(() => ({ p: tcpPage().annotations.map(a => [a.x, a.y]), rot: tcpPage().imgRot }));
  ok('向右轉：imgRot=90、點 (u,v)→(1−v,u)', R1.rot === 90 && P0.every((q, i) => near(R1.p[i][0], 100 - q[1], 0.02) && near(R1.p[i][1], q[0], 0.02)), R1);
  await page.click('[data-tcp-tool="rotl"]');
  ok('轉回來：點完全還原', await page.evaluate((P0) => !tcpPage().imgRot && tcpPage().annotations.every((a, i) => Math.abs(a.x - P0[i][0]) < 0.02 && Math.abs(a.y - P0[i][1]) < 0.02), P0));
  await page.click('[data-tcp-tool="fliph"]');
  ok('左右翻轉：x→100−x', await page.evaluate((P0) => tcpPage().imgFh === true && tcpPage().annotations.every((a, i) => Math.abs(a.x - (100 - P0[i][0])) < 0.02), P0));
  await page.click('[data-tcp-tool="fliph"]');
  const E = await page.evaluate(() => { const p = tcpPage(); const r = tcpApplyCrop(p, { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }); tcpRenderEditor(); return { r, crop: p.crop, n: p.annotations.length }; });
  ok('裁切：crop 記下、範圍外的點確認後移除', E.r && E.crop.w === 0.6 && E.n < 4, E);
  ok('出現「還原裁切」', !!(await page.$('[data-tcp-tool="uncrop"]')));
  await page.click('[data-tcp-tool="uncrop"]');
  ok('還原裁切', await page.evaluate(() => !tcpPage().crop));
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  ok('Ctrl+Z 兩次：回到裁切前、點也回來', await page.evaluate(() => !tcpPage().crop && tcpPage().annotations.length === 4));

  console.log('\n[F] 檢視與排版');
  await page.keyboard.press('+');
  ok('+ 放大到 125%', await page.evaluate(() => tcpUI.zoom === 1.25 && document.getElementById('tcp-zoom-label').textContent === '125%'));
  await page.keyboard.press('0');
  await page.keyboard.press('z');
  const r0 = await imgPt(0.3, 0.3), r1 = await imgPt(0.5, 0.5);
  await page.mouse.move(r0.x, r0.y); await page.mouse.down(); await page.mouse.move(r1.x, r1.y, { steps: 4 }); await page.mouse.up();
  const F1 = await page.evaluate(() => ({ z: tcpUI.zoom, mode: tcpUI.mode, n: tcpPage().annotations.length }));
  ok('框選放大：放大、回到原模式、沒有誤新增點', F1.z > 3 && F1.mode === 'add' && F1.n === 4, F1);
  await page.keyboard.press('0');
  await page.keyboard.press('v');
  const G0 = await page.evaluate(() => ({ b: { ...tcpPage().imgBox }, lx: tcpPage().annotations[0].lx }));
  pt = await imgPt(0.5, 0.3);
  await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.move(pt.x - 40, pt.y + 20, { steps: 4 }); await page.mouse.up();
  const G1 = await page.evaluate(() => ({ b: tcpPage().imgBox, lx: tcpPage().annotations[0].lx, n: tcpPage().annotations.length }));
  const dx = G1.b.x - G0.b.x;
  ok('選取模式拖曳照片：照片＋標籤整組移動', dx < -20 && near(G1.lx - G0.lx, dx, 1) && G1.n === 4, { G0, G1 });
  const hd = await page.evaluate(() => { const r = document.querySelector('[data-tcp-handle="se"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(hd.x, hd.y); await page.mouse.down(); await page.mouse.move(hd.x - 80, hd.y - 10, { steps: 4 }); await page.mouse.up();
  const G2 = await page.evaluate(() => tcpPage().imgBox);
  ok('拖曳右下角：等比縮小、左上角固定', G2.w < G1.b.w && near(G2.w / G2.h, G1.b.w / G1.b.h, 0.01) && near(G2.x, G1.b.x, 0.2), { G1: G1.b, G2 });
  await page.click('[data-tcp-tool="layout"]');
  ok('一鍵排版：標籤不重疊、都在照片外', await page.evaluate(() => { const p = tcpPage(), c = tcpCtx(), B = p.imgBox;
    return !tcpLabelsOverlap(p, c) && tcpLabelRects(p, c).every(r => r.x + r.w <= B.x + 0.5 || r.x >= B.x + B.w - 0.5 || r.y + r.h <= B.y + 0.5 || r.y >= B.y + B.h - 0.5); }));

  console.log('\n[G] 存檔');
  await page.click('#tcp-save-btn');
  await page.waitForTimeout(300);
  const db = await page.evaluate(() => window.__db.projects.X.tcPlacement.digital.pages[0]);
  ok('資料庫是 v2：imgBox、標籤畫布座標、沒有 imgFrame／history', db.v === 2 && db.imgBox && db.annotations.every(a => a.lx != null && !('labelX' in a)) && !('imgFrame' in db) && !('history' in db), Object.keys(db));
  ok('存完「有未儲存的修改」消失', await page.evaluate(() => document.getElementById('tcp-unsaved').hidden && !hasUnsavedEdits()));
  const audit = await page.evaluate(() => {
    const p = tcpPage(); const keep = p.imageData;
    p.imageData = 'sp:/tcp_images/X_digital_1.jpg'; tcpPushHist(p); p.imageData = 'sp:/tcp_images/X_digital_2.jpg';
    const used = [...tcpCollectUsedImagePaths()];
    tcpUndo(); p.imageData = keep;
    return used;
  });
  ok('存檔對帳：復原紀錄還指著的舊圖也算在用（不會被當孤兒刪掉）', audit.includes('/tcp_images/X_digital_1.jpg') && audit.includes('/tcp_images/X_digital_2.jpg'), audit);

  console.log('\n[H] 與元件清單連動');
  await page.evaluate(() => tcpCloseModal());
  await page.evaluate(() => { const i = sgProjectData.digital_data.findIndex(c => c.Component === 'SFP');
    const el = document.querySelector(`input[data-cat="Digital"][data-field="Component"][data-idx="${i}"]`);
    el.value = 'SFP28'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  ok('Tab1 改名 → 標註參照換名', await page.evaluate(() => sgProjectData.tcPlacement.digital.pages[0].annotations.some(a => a.componentRef === 'SFP28')));
  await page.evaluate(() => sgDeleteComp('Digital', sgProjectData.digital_data.findIndex(c => c.Component === '2GB_DDR')));
  ok('刪除元件 → 它的標註一起刪', await page.evaluate(() => !sgProjectData.tcPlacement.digital.pages[0].annotations.some(a => a.componentRef === '2GB_DDR')));

  console.log('\n[I] 唯讀與上鎖');
  await page.evaluate(() => tcpOpenModal('Digital', true));
  const I = await page.evaluate(() => ({ tools: [...document.querySelectorAll('#tcp-toolbar [data-tcp-tool]')].map(b => b.dataset.tcpTool),
    sel: document.querySelectorAll('.tcp-mcomp').length, badge: !!document.querySelector('.tcp-ro-badge'), n: tcpPage().annotations.length }));
  ok('唯讀：只剩檢視工具、沒有下拉、顯示唯讀', I.badge && I.sel === 0 && I.tools.every(t => ['magnify', 'zoomout', 'zoomfit', 'zoomin', 'side'].includes(t)), I);
  pt = await imgPt(0.8, 0.2); await page.mouse.click(pt.x, pt.y);
  ok('唯讀：點照片不會新增', await page.evaluate((n) => tcpPage().annotations.length === n, I.n));
  await page.click('#tcp-to-edit');
  ok('解鎖狀態：「切換為編輯」', await page.evaluate(() => !tcpUI.viewOnly && !!document.getElementById('tcp-save-btn')));
  await page.evaluate(() => { isProtected = true; tcpSyncPlacementBtns(); });
  ok('開著時被上鎖 → 立刻唯讀', await page.evaluate(() => tcpUI.viewOnly && !!document.querySelector('.tcp-ro-badge')));
  await page.evaluate(() => { isProtected = false; tcpCloseModal(); });

  ok('頁面無 JS 例外', errors.length === 0, errors);
  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
