/*
 * 專案頻段 FR1／FR2（`projects[id].band`）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 使用者要求：新增專案時勾選這案子是 FR1 還是 FR2；FR2 就不填 Backoff 與 Duplex Mode。驗證情境：
 *   [A] 新增專案表單：FR1／FR2 兩個選項、預設 FR1；建立 FR2 → 寫 band:'FR2'、不寫任何 Backoff／Duplex key；
 *       建立 FR1 → 寫 band:'FR1'；建完選項回到 FR1
 *   [B] FR2 專案：條件表沒有 Backoff／Duplex 欄位、換成「FR2 不適用」一格（跨兩欄），兩列仍對齊；
 *       Pd 照樣加總；存檔不寫那四個 key
 *   [C] 舊專案（沒有 band）：視為 FR1、畫面與原本相同；只是載入再存檔 → 不寫 band、Backoff／Duplex 照舊寫
 *   [D] 舊專案改成 FR2：欄位收起、算未存變更；存檔寫 band:'FR2'、資料庫原本的 Backoff／Duplex 不動；
 *       tooltip 寫出保留的值；切回 FR1 → 原本的值再顯示
 *   [E] 未解鎖：頻段下拉停用；不認得的值 → 補「（未知值）」選項照原字顯示、行為照 FR1、存檔原樣寫回
 *   [F] 版面：FR1／FR2 在 1920／1536／1366 都是兩列對齊、沒有橫向捲軸；1200 改成每個條件一行
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/fr-band.test.js
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

const comps = () => ({
  rf_data: [{ Component: 'PA-Final', Qty: 4, 'Power(W)': 60.5, 'Power_RT(W)': 61.2, 'Limit(C)': 150 }],
  digital_data: [{ Component: 'FPGA', Qty: 1, 'Power(W)': 44.85, 'Power_RT(W)': 44.85, 'Limit(C)': 100 }],
  pwr_data: [{ Component: 'DCDC', Qty: 2, 'Power(W)': 14.5, 'Power_RT(W)': 14.5, 'Limit(C)': 125 }],
});
const LEGACY = { project_name: 'Legacy-FR1', param_temp: '45', param_backoff: '1', param_duplex: 'FDD 100%', param_backoff_rt: '0', param_duplex_rt: 'FDD 100%', ...comps() };
const MMW = { project_name: 'mmW-28G', band: 'FR2', param_temp: '55', ...comps() };
const ODD = { project_name: 'Odd', band: 'FR3', param_backoff: '2', ...comps() };

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
    window.alert = (m) => { window.__alerts.push(String(m)); }; window.confirm = () => true;
    try { localStorage.clear(); } catch (e) {}
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof projLoadAll === 'function' && typeof saveAllTabs === 'function' && document.getElementById('gm-rail'));
  await page.evaluate(([a, b, c]) => {
    window.__db = { projects: { L: a, M: b, O: c }, tim_library: {} };
    dbAdapter.isReady = () => true; dbAdapter.isSharePointMode = () => false; dbAdapter.refresh = async () => {};
    dbAdapter.getProjectsSorted = async () => Object.entries(window.__db.projects).map(([id, p]) => ({ id, project_name: p.project_name }));
    dbAdapter.getDoc = async (c, id) => { const d = (window.__db[c] || {})[id]; return d ? JSON.parse(JSON.stringify(d)) : null; };
    dbAdapter.getCollection = async (c) => JSON.parse(JSON.stringify(window.__db[c] || {}));
    dbAdapter.releaseLock = async () => {};
    dbAdapter.setDoc = async (c, id, d) => { window.__db[c][id] = JSON.parse(JSON.stringify(d)); };
    window.__fields = {};
    dbAdapter.writeBatch = async (ops) => {
      const plan = ops.map(o => { const cur = (window.__db[o.col] || {})[o.id];
        return { o, f: typeof o.fields === 'function' ? o.fields(cur ? JSON.parse(JSON.stringify(cur)) : null) : o.fields }; });
      plan.forEach(({ o, f }) => {
        window.__fields[o.id] = Object.assign(window.__fields[o.id] || {}, JSON.parse(JSON.stringify(f)));
        window.__db[o.col][o.id] = Object.assign({}, window.__db[o.col][o.id] || {}, JSON.parse(JSON.stringify(f)));
      });
    };
    window._ensureLockBeforeWrite = async () => true;
    _applyUnlockedUI();
  }, [LEGACY, MMW, ODD]);

  const open = async (id) => {
    await page.evaluate(async (id) => { await projLoadAll(id); switchTab('specgen');
      document.getElementById('sg-project-status').style.display = 'none'; }, id);
    await page.waitForTimeout(120);
  };
  const save = () => page.evaluate(async () => { window.__fields = {}; await saveAllTabs(); return window.__fields; });
  const V = () => page.evaluate(() => {
    const R = (el) => el.getBoundingClientRect();
    const hot = [...document.querySelectorAll('#sg-power-row-hot > *')], rt = [...document.querySelectorAll('#sg-power-row-rt > *')];
    const hr = hot.map(R), rr = rt.map(R);
    const band = document.getElementById('sg-sel-band'), na = document.querySelector('#sg-power-row-hot .sg-na-chip');
    const cell = R(document.getElementById('sg-band-cell')), panel = R(document.querySelector('#tab-specgen > .sg-panel')),
          table = R(document.getElementById('sg-project-components-body'));
    return {
      band: band && band.value, bandDis: band && band.disabled, bandOpts: band ? [...band.options].map(o => o.textContent) : [],
      inputs: ['sg-param-backoff', 'sg-sel-duplex', 'sg-param-backoff-rt', 'sg-sel-duplex-rt'].filter(id => document.getElementById(id)),
      na: na && na.textContent, naTip: na && na.title, naSpan: na && getComputedStyle(na).gridColumnStart,
      naRt: !!document.querySelector('#sg-power-row-rt .sg-na-chip'),
      total: (document.querySelector('#sg-power-row-hot .sg-power-chip.total') || {}).textContent,
      oneLine: hr.every(r => Math.abs(r.top - hr[0].top) < 2) && rr.every(r => Math.abs(r.top - rr[0].top) < 2) && rr[0].top > hr[0].top,
      aligned: hot.length === rt.length && hr.every((r, i) => Math.abs(r.left - rr[i].left) < 1.5 && Math.abs(r.width - rr[i].width) < 1.5),
      cellSpans: cell.top <= hr[0].top + 1 && cell.bottom >= rr[0].bottom - 1 && cell.right <= Math.min(...hr.map(r => r.left), ...rr.map(r => r.left)),
      hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      h: Math.round(table.top - panel.top),
      dirty: hasUnsavedEdits(),
    };
  });

  console.log('\n[A] 新增專案表單');
  const form = await page.evaluate(() => {
    sgToggleNewProject();
    const r = [...document.querySelectorAll('input[name="sg-new-band"]')];
    return { vals: r.map(x => x.value), checked: (r.find(x => x.checked) || {}).value,
      w: r.map(x => x.getBoundingClientRect().width), hint: document.querySelector('.sg-band-hint').textContent };
  });
  ok('FR1／FR2 兩個選項、預設 FR1（radio 沒被 .field 撐寬）', form.vals.join() === 'FR1,FR2' && form.checked === 'FR1' && form.w.every(w => w > 0 && w < 30), form);
  ok('說明 FR2 不填 Backoff／Duplex、建立後可再改', /FR2/.test(form.hint) && /Backoff/.test(form.hint) && /Duplex/.test(form.hint) && /頻段/.test(form.hint), form.hint);
  await page.evaluate(() => {
    document.getElementById('sg-new-project-id').value = 'N2'; document.getElementById('sg-new-project-name').value = 'New FR2';
    document.querySelector('input[name="sg-new-band"][value="FR2"]').checked = true;
  });
  await page.evaluate(() => sgCreateProject());
  await page.waitForTimeout(150);
  let doc = await page.evaluate(() => window.__db.projects.N2);
  ok('建立 FR2 → band:FR2、沒有任何 Backoff／Duplex key', doc && doc.band === 'FR2' && !Object.keys(doc).some(k => /backoff|duplex/.test(k)), doc);
  ok('建完選項回到 FR1、表單收起', await page.evaluate(() => document.querySelector('input[name="sg-new-band"]:checked').value === 'FR1'
    && !document.getElementById('sg-new-project-form').classList.contains('active')));
  let v = await V();
  ok('建完自動開新專案：頻段 FR2、沒有 Backoff／Duplex 欄位', sgOk(v), v);
  function sgOk(v) { return v.band === 'FR2' && v.inputs.length === 0 && /FR2 不適用/.test(v.na || '') && v.naRt; }
  let f = await save();
  ok('FR2 新專案存檔：寫 band:FR2、不寫 Backoff／Duplex（不捏造 TDD 75%）', f.N2 && f.N2.band === 'FR2' && !Object.keys(f.N2).some(k => /backoff|duplex/.test(k)), f.N2);
  await page.evaluate(() => {
    sgToggleNewProject();
    document.getElementById('sg-new-project-id').value = 'N1'; document.getElementById('sg-new-project-name').value = 'New FR1';
  });
  await page.evaluate(() => sgCreateProject());
  await page.waitForTimeout(150);
  doc = await page.evaluate(() => window.__db.projects.N1);
  ok('建立 FR1（預設）→ band:FR1', doc && doc.band === 'FR1', doc);
  v = await V();
  ok('FR1 新專案：Backoff／Duplex 欄位都在', v.band === 'FR1' && v.inputs.length === 4 && !v.na, v);

  console.log('\n[B] FR2 專案');
  await open('M');
  v = await V();
  ok('頻段 FR2；Backoff／Duplex 欄位換成「FR2 不適用」（高溫、常溫各一格）', sgOk(v), v);
  ok('「不適用」跨兩欄 → 兩列仍對齊；頻段格跨高溫／常溫兩列、在最左邊', v.naSpan === 'span 2' && v.aligned && v.oneLine && v.cellSpans, v);
  ok('Pd 照樣加總（Total 4×60.5＋44.85＋2×14.5＝315.85 W）', /Total : 315\.85 W/.test(v.total || ''), v.total);
  ok('原本沒填過 → tooltip 不提保留的值', v.naTip && !/保留/.test(v.naTip), v.naTip);
  ok('載入後沒有未存變更', v.dirty === false, v);
  f = await save();
  ok('存檔不寫 Backoff／Duplex，band 照寫 FR2', f.M && f.M.band === 'FR2' && !Object.keys(f.M).some(k => /backoff|duplex/.test(k)), f.M);

  console.log('\n[C] 舊專案（沒有 band）');
  await open('L');
  v = await V();
  ok('視為 FR1：頻段 FR1、Backoff／Duplex 欄位照舊、值照舊', v.band === 'FR1' && v.inputs.length === 4 && !v.na
    && await page.evaluate(() => document.getElementById('sg-param-backoff').value === '1' && document.getElementById('sg-sel-duplex').value === 'FDD 100%'), v);
  ok('頻段 tooltip 註明「舊專案沒有指定頻段，視為 FR1」', await page.evaluate(() => /沒有指定頻段，視為 FR1/.test(document.getElementById('sg-sel-band').title)));
  ok('載入後沒有未存變更、兩列對齊', v.dirty === false && v.aligned && v.oneLine && v.cellSpans, v);
  f = await save();
  ok('只是載入再存檔 → 不寫 band（沒有 key＝FR1）、Backoff／Duplex 照舊寫', f.L && !('band' in f.L) && f.L.param_backoff === '1' && f.L.param_duplex === 'FDD 100%' && f.L.param_duplex_rt === 'FDD 100%', f.L);

  console.log('\n[D] 舊專案改成 FR2');
  await page.evaluate(() => { const s = document.getElementById('sg-sel-band'); s.value = 'FR2'; s.dispatchEvent(new Event('change')); });
  v = await V();
  ok('欄位收起、換成「不適用」；算未存變更', sgOk(v) && v.dirty === true, v);
  ok('tooltip 寫出保留的值（Backoff 1 dB、FDD 100%）', /Backoff 1 dB/.test(v.naTip || '') && /FDD 100%/.test(v.naTip || '') && /切回 FR1/.test(v.naTip || ''), v.naTip);
  f = await save();
  doc = await page.evaluate(() => window.__db.projects.L);
  ok('存檔寫 band:FR2、不寫 Backoff／Duplex', f.L && f.L.band === 'FR2' && !Object.keys(f.L).some(k => /backoff|duplex/.test(k)), f.L);
  ok('資料庫原本的 Backoff／Duplex 不動（沒被刪）', doc.param_backoff === '1' && doc.param_duplex === 'FDD 100%' && doc.param_backoff_rt === '0', doc);
  await page.evaluate(() => { const s = document.getElementById('sg-sel-band'); s.value = 'FR1'; s.dispatchEvent(new Event('change')); });
  v = await V();
  ok('切回 FR1 → 原本的值再顯示', v.inputs.length === 4 && await page.evaluate(() => document.getElementById('sg-param-backoff').value === '1'
    && document.getElementById('sg-sel-duplex').value === 'FDD 100%' && document.getElementById('sg-sel-duplex-rt').value === 'FDD 100%'), v);

  console.log('\n[E] 唯讀與不認得的值');
  await page.evaluate(() => relock());
  v = await V();
  ok('未解鎖：頻段下拉停用', v.bandDis === true, v);
  await page.evaluate(() => _applyUnlockedUI());
  await open('O');
  v = await V();
  ok('不認得的值（FR3）→ 補「（未知值）」選項照原字顯示、行為照 FR1（欄位都在）', v.band === 'FR3' && v.bandOpts.some(t => /FR3（未知值）/.test(t)) && v.inputs.length === 4, v);
  ok('載入後沒有未存變更', v.dirty === false, v);
  f = await save();
  ok('存檔原樣寫回 FR3（不靜默改成 FR1）', f.O && f.O.band === 'FR3', f.O);

  console.log('\n[F] 版面');
  await page.evaluate(() => { delete window.__db.projects.L.band; });   // [D] 把它存成 FR2 了 → 改回舊專案（FR1）
  for (const id of ['L', 'M']) {
    await open(id);
    for (const w of [1920, 1536, 1366]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(80);
      v = await V();
      ok(`${id === 'M' ? 'FR2' : 'FR1'} ${w}px：兩列對齊、頻段格跨兩列、沒有橫向捲軸、頂部 ≤ 200px`, v.aligned && v.oneLine && v.cellSpans && v.hscroll <= 0 && v.h <= 200, v);
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(80);
    const n = await page.evaluate(() => ({ grid: getComputedStyle(document.querySelector('.sg-power-grid')).display,
      hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cellH: document.getElementById('sg-band-cell').getBoundingClientRect().height }));
    ok(`${id === 'M' ? 'FR2' : 'FR1'} 1200px：每個條件一行、頻段一行、沒有橫向捲軸`, n.grid === 'flex' && n.hscroll <= 0 && n.cellH <= 28, n);
    await page.setViewportSize({ width: 1536, height: 900 });
  }
  if (process.env.SHOT) {
    await open('M');
    await page.evaluate(() => window.scrollTo(0, 0));
    const el = await page.$('#tab-specgen > .sg-panel');
    await el.screenshot({ path: process.env.SHOT + '-fr2.png', clip: undefined });
    await open('L');
    await (await page.$('#tab-specgen > .sg-panel')).screenshot({ path: process.env.SHOT + '-fr1.png' });
    await page.evaluate(() => sgToggleNewProject());
    await (await page.$('#tab-specgen > .sg-panel')).screenshot({ path: process.env.SHOT + '-form.png' });
  }

  ok('沒有頁面錯誤', errors.length === 0, errors.slice(0, 3));
  await browser.close();
  console.log(`\n結果：${pass} 通過、${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
