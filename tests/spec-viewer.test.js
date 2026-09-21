/*
 * 規格書線上預覽（👁）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 驗證情境：
 *   [A] 元件清單的規格書欄多一顆 👁：排在第一顆、沒上傳時停用、標 sg-spec-ro
 *       （唯讀／未解鎖時仍可看，因為預覽只讀不寫）。
 *   [B] PDF → iframe 就地顯示；圖片 → img；純文字 → <pre>（逸出後顯示）。
 *       blob 的 MIME 一律由副檔名決定（不採用伺服器回的 content-type）。
 *   [C] Office 檔 → 不硬塞，給 Office Online 連結（仍是線上看，不必下載）；
 *       zip 等其他格式 → 說明不能預覽並指向下載。
 *   [D] 關閉會 revoke blob URL、清空內容；Esc 也關得掉；讀取失敗有訊息不是空白。
 *   [E] 本機／離線模式（非 SharePoint）→ 明確告知，不是靜默無反應。
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/spec-viewer.test.js        # 可用 TEST_URL 指定網址
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

// 最小可用的 PDF / PNG，用 data: URL 當成 SharePoint 的 downloadUrl（測試不連外網）
const PDF_B64 = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\ntrailer<</Root 1 0 R>>\n'
).toString('base64');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
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
    window.confirm = () => true;
    window.__opened = []; window.__open0 = null;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sgRenderProjectComponents === 'function' && typeof sgSpecView === 'function');

  // 準備：一個有四顆元件的專案（PDF / PNG / TXT / DOCX / 無規格書）
  await page.evaluate(({ pdf, png }) => {
    window.__meta = {};
    window.open = (u) => { window.__opened.push(u); return null; };
    dbAdapter.isSharePointMode = () => true;
    dbAdapter.getSpecMeta = async (p) => window.__meta[p] || null;
    dbAdapter.getSpecSrc = async (p) => (window.__meta[p] || {}).downloadUrl || null;
    window.__meta['/SPEC/P/RF/PA__ds.pdf'] = { downloadUrl: 'data:application/pdf;base64,' + pdf,
      webUrl: 'https://sp.example/ds.pdf', name: 'ds.pdf', size: 12345 };
    window.__meta['/SPEC/P/RF/IMG__layout.png'] = { downloadUrl: 'data:image/png;base64,' + png,
      webUrl: 'https://sp.example/layout.png', name: 'layout.png', size: 68 };
    window.__meta['/SPEC/P/RF/TXT__note.txt'] = { downloadUrl: 'data:text/plain,hello%20%3Cb%3Espec%3C%2Fb%3E',
      webUrl: 'https://sp.example/note.txt', name: 'note.txt', size: 18 };
    window.__meta['/SPEC/P/RF/DOC__sheet.docx'] = { downloadUrl: 'data:application/octet-stream,x',
      webUrl: 'https://sp.example/sheet.docx', name: 'sheet.docx', size: 2048 };
    window.__meta['/SPEC/P/RF/ZIP__pack.zip'] = { downloadUrl: 'data:application/octet-stream,x',
      webUrl: '', name: 'pack.zip', size: 4096 };
    sgVariantsCache = { RF: [], Digital: [], PWR: [] };   // 不要去抓跨專案快取
    sgProjectId = 'P'; sgProjectData = { project_name: 'P', rf_data: [
      { Component: 'PA',   SpecFile: { path: '/SPEC/P/RF/PA__ds.pdf',       name: 'ds.pdf',     at: '2026-01-02T03:04:05Z', by: 'Me' } },
      { Component: 'IMG',  SpecFile: { path: '/SPEC/P/RF/IMG__layout.png',  name: 'layout.png', at: '2026-01-02T03:04:05Z' } },
      { Component: 'TXT',  SpecFile: { path: '/SPEC/P/RF/TXT__note.txt',    name: 'note.txt' } },
      { Component: 'DOC',  SpecFile: { path: '/SPEC/P/RF/DOC__sheet.docx',  name: 'sheet.docx', _from: '舊專案' } },
      { Component: 'ZIP',  SpecFile: { path: '/SPEC/P/RF/ZIP__pack.zip',    name: 'pack.zip' } },
      { Component: 'NONE' },
    ], digital_data: [], pwr_data: [] };
    sgRenderProjectComponents();
  }, { pdf: PDF_B64, png: PNG_B64 });

  console.log('\n[A] 規格書欄的 👁 按鈕');
  const a = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#sg-project-components-body .sg-spec-btns')];
    const first = rows[0];
    const last = rows[rows.length - 1];
    const btns = [...first.querySelectorAll('button')].map(b => b.textContent.trim());
    const eye = first.querySelector('.sg-spec-view');
    const eyeNone = last.querySelector('.sg-spec-view');
    return {
      rows: rows.length, btns,
      eyeFirst: first.firstElementChild === eye,
      eyeTitle: eye.getAttribute('title') || '',
      ro: eye.classList.contains('sg-spec-ro'),
      hasFile: eye.classList.contains('has-file'),
      disabledWithFile: eye.disabled,
      disabledNoFile: eyeNone.disabled,
      noFileClass: eyeNone.classList.contains('has-file'),
      onclick: eye.getAttribute('onclick') || '',
    };
  });
  ok('每一列都多了一顆 👁（' + a.rows + ' 列）', a.rows === 6 && a.btns[0] === '👁', a.btns);
  ok('👁 排在第一顆', a.eyeFirst);
  ok('有規格書 → 可按、標藍色識別', a.disabledWithFile === false && a.hasFile === true, a);
  ok('沒規格書 → 停用且不標識別色', a.disabledNoFile === true && a.noFileClass === false, a);
  ok('標 sg-spec-ro（未解鎖唯讀時仍可看）', a.ro === true);
  ok('tooltip 寫明「線上瀏覽」且不必下載', /線上瀏覽/.test(a.eyeTitle) && /不必下載/.test(a.eyeTitle), a.eyeTitle);
  ok('接到 sgSpecView', /sgSpecView\('RF',0\)/.test(a.onclick), a.onclick);

  // 唯讀鎖：預覽按鈕不可被鎖掉
  const aRo = await page.evaluate(() => {
    isProtected = true;
    if (typeof applyProtectionUI === 'function') applyProtectionUI();
    sgRenderProjectComponents();
    const eye = document.querySelector('#sg-project-components-body .sg-spec-view');
    const up = document.querySelector('#sg-project-components-body .sg-spec-up');
    return { eye: !!eye && !eye.disabled, up: up ? up.disabled : null };
  });
  ok('未解鎖（唯讀）時 👁 仍可按', aRo.eye === true, aRo);

  console.log('\n[B] 就地顯示：PDF / 圖片 / 純文字');
  const b1 = await page.evaluate(async () => {
    await sgSpecView('RF', 0);
    const body = document.getElementById('sg-specview-body');
    const f = body.querySelector('iframe');
    return {
      open: document.getElementById('sg-specview-modal').style.display === 'flex',
      iframe: !!f, src: f ? f.getAttribute('src').slice(0, 5) : '',
      blobType: await (await fetch(f.getAttribute('src'))).blob().then(b => b.type),
      title: document.getElementById('sg-specview-title').textContent,
      sub: document.getElementById('sg-specview-sub').textContent,
    };
  });
  ok('PDF → 視窗開啟並以 iframe 就地顯示', b1.open && b1.iframe && b1.src === 'blob:', b1);
  ok('blob 的 MIME 固定為 application/pdf（不採信伺服器）', b1.blobType === 'application/pdf', b1.blobType);
  ok('標題是檔名、副標有元件／上傳時間／大小', b1.title === 'ds.pdf' && /PA/.test(b1.sub) && /12\.1 KB|12 KB/.test(b1.sub), b1);

  const b2 = await page.evaluate(async () => {
    await sgSpecView('RF', 1);
    const img = document.querySelector('#sg-specview-body img');
    return { img: !!img, src: img ? img.getAttribute('src').slice(0, 5) : '',
             type: img ? await (await fetch(img.src)).blob().then(b => b.type) : '' };
  });
  ok('圖片 → img 就地顯示（blob:image/png）', b2.img && b2.src === 'blob:' && b2.type === 'image/png', b2);

  const b3 = await page.evaluate(async () => {
    await sgSpecView('RF', 2);
    const pre = document.querySelector('#sg-specview-body pre.sg-specview-text');
    return { pre: !!pre, text: pre ? pre.textContent : '', html: pre ? pre.innerHTML : '' };
  });
  ok('純文字 → <pre> 顯示內容', b3.pre && /hello <b>spec<\/b>/.test(b3.text), b3.text);
  ok('文字內容有逸出（不會被當 HTML 解析）', /&lt;b&gt;/.test(b3.html), b3.html.slice(0, 60));

  console.log('\n[C] 無法就地顯示的格式');
  const c1 = await page.evaluate(async () => {
    await sgSpecView('RF', 3);
    const body = document.getElementById('sg-specview-body');
    const link = body.querySelector('a');
    return { txt: body.textContent, href: link ? link.getAttribute('href') : '',
             target: link ? link.getAttribute('target') : '', noIframe: !body.querySelector('iframe'),
             sub: document.getElementById('sg-specview-sub').textContent };
  });
  ok('Office 檔 → 給 Office Online 連結（另開分頁）',
     /Office Online/.test(c1.txt) && c1.href === 'https://sp.example/sheet.docx' && c1.target === '_blank', c1);
  ok('Office 檔不硬塞進 iframe', c1.noIframe === true);
  ok('參照自別的專案有標示', /參照自專案/.test(c1.sub), c1.sub);

  const c2 = await page.evaluate(async () => {
    await sgSpecView('RF', 4);
    const body = document.getElementById('sg-specview-body');
    return { txt: body.textContent, links: body.querySelectorAll('a').length };
  });
  ok('zip → 說明不能預覽並指向下載', /無法線上預覽/.test(c2.txt) && /下載/.test(c2.txt), c2.txt.slice(0, 60));

  console.log('\n[D] 關閉／Esc／失敗處理');
  const d1 = await page.evaluate(async () => {
    await sgSpecView('RF', 0);
    const src = document.querySelector('#sg-specview-body iframe').getAttribute('src');
    sgSpecViewClose();
    let revoked = false;
    try { const r = await fetch(src); revoked = !r.ok; } catch (e) { revoked = true; }
    return { display: document.getElementById('sg-specview-modal').style.display,
             emptied: document.getElementById('sg-specview-body').innerHTML === '', revoked };
  });
  ok('關閉後視窗隱藏且內容清空', d1.display === 'none' && d1.emptied, d1);
  ok('關閉後 blob URL 已 revoke（不留記憶體）', d1.revoked === true, d1);

  await page.evaluate(async () => { await sgSpecView('RF', 1); });
  await page.keyboard.press('Escape');
  ok('Esc 關得掉', await page.evaluate(() => document.getElementById('sg-specview-modal').style.display === 'none'));

  const d2 = await page.evaluate(async () => {
    const keep = dbAdapter.getSpecMeta;
    dbAdapter.getSpecMeta = async () => { throw new Error('HTTP 404'); };
    await sgSpecView('RF', 0);
    const txt = document.getElementById('sg-specview-body').textContent;
    dbAdapter.getSpecMeta = keep;
    sgSpecViewClose();
    return txt;
  });
  ok('讀取失敗 → 顯示原因並指向下載（不是空白）', /無法線上預覽/.test(d2) && /404/.test(d2) && /下載/.test(d2), d2.slice(0, 80));

  const d3 = await page.evaluate(async () => {
    await sgSpecView('RF', 0);
    window.__opened = [];
    sgSpecViewNewTab();
    const u = window.__opened[0] || '';
    sgSpecViewClose();
    return u.slice(0, 5);
  });
  ok('「↗ 新分頁」開的是 blob（不觸發下載）', d3 === 'blob:', d3);

  console.log('\n[E] 本機／離線模式');
  const e1 = await page.evaluate(async () => {
    const keep = dbAdapter.isSharePointMode;
    dbAdapter.isSharePointMode = () => false;
    window.__alerts = [];
    await sgSpecView('RF', 0);
    const open = document.getElementById('sg-specview-modal').style.display;
    dbAdapter.isSharePointMode = keep;
    return { alerts: window.__alerts, open };
  });
  ok('非 SharePoint 模式 → 明確告知且不開空視窗',
     e1.alerts.length === 1 && /本機|離線/.test(e1.alerts[0]) && e1.open === 'none', e1);

  const e2 = await page.evaluate(async () => {
    window.__alerts = [];
    await sgSpecView('RF', 5);          // 沒有規格書的元件
    return { alerts: window.__alerts, open: document.getElementById('sg-specview-modal').style.display };
  });
  ok('沒上傳規格書 → 告知，不開視窗', e2.alerts.length === 1 && /尚未上傳/.test(e2.alerts[0]) && e2.open === 'none', e2);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
