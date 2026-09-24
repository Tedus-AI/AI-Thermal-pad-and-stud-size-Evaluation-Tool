/*
 * Tab1 限溫欄：限溫對象（Limit_Ref：Tj／Tc）＋限溫疑似範例值 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 「限溫」指的是 Tj（晶片接面）還是 Tc（外殼），原本只有 5G-RRU 用名稱猜（PWR 類或名稱含 ddr），
 * 本工具看不到也改不了。現在兩個工具的限溫欄底下都有同一個小下拉，自動判定與提醒的規則
 * 都在共用的 compMerge.js（CompMerge.limitRef／limitSuspect），兩邊看到的結果一致。
 *
 * 驗證情境：
 *   [A] 限溫欄底下的小下拉：自動（寫出判定結果）／Tj 接面／Tc 外殼；選自動＝刪 key；未知值不被靜默改掉
 *   [B] 改類型／名稱 → 「自動」跟著重新判定（就地更新，不整表重繪）
 *   [C] 限溫疑似範例值：虛線框＋提醒＋上方橫幅；確認 → 寫 _limit_ok 並消失；改成別的值 → 再提醒
 *   [D] 未解鎖（唯讀）→ 下拉與確認鈕都停用
 *   [E] 快選白名單 22 項含 Limit_Ref、參照同步欄位含 Limit_Ref
 *   [F] Excel 匯出多一欄「限溫對象」
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/limit-ref.test.js          # 可用 TEST_URL 指定網址
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
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.route('**', r => {
    const u = r.request().url();
    if (u.startsWith(BASE.replace(/index\.html$/, ''))) return r.continue();
    return r.abort();
  });
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.__xlsx = [];
    window.XLSX = { utils:{ book_new:()=>({}), aoa_to_sheet:(d)=>{ window.__xlsx.push(d); return {}; }, book_append_sheet(){} }, writeFile(){} };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.__confirms = []; window.confirm = m => { window.__confirms.push(String(m)); return true; };
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sgRenderProjectComponents === 'function' && typeof CompMerge === 'object');

  const setup = () => {
    isProtected = false;
    sgVariantsCache = { RF: [], Digital: [], PWR: [] };
    sgProjectTreeCache = { RF: [], Digital: [], PWR: [] };
    sgProjectId = 'P';
    sgProjectData = { project_name: '測試專案',
      rf_data: [{ Component: 'Final PA', Type: 'Final PA', 'Power(W)': 50, 'Limit(C)': 225 },
                { Component: 'Cavity Filter', Type: 'filter', 'Power(W)': 20, 'Limit(C)': 200 }],
      digital_data: [{ Component: '16G DDR', 'Power(W)': 1, 'Limit(C)': 95 },
                     { Component: 'U7', 'Power(W)': 0.5, 'Limit(C)': 200 }],
      pwr_data: [{ Component: 'Power Mod', 'Power(W)': 29, 'Limit(C)': 95 }] };
    sgRenderProjectComponents();
  };
  await page.evaluate(setup);
  const q = (cat, idx) => `#sg-project-components-body input[data-field="Limit(C)"][data-cat="${cat}"][data-idx="${idx}"]`;

  console.log('\n[A] 限溫欄底下的限溫對象小下拉');
  const a = await page.evaluate((qs) => {
    const td = s => document.querySelector(s).closest('td');
    const sel = s => td(s).querySelector('.sg-lim-ref select');
    const opts = s => Array.from(sel(s).options).map(o => o.textContent);
    const r = { pa: opts(qs.pa), ddr: opts(qs.ddr), pwr: opts(qs.pwr), filt: opts(qs.filt), val: sel(qs.ddr).value };
    const s = sel(qs.ddr); s.value = 'Tj'; s.dispatchEvent(new Event('change'));
    r.afterTj = sgProjectData.digital_data[0].Limit_Ref; r.selAfter = sel(qs.ddr).value;
    const s2 = sel(qs.ddr); s2.value = ''; s2.dispatchEvent(new Event('change'));
    r.afterAuto = ('Limit_Ref' in sgProjectData.digital_data[0]);
    sgProjectData.pwr_data[0].Limit_Ref = 'Tcase'; sgRenderProjectComponents();
    r.unknown = { val: sel(qs.pwr).value, opts: opts(qs.pwr), kept: sgProjectData.pwr_data[0].Limit_Ref };
    delete sgProjectData.pwr_data[0].Limit_Ref; sgRenderProjectComponents();
    return r;
  }, { pa: q('RF', 0), filt: q('RF', 1), ddr: q('Digital', 0), pwr: q('PWR', 0) });
  ok('自動判定寫在選項上：功放 Tj、濾波器（類型 filter）Tc、DDR（名稱）Tc、PWR 類 Tc',
     a.pa[0] === '自動·Tj' && a.filt[0] === '自動·Tc' && a.ddr[0] === '自動·Tc' && a.pwr[0] === '自動·Tc' &&
     JSON.stringify(a.ddr.slice(1)) === JSON.stringify(['Tj 接面', 'Tc 外殼']) && a.val === '', a);
  ok('選 Tj → 寫 Limit_Ref；選自動 → 刪 key（空值不寫 \'\'）', a.afterTj === 'Tj' && a.selAfter === 'Tj' && a.afterAuto === false, a);
  ok('不認得的值不被靜默改掉：補「（未知值）」選項、值保留', a.unknown.val === 'Tcase' && a.unknown.opts.includes('Tcase（未知值）') && a.unknown.kept === 'Tcase', a.unknown);

  console.log('\n[B] 改類型／名稱 → 自動判定就地更新');
  const b = await page.evaluate((qs) => {
    const body = document.getElementById('sg-project-components-body');
    const marker = body.firstElementChild;                               // 整表重繪的話這個節點會被換掉
    const typeSel = document.querySelector('#sg-project-components-body select[data-field="Type"][data-cat="Digital"][data-idx="1"]');
    typeSel.value = 'SFP'; sgOnTypeChange(typeSel);
    const autoText = document.querySelector(qs.u7).closest('td').querySelector('.sg-lim-ref select').options[0].textContent;
    const nameIn = document.querySelector('#sg-project-components-body input[data-field="Component"][data-cat="Digital"][data-idx="0"]');
    nameIn.value = 'Clock Buffer'; sgOnCompEdit(nameIn);
    const ddrAuto = document.querySelector(qs.ddr).closest('td').querySelector('.sg-lim-ref select').options[0].textContent;
    nameIn.value = '16G DDR'; sgOnCompEdit(nameIn);
    return { autoText, ddrAuto, same: body.firstElementChild === marker, type: sgProjectData.digital_data[1].Type };
  }, { u7: q('Digital', 1), ddr: q('Digital', 0) });
  ok('類型改成 SFP → 自動判定變 Tc', b.type === 'SFP' && b.autoText === '自動·Tc', b);
  ok('名稱不再含 DDR → 自動判定變 Tj', b.ddrAuto === '自動·Tj', b);
  ok('就地更新，不整表重繪（UX 慣例 1）', b.same === true, b);

  console.log('\n[C] 限溫疑似範例值');
  await page.evaluate(setup);
  const c = await page.evaluate((qs) => {
    const td = s => document.querySelector(s).closest('td');
    const banner = () => (document.getElementById('sg-lim-sus-banner') || {}).textContent || '';
    const r = { banner: banner(), filtCls: document.querySelector(qs.filt).className, filtNote: (td(qs.filt).querySelector('.sg-lim-sus') || {}).textContent || '',
                paNote: !!td(qs.pa).querySelector('.sg-lim-sus'), paCls: document.querySelector(qs.pa).className };
    td(qs.filt).querySelector('.sg-lim-sus button').click();
    r.ok = sgProjectData.rf_data[1]._limit_ok; r.msg = window.__confirms.slice(-1)[0] || '';
    r.afterNote = !!td(qs.filt).querySelector('.sg-lim-sus'); r.afterCls = document.querySelector(qs.filt).className; r.afterBanner = banner();
    const inp = document.querySelector(qs.filt); inp.value = '250'; sgOnCompEdit(inp);      // 換成另一個仍可疑的值（確認的是 200）
    r.again = !!td(qs.filt).querySelector('.sg-lim-sus') && /sg-suspect/.test(document.querySelector(qs.filt).className) && /Cavity Filter/.test(banner());
    inp.value = ''; sgOnCompEdit(inp);
    r.cleared = !('Limit(C)' in sgProjectData.rf_data[1]) && !td(qs.filt).querySelector('.sg-lim-sus');
    return r;
  }, { pa: q('RF', 0), filt: q('RF', 1) });
  ok('上方橫幅列出限溫疑似範例值（濾波器 200、類型空白但名稱不像光模組的 U7 200）',
     /限溫疑似範例值（2 顆）/.test(c.banner) && /Cavity Filter/.test(c.banner) && /U7/.test(c.banner) && /很少到 200/.test(c.banner), c.banner.slice(0, 160));
  ok('限溫格：琥珀色虛線框＋「疑似範例值」與確認鈕；功放 225 不提醒',
     /sg-suspect/.test(c.filtCls) && /疑似範例值/.test(c.filtNote) && !c.paNote && !/sg-suspect/.test(c.paCls), c);
  ok('按確認：先問一次，記下確認的值（_limit_ok ＝ 200），格子與橫幅都不再提醒',
     c.ok === 200 && /200 °C 是實際規格/.test(c.msg) && !c.afterNote && !/sg-suspect/.test(c.afterCls) && !/Cavity Filter/.test(c.afterBanner), c);
  ok('限溫改成另一個仍可疑的值 → 再提醒（就地更新格子與橫幅）', c.again === true, c);
  ok('清空限溫 → 刪 key、不提醒（缺值不是範例值）', c.cleared === true, c);

  console.log('\n[D] 未解鎖（唯讀）');
  await page.evaluate(setup);
  const d = await page.evaluate((qs) => {
    isProtected = true; applyReadonlyLock();
    const td = document.querySelector(qs.filt).closest('td');
    const r = { sel: td.querySelector('.sg-lim-ref select').disabled, btn: td.querySelector('.sg-lim-sus button').disabled,
                ban: Array.from(document.querySelectorAll('#sg-lim-sus-banner button')).every(b => b.disabled) };
    isProtected = false; applyReadonlyLock();
    return r;
  }, { filt: q('RF', 1) });
  ok('限溫對象下拉、確認鈕（格子與橫幅）都停用', d.sel && d.btn && d.ban, d);

  console.log('\n[E] 快選白名單／參照同步');
  const e = await page.evaluate(() => ({ n: SG_VARIANT_CARRY.length, has: SG_VARIANT_CARRY.includes('Limit_Ref'), mark: SG_VARIANT_CARRY.includes('_limit_ok'),
    ref: SG_REF_SPEC_FIELDS.some(f => f.key === 'Limit_Ref') }));
  ok('SG_VARIANT_CARRY 22 項、含 Limit_Ref、不含確認標記（與 5G-RRU 的 VARIANT_CARRY 同步）', e.n === 22 && e.has && !e.mark, e);
  ok('參照同步（↻ 來源有更新）也比對限溫對象（屬於這顆料本身）', e.ref, e);

  console.log('\n[F] Excel 匯出');
  await page.evaluate(setup);
  const f = await page.evaluate(() => {
    window.__xlsx = []; sgExportExcel();
    const dig = window.__xlsx[1] || [];
    const hi = (dig[0] || []).indexOf('限溫對象');
    return { header: dig[0], hi, lim: (dig[0] || []).indexOf('限溫(°C)'), ddr: (dig.find(r => r[0] === '16G DDR') || [])[hi] };
  });
  ok('限溫後面多一欄「限溫對象」，沒指定的寫自動判定結果與依據', f.hi === f.lim + 1 && f.ddr === '自動 Tc（名稱含 DDR）', f);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
