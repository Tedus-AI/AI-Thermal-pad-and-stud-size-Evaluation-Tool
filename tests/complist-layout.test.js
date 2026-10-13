/*
 * TH/ME-專案元件清單（Tab2）版面與備註 icon —— headless 驗證
 * ---------------------------------------------------------------------------
 * 驗證情境：
 *   [A] 版面：22 吋（1920）、17 吋筆電（125% 縮放＝1536；1600）、1440、1366 都沒有橫向捲軸
 *       （整頁與每一張表），欄位順序不變，代表性的值沒有被截斷，鎖定值與 ✂ 同一行
 *   [B] 右側浮動工具列在預設位置時不蓋住最右邊的「備註」欄；工具列被拖走（.gm-moved）就不讓位
 *   [C] 備註欄是 📝 icon（與 EE/RF/PWR 頁、模擬與實測驗證頁同一套）：沒寫反灰、有寫上色；
 *       滑過顯示完整內容；點開視窗編輯 → 寫回 thermal_specs[key].note；清空 → 刪 key
 *       （spec 空了整個刪）；算未存變更；存檔寫進資料庫；重繪後展開中的「被隱藏的元件」維持展開、捲動位置不跳
 *   [D] 未解鎖：📝 仍可點開檢視（唯讀、沒有「確定」），不跳「唯讀狀態」提示
 *   [E] 匯出：Excel／PDF 的備註仍是文字，PDF 保留換行
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/complist-layout.test.js
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

const NAMES = ['XCZU67DR-FFVE1156', 'U850-Si5518', '2GB_DDR', 'SFP', 'Q6505-PSMQC094N10NS2', 'U1451-LM706A0', 'U6300-LM706A0', 'L1452-TMPA1004S'];
const LONG_NOTE = 'FPGA 主晶片，熱點在右下角\n需確認 Coin 尺寸與 PCB 開孔是否一致';
const PROJ = () => ({
  project_name: 'Layout', global_params: {},
  rf_data: [{ Component: 'PA-BLM10D3438-50ABG', Qty: 2, 'Power(W)': 30.5 }, { Component: 'Driver', Qty: 4, 'Power(W)': 1.25 }],
  digital_data: NAMES.map((n, i) => ({ Component: n, Qty: 1, 'Power(W)': [25, 1.2, 0.8, 1.5, 3.2, 0.9, 0.9, 0.3][i] })),
  pwr_data: [{ Component: 'U1205-MPQ8785GMJT', Qty: 3, 'Power(W)': 2.1 }],
  thermal_specs: {
    'XCZU67DR-FFVE1156': { heatSourceSize: '35×35', heatSourceHeight: '3.2', timType: 'Pad', timModel: 'TG-A1250', padAuto: true, bossSizeType: '自動帶入', bossSize: '37×37', bossSurface: '表面刻花', timThickness: '1.5', timSize: '35×35', heatDirection: 'Copper Coin', icToHSK: '1.7', note: LONG_NOTE },
    'U850-Si5518': { heatSourceSize: '12.5×12.5', heatSourceHeight: '0.9', timType: 'Putty', padAuto: true, bossSizeType: '自訂', bossSize: '12.5×12.5', bossSurface: '表面光滑', timThickness: '0.5', timSize: '12.5×12.5', heatDirection: 'Thermal Via', epadSize: '4.6×4.6', icToHSK: '0.5' },
    '2GB_DDR': { heatSourceSize: '7.5×13.5', heatSourceHeight: '1.2', timType: 'Grease', bossSizeType: '無凸台，刻花定位', heatDirection: 'IC top', icToHSK: '直觸', note: '短備註' },
    'SFP': { heatSourceSize: '14×48', timType: 'Pad', bossSizeType: '自訂', bossSize: '12.5×12.5', icToHSK: '2.35', heatDirection: 'IC top', timThickness: '0.05mm以下' },
    'U1451-LM706A0': { heatDirection: 'IC bot' },
    'U1205-MPQ8785GMJT': { note: '只有備註' },
  },
  hidden_components: { 'L1452-TMPA1004S': true },
});
const TIM_LIB = { a: { model: 'TG-A1250', timType: 'Pad', k: 12.5, thickness: 1.5, gapThickness: 1.2 } };

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
  await page.waitForFunction(() => typeof renderAllCategories === 'function' && typeof saveAllTabs === 'function' && window.CompMerge);

  const seed = (projects) => page.evaluate(([projects, timLib]) => {
    window.__db = { projects: JSON.parse(JSON.stringify(projects)), tim_library: timLib };
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
    timLibrary = JSON.parse(JSON.stringify(timLib));
    sgProjectId = null; sgProjectData = null; currentProjectId = null; currentProjectData = null;
  }, [projects, TIM_LIB]);
  const loadTab2 = () => page.evaluate(async () => {
    const s = document.getElementById('project-select');
    s.innerHTML = '<option value="">--</option><option value="X">X</option>'; s.value = 'X';
    await onProjectChange(); switchTab('complist');
    await new Promise(r => setTimeout(r, 50));   // 型號庫背景載入完會再重繪一次
    document.querySelectorAll('#comp-container details.hidden-comp-zone').forEach(d => { d.open = true; });
  });

  await seed({ X: PROJ() });
  await loadTab2();

  console.log('\n[A] 版面：各種寬度都沒有橫向捲軸');
  const ths = await page.evaluate(() => [...document.querySelector('#comp-container table.comp-table thead tr').children].map(t => t.textContent.replace(/\s+/g, '')));
  ok('欄位順序不變（16 欄，備註在最後）', ths.join('|') === '隱藏|#|元件名稱|規格書|數量|發熱瓦數(W)|元件大小(mm)|元件高度max(mm)|TIMType|凸台大小(mm)|凸台表面處理|TIM厚度(mm)|TIMSize(mm)|主散熱路徑|IC距離HSK|備註', ths);
  const probe = () => page.evaluate(() => {
    const de = document.documentElement;
    const wraps = [...document.querySelectorAll('#comp-container .comp-table-wrap')].filter(w => w.offsetParent);
    const over = wraps.map(w => w.scrollWidth - w.clientWidth).filter(d => d > 0);
    // 代表性的值有沒有被截斷：輸入框看 scrollWidth；下拉看選到的文字＋箭頭是否放得下
    const cut = [];
    const ctx = document.createElement('canvas').getContext('2d');
    document.querySelectorAll('#comp-container .comp-table td.editable-cell').forEach(td => {
      td.querySelectorAll('input:not([disabled])').forEach(el => {
        if (el.offsetParent && el.value && el.scrollWidth > el.clientWidth + 1) cut.push(el.dataset.field + '=' + el.value);
      });
      td.querySelectorAll('select').forEach(sel => {
        if (!sel.offsetParent || sel.dataset.field === 'timModel') return;   // 型號名不限長度，下拉本來就可能截
        const t = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
        const cs = getComputedStyle(sel); ctx.font = cs.fontSize + ' ' + cs.fontFamily;
        const need = ctx.measureText(t).width + 18 + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        if (need > sel.clientWidth + 1) cut.push(sel.dataset.field + '=' + t + ' (' + Math.round(need) + '>' + sel.clientWidth + ')');
      });
    });
    // 鎖定值與 ✂ 要在同一行
    const split = [...document.querySelectorAll('#comp-container td.lock-cell')].filter(td => {
      const v = td.querySelector('.tim-locked-val'), b = td.querySelector('.tim-unlock-btn');
      return v && b && Math.abs(v.getBoundingClientRect().top - b.getBoundingClientRect().top) > 6;
    }).length;
    return { doc: de.scrollWidth - de.clientWidth, over, cut, split, tables: wraps.length };
  });
  for (const w of [1920, 1600, 1536, 1440, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(80);
    const p = await probe();
    ok(`${w}px：整頁與 ${p.tables} 張表都沒有橫向捲軸`, p.doc <= 0 && p.over.length === 0, p);
    ok(`${w}px：值沒有被截斷（12.5×12.5、無凸台，刻花定位、0.05mm以下、Copper Coin…）、鎖定值與 ✂ 同一行`, p.cut.length === 0 && p.split === 0, p);
  }

  console.log('\n[B] 右側浮動工具列不蓋住備註欄');
  const railGap = () => page.evaluate(() => {
    const rail = document.getElementById('tc-rail-wrapper').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#comp-container .comp-table .note-col .sg-note-btn')].filter(b => b.offsetParent);
    const right = Math.max(...btns.map(b => b.getBoundingClientRect().right));
    const tab = getComputedStyle(document.getElementById('tab-complist')).paddingRight;
    return { railLeft: Math.round(rail.left), noteRight: Math.round(right), pad: tab };
  });
  for (const w of [1366, 1536, 1600, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(80);
    const g = await railGap();
    ok(`${w}px：📝 在工具列左邊（不被蓋住）`, g.noteRight <= g.railLeft, g);
  }
  ok('1920px 本來就不重疊 → 不讓位（padding 0）', (await railGap()).pad === '0px');
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.evaluate(() => document.getElementById('tc-rail-wrapper').classList.add('gm-moved'));
  await page.waitForTimeout(50);
  ok('工具列被拖走（.gm-moved）→ 不讓位，表格用滿寬度', (await railGap()).pad === '0px');
  await page.evaluate(() => document.getElementById('tc-rail-wrapper').classList.remove('gm-moved'));

  console.log('\n[C] 備註 📝 icon');
  const sel = (n) => `#comp-container tr[data-speckey="${n}"] button.sg-note-btn`;
  const C1 = await page.evaluate(([a, b]) => {
    const x = document.querySelector(a), y = document.querySelector(b);
    return { has: x.classList.contains('has-note'), none: !y.classList.contains('has-note'), grey: getComputedStyle(y).filter, color: getComputedStyle(x).filter,
      input: !!document.querySelector('#comp-container input[data-field="note"]'), w: Math.round(x.closest('td').getBoundingClientRect().width) };
  }, [sel('XCZU67DR-FFVE1156'), sel('U6300-LM706A0')]);
  ok('有寫 → 上色、沒寫 → 反灰；表格裡不再有備註輸入框；欄寬 ≤ 50px', C1.has && C1.none && /grayscale/.test(C1.grey) && C1.color === 'none' && !C1.input && C1.w <= 50, C1);
  const hoverOn = async (s) => { await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), s);
    await page.waitForTimeout(400); await page.hover(s); await page.waitForTimeout(80); };
  await hoverOn(sel('XCZU67DR-FFVE1156'));
  const tip = await page.evaluate(() => { const t = document.querySelector('.note-tip'); return t && { h: t.querySelector('.note-tip-h').textContent, b: t.querySelector('.note-tip-b').textContent }; });
  ok('滑過顯示完整內容（含換行）與元件名稱', tip && tip.b === LONG_NOTE && /XCZU67DR-FFVE1156/.test(tip.h), tip);
  await hoverOn(sel('U6300-LM706A0'));
  ok('沒寫的滑過：提示「尚未填寫備註・點一下新增」', await page.evaluate(() => /尚未填寫備註/.test(document.querySelector('.note-tip')?.textContent || '')));

  const y0 = await page.evaluate(() => window.scrollY);
  await page.click(sel('U6300-LM706A0'));
  const M1 = await page.evaluate(() => ({ open: document.getElementById('sg-note-modal').style.display === 'flex', v: document.getElementById('sg-note-text').value, who: document.getElementById('sg-note-comp').textContent }));
  ok('點開編輯視窗：空白、標出元件名稱', M1.open && M1.v === '' && /U6300-LM706A0/.test(M1.who), M1);
  await page.fill('#sg-note-text', '  凸台需加高 0.2\n待 ME 確認  ');
  await page.click('#sg-note-save');
  const C2 = await page.evaluate(([s]) => {
    const b = document.querySelector(s);
    return { note: (thermalSpecs['U6300-LM706A0'] || {}).note, has: b.classList.contains('has-note'), data: b.dataset.note, dirty: hasUnsavedEdits(), y: window.scrollY,
      closed: document.getElementById('sg-note-modal').style.display === 'none',
      zoneOpen: !!document.querySelector('#comp-container details.hidden-comp-zone[data-cat="Digital"][open]') };
  }, [sel('U6300-LM706A0')]);
  ok('確定 → 寫進 thermal_specs[key].note（去頭尾空白）、icon 上色、算未存變更', C2.note === '凸台需加高 0.2\n待 ME 確認' && C2.has && C2.data === C2.note && C2.dirty && C2.closed, C2);
  ok('重繪後「被隱藏的元件」維持展開、捲動位置不跳', C2.zoneOpen && Math.abs(C2.y - y0) <= 2, { C2, y0 });
  await page.click(sel('2GB_DDR'));
  ok('點開已有的備註：帶入原文', await page.evaluate(() => document.getElementById('sg-note-text').value === '短備註'));
  await page.fill('#sg-note-text', '');
  await page.click('#sg-note-save');
  const C3 = await page.evaluate(() => ({ spec: thermalSpecs['2GB_DDR'] }));
  ok('清空 → 刪 note key、其他欄位保留', C3.spec && !('note' in C3.spec) && C3.spec.timType === 'Grease' && C3.spec.icToHSK === '直觸', C3);
  await page.click(sel('U1205-MPQ8785GMJT'));
  await page.fill('#sg-note-text', '   ');
  await page.click('#sg-note-save');
  ok('只有備註的 spec 清空 → 整個 spec 刪掉（不留空物件）', await page.evaluate(() => !('U1205-MPQ8785GMJT' in thermalSpecs)));
  await page.click(sel('XCZU67DR-FFVE1156'));
  await page.keyboard.press('Escape');
  ok('Esc 取消：不改內容', await page.evaluate((v) => thermalSpecs['XCZU67DR-FFVE1156'].note === v && document.getElementById('sg-note-modal').style.display === 'none', LONG_NOTE));
  await page.evaluate(() => saveAllTabs());
  const db = await page.evaluate(() => window.__db.projects.X.thermal_specs);
  ok('存檔：新備註寫進資料庫、清空的 key 不在了', db['U6300-LM706A0'].note === '凸台需加高 0.2\n待 ME 確認' && !('note' in db['2GB_DDR']) && !('U1205-MPQ8785GMJT' in db) && db['XCZU67DR-FFVE1156'].note === LONG_NOTE, db);

  console.log('\n[D] 未解鎖');
  await page.evaluate(() => { isProtected = true; renderAllCategories(); const t = document.getElementById('ro-toast'); if (t) t.classList.remove('show'); });
  const D1 = await page.evaluate(([s]) => ({ disabled: document.querySelector(s).disabled, sel: document.querySelector('#comp-container select[data-field="timType"]').disabled }), [sel('XCZU67DR-FFVE1156')]);
  ok('📝 仍可用（其他欄位照樣鎖住）', !D1.disabled && D1.sel, D1);
  await page.click(sel('XCZU67DR-FFVE1156'));
  const D2 = await page.evaluate(() => ({ ro: document.getElementById('sg-note-text').readOnly, save: document.getElementById('sg-note-save').style.display,
    toast: !!document.querySelector('#ro-toast.show') }));
  ok('點開是唯讀、沒有「確定」、不跳「唯讀狀態」提示', D2.ro && D2.save === 'none' && !D2.toast, D2);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { isProtected = false; renderAllCategories(); });

  console.log('\n[E] 匯出');
  const E = await page.evaluate(() => {
    const cats = collectExportDataByCategory();
    const row = cats.flatMap(c => c.rows).find(r => r.name === 'XCZU67DR-FFVE1156' || r.component === 'XCZU67DR-FFVE1156');
    const html = buildPdfHtml(cats);
    return { note: row && row.note, pre: /white-space:pre-wrap;">FPGA 主晶片/.test(html) };
  });
  ok('Excel／PDF 的備註仍是文字；PDF 保留換行（pre-wrap）', E.note === LONG_NOTE && E.pre, E);

  ok('頁面無 JS 例外', errors.length === 0, errors);
  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
