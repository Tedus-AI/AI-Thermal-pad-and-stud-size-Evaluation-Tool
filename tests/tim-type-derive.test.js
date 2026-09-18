/*
 * Tab2 TIM 選型 → 元件欄位（comp.TIM_Type / comp.TIM_Model）—— headless 驗證
 * ---------------------------------------------------------------------------
 * 5G-RRU 移除 Pad2 之後（其 PR #76），兩邊的 TIM 類型收斂成同一組，本工具才開始
 * 把 Tab2 的「TIM Type」一併寫回共用 DB 的元件物件。驗證情境：
 *   1. Tab2 有選類型（含型號）→ 兩個 key 都寫進去
 *   2. Tab2 有選類型、沒選型號 → 寫 TIM_Type、delete TIM_Model（不寫 ''）
 *   3. Tab2 沒選類型 / 整列沒填 → 兩個 key 都不動（保留 5G-RRU 端填的值）
 *   4. 元件是舊的 Pad2 / Solder 且沒有一起指定型號 → 不覆寫（否則靜默換掉 k/t）
 *   5. 舊的 Pad2 ＋型號 → 收斂成 Pad ＋型號（遷移完成）
 *   6. 主散熱路徑的推導不受影響（回歸）
 *
 * 執行：
 *   npx http-server . -p 8124 -c-1 &      # 於 repo 根目錄
 *   node tests/tim-type-derive.test.js    # 可用 TEST_URL 指定網址
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const BASE = process.env.TEST_URL || 'http://127.0.0.1:8124/index.html';
const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

(async () => {
  const browser = await chromium.launch(EXEC ? { executablePath: EXEC } : {});
  const page = await browser.newPage();
  await page.route('**', r => r.request().url().startsWith(BASE.replace(/index\.html$/, '')) ? r.continue() : r.abort());
  await page.addInitScript(() => {
    window.Plotly = { newPlot(){}, Plots:{resize(){}}, relayout(){}, purge(){}, toImage: async()=>'' };
    window.XLSX = { utils:{book_new:()=>({}),aoa_to_sheet:()=>({}),book_append_sheet(){}}, writeFile(){} };
    window.msal = { PublicClientApplication: class {
      async initialize(){} async handleRedirectPromise(){return null} getAllAccounts(){return []} } };
    window.alert = () => {}; window.confirm = () => true;
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof sgDeriveFromSpec === 'function');

  console.log('\n[1] Tab2 有選 TIM 類型 → 寫回元件');
  const r1 = await page.evaluate(() => {
    const comp = { Component:'PA', TIM_Type:'Grease' };
    const changed = sgDeriveFromSpec(comp, { timType:'Pad', timModel:'TG-A6200' });
    return { changed, type: comp.TIM_Type, model: comp.TIM_Model };
  });
  ok('類型＋型號都寫進元件', r1.changed && r1.type === 'Pad' && r1.model === 'TG-A6200', r1);

  const r2 = await page.evaluate(() => {
    const comp = { Component:'PA', TIM_Type:'Grease', TIM_Model:'OLD-MODEL' };
    sgDeriveFromSpec(comp, { timType:'Putty' });
    return { type: comp.TIM_Type, hasModel: Object.prototype.hasOwnProperty.call(comp, 'TIM_Model') };
  });
  ok('有類型沒型號 → 寫 TIM_Type、delete TIM_Model（不寫 \'\'）', r2.type === 'Putty' && r2.hasModel === false, r2);

  const r3 = await page.evaluate(() => {
    const comp = { Component:'PA', TIM_Type:'None' };
    sgDeriveFromSpec(comp, { timType:'None' });
    return comp.TIM_Type;
  });
  ok('None 也是合法類型', r3 === 'None', r3);

  console.log('\n[2] Tab2 沒選類型 → 不動 5G-RRU 填的值');
  const r4 = await page.evaluate(() => {
    const a = { Component:'PA', TIM_Type:'Putty', TIM_Model:'TP-500' };
    const chA = sgDeriveFromSpec(a, { timType:'', heatSourceSize:'' });      // Tab2 選「—」
    const b = { Component:'PA', TIM_Type:'Putty', TIM_Model:'TP-500' };
    const chB = sgDeriveFromSpec(b, undefined);                              // Tab2 整列沒填過
    return { chA, a, chB, b };
  });
  ok('類型選「—」→ TIM_Type / TIM_Model 都不動',
     r4.a.TIM_Type === 'Putty' && r4.a.TIM_Model === 'TP-500' && r4.chA === false, r4.a);
  ok('Tab2 沒有這一列 → TIM_Type / TIM_Model 都不動',
     r4.b.TIM_Type === 'Putty' && r4.b.TIM_Model === 'TP-500' && r4.chB === false, r4.b);

  console.log('\n[3] 舊類型（Pad2 / Solder）不被靜默覆寫');
  const r5 = await page.evaluate(() => {
    const a = { Component:'PA', TIM_Type:'Pad2' };
    sgDeriveFromSpec(a, { timType:'Pad' });                       // 沒指定型號 → 不可覆寫
    const b = { Component:'PA', TIM_Type:'Pad2' };
    sgDeriveFromSpec(b, { timType:'Pad', timModel:'TG-A6200' });  // 連型號一起寫 → 收斂
    const c = { Component:'PA', TIM_Type:'Solder' };
    sgDeriveFromSpec(c, { timType:'Grease' });
    return { a: a.TIM_Type, b: [b.TIM_Type, b.TIM_Model], c: c.TIM_Type };
  });
  ok('Pad2 ＋沒型號 → 保留 Pad2（不靜默換成 K_Pad/t_Pad）', r5.a === 'Pad2', r5.a);
  ok('Pad2 ＋型號 → 收斂成 Pad ＋型號', r5.b[0] === 'Pad' && r5.b[1] === 'TG-A6200', r5.b);
  ok('Solder ＋沒型號 → 保留', r5.c === 'Solder', r5.c);

  console.log('\n[4] 主散熱路徑推導不受影響（回歸）');
  const r6 = await page.evaluate(() => {
    const via = { Component:'FPGA' };
    sgDeriveFromSpec(via, { timType:'Putty', heatDirection:'Thermal Via', epadSize:'8×6', heatSourceSize:'20×20' });
    const coin = { Component:'PA' };
    sgDeriveFromSpec(coin, { timType:'Grease', heatDirection:'Copper Coin', heatSourceSize:'12×10' });
    const none = { Component:'X', Board_Type:'Thermal Via', Pad_L:1, Pad_W:2 };
    sgDeriveFromSpec(none, { timType:'Pad' });     // 沒選主散熱路徑 → 不動 Board_Type/Pad
    return { via:[via.Board_Type, via.Pad_L, via.Pad_W, via.TIM_Type],
             coin:[coin.Board_Type, coin.Pad_L, coin.Pad_W],
             none:[none.Board_Type, none.Pad_L, none.Pad_W, none.TIM_Type] };
  });
  ok('Thermal Via → Board_Type/Pad 取 E-PAD 大小，TIM 照寫',
     r6.via.join(',') === 'Thermal Via,8,6,Putty', r6.via);
  ok('Copper Coin → Pad 取元件大小', r6.coin.join(',') === 'Copper Coin,12,10', r6.coin);
  ok('沒選主散熱路徑 → 不動 Board_Type/Pad，但 TIM 照寫', r6.none.join(',') === 'Thermal Via,1,2,Pad', r6.none);

  console.log('\n[5] 整批推導');
  const r7 = await page.evaluate(() => {
    const data = { rf_data:[{Component:'Final PA', TIM_Type:'Grease'}], digital_data:[{Component:'CPU (FPGA)'}], pwr_data:[] };
    const specs = { 'Final_PA': { timType:'Pad', timModel:'TG-A6200' } };   // CPU 沒有 spec
    const changed = sgDeriveAllFromSpecs(data, specs);
    return { changed, pa:[data.rf_data[0].TIM_Type, data.rf_data[0].TIM_Model],
             cpuHasType: Object.prototype.hasOwnProperty.call(data.digital_data[0], 'TIM_Type') };
  });
  ok('有 spec 的元件被寫入、沒 spec 的不被塞值', r7.changed && r7.pa.join(',') === 'Pad,TG-A6200' && r7.cpuHasType === false, r7);

  ok('頁面無 JS 例外', errors.length === 0, errors.slice(0, 3));
  await browser.close();
  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
