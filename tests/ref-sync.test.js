/*
 * 快選參照：來源專案有更新 → 提示 ＋ 一鍵套用 —— headless 驗證
 * ---------------------------------------------------------------------------
 * 情境：專案 B 從專案 A 快選帶入一顆元件，當時 A 還沒填熱阻；之後 A 補了熱阻。
 * 快選是一次性快照，所以 B 不會自己變 —— 但要「看得出來源有更新」並且能一鍵套用。
 *
 * 驗證情境：
 *   [A] 來源補了熱阻 → 元件名稱下方出現「↻ 來源有更新 (n)」；沒有差異時不出現。
 *   [B] 只比對規格類欄位（熱阻／規格書／限溫／類型／Temp Sensor）；功耗、E-Pad 尺寸、
 *       導熱方式、TIM、備註不在同步範圍（各專案自己的設計）。
 *   [C] 視窗列出「目前 vs 來源」；勾選套用會深拷貝（不與快取共用參照）、
 *       規格書重新標 _from、熱阻套用後 R_jc 跟著重算、空值 delete key 不寫 ''。
 *   [D] 來源被清空的欄位預設不勾（不順手清掉本專案的值）；全選／全不選可用。
 *   [E] 來源專案或同名元件不見了 → 顯示「來源已不存在」，不給更新鈕也不報錯。
 *   [F] 未解鎖（唯讀）→ 可以開來看差異，但沒有套用鍵。
 *
 * 執行：
 *   npx http-server . -p 8125 -c-1 &      # 於 repo 根目錄
 *   node tests/ref-sync.test.js           # 可用 TEST_URL 指定網址
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
    window.XLSX = { utils:{book_new:()=>({}),aoa_to_sheet:()=>({}),book_append_sheet(){}}, writeFile(){} };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sgRenderProjectComponents === 'function' && typeof sgRefDiff === 'function');

  // 專案 A（來源，已補上熱阻與規格書）／專案 B（目前編輯中，快選時 A 還沒有熱阻）
  const setup = () => {
    isProtected = false;
    sgVariantsCache = { RF: [], Digital: [], PWR: [] };
    sgProjectTreeCache = { RF: [{
      projId: 'A', projName: '專案A', ts: 1, comps: [{
        name: 'Final PA', power: 50, power_rt: 40,
        src: {
          Rth: [{ type: 'JC_bot', value: 0.35, cond: '@85°C 冷板', primary: true }],
          SpecFile: { path: '/SPEC/專案A/RF/PA__ds.pdf', name: 'ds.pdf', at: '2026-01-01T00:00:00Z' },
          'Limit(C)': 225, Type: 'Final PA', Temp_Sensor: 'Y', Local_Qty: 1, Remote_Qty: 0,
          'Power(W)': 50, Pad_L: 20, Pad_W: 10, Board_Type: 'Copper Coin', TIM_Type: 'Pad', note: 'A 的備註',
        },
      }],
    }], Digital: [], PWR: [] };
    sgProjectId = 'B';
    sgProjectData = { project_name: '專案B', rf_data: [
      { Component: 'Final PA', 'Power(W)': 52, Pad_L: 12, Pad_W: 12, Board_Type: 'Thermal Via',
        TIM_Type: 'Grease', note: 'B 自己的備註',
        _ref_origin_project: '專案A', _ref_origin_id: 'A', _ref_locked: true },
      { Component: '本地元件', 'Power(W)': 3 },     // 沒有參照
    ], digital_data: [], pwr_data: [] };
    sgRenderProjectComponents();
  };
  await page.evaluate(setup);

  console.log('\n[A] 來源有更新 → 出現提示');
  const a = await page.evaluate(() => {
    const rows = document.querySelectorAll('#sg-project-components-body tbody tr');
    const btn = rows[0].querySelector('.sg-ref-sync-btn');
    const none = rows[1] ? rows[1].querySelector('.sg-ref-sync-btn') : null;
    return { has: !!btn, text: btn ? btn.textContent.trim() : '', title: btn ? btn.getAttribute('title') : '',
             onclick: btn ? btn.getAttribute('onclick') : '', noRefRow: !none,
             badgeHasDetach: !!rows[0].querySelector('.sg-ref-detach-btn') };
  });
  ok('參照元件出現「↻ 來源有更新」', a.has && /來源有更新/.test(a.text), a);
  ok('數字＝有差異的欄位數（熱阻/規格書/限溫/類型/Temp Sensor/Local/Remote = 7）', /\(7\)/.test(a.text), a.text);
  ok('tooltip 列出是哪些欄位、並說明不會自動改', /熱阻/.test(a.title) && /不會自動改/.test(a.title), a.title);
  ok('沒有參照的元件不顯示', a.noRefRow === true);
  ok('原本的「解除參照」還在（沒被擠掉）', a.badgeHasDetach === true);

  const a2 = await page.evaluate(() => {
    // 讓 B 與來源一致 → 提示要消失
    const comp = sgProjectData.rf_data[0];
    const src = sgProjectTreeCache.RF[0].comps[0].src;
    ['Rth','SpecFile','Limit(C)','Type','Temp_Sensor','Local_Qty','Remote_Qty']
      .forEach(k => { comp[k] = JSON.parse(JSON.stringify(src[k])); });
    sgRenderProjectComponents();
    const gone = !document.querySelector('#sg-project-components-body .sg-ref-sync-btn');
    return { gone, diff: sgRefDiff(comp, 'RF').length };
  });
  ok('兩邊一致時不顯示提示', a2.gone && a2.diff === 0, a2);

  console.log('\n[B] 只比對規格類欄位');
  await page.evaluate(setup);
  const b = await page.evaluate(() => {
    const comp = sgProjectData.rf_data[0];
    return { keys: sgRefDiff(comp, 'RF').map(d => d.key),
             fields: SG_REF_SPEC_FIELDS.map(f => f.key) };
  });
  ok('差異只含規格類欄位', b.keys.every(k => b.fields.includes(k)), b.keys);
  ok('功耗／E-Pad／導熱方式／TIM／備註不在同步範圍',
     !b.fields.some(k => ['Power(W)','Pad_L','Pad_W','Board_Type','TIM_Type','TIM_Model','note','Qty','Height(mm)','Thick(mm)'].includes(k)), b.fields);

  console.log('\n[C] 視窗與套用');
  const c1 = await page.evaluate(() => {
    sgRefSyncOpen('RF', 0);
    const body = document.getElementById('sg-refsync-body');
    const rows = [...body.querySelectorAll('tbody tr')].map(tr => [...tr.children].slice(1).map(td => td.textContent.trim()));
    return { open: document.getElementById('sg-refsync-modal').style.display === 'flex',
             rows, who: document.getElementById('sg-refsync-who').textContent,
             checked: [...body.querySelectorAll('input[type=checkbox]')].map(c => c.checked) };
  });
  ok('視窗列出每個差異欄位的「目前 vs 來源」', c1.open && c1.rows.length === 7, c1.rows);
  ok('熱阻那列看得出來源值（★JCb=0.35）',
     c1.rows.some(r => /熱阻/.test(r[0]) && /JCb=0\.35/.test(r[2]) && /（空）/.test(r[1])), c1.rows);
  ok('標題寫出元件與來源專案', /Final PA/.test(c1.who) && /專案A/.test(c1.who), c1.who);
  ok('有值的差異預設勾選', c1.checked.every(x => x === true), c1.checked);

  const c2 = await page.evaluate(() => {
    sgRefSyncApply();
    const comp = sgProjectData.rf_data[0];
    const srcRth = sgProjectTreeCache.RF[0].comps[0].src.Rth;
    // 深拷貝檢查：改本專案不可動到快取
    comp.Rth[0].value = 9.9;
    return {
      rjc: comp.R_jc, rjcFrom: comp._rjc_from,
      limit: comp['Limit(C)'], type: comp.Type, sensor: comp.Temp_Sensor,
      specFrom: comp.SpecFile && comp.SpecFile._from, specName: comp.SpecFile && comp.SpecFile.name,
      cacheUntouched: srcRth[0].value === 0.35,
      powerKept: comp['Power(W)'], noteKept: comp.note, padKept: comp.Pad_L,
      closed: document.getElementById('sg-refsync-modal').style.display === 'none',
      badgeGone: !document.querySelector('#sg-project-components-body .sg-ref-sync-btn'),
    };
  });
  ok('套用後熱阻進來且 R_jc 立刻重算（0.35 / JC_bot）', c2.rjc === 0.35 && c2.rjcFrom === 'JC_bot', c2);
  ok('限溫／類型／Temp Sensor 也跟著更新', c2.limit === 225 && c2.type === 'Final PA' && c2.sensor === 'Y', c2);
  ok('規格書重新標 _from（仍是參照來源專案的檔案）', c2.specFrom === '專案A' && c2.specName === 'ds.pdf', c2);
  ok('深拷貝：改本專案不會動到快取裡的來源', c2.cacheUntouched === true, c2);
  ok('不在同步範圍的欄位原封不動（功耗 52／備註／E-Pad 12）',
     c2.powerKept === 52 && c2.noteKept === 'B 自己的備註' && c2.padKept === 12, c2);
  ok('套用後視窗關閉、提示消失', c2.closed && c2.badgeGone, c2);

  console.log('\n[D] 來源清空的欄位預設不勾');
  const d = await page.evaluate(() => {
    setupAgain();
    function setupAgain() {
      sgProjectData.rf_data[0] = { Component: 'Final PA', 'Limit(C)': 225, Type: 'Final PA',
        Rth: [{ type: 'JC_bot', value: 0.35, cond: '', primary: true }],
        _ref_origin_project: '專案A', _ref_origin_id: 'A', _ref_locked: true };
      const src = sgProjectTreeCache.RF[0].comps[0].src;
      delete src.Rth;                 // 來源把熱阻清掉了
      src['Limit(C)'] = 200;          // 來源改了限溫
      delete src.SpecFile; delete src.Temp_Sensor; delete src.Local_Qty; delete src.Remote_Qty;
      sgRenderProjectComponents();
    }
    sgRefSyncOpen('RF', 0);
    const body = document.getElementById('sg-refsync-body');
    const state = [...body.querySelectorAll('tbody tr')].map(tr => ({
      label: tr.children[1].textContent.trim(), checked: tr.querySelector('input').checked,
      src: tr.children[3].textContent.trim(),
    }));
    sgRefSyncAll(true);
    const allOn = [...body.querySelectorAll('input')].every(c => c.checked);
    sgRefSyncAll(false);
    const allOff = [...body.querySelectorAll('input')].every(c => !c.checked);
    return { state, allOn, allOff };
  });
  ok('來源已清空的欄位預設不勾', d.state.some(r => /熱阻/.test(r.label) && r.checked === false && /清空/.test(r.src)), d.state);
  ok('來源有新值的欄位預設勾選（限溫 200）', d.state.some(r => /限溫/.test(r.label) && r.checked === true && /200/.test(r.src)), d.state);
  ok('全選／全不選可用', d.allOn && d.allOff, d);

  const d2 = await page.evaluate(() => {
    // 只勾「來源已清空」的熱阻 → 應該 delete key，不可寫 ''
    const body = document.getElementById('sg-refsync-body');
    [...body.querySelectorAll('tbody tr')].forEach(tr => {
      tr.querySelector('input').checked = /熱阻/.test(tr.children[1].textContent);
    });
    sgRefSyncApply();
    const comp = sgProjectData.rf_data[0];
    return { hasRth: Object.prototype.hasOwnProperty.call(comp, 'Rth'),
             limitKept: comp['Limit(C)'], rjcFrom: comp._rjc_from };
  });
  ok('勾了「來源已清空」→ delete key（不寫 \'\'）', d2.hasRth === false, d2);
  ok('沒勾的欄位不動（限溫仍是 225）', d2.limitKept === 225, d2);
  ok('熱阻清掉後來源標記也清掉', d2.rjcFrom === undefined, d2);

  console.log('\n[E] 來源不見了');
  const e = await page.evaluate(() => {
    sgProjectData.rf_data[0] = { Component: '不存在的元件', _ref_origin_project: '專案A', _ref_origin_id: 'A', _ref_locked: true };
    sgRenderProjectComponents();
    const gone = document.querySelector('#sg-project-components-body .sg-ref-gone');
    const btn = document.querySelector('#sg-project-components-body .sg-ref-sync-btn');
    // 整個來源專案不見
    sgProjectData.rf_data[0].Component = 'Final PA';
    sgProjectData.rf_data[0]._ref_origin_id = 'ZZZ';
    sgRenderProjectComponents();
    const gone2 = !!document.querySelector('#sg-project-components-body .sg-ref-gone');
    return { goneText: gone ? gone.textContent : '', noBtn: !btn, gone2 };
  });
  ok('來源同名元件不見 → 顯示「來源已不存在」且不給更新鈕', /來源已不存在/.test(e.goneText) && e.noBtn, e);
  ok('整個來源專案不見也一樣', e.gone2 === true, e);

  console.log('\n[F] 唯讀（未解鎖）');
  const f = await page.evaluate(() => {
    sgProjectData.rf_data[0] = { Component: 'Final PA', _ref_origin_project: '專案A', _ref_origin_id: 'A', _ref_locked: true };
    sgProjectTreeCache.RF[0].comps[0].src = { 'Limit(C)': 225, Type: 'Final PA' };
    isProtected = true;
    sgRenderProjectComponents();
    const btn = document.querySelector('#sg-project-components-body .sg-ref-sync-btn');
    if (btn) sgRefSyncOpen('RF', 0);
    const open = document.getElementById('sg-refsync-modal').style.display === 'flex';
    const applyHidden = document.getElementById('sg-refsync-apply').style.display === 'none';
    const lockNote = document.getElementById('sg-refsync-lock').style.display !== 'none';
    window.__alerts = [];
    sgRefSyncApply();
    const blocked = window.__alerts.length === 1;
    sgRefSyncClose();
    isProtected = false;
    return { hasBtn: !!btn, open, applyHidden, lockNote, blocked };
  });
  ok('唯讀時仍看得到提示並開得了視窗', f.hasBtn && f.open, f);
  ok('唯讀時沒有套用鍵、有「請先解鎖」說明', f.applyHidden && f.lockNote, f);
  ok('唯讀時就算硬呼叫 apply 也會被擋下', f.blocked, f);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
