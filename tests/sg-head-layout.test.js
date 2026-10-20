/*
 * EE/RF/PWR 頁頂部精簡（專案列＋高溫／常溫條件）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 使用者要求這一區整體高度壓掉一半以上（原本面板頂端到元件表約 402px）。驗證情境：
 *   [A] 結構：沒有「目前專案元件清單」小標題；高溫／常溫條件在同一個 grid（兩列、欄位上下對齊）；
 *       「選擇專案」在下拉左邊；chip 高度 ≤ 28px
 *   [B] 高度：面板頂端到元件表 ≤ 200px（原本 402px 的一半以下）
 *   [C] 版面：1920／1536／1366 沒有橫向捲軸、條件表兩列；環溫選「自訂」多出輸入框時兩列仍對齊；
 *       1200（窄於 grid）改成每個條件一行、不出橫向捲軸
 *   [D] 參數仍可改（Backoff、Duplex 改了會重算 Pd），未解鎖時停用
 *   [E] TH/ME、模擬與實測驗證、Thermal Via 三頁比照同一套：專案卡片 ≤ 100px、工具列一行（1920／1536／1366）、
 *       「選擇專案」在下拉左邊；TH/ME 頁的匯出列（PDF／Excel／TIM 型號庫／EE 匯出入）併進卡片、說明改成 tooltip；
 *       右側浮動工具列不蓋住任何一頁的工具列按鈕；驗證頁的判定規則兩行、展開「公式與依據」時自己佔一行
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/sg-head-layout.test.js
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
  project_name: 'StarKcore-12L', param_temp: '45', param_backoff: '1', param_duplex: 'TDD 75%', param_backoff_rt: '0',
  rf_data: [{ Component: 'PA-Final', Qty: 4, 'Power(W)': 60.5, 'Power_RT(W)': 61.2, 'Limit(C)': 150 },
            { Component: 'Driver', Qty: 4, 'Power(W)': 11.03, 'Power_RT(W)': 11.4, 'Limit(C)': 150 }],
  digital_data: [{ Component: 'FPGA', Qty: 1, 'Power(W)': 44.85, 'Power_RT(W)': 44.85, 'Limit(C)': 100 }],
  pwr_data: [{ Component: 'DCDC', Qty: 2, 'Power(W)': 14.5, 'Power_RT(W)': 14.5, 'Limit(C)': 125 }],
};

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
    try { localStorage.clear(); } catch (e) {}
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof projLoadAll === 'function' && document.getElementById('gm-rail'));
  await page.evaluate(async (p) => {
    window.__db = { projects: { X: p }, tim_library: {} };
    dbAdapter.isReady = () => true; dbAdapter.isSharePointMode = () => false; dbAdapter.refresh = async () => {};
    dbAdapter.getProjectsSorted = async () => [{ id: 'X', project_name: p.project_name }];
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    await projLoadAll('X'); switchTab('specgen');
    document.getElementById('sg-project-status').style.display = 'none';   // 載入提示列 4 秒後自己會收，量高度時先收掉
  }, PROJ);
  await page.waitForTimeout(200);

  const M = () => page.evaluate(() => {
    const R = (el) => el.getBoundingClientRect();
    const panel = R(document.querySelector('#tab-specgen > .sg-panel'));
    const table = R(document.getElementById('sg-project-components-body'));
    const hot = [...document.querySelectorAll('#sg-power-row-hot > *')].map(R);
    const rt = [...document.querySelectorAll('#sg-power-row-rt > *')].map(R);
    const lab = R(document.querySelector('#tab-specgen .sg-proj-field label')), sel = R(document.getElementById('sg-project-select'));
    return {
      h: Math.round(table.top - panel.top),
      hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      twoRows: hot.length === 7 && rt.length === 7 && hot.every(r => Math.abs(r.top - hot[0].top) < 2) && rt.every(r => Math.abs(r.top - rt[0].top) < 2) && rt[0].top > hot[0].top,
      aligned: hot.every((r, i) => Math.abs(r.left - rt[i].left) < 1.5 && Math.abs(r.width - rt[i].width) < 1.5),
      chipH: Math.max(...hot.concat(rt).map(r => r.height)),
      labelLeft: Math.abs((lab.top + lab.bottom) / 2 - (sel.top + sel.bottom) / 2) < 6 && lab.right <= sel.left,
      oneGrid: !!document.querySelector('.sg-power-grid #sg-power-row-hot') && !!document.querySelector('.sg-power-grid #sg-power-row-rt'),
      oldTitle: [...document.querySelectorAll('#sg-project-components div')].some(d => d.children.length === 0 && d.textContent.trim() === '目前專案元件清單'),
    };
  });

  console.log('\n[A] 結構');
  let m = await M();
  ok('沒有「目前專案元件清單」小標題；高溫／常溫條件在同一個 grid', !m.oldTitle && m.oneGrid, m);
  ok('「選擇專案」在下拉左邊（同一行）', m.labelLeft, m);
  ok('高溫、常溫各一列，7 格欄位上下對齊（位置與寬度相同）', m.twoRows && m.aligned, m);
  ok('chip 高度 ≤ 28px', m.chipH <= 28, m);

  console.log('\n[B] 高度');
  ok(`面板頂端到元件表 ${m.h}px ≤ 200px（原本 402px 的一半以下）`, m.h <= 200, m);

  console.log('\n[C] 版面');
  for (const w of [1920, 1536, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(80);
    m = await M();
    ok(`${w}px：沒有橫向捲軸、條件表兩列對齊、高度 ≤ 200px`, m.hscroll <= 0 && m.twoRows && m.aligned && m.h <= 200, m);
  }
  await page.evaluate(() => { _applyUnlockedUI(); const s = document.getElementById('sg-sel-temp'); s.value = 'custom'; sgOnParamChange(); });
  await page.waitForTimeout(50);
  m = await M();
  ok('環溫選「自訂」多出輸入框 → 兩列仍對齊、沒有橫向捲軸', m.aligned && m.twoRows && m.hscroll <= 0
    && await page.evaluate(() => document.getElementById('sg-temp-custom').getBoundingClientRect().width > 0), m);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(80);
  const narrow = await page.evaluate(() => ({ hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    grid: getComputedStyle(document.querySelector('.sg-power-grid')).display }));
  ok('1200px：改成每個條件一行（不是 grid）、沒有橫向捲軸', narrow.grid === 'flex' && narrow.hscroll <= 0, narrow);
  await page.setViewportSize({ width: 1536, height: 900 });

  console.log('\n[D] 參數');
  const before = await page.evaluate(() => document.querySelector('#sg-power-row-hot .sg-power-chip.total').textContent);
  await page.evaluate(() => { const b = document.getElementById('sg-param-backoff'); b.value = '3'; b.dispatchEvent(new Event('change')); });
  const after = await page.evaluate(() => ({ t: document.querySelector('#sg-power-row-hot .sg-power-chip.total').textContent, saved: sgProjectData.param_backoff }));
  ok('改 Backoff → 存進專案參數、條件表重繪（Total 照樣顯示）', after.saved === '3' && /Total : [\d.]+ W/.test(after.t), { before, after });
  await page.evaluate(() => relock());
  ok('未解鎖：Backoff／Duplex／環溫停用', await page.evaluate(() => ['sg-param-backoff', 'sg-sel-duplex', 'sg-sel-temp', 'sg-param-backoff-rt', 'sg-sel-duplex-rt'].every(id => document.getElementById(id).disabled)));

  console.log('\n[E] 其他三頁');
  await page.evaluate(() => _applyUnlockedUI());
  const CARD = { complist: '#tab-complist > .card', validation: '#tab-validation > .card', via: '#tab-via > .card' };
  for (const w of [1920, 1536, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [t, sel] of Object.entries(CARD)) {
      await page.evaluate((t) => { switchTab(t); ['comp-status', 'vd-status', 'via-status'].forEach(i => { const e = document.getElementById(i); if (e) e.style.display = 'none'; }); }, t);
      await page.waitForTimeout(60);
      const c = await page.evaluate((sel) => {
        const card = document.querySelector(sel), R = (el) => el.getBoundingClientRect();
        const btns = [...card.querySelectorAll('.sg-proj-toolbar button')].filter(b => b.offsetParent !== null).map(R);
        const rail = R(document.getElementById('gm-rail')), fab = R(document.getElementById('tc-fab'));
        const lab = R(card.querySelector('.sg-proj-field label')), s = R(card.querySelector('.sg-proj-field select'));
        return { h: Math.round(R(card).height), n: btns.length,
          oneLine: btns.every(b => Math.abs((b.top + b.bottom) / 2 - (s.top + s.bottom) / 2) < 6),
          labelLeft: lab.right <= s.left && Math.abs((lab.top + lab.bottom) / 2 - (s.top + s.bottom) / 2) < 6,
          railClear: btns.every(b => b.right <= rail.left - 2 || b.bottom <= rail.top || b.top >= rail.bottom) && btns.every(b => b.right <= fab.left - 2 || b.bottom <= fab.top || b.top >= fab.bottom),
          hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      }, sel);
      ok(`${w}px ${t}：卡片 ${c.h}px ≤ 100、工具列一行、「選擇專案」在下拉左邊、按鈕不被右側工具列蓋住、沒有橫向捲軸`, c.h <= 100 && c.oneLine && c.labelLeft && c.railClear && c.hscroll <= 0, c);
    }
  }
  for (const w of [1536, 1366]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(() => switchTab('specgen'));
    await page.waitForTimeout(60);
    const t1 = await page.evaluate(() => {
      const R = (el) => el.getBoundingClientRect(), rail = R(document.getElementById('gm-rail')), fab = R(document.getElementById('tc-fab'));
      const btns = [...document.querySelectorAll('#tab-specgen .sg-proj-toolbar button')].filter(b => b.offsetParent !== null).map(R);
      const clear = (r) => btns.every(b => b.right <= r.left - 2 || b.bottom <= r.top || b.top >= r.bottom);
      return { n: btns.length, clear: clear(rail) && clear(fab), maxRight: Math.round(Math.max(...btns.map(b => b.right))), railLeft: Math.round(Math.min(rail.left, fab.left)) };
    });
    ok(`${w}px EE/RF/PWR 頁：專案列按鈕（含匯出 PDF）不被右側工具列蓋住`, t1.n >= 7 && t1.clear, t1);
  }
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.evaluate(() => switchTab('complist'));
  const ex = await page.evaluate(() => {
    const tb = document.getElementById('export-toolbar');
    return { inCard: !!tb.closest('#tab-complist > .card'), shown: tb.style.display !== 'none',
      btns: [...tb.querySelectorAll('button')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      tip: /隱藏/.test(tb.querySelector('.btn-export.pdf').title) && /隱藏/.test(tb.querySelector('.btn-export.excel').title),
      oldRow: !!document.querySelector('#tab-complist > .export-toolbar') };
  });
  ok('TH/ME 頁：匯出列併進卡片工具列（PDF／Excel／TIM 型號庫／EE 匯出／EE 匯入）、「隱藏元件不匯出」改成 tooltip',
    ex.inCard && ex.shown && !ex.oldRow && ex.btns.length === 5 && ex.tip && /TIM 型號庫/.test(ex.btns.join()) && /EE 匯入/.test(ex.btns.join()), ex);
  ok('TH/ME 頁：沒選專案時匯出整組隱藏', await page.evaluate(async () => { document.getElementById('project-select').value = ''; await onProjectChange();
    const hidden = document.getElementById('export-toolbar').style.display === 'none'; await projOpenAll('X'); return hidden; }));
  await page.evaluate(() => switchTab('validation'));
  const vr = await page.evaluate(() => {
    const box = document.querySelector('#vd-container .vd-rules'), rows = box.querySelectorAll(':scope > .vd-rules-row');
    return { rows: rows.length, h: Math.round(box.getBoundingClientRect().height),
      ta: !!rows[0].querySelector('.vd-ta'), note: /RF\/EE\/PWR 填寫/.test(rows[0].textContent), grp: rows[1].querySelectorAll('.vd-rules-grp').length };
  });
  ok(`驗證頁判定規則：兩行（標題＋填寫說明＋Ta／溫度＋Pd 門檻）、高度 ${vr.h}px ≤ 60`, vr.rows === 2 && vr.h <= 60 && vr.ta && vr.note && vr.grp === 2, vr);
  await page.click('#vd-container .vd-rules-more summary');
  const op = await page.evaluate(() => { const d = document.querySelector('#vd-container .vd-rules-more'), row = d.parentElement;
    return { open: d.open, full: Math.abs(d.getBoundingClientRect().width - (row.getBoundingClientRect().width)) < 2 }; });
  ok('展開「公式與依據」→ 自己佔滿一行', op.open && op.full, op);

  ok('沒有 JS 錯誤', errors.length === 0, errors);
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('UNEXPECTED:', e); process.exit(1); });
