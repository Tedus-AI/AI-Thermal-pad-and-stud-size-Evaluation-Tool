/*
 * TIM 型號庫 ← TIM 管理工具的 TIM 型號目錄（tim_catalog.json）—— headless 驗證
 * ---------------------------------------------------------------------------
 * TIM 材料在 TIM 管理工具建立；它在 SharePoint 放 TIM_Manager/Database/tim_catalog.json。
 * 型號庫的一列可以連結目錄的一筆（src:'tim-manager', srcId），型號／k／廠商參照 TIM 管理工具。
 * 驗證情境（假 dbAdapter：SharePoint 模式、readTimCatalog 回假目錄；材料名稱全為虛構）：
 *   [A] 帶入視窗：列出目錄；同名同類型的既有型號 → 改為連結那一列；新材料 → 新增連結列（類型 = family）
 *   [B] 連結列：型號／k／廠商是純文字＋「TIM 管理工具」標籤；存檔帶 src/srcId；沒連結的列不寫這兩個 key
 *   [C] 跟隨：k、廠商自動套用（提示＋狀態列）；改名／改型態只提示＋「套用」（元件用名稱參照）；已刪除 → 保留值並提示
 *   [D] 工具列徽章 ↻n：已存的連結型號與目錄不一致的筆數
 *   [E] ✂ 解除連結 → 改回輸入框、存檔不帶 src
 *   [F] 未解鎖：沒有「帶入」「新增」「儲存」，狀態列說明有更新待寫入
 *   [G] 本機模式：不讀目錄，連結列照用存下來的值並說明
 *   [H] 驗證：連結列沒有 k → 錯誤訊息指向 TIM 管理工具；名稱一律逸出（不執行 HTML）
 *
 * 執行：
 *   npx http-server . -p 8126 -c-1 &      # 於 repo 根目錄
 *   node tests/tim-catalog.test.js
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const BASE = process.env.TEST_URL || 'http://127.0.0.1:8126/index.html';
const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOT = process.env.SHOT_DIR || '';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const CATALOG = {
  format: 'tim-catalog', version: 1, db_rev: 7, updated_at: '2026-10-20T02:00:00Z',
  materials: [
    { id: 'mat_gf', vendor: 'Vendor-B', model: 'GF-750', tim_type: 'pad', type_label: 'Thermal Pad', family: 'Pad', family_exact: true, k: 7.8, k_method: 'ASTM D5470', avl_label: '已承認' },
    { id: 'mat_tp', vendor: 'Vendor-A', model: 'TP-910', tim_type: 'putty', type_label: 'Thermal Putty', family: 'Putty', family_exact: true, k: 9.1, k_method: '', avl_label: '承認中' },
    { id: 'mat_pcm', vendor: 'Vendor-D', model: 'PCM-45', tim_type: 'pcm', type_label: 'Phase Change', family: 'Grease', family_exact: false, k: 4.5 },
    { id: 'mat_x', vendor: 'Vendor-E', model: '<img src=x onerror="window.__xss=1">', tim_type: 'pad', type_label: 'Thermal Pad', family: 'Pad', family_exact: true, k: 3 },
  ],
};
const LIB = {
  tim_a: { model: 'GF-750', timType: 'Pad', k: 7.5, thickness: 2.5, gapThickness: 1.7, gapUnlock: false, vendor: 'Vendor-B', note: '', at: '2026-09-01T00:00:00Z', by: 'u' },
  tim_b: { model: 'GL-60', timType: 'Grease', k: 6.4, thickness: 0.05, gapThickness: 0.05, gapUnlock: false, vendor: 'Vendor-C', note: '', at: '2026-09-01T00:00:00Z', by: 'u' },
};

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.route('**', r => r.request().url().startsWith(BASE.replace(/index\.html$/, '')) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.XLSX = { utils:{book_new:()=>({}),aoa_to_sheet:()=>({}),book_append_sheet(){}}, writeFile(){} };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.__confirms = []; window.confirm = m => { window.__confirms.push(String(m)); return true; };
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof timLibOpen === 'function' && typeof timCatOpen === 'function');

  const seed = (lib, catalog, sp) => page.evaluate(([lib, catalog, sp]) => {
    window.__db = { tim_library: JSON.parse(JSON.stringify(lib)) };
    window.__catalog = catalog ? JSON.parse(JSON.stringify(catalog)) : null;
    window.__catReads = 0; window.__batches = [];
    isProtected = false;
    dbAdapter.isReady = () => true;
    dbAdapter.isSharePointMode = () => sp;
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.readTimCatalog = async () => { window.__catReads++; return window.__catalog ? JSON.parse(JSON.stringify(window.__catalog)) : null; };
    dbAdapter.getAccountInfo = () => ({ name: 'Tester', email: 't@example.test' });
    dbAdapter.writeBatch = async (ops) => {
      window.__batches.push(JSON.parse(JSON.stringify(ops)));
      ops.forEach(o => { window.__db[o.col][o.id] = JSON.parse(JSON.stringify(o.data)); });
    };
    dbAdapter.deleteDoc = async (c, id) => { delete window.__db[c][id]; };
    window._ensureLockBeforeWrite = async () => true;
    timLibLoaded = false; timLibrary = {}; timCatalog = null; timCatState = 'idle';
  }, [lib, catalog, sp]);
  const rowsInfo = () => page.evaluate(() => Array.from(document.querySelectorAll('#tim-lib-rows tr')).map(tr => ({
    text: tr.innerText.replace(/\s+/g, ' ').trim(),
    linked: tr.classList.contains('tim-lib-linked'),
    modelInput: !!tr.querySelector('input[data-libfield="model"]'),
    kInput: !!tr.querySelector('input[data-libfield="k"]'),
  })));
  const status = () => page.evaluate(() => document.getElementById('tim-lib-status').textContent);
  const lastSaved = () => page.evaluate(() => window.__db.tim_library);

  console.log('\n[A] 從 TIM 管理工具帶入');
  await seed(LIB, CATALOG, true);
  await page.evaluate(() => timLibOpen());
  ok('型號庫開啟時讀了目錄', await page.evaluate(() => window.__catReads === 1 && timCatState === 'ok'));
  ok('解鎖時看得到「從 TIM 管理工具帶入」', await page.isVisible('#tim-lib-cat'));
  await page.click('#tim-lib-cat');
  await page.waitForSelector('#tim-cat-modal', { state: 'visible' });
  const pick = await page.evaluate(() => Array.from(document.querySelectorAll('#tim-cat-rows tr')).map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
  ok('列出目錄 4 筆材料', pick.length === 4, pick);
  ok('同名同類型的既有型號 → 標「將改為連結」', /GF-750.*型號庫有同名，將改為連結/.test(pick.find(t => /GF-750/.test(t)) || ''), pick);
  ok('非確定的類型（Phase Change → Grease）提示確認', /PCM-45.*Grease.*Phase Change（加入後請確認類型）/.test(pick.find(t => /PCM-45/.test(t)) || ''), pick);
  ok('材料名稱逸出、不執行 HTML', await page.evaluate(() => !document.querySelector('#tim-cat-rows img') && !window.__xss));
  await page.fill('#tim-cat-q', 'vendor-a');
  ok('搜尋', (await page.$$('#tim-cat-rows tr')).length === 1);
  await page.fill('#tim-cat-q', '');
  await page.evaluate(() => timCatRenderList());
  await page.click('#tim-cat-rows tr[data-cat-id="mat_gf"]');
  await page.click('#tim-cat-rows tr[data-cat-id="mat_tp"] input');
  ok('勾 2 筆 → 按鈕顯示數量', /加入型號庫（2）/.test(await page.textContent('#tim-cat-ok')));
  if (SHOT) await page.screenshot({ path: SHOT + '/tim-cat-picker.png' });
  await page.click('#tim-cat-ok');
  ok('帶入視窗關閉', !(await page.isVisible('#tim-cat-modal')));
  let rows = await rowsInfo();
  ok('沒有重複新增 GF-750（連結既有那一列）', rows.filter(r => /GF-750/.test(r.text)).length === 1, rows);
  const gf = rows.find(r => /GF-750/.test(r.text));
  ok('GF-750 連結後：型號／k 為純文字＋TIM 管理工具標籤', gf && gf.linked && !gf.modelInput && !gf.kInput && /TIM 管理工具/.test(gf.text), gf);
  ok('GF-750 的 k 跟隨 TIM 管理工具（7.5 → 7.8）並提示', /7\.8/.test(gf.text) && /已依 TIM 管理工具更新 k/.test(gf.text), gf);
  const tp = rows.find(r => /TP-910/.test(r.text));
  ok('TP-910 新增為連結列（類型 Putty、k 9.1、廠商 Vendor-A）', tp && tp.linked && /9\.1/.test(tp.text) && /Vendor-A/.test(tp.text)
     && await page.evaluate(() => _timLibRows.find(r => r.srcId === 'mat_tp').timType === 'Putty'), tp);
  ok('狀態列提醒填填縫厚度', /已加入 1 筆、已連結 1 筆既有型號：請填「填縫厚度」後按「儲存型號庫」/.test(await status()), await status());
  if (SHOT) await page.screenshot({ path: SHOT + '/tim-lib-linked.png' });

  console.log('\n[B] 存檔：連結列帶 src/srcId');
  await page.evaluate(() => timLibSave());
  ok('填縫厚度沒填 → 擋下（TP-910）', /TP-910.*填縫厚度/.test(await status()), await status());
  const idx = await page.evaluate(() => _timLibRows.findIndex(r => r.srcId === 'mat_tp'));
  await page.fill(`#tim-lib-rows tr:nth-child(${idx + 1}) input[data-libfield="thickness"]`, '0.5');
  await page.dispatchEvent(`#tim-lib-rows tr:nth-child(${idx + 1}) input[data-libfield="thickness"]`, 'change');
  await page.evaluate(() => timLibSave());
  let saved = await lastSaved();
  const sGf = Object.values(saved).find(v => v.model === 'GF-750');
  const sTp = Object.values(saved).find(v => v.model === 'TP-910');
  const sGl = Object.values(saved).find(v => v.model === 'GL-60');
  ok('GF-750 存成連結（src/srcId）且 k = 7.8、填縫厚度保留 1.7', sGf && sGf.src === 'tim-manager' && sGf.srcId === 'mat_gf' && sGf.k === 7.8 && sGf.gapThickness === 1.7, sGf);
  ok('TP-910 存成連結、Putty 填縫厚度 = 預設厚度 0.5', sTp && sTp.srcId === 'mat_tp' && sTp.timType === 'Putty' && sTp.gapThickness === 0.5, sTp);
  ok('沒連結的 GL-60 不寫 src / srcId', sGl && !('src' in sGl) && !('srcId' in sGl), sGl);
  ok('首次登錄時間保留', sGf.at === '2026-09-01T00:00:00Z');
  ok('Tab2 型號下拉仍以名稱找得到（5G-RRU 相容）', await page.evaluate(() => !!timLibFindByModel('Pad', 'GF-750') && !!timLibFindByModel('Putty', 'TP-910')));
  await page.evaluate(() => timLibClose());

  console.log('\n[C] TIM 管理工具更新：k / 廠商跟隨；改名、改型態只提示＋套用；已刪除保留值');
  await page.evaluate(() => {
    const c = window.__catalog;
    c.materials.find(m => m.id === 'mat_tp').k = 9.5;
    c.materials.find(m => m.id === 'mat_tp').vendor = 'Vendor-A2';
    c.materials.find(m => m.id === 'mat_gf').model = 'GF-750S';
    c.materials.find(m => m.id === 'mat_gf').family = 'Putty';
  });
  await page.evaluate(() => { timCatState = 'idle'; return Promise.all([timLibLoad(true), timCatLoad()]).then(timCatBadgeSync); });
  ok('[D] 工具列徽章 ↻2', await page.evaluate(() => { const b = document.getElementById('tim-lib-badge'); return b.style.display !== 'none' && b.textContent.trim() === '↻ 2'; }),
     await page.evaluate(() => document.getElementById('tim-lib-badge').textContent));
  await page.evaluate(() => timLibOpen());
  rows = await rowsInfo();
  const tp2 = rows.find(r => /TP-910/.test(r.text));
  ok('TP-910 的 k 9.5、廠商 Vendor-A2 已套用並提示', /9\.5/.test(tp2.text) && /Vendor-A2/.test(tp2.text) && /已依 TIM 管理工具更新 k、廠商/.test(tp2.text), tp2);
  ok('狀態列：已依 TIM 管理工具更新 1 筆', /已依 TIM 管理工具更新 1 筆型號的 k／廠商/.test(await status()), await status());
  const gf2 = rows.find(r => /GF-750/.test(r.text));
  ok('GF-750 改名不自動改，提示「已改名為 GF-750S」', /^GF-750(?!S)/.test(gf2.text) && /已改名為「GF-750S」/.test(gf2.text)
     && await page.evaluate(() => _timLibRows.find(r => r.srcId === 'mat_gf').model === 'GF-750'), gf2);
  ok('型態不同只提示「TIM 管理工具是 Putty」', /TIM 管理工具是 Putty/.test(gf2.text), gf2);
  const gIdx = await page.evaluate(() => _timLibRows.findIndex(r => r.srcId === 'mat_gf'));
  await page.click(`#tim-lib-rows tr:nth-child(${gIdx + 1}) .tim-lib-follow button:has-text("套用")`);
  ok('套用改名前先說明元件參照會斷', await page.evaluate(() => /元件是用型號名稱參照的/.test(window.__confirms.slice(-1)[0] || '')));
  ok('套用後型號 = GF-750S', await page.evaluate(() => _timLibRows.find(r => r.srcId === 'mat_gf').model === 'GF-750S'));
  await page.evaluate(() => timLibSave());
  saved = await lastSaved();
  ok('存檔：TP-910 k 9.5 / Vendor-A2、GF-750S、類型仍是 Pad（沒套用）', !!Object.values(saved).find(v => v.model === 'TP-910' && v.k === 9.5 && v.vendor === 'Vendor-A2')
     && !!Object.values(saved).find(v => v.model === 'GF-750S' && v.timType === 'Pad'), saved);
  ok('存檔後提示收掉、徽章更新（剩型態 1 筆）', await page.evaluate(() => !/已依 TIM 管理工具更新/.test(document.getElementById('tim-lib-rows').innerText)
     && document.getElementById('tim-lib-badge').textContent.trim() === '↻ 1'));
  await page.evaluate(() => timLibClose());
  await page.evaluate(() => { window.__catalog.materials = window.__catalog.materials.filter(m => m.id !== 'mat_tp'); });
  await page.evaluate(() => timLibOpen());
  rows = await rowsInfo();
  const tp3 = rows.find(r => /TP-910/.test(r.text));
  ok('TIM 管理工具刪除材料 → 保留值並提示', /9\.5/.test(tp3.text) && /TIM 管理工具已刪除這筆材料/.test(tp3.text), tp3);

  console.log('\n[E] ✂ 解除連結');
  const tIdx = await page.evaluate(() => _timLibRows.findIndex(r => r.srcId === 'mat_tp'));
  await page.click(`#tim-lib-rows tr:nth-child(${tIdx + 1}) .tim-lib-cut[title^="解除連結"]`);
  rows = await rowsInfo();
  const tp4 = rows.find(r => r.modelInput && !r.linked && r.kInput);
  ok('解除後型號、k 回到輸入框', !!tp4 && await page.evaluate(i => !_timLibRows[i].src && _timLibRows[i].k === 9.5, tIdx), rows);
  await page.evaluate(() => timLibSave());
  saved = await lastSaved();
  const sTp4 = Object.values(saved).find(v => v.model === 'TP-910');
  ok('存檔不帶 src / srcId', sTp4 && !('src' in sTp4) && !('srcId' in sTp4), sTp4);
  await page.evaluate(() => timLibClose());

  console.log('\n[F] 未解鎖：唯讀檢視');
  await page.evaluate(() => { window.__catalog.materials.find(m => m.id === 'mat_gf').k = 8.0; isProtected = true; });
  await page.evaluate(() => timLibOpen());
  ok('沒有帶入／新增／儲存', !(await page.isVisible('#tim-lib-cat')) && !(await page.isVisible('#tim-lib-add')) && !(await page.isVisible('#tim-lib-save')));
  ok('狀態列：有更新，解鎖後儲存即可寫入', /TIM 管理工具有 1 筆型號的 k／廠商更新，解鎖後儲存即可寫入/.test(await status()), await status());
  ok('唯讀時沒有 ✂ 與套用鈕', await page.evaluate(() => !document.querySelector('#tim-lib-rows .tim-lib-cut') && !document.querySelector('#tim-lib-rows .tim-lib-follow button')));
  ok('呼叫 timCatOpen 也開不了', await page.evaluate(() => { timCatOpen(); return document.getElementById('tim-cat-modal').style.display !== 'flex'; }));
  await page.evaluate(() => timLibClose());

  console.log('\n[G] 本機模式');
  await seed({ tim_a: Object.assign({}, LIB.tim_a, { src: 'tim-manager', srcId: 'mat_gf' }) }, CATALOG, false);
  await page.evaluate(() => timLibOpen());
  rows = await rowsInfo();
  ok('不讀目錄', await page.evaluate(() => window.__catReads === 0 && timCatState === 'local'));
  ok('連結列照用存下來的值（k 7.5）並有標籤', rows[0].linked && /7\.5/.test(rows[0].text) && /TIM 管理工具/.test(rows[0].text), rows);
  ok('狀態列說明本機讀不到目錄', /本機／離線模式讀不到 TIM 管理工具的型號目錄/.test(await status()), await status());
  await page.click('#tim-lib-cat');
  ok('帶入視窗說明需要 SharePoint', /本機／離線模式/.test(await page.textContent('#tim-cat-rows')));
  await page.keyboard.press('Escape');
  ok('Esc 關閉帶入視窗', !(await page.isVisible('#tim-cat-modal')));
  await page.evaluate(() => timLibClose());

  console.log('\n[H] 驗證');
  await seed({}, { format: 'tim-catalog', version: 1, materials: [{ id: 'mat_nok', vendor: 'Vendor-F', model: 'NK-1', family: 'Pad', family_exact: true, k: null }] }, true);
  await page.evaluate(() => timLibOpen());
  await page.click('#tim-lib-cat');
  await page.click('#tim-cat-rows tr[data-cat-id="mat_nok"]');
  await page.click('#tim-cat-ok');
  await page.evaluate(() => { _timLibRows[0].thickness = '2'; _timLibRows[0].gapThickness = '1.5'; timLibRender(); return timLibSave(); });
  ok('沒有 k 的連結列 → 指向 TIM 管理工具補上', /在 TIM 管理工具沒有 k 值/.test(await status()), await status());
  ok('k 的純文字格標紅框', await page.evaluate(() => !!document.querySelector('#tim-lib-rows .tim-lib-mirror.tim-lib-invalid')));
  ok('沒有寫入', await page.evaluate(() => window.__batches.length === 0));

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
