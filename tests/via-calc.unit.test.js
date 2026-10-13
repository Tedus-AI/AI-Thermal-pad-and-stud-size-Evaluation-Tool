/*
 * viaCalc.js 單元測試（純 Node，不需要瀏覽器）
 * ---------------------------------------------------------------------------
 *   [A] 公式與舊版獨立工具（thermal-via-calculator）逐字相同：K_eff、R_th、銅面積比、單顆 via 熱阻
 *   [B] via 佔用面積超過焊盤 → 不成立（舊版把 FR4 夾成 0 照算 → K_eff 被高估）
 *   [C] 排列：自動間距與畫圖用同一個排列（舊版兩套行列數公式相反）；最後一列不滿時置中；
 *       交錯排列納入列距 √3/2 與錯位半格；圓形 4 顆排成 2×2（舊版是中心＋3 顆）
 *   [D] 自動間距：所有孔壁離邊緣 ≥ 0.25 mm（舊版只算中心 → 孔壁越線）；矩形／交錯／圓形都排得下；
 *       放不下回 ok:false 並可算出最多放幾顆；單顆不需要間距（舊版跳「Pad 尺寸過小」）
 *   [E] 檢查：孔壁超出焊盤、孔壁重疊＝錯誤；離邊緣太近、中心距 < 2 倍內徑＝提醒
 *   [F] missing()：缺哪些輸入；數量須為正整數；單顆不需要間距
 *   [G] keffForComp（兩個工具共用：AI-Thermal 頁面的說明、5G-RRU 的基板熱阻 R_int）：
 *       完整設計 → ok（8.6×8.6、134 顆 8 mil、1 mil 鍍銅、導熱膠 → K_eff 13.114）；R_int ＝ t ÷ (K_eff × A_pad)；
 *       沒有 via 設計／缺塞孔材料／暫不納入／via 面積 > 焊盤 → 不 ok（呼叫端用通用值）；
 *       與板厚、中心間距無關；_renamed_from 查得到；E-PAD 用 Pad_L/Pad_W fallback；N/A 當沒填；試算值優先；
 *       配置問題（超出、重疊、沒填間距）照樣 ok、列在 issues
 *   [H] resolve()／parseLW()／specKey()／tvNum() 與 AI-Thermal 頁面原本的 viaResolve／sgParseLW／sgSpecKey／viaTvNum 相同
 *
 * ⚠ 本檔與 viaCalc.js 在 AI-Thermal 與 5G-RRU 兩個 repo 內容逐字相同，改一邊就同步另一邊。
 *
 * 執行：node tests/via-calc.unit.test.js
 */
const path = require('path');
const V = require(path.join(__dirname, '..', 'viaCalc.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);
const MIL = 0.0254;
const base = (o) => Object.assign({ shape: 'rect', L: 5, W: 5, pattern: 'matrix', n: 9, dia: 8 * MIL, pitch: 16 * MIL,
  t: 1.6, plating: 0.0254, kFill: 0.026 }, o || {});

// 舊版工具的公式（index.html calculateKeff，原封不動）
function legacy(data, padArea) {
  const r_inner = data.innerDia / 2, r_outer = r_inner + data.platingT;
  const area_fill = Math.PI * Math.pow(r_inner, 2);
  const area_copper = (Math.PI * Math.pow(r_outer, 2)) - area_fill;
  const area_via_footprint = Math.PI * Math.pow(r_outer, 2);
  const total_area_copper = area_copper * data.count, total_area_fill = area_fill * data.count;
  const area_fr4 = padArea - (area_via_footprint * data.count);
  const valid_area_fr4 = area_fr4 > 0 ? area_fr4 : 0;
  const keff = (total_area_copper * 385 + total_area_fill * data.fillK + valid_area_fr4 * 0.3) / padArea;
  const rth = (data.pcbT / (keff * padArea)) * 1000;
  const single_via_k_approx = (area_copper * 385 + area_fill * data.fillK) / area_via_footprint;
  const single_via_r = (data.pcbT / (single_via_k_approx * area_via_footprint)) * 1000;
  return { keff, rth, copperRatio: total_area_copper / padArea, singleViaR: single_via_r };
}

console.log('\n[A] 公式與舊版相同');
[
  base(),
  base({ n: 134, L: 8.6, W: 8.6, kFill: 2.0 }),
  base({ shape: 'circle', D: 6, n: 20, dia: 12 * MIL, plating: 0.035, kFill: 50 }),
  base({ n: 4, L: 2, W: 3, kFill: 385, t: 2.4 }),
].forEach((d, i) => {
  const r = V.calc(d);
  const area = d.shape === 'circle' ? Math.PI * Math.pow(d.D / 2, 2) : d.L * d.W;
  const l = legacy({ innerDia: d.dia, platingT: d.plating, count: d.n, fillK: d.kFill, pcbT: d.t }, area);
  ok(`案例 ${i + 1}：K_eff／R_th／銅面積比／單顆 R 與舊版相同`, r.ok && near(r.keff, l.keff, 1e-9) && near(r.rth, l.rth, 1e-9)
    && near(r.cuRatio, l.copperRatio, 1e-12) && near(r.singleR, l.singleViaR, 1e-9), { r, l });
});
{
  const r = V.calc(base());
  ok('預設案例（5×5、9 顆 8 mil、空氣）：K_eff 2.823、R_th 22.670 °C/W', r.keff.toFixed(3) === '2.823' && r.rth.toFixed(3) === '22.670', r);
  ok('沒有 via 的 FR4 熱阻 t/(K_FR4·A)', near(r.rthFr4, 1.6 / (0.3 * 25) * 1000, 1e-9), r.rthFr4);
  ok('中心間距不影響 K_eff', near(V.calc(base({ pitch: 0.3 })).keff, V.calc(base({ pitch: 1.2 })).keff), null);
  ok('沒有間距也能算 K_eff（間距只用於排列）', V.calc(base({ pitch: null })).ok);
}

console.log('\n[B] via 佔用面積超過焊盤 → 不成立');
{
  const d = base({ L: 1.6, W: 1.6, n: 200 });
  const r = V.calc(d);
  const l = legacy({ innerDia: d.dia, platingT: d.plating, count: d.n, fillK: d.kFill, pcbT: d.t }, 2.56);
  ok('ok:false、reason:over、footRatio > 1', !r.ok && r.reason === 'over' && r.footRatio > 1, r);
  ok('（對照：舊版照算出一個比純銅還誇張的 K_eff）', l.keff > 385, l.keff);
  ok('輸入不齊 → reason:missing', V.calc(base({ dia: null })).reason === 'missing' && V.calc(base({ kFill: null })).reason === 'missing');
}

console.log('\n[C] 排列');
{
  // 舊版：自動間距 rows = round(√(n/ratio))、cols = ceil(n/rows)；畫圖 cols = round(√(n·ratio))、rows = ceil(n/cols) → 可能相反
  const d = base({ n: 6, L: 4, W: 6 });
  const g = V.grid(d);
  const pts = V.layout(d, V.autoPitch(d).pitch);
  ok('同一個排列：自動間距排出來的 6 顆全部在焊盤內、離邊緣 ≥ 0.25', V.check(d, pts).nOut === 0 && V.check(d, pts).nEdge === 0, { g });
  const d10 = base({ n: 10, L: 6, W: 6 });
  const p10 = V.layout(d10, 0.8);
  const ys = [...new Set(p10.map(q => q.y.toFixed(6)))];
  const lastRow = p10.filter(q => q.y.toFixed(6) === ys[ys.length - 1]);
  ok('最後一列不滿時置中（舊版靠左）', near(lastRow.reduce((s, q) => s + q.x, 0) / lastRow.length, 0, 1e-9), lastRow);
  ok('整個排列以焊盤中心為中心', near(Math.max(...p10.map(q => q.y)) + Math.min(...p10.map(q => q.y)), 0, 1e-9));
  const st = base({ n: 12, L: 6, W: 6, pattern: 'staggered' });
  const ps = V.layout(st, 1);
  const rowsY = [...new Set(ps.map(q => q.y.toFixed(6)))].map(Number).sort((a, b) => a - b);
  ok('交錯排列：列距 = p·√3/2', near(rowsY[1] - rowsY[0], Math.sqrt(3) / 2, 1e-5), rowsY);
  const c = V.check(st, ps);
  ok('交錯排列：最近中心距 = p（六角晶格）', near(c.minDist, 1, 1e-9), c.minDist);
  const ci = { shape: 'circle', D: 3, pattern: 'matrix', n: 4, dia: 0.2, plating: 0.0254, t: 1.6, kFill: 0.026 };
  const pc = V.layout(ci, 0.5);
  ok('圓形焊盤 4 顆排成 2×2 對稱（舊版是中心＋3 顆）', pc.length === 4 && pc.every(q => near(Math.abs(q.x), 0.25, 1e-9) && near(Math.abs(q.y), 0.25, 1e-9)), pc);
  ok('單顆放在中心', JSON.stringify(V.layout(base({ n: 1 }), 0)) === JSON.stringify([{ x: 0, y: 0 }]));
}

console.log('\n[D] 自動間距');
{
  const cases = [
    ['矩形 5×5、9 顆', base()],
    ['長條 9.8×4.8、20 顆', base({ L: 9.8, W: 4.8, n: 20 })],
    ['交錯 6×6、10 顆', base({ L: 6, W: 6, n: 10, pattern: 'staggered' })],
    ['交錯 8.6×8.6、134 顆', base({ L: 8.6, W: 8.6, n: 134, pattern: 'staggered' })],
    ['圓形 D6、20 顆', base({ shape: 'circle', D: 6, n: 20 })],
    ['圓形交錯 D4、7 顆', base({ shape: 'circle', D: 4, n: 7, pattern: 'staggered' })],
    ['小焊盤 1.6×1.6、9 顆', base({ L: 1.6, W: 1.6 })],
  ];
  cases.forEach(([name, d]) => {
    const a = V.autoPitch(d);
    const c = a.ok ? V.check(d, V.layout(d, a.pitch)) : null;
    // 邊距剛好卡在 0.25 → 至少有一顆貼著邊距線（最大間距）
    const tight = c && Math.min(...c.pts.map(q => q.margin));
    ok(`${name}：排得下、沒有孔壁越過 0.25 mm 線、沒有重疊，且是最大間距`, a.ok && c.nOut === 0 && c.nEdge === 0 && c.nOverlap === 0 && near(tight, 0.25, 1e-6), { a, tight });
    // 取整後仍排得下
    const pf = V.floorTo(V.mmToMil(a.pitch), 0.1) * MIL;
    const c2 = V.check(d, V.layout(d, pf));
    ok(`${name}：往下取整到 0.1 mil 後仍排得下`, c2.nOut === 0 && c2.nEdge === 0);
  });
  // 舊版：中心放在距邊 0.25 mm 線上（不計孔壁）→ 用舊版算法的間距，孔壁會越線
  const d = base();
  const padL = d.L - 0.5, oldPitch = padL / 2;
  const cOld = V.check(d, V.layout(d, oldPitch));
  ok('（對照：舊版的自動間距讓孔壁越過 0.25 mm 線）', cOld.nEdge > 0, cOld.nEdge);
  const big = base({ L: 1.6, W: 1.6, n: 30 });
  const a = V.autoPitch(big);
  ok('放不下 → ok:false', !a.ok, a);
  const mx = V.maxCount(big);
  ok('最多可放的顆數：以 2 倍內徑為最小中心距時剛好排得下、再多一顆就排不下', mx === 9 &&
    V.autoPitch(base({ L: 1.6, W: 1.6, n: mx })).pitch >= 2 * big.dia - 1e-6 &&
    !(V.autoPitch(base({ L: 1.6, W: 1.6, n: mx + 1 })).pitch >= 2 * big.dia - 1e-6), mx);
  ok('單顆：不需要間距（舊版跳「Pad 尺寸過小」）', V.autoPitch(base({ n: 1 })).single === true);
  ok('自動間距 < 2 倍內徑時標 dfmTight', V.autoPitch(base({ L: 1.4, W: 1.4, n: 9 })).dfmTight === true, V.autoPitch(base({ L: 1.4, W: 1.4, n: 9 })));
}

console.log('\n[E] 檢查');
{
  const d = base();
  const over = V.check(d, V.layout(d, 3));
  ok('間距太大 → 外圈孔壁超出焊盤（錯誤）', over.nOut === 8, over.nOut);
  const tightP = V.check(d, V.layout(d, 0.2));
  ok('間距 < 孔外徑 → 孔壁重疊（錯誤）', tightP.nOverlap === 9, tightP.nOverlap);
  const dfm = V.check(d, V.layout(d, 0.3));
  ok('孔外徑 ≤ 中心距 < 2 倍內徑 → 不算重疊、標「間距 < 2 倍孔徑」提醒', dfm.nOverlap === 0 && dfm.dfmTight === true, dfm);
  const ok16 = V.check(d, V.layout(d, 16 * MIL));
  ok('16 mil 間距（剛好 2 倍）不提醒', ok16.dfmTight === false && ok16.nOut === 0 && ok16.nOverlap === 0, ok16);
  const edge = V.check(d, V.layout(d, 2.2));
  ok('孔壁在焊盤內但離邊緣 < 0.25 → 提醒（不算超出）', edge.nOut === 0 && edge.nEdge === 8, edge);
  const ci = { shape: 'circle', D: 3, pattern: 'matrix', n: 9, dia: 0.2, plating: 0.0254, t: 1.6, kFill: 0.026 };
  ok('圓形：以到圓心距離判定超出', V.check(ci, V.layout(ci, 1.4)).nOut > 0 && V.check(ci, V.layout(ci, 0.5)).nOut === 0);
}

console.log('\n[F] missing()');
{
  ok('齊全 → []', V.missing(base()).length === 0);
  ok('缺尺寸／數量／內徑／間距／厚度／塞孔', JSON.stringify(V.missing(base({ L: null, n: null, dia: null, pitch: null, t: null, kFill: null })))
    === JSON.stringify(['pad', 'n', 'dia', 't', 'fill']), V.missing(base({ L: null, n: null, dia: null, pitch: null, t: null, kFill: null })));
  ok('數量不是整數 → 缺 n', V.missing(base({ n: 9.5 })).includes('n'));
  ok('數量 > 1 沒有間距 → 缺 pitch；單顆不需要', V.missing(base({ pitch: null })).includes('pitch') && !V.missing(base({ n: 1, pitch: null })).includes('pitch'));
  ok('圓形：沒有直徑 → 缺 pad', V.missing(base({ shape: 'circle', D: null })).includes('pad'));
}

console.log('\n[G] keffForComp');
{
  const GP = { t_PCB: 2, K_Via: 30, Via_Eff: 0.9 };
  const U850 = () => ({ Component: 'U850-Si5518', TV_Qty: 134, TV_ID_mil: 8, Board_Type: 'Thermal Via', Pad_L: 8.6, Pad_W: 8.6 });
  const SPECS = () => ({ 'U850-Si5518': { epadSize: '8.6×8.6', via: { fill: 'epoxy', pitchMil: 28 } } });
  const r = V.keffForComp(U850(), SPECS(), GP);
  ok('完整設計 → ok、K_eff 13.114 W/m·K（prompt 驗算用例）', r.ok && r.keff.toFixed(3) === '13.114' && !r.reason, r);
  ok('A_pad = 8.6 × 8.6 = 73.96 mm²', near(r.aPad, 73.96, 1e-9), r.aPad);
  ok('R_int = t ÷ (K_eff × A_pad)（2 mm → 2.062 °C/W）＝ calc 的 R_th', near(V.rint(r, 2), 2 / (r.keff * 73.96) * 1000, 1e-12) && V.rint(r, 2).toFixed(3) === '2.062'
    && near(V.rint(r, 2), V.calc(base({ L: 8.6, W: 8.6, n: 134, kFill: 2, t: 2 })).rth, 1e-9), V.rint(r, 2));
  ok('rint：不 ok → NaN（不偷偷當 0）', isNaN(V.rint({ ok: false }, 2)) && isNaN(V.rint(null, 2)));
  ok('與板厚無關（t_PCB 1.6 或沒有 t_PCB 都一樣）', near(V.keffForComp(U850(), SPECS(), { t_PCB: 1.6 }).keff, r.keff) && V.keffForComp(U850(), SPECS(), {}).ok
    && near(V.keffForComp(U850(), SPECS(), {}).keff, r.keff), null);
  const sp2 = SPECS(); sp2['U850-Si5518'].via.pitchMil = 12;
  ok('與中心間距無關（間距只影響配置檢查）', near(V.keffForComp(U850(), sp2, GP).keff, r.keff));
  ok('來源標示：E-PAD／數量／內徑取 EE 清單／鍍銅預設', r.src.pad === 'epad' && r.src.qty === 'ee' && r.src.dia === 'ee' && r.src.plating === 'default', r.src);
  ok('配置正常（28 mil）→ 沒有 issues', r.issues.length === 0, r.issues);

  const nd = V.keffForComp(U850(), {}, GP);
  ok('沒有 thermal_specs → reason nodata', !nd.ok && nd.reason === 'nodata' && /沒有這顆的 via 設計/.test(V.reasonText(nd)), nd);
  ok('有 spec 但沒有 via（或 via 是空物件）→ nodata', V.keffForComp(U850(), { 'U850-Si5518': { epadSize: '8.6×8.6' } }, GP).reason === 'nodata'
    && V.keffForComp(U850(), { 'U850-Si5518': { epadSize: '8.6×8.6', via: {} } }, GP).reason === 'nodata');
  const sp3 = SPECS(); delete sp3['U850-Si5518'].via.fill;
  const mf = V.keffForComp(U850(), sp3, GP);
  ok('缺塞孔材料 → reason missing、missing=[fill]、文字寫「缺：塞孔材料」', !mf.ok && mf.reason === 'missing' && JSON.stringify(mf.missing) === '["fill"]'
    && V.reasonText(mf) === 'via 設計還缺：塞孔材料', { mf, t: V.reasonText(mf) });
  const sp4 = SPECS(); sp4['U850-Si5518'].via.fill = 'custom';
  ok('塞孔自訂 K 但沒填 K → 缺塞孔材料', V.keffForComp(U850(), sp4, GP).reason === 'missing');
  sp4['U850-Si5518'].via.fillK = 3;
  ok('自訂 K = 3 → ok', V.keffForComp(U850(), sp4, GP).ok && V.keffForComp(U850(), sp4, GP).kFill === 3);
  const sp5 = SPECS(); sp5['U850-Si5518'].via.skip = true; sp5['U850-Si5518'].via.skipNote = '規格溫度很高';
  const sk = V.keffForComp(U850(), sp5, GP);
  ok('勾了暫不納入熱流評估 → reason skip（資料完整也不用）', !sk.ok && sk.reason === 'skip' && /暫不納入熱流評估/.test(V.reasonText(sk)) && /規格溫度很高/.test(V.reasonText(sk)), sk);
  const ov = V.keffForComp(Object.assign(U850(), { TV_Qty: 200 }), { 'U850-Si5518': { epadSize: '1.6×1.6', via: { fill: 'air' } } }, GP);
  ok('via 面積 > 焊盤 → reason over、文字寫出百分比', !ov.ok && ov.reason === 'over' && /超過焊盤/.test(V.reasonText(ov)) && /\d+%/.test(V.reasonText(ov)), { ov, t: V.reasonText(ov) });

  // _renamed_from：5G-RRU 改了名、AI-Thermal 還沒把 thermal_specs 搬到新名稱
  const ren = Object.assign(U850(), { Component: 'U850-Si5518-NEW', _renamed_from: 'U850-Si5518' });
  const rr = V.keffForComp(ren, SPECS(), GP);
  ok('_renamed_from 查得到舊名稱的 spec → ok、標 renamed', rr.ok && rr.renamed && rr.key === 'U850-Si5518' && near(rr.keff, r.keff), rr);
  const both = SPECS(); both['U850-Si5518-NEW'] = { epadSize: '8.6×8.6', via: { fill: 'copper', pitchMil: 28 } };
  ok('新名稱已有 spec → 用新名稱的（不看舊名稱）', V.keffForComp(ren, both, GP).key === 'U850-Si5518-NEW' && !V.keffForComp(ren, both, GP).renamed);
  ok('名稱有空白／斜線 → 照 sgSpecKey 規則找', V.keffForComp(Object.assign(U850(), { Component: 'Q1 A/B' }), { 'Q1_A-B': SPECS()['U850-Si5518'] }, GP).ok);

  // E-PAD fallback：TH/ME 頁沒填 → 5G-RRU 的 Pad_L/Pad_W（Board_Type = Thermal Via 或 _pad_from = epadSize）
  const fb = V.keffForComp(U850(), { 'U850-Si5518': { via: { fill: 'epoxy', pitchMil: 28 } } }, GP);
  ok('epadSize 空白、Board_Type Thermal Via → 用 Pad_L × Pad_W', fb.ok && fb.src.pad === 'rru' && near(fb.aPad, 73.96, 1e-9), fb);
  const fb2 = V.keffForComp(Object.assign(U850(), { Board_Type: 'Copper Coin', _pad_from: 'epadSize' }), { 'U850-Si5518': { via: { fill: 'epoxy' } } }, GP);
  ok('_pad_from = epadSize 也可以', fb2.ok && fb2.src.pad === 'rru', fb2);
  const fb3 = V.keffForComp(Object.assign(U850(), { Board_Type: 'IC top' }), { 'U850-Si5518': { via: { fill: 'epoxy' } } }, GP);
  ok('導熱方式不是 Thermal Via、也沒有 _pad_from → 不用 Pad_L/W（缺 E-PAD 尺寸）', !fb3.ok && fb3.reason === 'missing' && fb3.missing.includes('pad') && /E-PAD 尺寸/.test(V.reasonText(fb3)), fb3);
  const fb4 = V.keffForComp(U850(), { 'U850-Si5518': { epadSize: 'abc', via: { fill: 'epoxy' } } }, GP);
  ok('epadSize 填了但看不懂 → 不 fallback（缺 E-PAD 尺寸）', fb4.reason === 'missing' && fb4.missing.includes('pad'), fb4);

  // N/A／空白／0 當沒填
  const na = V.keffForComp(Object.assign(U850(), { TV_Qty: 'N/A', TV_ID_mil: ' n/a ' }), SPECS(), GP);
  ok('TV_Qty／TV_ID_mil 是 N/A → 缺 Via 數量、Via 內徑', na.reason === 'missing' && JSON.stringify(na.missing) === '["n","dia"]' && V.reasonText(na) === 'via 設計還缺：Via 數量、Via 內徑', na);
  ok('空白／0 也當沒填', V.keffForComp(Object.assign(U850(), { TV_Qty: '', TV_ID_mil: 0 }), SPECS(), GP).reason === 'missing');
  ok('tvNum：N/A、空白、0、負數 → null；"8" → 8', V.tvNum('N/A') === null && V.tvNum('') === null && V.tvNum(0) === null && V.tvNum(-1) === null && V.tvNum('8') === 8 && V.tvNum(undefined) === null);

  // 試算值：via.qty／via.diaMil 有 key 就用它（與 AI-Thermal 頁面上看到的 K_eff 一致）
  const tr = SPECS(); tr['U850-Si5518'].via.qty = 100; tr['U850-Si5518'].via.diaMil = 10;
  const trr = V.keffForComp(U850(), tr, GP);
  const exp = V.calc(base({ L: 8.6, W: 8.6, n: 100, dia: 10 * MIL, kFill: 2, t: 2 }));
  ok('試算值優先（100 顆 10 mil），並記下 EE 清單的值', trr.ok && near(trr.keff, exp.keff, 1e-12) && trr.src.qty === 'via' && trr.src.dia === 'via' && trr.srcQty === 134 && trr.srcDia === 8, trr);
  const tr2 = SPECS(); tr2['U850-Si5518'].via.qty = 134; tr2['U850-Si5518'].via.plating = 0.035;
  ok('鍍銅厚度有 key → 用它（35 µm）', V.keffForComp(U850(), tr2, GP).plating === 0.035 && V.keffForComp(U850(), tr2, GP).src.plating === 'via');

  // 配置問題：K_eff 照算（ok），列在 issues
  const np = SPECS(); delete np['U850-Si5518'].via.pitchMil;
  const npr = V.keffForComp(U850(), np, GP);
  ok('沒填中心間距 → 仍 ok，issues 寫「沒填中心間距」', npr.ok && npr.issues.length === 1 && npr.issues[0].code === 'nopitch', npr.issues);
  const big = SPECS(); big['U850-Si5518'].via.pitchMil = 60;
  const bigr = V.keffForComp(U850(), big, GP);
  ok('間距太大 → 孔壁超出焊盤：仍 ok，issues 有 err/out', bigr.ok && bigr.issues.some(i => i.lv === 'err' && i.code === 'out'), bigr.issues);
  const ovl = SPECS(); ovl['U850-Si5518'].via.pitchMil = 8;
  ok('間距 < 孔外徑 → 孔壁重疊：仍 ok，issues 有 err/overlap', V.keffForComp(U850(), ovl, GP).issues.some(i => i.code === 'overlap'));
  ok('單顆不需要間距 → 沒有 nopitch', V.keffForComp(Object.assign(U850(), { TV_Qty: 1 }), np, GP).issues.length === 0);
  const many = SPECS(); many['U850-Si5518'].epadSize = '200×200'; many['U850-Si5518'].via.qty = 5000;
  ok('數量 > 2000 → 不排列、issues 寫「太多」', V.keffForComp(U850(), many, GP).issues.some(i => i.code === 'many'));

  // 圓形焊盤
  const ci = V.keffForComp(U850(), { 'U850-Si5518': { via: { shape: 'circle', padD: 9, fill: 'solder', pitchMil: 28 } } }, GP);
  ok('圓形焊盤：A_pad = π·(D/2)²、src.pad = circle', ci.ok && near(ci.aPad, Math.PI * 4.5 * 4.5, 1e-9) && ci.src.pad === 'circle', ci);
  ok('圓形焊盤沒填直徑 → 文字寫「焊盤直徑」', V.reasonText(V.keffForComp(U850(), { 'U850-Si5518': { via: { shape: 'circle', fill: 'air' } } }, GP)) === 'via 設計還缺：焊盤直徑');

  ok('沒有元件／沒有 specs 也不丟例外', V.keffForComp(null, null, null).reason === 'nodata' && V.keffForComp({}, undefined).reason === 'nodata');
  ok('reasonText(ok) → 空字串', V.reasonText(r) === '');
}

console.log('\n[H] resolve／parseLW／specKey 與 AI-Thermal 頁面原本的寫法相同');
{
  ok('parseLW：8.6*8.6、9.8x4.8、3 X 2.5、單一數字＝正方形、看不懂 → null',
    JSON.stringify(V.parseLW('8.6*8.6')) === '{"L":8.6,"W":8.6}' && JSON.stringify(V.parseLW('9.8x4.8')) === '{"L":9.8,"W":4.8}'
    && JSON.stringify(V.parseLW('3 X 2.5')) === '{"L":3,"W":2.5}' && JSON.stringify(V.parseLW('5')) === '{"L":5,"W":5}'
    && V.parseLW('abc') === null && V.parseLW('') === null && V.parseLW(null) === null);
  ok('specKey：空白 → _、/ → -', V.specKey('Q1 A/B C') === 'Q1_A-B_C' && V.specKey(null) === '');
  const r = V.resolve({ TV_Qty: 9, TV_ID_mil: 8 }, { epadSize: '1.6*1.6', via: { pcbT: 1.2, pitchMil: 20, pattern: 'staggered' } }, { t_PCB: 1.6 });
  ok('resolve：板厚頁面指定優先、間距換成 mm、交錯排列、塞孔沒選 → kFill null', r.t === 1.2 && r.tLocal && r.srcT === 1.6 && near(r.d.pitch, 20 * MIL, 1e-12)
    && r.d.pattern === 'staggered' && r.d.kFill === null && r.fill === null && r.platingDefault && r.d.plating === V.PLATING_DEFAULT, r);
  ok('resolve：沒有 spec／沒有元件也不丟例外', V.resolve(null, null, null).d.n === null);
}

console.log(`\n結果：${pass} 通過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
