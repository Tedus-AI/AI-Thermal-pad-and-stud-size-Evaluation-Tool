/*
 * compMerge.js 單元測試（純 Node，不需要瀏覽器）
 * ⚠ 5G-RRU 與 AI-Thermal 兩個 repo 各放一份，內容必須逐字相同（跟 compMerge.js 一樣）。
 *
 * 情境：base＝載入時的快照、mine＝畫面上的副本、theirs＝寫入當下資料庫的最新內容。
 *   [A] 沒有別人改過 → 結果就是我的
 *   [B] 各改各的欄位 → 兩邊都留
 *   [C] 同一格改得不一樣 → 衝突；選「我的／資料庫的」後照選擇寫入
 *   [D] 型別差異（"5.2" vs 5.2、''）不算修改
 *   [E] 相依欄位整組比對（E-Pad 長寬、Rjc＋來源標記、介面材料＋型號）
 *   [F] 刪除：對方刪了我沒改 → 刪；對方刪了我改過 → 衝突；我刪了對方改過 → 衝突
 *   [G] 新增：兩邊新增都保留；兩邊新增同名 → 合成一顆
 *   [H] 舊資料沒有 _cid → 用名稱配對；對方剛補發的 id 優先沿用
 *   [I] 改名：用 _cid 配對，改名與對方的修改都保留
 *   [J] 專案欄位（project_name）三方比對
 *   [K] ensureCids／projectDigest／saveWithMerge 流程
 *   [L] 呼叫端自己推導的欄位（derivedKeys）不比對、不跳假衝突
 *   [M] 限溫與限溫對象（Limit_Ref）整組比對
 *   [N] 共用元件語意：limitRef（限溫對象自動判定）、limitSuspect（限溫疑似範例值）
 *
 * 執行：node tests/comp-merge.unit.test.js
 */
const path = require('path');
const CM = require(path.join(__dirname, '..', 'compMerge.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const C = (o) => JSON.parse(JSON.stringify(o));
const find = (list, name) => (list || []).find(c => c.Component === name);

const BASE = {
  project_name: 'P1',
  rf_data: [
    { _cid: 'a', Component: 'PA', Qty: 2, 'Power(W)': 30, R_jc: 0.5, _rjc_from: 'JC_bot', Pad_L: 10, Pad_W: 8, _pad_from: 'epadSize',
      Board_Type: 'Copper Coin', TIM_Type: 'Pad', TIM_Model: 'X1', 'Height(mm)': 20, 'Limit(C)': 200 },
    { _cid: 'b', Component: 'Driver', Qty: 1, 'Power(W)': 5, R_jc: 1.2, Board_Type: 'Thermal Via', TIM_Type: 'Grease',
      Pad_L: 5, Pad_W: 5, 'Height(mm)': 10, 'Limit(C)': 175 },
  ],
  digital_data: [{ _cid: 'c', Component: 'FPGA', Qty: 1, 'Power(W)': 25 }],
  pwr_data: [],
};

(async () => {
  console.log('\n[A] 沒有別人改過 → 結果就是我的');
  {
    const mine = C(BASE); find(mine.rf_data, 'PA')['Height(mm)'] = 22;
    const r = CM.mergeProject(BASE, mine, C(BASE), { scalars: ['project_name'] });
    ok('沒有衝突', r.conflicts.length === 0 && r.unresolved.length === 0, r.conflicts);
    ok('我改的高度寫進去', find(r.fields.rf_data, 'PA')['Height(mm)'] === 22);
    ok('其他欄位不變、_cid 保留', find(r.fields.rf_data, 'PA')._cid === 'a' && find(r.fields.rf_data, 'Driver')['Power(W)'] === 5);
    ok('順序跟著畫面', r.fields.rf_data.map(c => c.Component).join() === 'PA,Driver');
  }

  console.log('\n[B] 各改各的欄位 → 兩邊都留（標準流程：AI-Thermal 補 θJC、5G-RRU 補高度）');
  {
    const theirs = C(BASE); Object.assign(find(theirs.rf_data, 'Driver'), { R_jc: 0.8, _rjc_from: 'JC_bot' });
    const mine = C(BASE); find(mine.rf_data, 'Driver')['Height(mm)'] = 12;
    const r = CM.mergeProject(BASE, mine, theirs);
    const d = find(r.fields.rf_data, 'Driver');
    ok('對方的 Rjc 保留（不被我的舊副本蓋掉）', d.R_jc === 0.8 && d._rjc_from === 'JC_bot', d);
    ok('我的高度也寫進去', d['Height(mm)'] === 12, d);
    ok('沒有衝突', r.conflicts.length === 0, r.conflicts);
    ok('統計：併入資料庫最新 1 項', r.stats.fromTheirs === 1, r.stats);
    ok('摘要文字寫出併入幾項', /併入資料庫最新的 1 項修改/.test(CM.summaryText(r)), CM.summaryText(r));
  }

  console.log('\n[C] 同一格改得不一樣 → 衝突，照使用者選擇寫入');
  {
    const theirs = C(BASE); find(theirs.rf_data, 'PA')['Power(W)'] = 35;
    const mine = C(BASE); find(mine.rf_data, 'PA')['Power(W)'] = 28;
    const r = CM.mergeProject(BASE, mine, theirs);
    ok('列出 1 個未決定的衝突', r.unresolved.length === 1 && r.unresolved[0].kind === 'field', r.unresolved);
    const c = r.unresolved[0];
    ok('衝突內容：元件、欄位、兩邊的值、載入時的值', c.name === 'PA' && c.label === '瓦數 (W)' &&
       c.mine['Power(W)'] === 28 && c.theirs['Power(W)'] === 35 && c.base['Power(W)'] === 30 && c.catLabel === 'RF', c);
    const rm = CM.mergeProject(BASE, mine, theirs, { resolutions: { [c.key]: 'mine' } });
    ok('選「我的」→ 28，且不再有未決定的衝突', find(rm.fields.rf_data, 'PA')['Power(W)'] === 28 && rm.unresolved.length === 0);
    const rt = CM.mergeProject(BASE, mine, theirs, { resolutions: { [c.key]: 'theirs' } });
    ok('選「資料庫的」→ 35', find(rt.fields.rf_data, 'PA')['Power(W)'] === 35 && rt.unresolved.length === 0);
    const same = C(BASE); find(same.rf_data, 'PA')['Power(W)'] = 28;
    ok('兩邊改成一樣的值 → 不算衝突', CM.mergeProject(BASE, mine, same).conflicts.length === 0);
  }

  console.log('\n[D] 型別差異不算修改');
  {
    const base = { rf_data: [{ _cid: 'x', Component: 'L', 'Power(W)': '5.2', Qty: '2', 'Limit(C)': '' }] };
    const theirs = { rf_data: [{ Component: 'L', 'Power(W)': 5.2, Qty: 2 }] };          // 5G-RRU 存檔後：數字、'' 被刪掉
    const mine = C(base); mine.rf_data[0]['Power(W)'] = 6;                             // AI-Thermal 使用者改了瓦數
    const r = CM.mergeProject(base, mine, theirs);
    const l = r.fields.rf_data[0];
    ok('"5.2" 與 5.2 視為相同 → 我改的 6 直接寫入，不跳衝突', l['Power(W)'] === 6 && r.conflicts.length === 0, r.conflicts);
    ok('字串數字轉成數字、空字串不寫 key', l.Qty === 2 && !('Limit(C)' in l), l);
    const n = CM.normalizeComp({ Board_Type: '  ', TIM_Model: '', R_jc: 'abc', Pad_L: '7', _filled: { x: 1 } });
    ok('normalizeComp：空的類型／型號刪 key、非數字刪 key、字串數字轉數字、清掉舊 _filled',
       !('Board_Type' in n) && !('TIM_Model' in n) && !('R_jc' in n) && n.Pad_L === 7 && !('_filled' in n), n);
  }

  console.log('\n[E] 相依欄位整組比對');
  {
    const theirs = C(BASE); find(theirs.rf_data, 'PA').Pad_W = 9;
    const mine = C(BASE); find(mine.rf_data, 'PA').Pad_L = 12;
    const r = CM.mergeProject(BASE, mine, theirs);
    ok('E-Pad 長（我）與寬（對方）不會拼成兩邊都沒有過的 12×9 → 整組當一個衝突',
       r.unresolved.length === 1 && r.unresolved[0].label === 'E-Pad 長 × 寬', r.unresolved);
    ok('衝突的值以「長 × 寬」顯示', CM.fmtUnit(r.unresolved[0].fields, r.unresolved[0].mine) === '12 × 8 mm' &&
       CM.fmtUnit(r.unresolved[0].fields, r.unresolved[0].theirs) === '10 × 9 mm');
    const rj = C(BASE); Object.assign(find(rj.rf_data, 'PA'), { R_jc: 3.1, _rjc_from: 'JC_top' });
    const r2 = CM.mergeProject(BASE, C(BASE), rj);
    ok('Rjc 與它的來源標記一起跟著對方', find(r2.fields.rf_data, 'PA').R_jc === 3.1 && find(r2.fields.rf_data, 'PA')._rjc_from === 'JC_top');
    const tm = C(BASE); delete find(tm.rf_data, 'PA').TIM_Model;                       // 對方取消了型號
    const mm = C(BASE); find(mm.rf_data, 'PA').TIM_Type = 'Putty';                     // 我換了類型（型號跟著清掉）
    delete find(mm.rf_data, 'PA').TIM_Model;
    const r3 = CM.mergeProject(BASE, mm, tm);
    ok('介面材料＋型號：兩邊都動到 → 整組衝突（不會出現 Putty＋舊 Pad 型號）', r3.unresolved.length === 1 && r3.unresolved[0].label === '介面材料／型號', r3.unresolved);
  }

  console.log('\n[F] 刪除');
  {
    const theirs = C(BASE); theirs.rf_data = theirs.rf_data.filter(c => c.Component !== 'Driver');
    const r = CM.mergeProject(BASE, C(BASE), theirs);
    ok('對方刪了、我沒改 → 照對方刪除', !find(r.fields.rf_data, 'Driver') && r.conflicts.length === 0 && r.stats.droppedByTheirs === 1);
    const mine = C(BASE); find(mine.rf_data, 'Driver')['Height(mm)'] = 11;
    const r2 = CM.mergeProject(BASE, mine, theirs);
    ok('對方刪了、我改過 → 衝突（kind=theirsDeleted）', r2.unresolved.length === 1 && r2.unresolved[0].kind === 'theirsDeleted', r2.unresolved);
    ok('未決定前暫時保留我的', !!find(r2.fields.rf_data, 'Driver'));
    const k = r2.unresolved[0].key;
    ok('選「資料庫的」→ 刪除', !find(CM.mergeProject(BASE, mine, theirs, { resolutions: { [k]: 'theirs' } }).fields.rf_data, 'Driver'));
    ok('選「我的」→ 保留（含我改的高度）', find(CM.mergeProject(BASE, mine, theirs, { resolutions: { [k]: 'mine' } }).fields.rf_data, 'Driver')['Height(mm)'] === 11);

    const mdel = C(BASE); mdel.rf_data = mdel.rf_data.filter(c => c.Component !== 'Driver');
    const r3 = CM.mergeProject(BASE, mdel, C(BASE));
    ok('我刪了、對方沒改 → 照我的刪除', !find(r3.fields.rf_data, 'Driver') && r3.conflicts.length === 0 && r3.stats.deletedMine === 1);
    const tch = C(BASE); find(tch.rf_data, 'Driver').R_jc = 0.9;
    const r4 = CM.mergeProject(BASE, mdel, tch);
    ok('我刪了、對方改過 → 衝突（kind=mineDeleted），未決定前照我的刪除',
       r4.unresolved.length === 1 && r4.unresolved[0].kind === 'mineDeleted' && !find(r4.fields.rf_data, 'Driver'), r4.unresolved);
    const r5 = CM.mergeProject(BASE, mdel, tch, { resolutions: { [r4.unresolved[0].key]: 'theirs' } });
    ok('選「資料庫的」→ 保留對方的版本', find(r5.fields.rf_data, 'Driver').R_jc === 0.9);
    const both = C(BASE); both.rf_data = both.rf_data.filter(c => c.Component !== 'Driver');
    ok('兩邊都刪了 → 不用管', !find(CM.mergeProject(BASE, mdel, both).fields.rf_data, 'Driver'));
  }

  console.log('\n[G] 新增');
  {
    const theirs = C(BASE); theirs.rf_data.push({ _cid: 't1', Component: 'LNA', Qty: 1, 'Power(W)': 0.5 });
    const mine = C(BASE); mine.rf_data.push({ Component: 'Circulator', Qty: 1, 'Power(W)': 3 });
    const r = CM.mergeProject(BASE, mine, theirs);
    ok('我新增的與對方新增的都保留（對方的接在後面）', r.fields.rf_data.map(c => c.Component).join() === 'PA,Driver,Circulator,LNA', r.fields.rf_data.map(c => c.Component));
    ok('我新增的元件補發 _cid', !!find(r.fields.rf_data, 'Circulator')._cid);
    const t2 = C(BASE); t2.rf_data.push({ _cid: 't9', Component: 'Circulator', Qty: 1, 'Power(W)': 4 });
    const r2 = CM.mergeProject(BASE, mine, t2);
    ok('兩邊都新增同名元件 → 合成一顆，瓦數不同列為衝突',
       r2.fields.rf_data.filter(c => c.Component === 'Circulator').length === 1 && r2.unresolved.length === 1 && r2.unresolved[0].label === '瓦數 (W)', r2.unresolved);
    ok('合成的那顆沿用資料庫已有的 _cid', find(r2.fields.rf_data, 'Circulator')._cid === 't9');
  }

  console.log('\n[H] 舊資料沒有 _cid → 用名稱配對');
  {
    const legacy = { rf_data: [{ Component: 'PA', 'Power(W)': 30 }, { Component: 'LNA', 'Power(W)': 1 }] };
    const base = C(legacy); CM.ensureProjectCids(base);                     // 載入時補發 id（畫面副本同一份 id）
    const mine = C(base); find(mine.rf_data, 'PA')['Power(W)'] = 31;
    const theirs = C(legacy); find(theirs.rf_data, 'LNA')['Power(W)'] = 2;   // 資料庫還沒有 id
    const r = CM.mergeProject(base, mine, theirs);
    ok('名稱配對成功：兩邊的修改都保留', find(r.fields.rf_data, 'PA')['Power(W)'] === 31 && find(r.fields.rf_data, 'LNA')['Power(W)'] === 2 && r.conflicts.length === 0, r.fields.rf_data);
    ok('寫出去的元件都有 _cid（沿用畫面上的）', r.fields.rf_data.every(c => c._cid) && find(r.fields.rf_data, 'PA')._cid === find(mine.rf_data, 'PA')._cid);
    const other = C(legacy); other.rf_data.forEach((c, i) => { c._cid = 'o' + i; });   // 對方工具先存檔、自己補發了 id
    const r2 = CM.mergeProject(base, mine, other);
    ok('對方剛補發的 id 與我的不同 → 仍以名稱配對，且沿用資料庫已有的 id',
       find(r2.fields.rf_data, 'PA')._cid === 'o0' && r2.fields.rf_data.length === 2 && r2.conflicts.length === 0, r2.fields.rf_data);
  }

  console.log('\n[I] 改名：用 _cid 配對');
  {
    const theirs = C(BASE); find(theirs.rf_data, 'PA')['Power(W)'] = 33;
    const mine = C(BASE); find(mine.rf_data, 'PA').Component = 'PA_main';
    const r = CM.mergeProject(BASE, mine, theirs);
    const pa = r.fields.rf_data.find(c => c._cid === 'a');
    ok('我改名＋對方改瓦數 → 同一顆，兩個修改都保留', pa.Component === 'PA_main' && pa['Power(W)'] === 33 && r.fields.rf_data.length === 2, r.fields.rf_data);
    const t2 = C(BASE); find(t2.rf_data, 'PA').Component = 'PA_v2';
    const m2 = C(BASE); find(m2.rf_data, 'PA')['Height(mm)'] = 25;
    const r2 = CM.mergeProject(BASE, m2, t2);
    const pa2 = r2.fields.rf_data.find(c => c._cid === 'a');
    ok('對方改名＋我改高度 → 同一顆（名稱用對方的）', pa2.Component === 'PA_v2' && pa2['Height(mm)'] === 25 && r2.fields.rf_data.length === 2);
    const t3 = C(BASE); find(t3.rf_data, 'PA').Component = 'Driver';            // 對方把 PA 改名成跟另一顆一樣
    const r3 = CM.mergeProject(BASE, C(BASE), t3);
    ok('有 id 的元件不會被別顆用名稱搶配', r3.fields.rf_data.filter(c => c._cid === 'b').length === 1 && r3.fields.rf_data.length === 2, r3.fields.rf_data);
  }

  console.log('\n[J] 專案欄位（project_name）三方比對');
  {
    const theirs = C(BASE); theirs.project_name = 'P1（AI-Thermal 改名）';
    const r = CM.mergeProject(BASE, C(BASE), theirs, { scalars: ['project_name'] });
    ok('我沒改名 → 沿用對方的新名稱（不會被我的舊名稱蓋回去）', r.fields.project_name === 'P1（AI-Thermal 改名）');
    const mine = C(BASE); mine.project_name = 'P1-mine';
    const r2 = CM.mergeProject(BASE, mine, theirs, { scalars: ['project_name'] });
    ok('兩邊都改名 → 衝突', r2.unresolved.length === 1 && r2.unresolved[0].kind === 'scalar' && r2.unresolved[0].label === '專案名稱');
    ok('只有我改名 → 用我的', CM.mergeProject(BASE, mine, C(BASE), { scalars: ['project_name'] }).fields.project_name === 'P1-mine');
  }

  console.log('\n[L] 呼叫端自己推導的欄位（derivedKeys，例：5G-RRU 的板厚）');
  {
    const base = { pwr_data: [{ _cid: 'p', Component: 'PSU', 'Power(W)': 30 }] };            // 資料庫裡沒有板厚
    const mine = { pwr_data: [{ _cid: 'p', Component: 'PSU', 'Power(W)': 30, 'Thick(mm)': 0 }] };  // 載入時自動帶入 0
    const gone = { pwr_data: [] };                                                            // AI-Thermal 刪掉了
    const r = CM.mergeProject(base, mine, gone, { derivedKeys: ['Thick(mm)'] });
    ok('載入時自動帶入的板厚不算「我改過」→ 對方刪除照刪，不跳假衝突', r.fields.pwr_data.length === 0 && r.conflicts.length === 0, r.conflicts);
    const r0 = CM.mergeProject(base, mine, gone);
    ok('（對照）沒排除的話就會變成假衝突', r0.unresolved.length === 1 && r0.unresolved[0].kind === 'theirsDeleted');
    const b2 = { rf_data: [{ _cid: 'a', Component: 'PA', 'Thick(mm)': 1.6, Board_Type: 'Thermal Via' }] };
    const m2 = { rf_data: [{ _cid: 'a', Component: 'PA', 'Thick(mm)': 3, Board_Type: 'Copper Coin' }] };   // 我換導熱方式 → 板厚跟著變
    const t2 = { rf_data: [{ _cid: 'a', Component: 'PA', 'Thick(mm)': 2.5, Board_Type: 'Thermal Via' }] };
    const r2 = CM.mergeProject(b2, m2, t2, { derivedKeys: ['Thick(mm)'] });
    ok('推導欄位兩邊不同也不跳衝突，一律用畫面上的值（呼叫端之後重新推導）',
       r2.conflicts.length === 0 && r2.fields.rf_data[0]['Thick(mm)'] === 3 && r2.fields.rf_data[0].Board_Type === 'Copper Coin', r2);
  }

  console.log('\n[M] 限溫與限溫對象整組比對');
  {
    const b = { digital_data: [{ _cid: 'd', Component: 'DDR', 'Limit(C)': 95 }] };
    const m = { digital_data: [{ _cid: 'd', Component: 'DDR', 'Limit(C)': 95, Limit_Ref: 'Tj' }] };   // 我只改對象
    const t = { digital_data: [{ _cid: 'd', Component: 'DDR', 'Limit(C)': 105 }] };                   // 對方只改數字
    const r = CM.mergeProject(b, m, t);
    ok('一邊改限溫、一邊改對象 → 整組衝突（不拼成「對方的數字＋我的對象」）',
       r.unresolved.length === 1 && r.unresolved[0].fields.join() === 'Limit(C),Limit_Ref', r.unresolved);
    ok('衝突視窗寫出兩邊的數字與對象',
       CM.fmtUnit(['Limit(C)', 'Limit_Ref'], r.unresolved[0].mine) === '95 °C（Tj）' &&
       CM.fmtUnit(['Limit(C)', 'Limit_Ref'], r.unresolved[0].theirs) === '105 °C（對象自動判定）', [CM.fmtUnit(['Limit(C)', 'Limit_Ref'], r.unresolved[0].mine), CM.fmtUnit(['Limit(C)', 'Limit_Ref'], r.unresolved[0].theirs)]);
    const r2 = CM.mergeProject(b, m, C(b));
    ok('只有我改 → 用我的對象', r2.conflicts.length === 0 && r2.fields.digital_data[0].Limit_Ref === 'Tj' && r2.fields.digital_data[0]['Limit(C)'] === 95);
    const m3 = C(b); m3.digital_data[0].Limit_Ref = '';
    ok("對象空字串等於沒填（不算修改）", CM.mergeProject(b, m3, C(b)).fields.digital_data[0].Limit_Ref === undefined && CM.normalizeComp(m3.digital_data[0]).Limit_Ref === undefined);
    const b4 = { rf_data: [{ _cid: 's', Component: 'SFP', 'Limit(C)': 200 }] };
    const m4 = { rf_data: [{ _cid: 's', Component: 'SFP', 'Limit(C)': 200, _limit_ok: 200 }] };        // 我確認了
    const t4 = { rf_data: [{ _cid: 's', Component: 'SFP', 'Limit(C)': 85 }] };                        // 對方改了數字
    const r4 = CM.mergeProject(b4, m4, t4);
    ok('確認標記不跟限溫綁成一組：不跳衝突，數字用對方的、標記留著（值不同 → 之後照樣提醒）',
       r4.conflicts.length === 0 && r4.fields.rf_data[0]['Limit(C)'] === 85 && r4.fields.rf_data[0]._limit_ok === 200, r4.fields.rf_data[0]);
  }

  console.log('\n[N] 共用元件語意：限溫對象自動判定、限溫疑似範例值');
  {
    const ref = (c, cat) => { const r = CM.limitRef(c, cat); return r.ref + (r.auto ? '·' + r.why : ''); };
    ok('有填就照填的', ref({ Component: 'SFP', Limit_Ref: 'Tj' }, 'digital') === 'Tj' && CM.limitRef({ Limit_Ref: 'Tc' }).auto === false);
    ok('AI-Thermal 的元件類型優先：SFP／DDR／濾波器 → Tc，DC-DC／CPU → Tj（即使在 PWR 類）',
       ref({ Component: 'U1', Type: 'SFP' }, 'digital') === 'Tc·類型 SFP' && ref({ Component: 'M', Type: 'DDR' }, 'digital') === 'Tc·類型 DDR' &&
       ref({ Component: 'F', Type: 'filter' }, 'rf') === 'Tc·類型 filter' && ref({ Component: 'Buck', Type: 'DC-DC' }, 'pwr') === 'Tj·類型 DC-DC' &&
       ref({ Component: 'SoC', Type: 'CPU' }, 'DIGITAL') === 'Tj·類型 CPU');
    ok('沒有類型 → 舊規則：PWR 類、名稱含 DDR 或 SFP → Tc，其餘 Tj（兩個工具的分類寫法都認得）',
       ref({ Component: 'Power Mod' }, 'pwr') === 'Tc·PWR 類' && ref({ Component: 'Power Mod' }, 'PWR') === 'Tc·PWR 類' &&
       ref({ Component: 'Power Mod' }, 'pwr_data') === 'Tc·PWR 類' && ref({ Component: '16G DDR' }, 'digital') === 'Tc·名稱含 DDR' &&
       ref({ Component: 'SFP28' }, 'digital') === 'Tc·名稱含 SFP' && ref({ Component: 'CPU (FPGA)' }, 'digital') === 'Tj·預設' &&
       ref({ Component: 'X', Type: '其他' }, 'rf') === 'Tj·預設');
    ok('不認得的值當成沒填（自動判定）', ref({ Component: 'A', Limit_Ref: 'tc' }, 'rf') === 'Tj·預設');
    const sus = c => { const r = CM.limitSuspect(c); return r ? r.id + ':' + r.value : null; };
    ok('光模組 > 85 °C、DDR > 105 °C → 提醒', sus({ Component: 'SFP', 'Limit(C)': 200 }) === 'sfp:200' &&
       sus({ Component: 'U7', Type: 'SFP', 'Limit(C)': 95 }) === 'sfp:95' && sus({ Component: 'SFP', 'Limit(C)': 85 }) === null &&
       sus({ Component: 'LPDDR4', 'Limit(C)': 125 }) === 'ddr:125' && sus({ Component: '16G DDR', 'Limit(C)': 95 }) === null);
    ok('功放以外的元件 ≥ 200 °C → 提醒；功放（類型或名稱）不提醒',
       sus({ Component: 'Cavity Filter', 'Limit(C)': 200 }) === 'hot:200' && sus({ Component: 'Circulator', 'Limit(C)': 125 }) === null &&
       sus({ Component: 'Final PA', 'Limit(C)': 225 }) === null && sus({ Component: 'Driver PA', 'Limit(C)': 200 }) === null &&
       sus({ Component: 'BTS6201U-PreDriver', 'Limit(C)': 200 }) === null && sus({ Component: 'GTRB384608FC', Type: 'Final PA', 'Limit(C)': 250 }) === null);
    ok('確認過（_limit_ok ＝ 目前的限溫）→ 不再提醒；限溫改了 → 再提醒；字串數字也認得',
       sus({ Component: 'SFP', 'Limit(C)': 200, _limit_ok: 200 }) === null && sus({ Component: 'SFP', 'Limit(C)': 150, _limit_ok: 200 }) === 'sfp:150' &&
       sus({ Component: 'SFP', 'Limit(C)': '200', _limit_ok: '200' }) === null);
    ok('沒有限溫 → 不提醒（缺值交給必填檢查）', sus({ Component: 'SFP' }) === null && sus({ Component: 'SFP', 'Limit(C)': '' }) === null);
  }

  console.log('\n[K] ensureCids／projectDigest／saveWithMerge');
  {
    const list = [{ Component: 'A' }, { _cid: 'dup', Component: 'B' }, { _cid: 'dup', Component: 'B copy' }];
    const n = CM.ensureCids(list);
    ok('沒有 id 的補發、重複的 id 改發新的（第一顆保留原 id）', n === 2 && list[1]._cid === 'dup' && list[2]._cid !== 'dup' && list[0]._cid && new Set(list.map(c => c._cid)).size === 3, list);
    const a = C(BASE), b = C(BASE);
    b.rf_data.forEach(c => { delete c._cid; c['Power(W)'] = String(c['Power(W)']); });
    ok('projectDigest 忽略 _cid 與型別差異', CM.sameDoc(a, b, ['project_name']));
    b.rf_data[0]['Power(W)'] = '31';
    ok('內容真的不同 → 指紋不同', !CM.sameDoc(a, b, ['project_name']));
    ok('只比指定的欄位（thermal_specs 之類不在比對範圍）', CM.sameDoc(Object.assign(C(BASE), { thermal_specs: { x: 1 } }), C(BASE), ['project_name']));

    // saveWithMerge：第一次寫入遇到衝突 → 問使用者 → 帶著選擇重試
    const theirs = C(BASE); find(theirs.rf_data, 'PA')['Power(W)'] = 35;
    const mine = C(BASE); find(mine.rf_data, 'PA')['Power(W)'] = 28;
    let asked = 0, written = null, attempts = 0;
    const res = await CM.saveWithMerge(async (resolutions) => {
      attempts++;
      const m = CM.mergeProject(BASE, mine, theirs, { resolutions });
      if (m.unresolved.length) throw CM.MergePending(m.unresolved);
      written = m.fields;
    }, { ask: async (cs) => { asked++; return { [cs[0].key]: 'theirs' }; } });
    ok('有衝突 → 問一次使用者，帶著選擇重試後寫入', res.ok && asked === 1 && attempts === 2 && find(written.rf_data, 'PA')['Power(W)'] === 35, { res, asked, attempts });
    const cancelled = await CM.saveWithMerge(async (resolutions) => {
      const m = CM.mergeProject(BASE, mine, theirs, { resolutions });
      if (m.unresolved.length) throw CM.MergePending(m.unresolved);
    }, { ask: async () => null });
    ok('使用者按取消 → 不寫入', cancelled.ok === false && cancelled.cancelled === true);
    let tries = 0;
    const retried = await CM.saveWithMerge(async () => { tries++; if (tries < 3) { const e = new Error('版本衝突'); e.name = 'ConflictError'; throw e; } return 'done'; },
      { isRetryable: e => e.name === 'ConflictError' });
    ok('可重試的錯誤（本機檔版本衝突）自動再試', retried.ok && retried.value === 'done' && tries === 3);
    let threw = null;
    try { await CM.saveWithMerge(async () => { throw new Error('網路斷線'); }); } catch (e) { threw = e.message; }
    ok('其他錯誤照樣往外丟（呼叫端顯示儲存失敗）', threw === '網路斷線');
  }

  console.log('\n通過 ' + pass + ' 項，失敗 ' + fail + ' 項');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
