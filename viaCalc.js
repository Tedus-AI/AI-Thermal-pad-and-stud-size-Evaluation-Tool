/* viaCalc.js — Thermal Via 等效 K 值計算（純函式，畫面、匯出與測試共用）
 *
 * 原本是獨立的 thermal-via-calculator 工具（本機 localStorage／Firebase 各自存），移植成本工具的
 * 「Thermal Via 計算」頁之後，資料改存進專案（thermal_specs[元件].via），計算核心放在這裡。
 *
 * 模型（一維、穿板方向、面積加權並聯）：
 *   焊盤（E-PAD）面積 A_pad 內，N 顆 via 各自由「銅壁（鍍銅環）＋孔內塞孔材料」組成，其餘是 FR4：
 *     r_in  = 內徑 / 2（成品孔徑，Layout 上標的那個孔徑）
 *     r_out = r_in + 鍍銅厚度
 *     A_fill = π·r_in²、A_cu = π·r_out² − A_fill、A_foot = π·r_out²
 *     A_fr4  = A_pad − N·A_foot
 *     K_eff  = (N·A_cu·K_Cu + N·A_fill·K_fill + A_fr4·K_FR4) / A_pad        [W/m·K]
 *     R_th   = t / (K_eff · A_pad)                                           [°C/W]（t、A 用 mm → ×1000）
 *   ⚠ 中心間距不出現在公式裡：間距只決定「排不排得下、會不會干涉」，不影響 K_eff。
 *   ⚠ 不含銅層的橫向擴散、焊錫層、via 空洞；是穿板方向的一維估算。
 *
 * 修正（相對於舊版獨立工具）：
 *   - 「自動計算間距」與「畫圖」原本各用一套行列數公式（rows/cols 取法相反），可能算出一個畫起來
 *     超出焊盤的間距 → 改成同一個 grid() 決定排列，自動間距直接由同一個排列反推（必定排得下）。
 *   - 自動間距原本沒算交錯排列的列距（√3/2）與錯位半格，交錯排列時會超出焊盤 → 納入。
 *   - 自動間距原本把 via「中心」放在距邊 0.25 mm 的線上，孔壁其實已經越線 → 邊距改以孔壁（r_out）計。
 *   - 數量 = 1 時原本跳「Pad 尺寸過小」（訊息錯誤，且單顆不需要間距）→ 單顆直接放中心。
 *   - 最後一列不滿時原本靠左排（不對稱）→ 置中。
 *   - via 總佔用面積超過焊盤時原本照算（FR4 面積夾成 0、銅與塞孔照加 → K_eff 被高估）→ 判定為不成立。
 *   - 圓形焊盤偶數顆時原本一律「中心放一顆」（4 顆會排成中心＋3 顆）→ 改挑最緊湊的晶格偏移。
 *   - 干涉檢查原本用「2 倍內徑」當孔環直徑判定重疊（紅色錯誤）→ 拆成：孔壁真的重疊＝錯誤；
 *     中心距 < 2 倍內徑＝常見加工下限的提醒（琥珀色）。
 */
(function (root) {
  'use strict';

  var K_CU = 385;          // 銅 W/m·K
  var K_FR4 = 0.3;         // FR4 穿板方向 W/m·K
  var EDGE = 0.25;         // 孔壁到焊盤邊緣的最小距離 mm
  var MIL = 0.0254;        // 1 mil = 0.0254 mm
  var HEX = Math.sqrt(3) / 2;
  var EPS = 1e-9;

  // 塞孔材料。舊版只有前三種；電鍍填銅（VIPPO／copper filled via）在 RRU 功放板常見，K 就是銅。
  var FILLS = [
    { key: 'air',    label: '空氣（未塞孔）',       k: 0.026 },
    { key: 'epoxy',  label: '導熱膠／樹脂（Epoxy）', k: 2.0 },
    { key: 'solder', label: '錫膏（Solder）',        k: 50 },
    { key: 'copper', label: '電鍍填銅（Cu fill）',   k: K_CU },
    { key: 'custom', label: '自訂 K 值' },
  ];
  // 鍍銅厚度（mm）＝孔壁電鍍銅（barrel plating），不是表層銅箔。IPC-6012 通孔孔銅平均下限：
  // Class 2 20 µm（最薄處 18）、Class 3 25 µm（最薄處 20）。沒選＝預設 1 mil（≈ Class 3）。
  // ⚠ 舊工具標成「1 oz（35 µm）」：oz 是銅箔重量的說法、容易誤以為要填表層銅厚 → 改標成「加厚孔銅」（值不變，舊資料照讀）
  var PLATINGS = [
    { mm: 0.020,  label: '20 µm（IPC Class 2 平均）' },
    { mm: 0.0254, label: '25.4 µm／1 mil（≈ IPC Class 3）' },
    { mm: 0.035,  label: '35 µm（加厚孔銅）' },
  ];
  var PLATING_DEFAULT = 0.0254;

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = typeof v === 'number' ? v : parseFloat(String(v).trim());
    return isFinite(n) ? n : null;
  }
  function pos(v) { var n = num(v); return (n !== null && n > 0) ? n : null; }
  function fillOf(key) { for (var i = 0; i < FILLS.length; i++) if (FILLS[i].key === key) return FILLS[i]; return null; }

  /* d（全部 mm）：{ shape:'rect'|'circle', L, W, D, pattern:'matrix'|'staggered', n, dia, pitch, t, plating, kFill, edge } */
  function rOut(d) { return d.dia / 2 + d.plating; }
  function edgeOf(d) { return (d.edge === undefined || d.edge === null) ? EDGE : d.edge; }
  function isCircle(d) { return d.shape === 'circle'; }
  function padArea(d) {
    if (isCircle(d)) return d.D > 0 ? Math.PI * Math.pow(d.D / 2, 2) : 0;
    return (d.L > 0 && d.W > 0) ? d.L * d.W : 0;
  }

  /* 缺哪些輸入（計算需要的最小集合）。回傳 key 陣列：pad／n／dia／pitch（n > 1 才需要）／t／plating／fill */
  function missing(d) {
    var m = [];
    if (!(padArea(d) > 0)) m.push('pad');
    if (!(d.n >= 1 && Math.floor(d.n) === d.n)) m.push('n');
    if (!(d.dia > 0)) m.push('dia');
    if (d.n > 1 && !(d.pitch > 0)) m.push('pitch');
    if (!(d.t > 0)) m.push('t');
    if (!(d.plating > 0)) m.push('plating');
    if (!(d.kFill > 0)) m.push('fill');
    return m;
  }

  /* 等效 K 與熱阻。輸入不齊回 { ok:false, reason:'missing' }；via 佔用面積超過焊盤回 reason:'over' */
  function calc(d) {
    if (missing(d).filter(function (k) { return k !== 'pitch'; }).length) return { ok: false, reason: 'missing' };
    var aPad = padArea(d), ri = d.dia / 2, ro = rOut(d);
    var aFill = Math.PI * ri * ri, aFoot = Math.PI * ro * ro, aCu = aFoot - aFill;
    var footRatio = d.n * aFoot / aPad;
    var base = { aPad: aPad, aCu1: aCu, aFill1: aFill, aFoot1: aFoot, footRatio: footRatio,
                 rthFr4: d.t / (K_FR4 * aPad) * 1000 };
    if (footRatio > 1 + EPS) return Object.assign({ ok: false, reason: 'over' }, base);
    var aFr4 = Math.max(0, aPad - d.n * aFoot);
    var keff = (d.n * aCu * K_CU + d.n * aFill * d.kFill + aFr4 * K_FR4) / aPad;
    return Object.assign(base, {
      ok: true,
      keff: keff,
      rth: d.t / (keff * aPad) * 1000,                         // °C/W
      cuRatio: d.n * aCu / aPad,
      singleR: d.t / (aCu * K_CU + aFill * d.kFill) * 1000,    // 單顆 via（銅壁＋塞孔並聯）°C/W
      aFr4: aFr4,
    });
  }

  /* ── 排列 ────────────────────────────────────────────────────────────
     矩形焊盤：cols 沿 L（x）、rows 沿 W（y）。挑「可達到的最大間距」最大的行列數（同分取空位少的），
     與使用者填的間距無關 → 自動間距與畫圖永遠是同一個排列。 */
  function spanUnits(cols, rows, stag) {
    return { x: (cols - 1) + (stag && rows > 1 ? 0.5 : 0), y: (rows - 1) * (stag ? HEX : 1) };
  }
  function grid(d) {
    var n = Math.max(1, Math.floor(d.n || 1));
    if (n === 1) return { cols: 1, rows: 1 };
    var stag = d.pattern === 'staggered';
    var m = edgeOf(d) + rOut(d);
    var uL = d.L - 2 * m, uW = d.W - 2 * m;
    var best = null;
    for (var c = 1; c <= n; c++) {
      var r = Math.ceil(n / c);
      var s = spanUnits(c, r, stag);
      var p = Math.min(s.x > 0 ? uL / s.x : Infinity, s.y > 0 ? uW / s.y : Infinity);
      var empty = c * r - n;
      if (!best || p > best.p + EPS || (Math.abs(p - best.p) <= EPS && empty < best.empty)) {
        best = { cols: c, rows: r, p: p, empty: empty };
      }
    }
    return { cols: best.cols, rows: best.rows };
  }

  function layoutRect(d, p) {
    var n = Math.max(1, Math.floor(d.n || 1));
    var g = grid(d), stag = d.pattern === 'staggered';
    var dy = p * (stag ? HEX : 1), pts = [];
    for (var row = 0; row < g.rows; row++) {
      var k = Math.min(g.cols, n - row * g.cols);
      if (k <= 0) break;
      // 不滿的一列置中；交錯排列只能整格位移（否則破壞六角晶格）
      var shift = stag ? Math.floor((g.cols - k) / 2) * p : (g.cols - k) / 2 * p;
      var off = (stag && row % 2 === 1) ? p / 2 : 0;
      for (var i = 0; i < k; i++) pts.push({ x: i * p + shift + off, y: row * dy });
    }
    return center(pts);
  }
  function center(pts) {
    if (!pts.length) return pts;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach(function (q) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); });
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return pts.map(function (q) { return { x: q.x - cx, y: q.y - cy }; });
  }

  /* 圓形焊盤：晶格上離中心最近的 n 個點。試幾種晶格偏移（中心放一顆／中心是空隙），挑最緊湊的。
     晶格隨 p 等比縮放 → 選到的點集合與 p 無關，自動間距可以直接反推。 */
  function layoutCircle(d, p) {
    var n = Math.max(1, Math.floor(d.n || 1));
    var stag = d.pattern === 'staggered';
    var dy = p * (stag ? HEX : 1);
    var offs = stag ? [[0, 0], [p / 2, 0], [p / 2, dy / 3]] : [[0, 0], [p / 2, 0], [0, p / 2], [p / 2, p / 2]];
    var need = Math.sqrt(n * p * dy / Math.PI) + 2 * p;     // 夠涵蓋 n 個點的半徑
    var rows = Math.ceil(need / dy) + 1, cols = Math.ceil(need / p) + 1;
    var best = null;
    offs.forEach(function (o) {
      var cand = [];
      for (var r = -rows; r <= rows; r++) {
        for (var c = -cols; c <= cols; c++) {
          var x = c * p + ((stag && Math.abs(r) % 2 === 1) ? p / 2 : 0) - o[0];
          var y = r * dy - o[1];
          cand.push({ x: x, y: y, dist: Math.sqrt(x * x + y * y), ang: Math.atan2(y, x) });
        }
      }
      cand.sort(function (a, b) { return (a.dist - b.dist) || (a.ang - b.ang); });
      var pick = cand.slice(0, n);
      var far = pick.length ? pick[pick.length - 1].dist : 0;
      var sum = pick.reduce(function (s, q) { return s + q.dist; }, 0);
      if (!best || far < best.far - EPS || (Math.abs(far - best.far) <= EPS && sum < best.sum - EPS)) {
        best = { far: far, sum: sum, pts: pick.map(function (q) { return { x: q.x, y: q.y }; }) };
      }
    });
    return best ? best.pts : [];
  }

  function layout(d, p) {
    var n = Math.max(1, Math.floor(d.n || 1));
    if (n === 1) return [{ x: 0, y: 0 }];
    if (!(p > 0)) return [];
    return isCircle(d) ? layoutCircle(d, p) : layoutRect(d, p);
  }

  /* 檢查：每顆 via 的孔壁有沒有超出焊盤（錯誤）、離邊緣 < EDGE（提醒）、孔壁互相重疊（錯誤）；
     最近中心距 < 2 倍內徑（常見加工下限，提醒） */
  function check(d, pts) {
    var ro = rOut(d), e = edgeOf(d), R = (d.D || 0) / 2;
    var out = pts.map(function (q) {
      var margin = isCircle(d) ? R - (Math.sqrt(q.x * q.x + q.y * q.y) + ro)
                               : Math.min(d.L / 2 - (Math.abs(q.x) + ro), d.W / 2 - (Math.abs(q.y) + ro));
      return { x: q.x, y: q.y, margin: margin, out: margin < -EPS, edge: margin >= -EPS && margin < e - 1e-6, overlap: false };
    });
    var minDist = Infinity;
    for (var i = 0; i < out.length; i++) {
      for (var j = i + 1; j < out.length; j++) {
        var dd = Math.sqrt(Math.pow(out[i].x - out[j].x, 2) + Math.pow(out[i].y - out[j].y, 2));
        if (dd < minDist) minDist = dd;
        if (dd < 2 * ro - 1e-6) { out[i].overlap = true; out[j].overlap = true; }
      }
    }
    var cnt = function (k) { return out.filter(function (q) { return q[k]; }).length; };
    return {
      pts: out, nOut: cnt('out'), nEdge: cnt('edge'), nOverlap: cnt('overlap'),
      minDist: out.length > 1 ? minDist : null,
      dfmTight: out.length > 1 && minDist < 2 * d.dia - 1e-6,
    };
  }

  /* 自動間距：同一個排列下，所有孔壁都離邊緣 ≥ EDGE 的最大中心距（mm）。
     排列隨 p 等比縮放 → 直接反推，不用試誤。放不下（連孔壁相切都塞不進）回 ok:false。 */
  function autoPitch(d) {
    var n = Math.max(1, Math.floor(d.n || 1));
    if (n === 1) return { ok: true, single: true, pitch: null };
    var ro = rOut(d), e = edgeOf(d);
    var unit = layout(d, 1);
    var p;
    if (isCircle(d)) {
      var far = 0;
      unit.forEach(function (q) { far = Math.max(far, Math.sqrt(q.x * q.x + q.y * q.y)); });
      p = far > 0 ? (d.D / 2 - e - ro) / far : Infinity;
    } else {
      var hx = 0, hy = 0;
      unit.forEach(function (q) { hx = Math.max(hx, Math.abs(q.x)); hy = Math.max(hy, Math.abs(q.y)); });
      p = Math.min(hx > 0 ? (d.L / 2 - e - ro) / hx : Infinity, hy > 0 ? (d.W / 2 - e - ro) / hy : Infinity);
    }
    if (!(p >= 2 * ro - 1e-6) || !isFinite(p)) return { ok: false, pitch: null };
    return { ok: true, pitch: p, dfmTight: p < 2 * d.dia - 1e-6 };
  }

  /* 在「中心距 ≥ max(2 倍內徑, 孔壁相切)」且邊距足夠的條件下，最多放得下幾顆（自動間距放不下時給使用者參考） */
  function maxCount(d) {
    var ro = rOut(d), minP = Math.max(2 * d.dia, 2 * ro);
    var aPad = padArea(d);
    if (!(aPad > 0) || !(minP > 0)) return 0;
    var cap = Math.min(2000, Math.ceil(aPad / (minP * minP * HEX)) + 4);
    var best = 0;
    for (var n = 1; n <= cap; n++) {
      var dn = Object.assign({}, d, { n: n });
      if (n === 1) {
        if (check(dn, [{ x: 0, y: 0 }]).nOut === 0) best = 1; else break;
        continue;
      }
      var a = autoPitch(dn);
      if (a.ok && a.pitch >= minP - 1e-6) best = n;
    }
    return best;
  }

  /* 單位換算（顯示用） */
  function milToMm(v) { return v * MIL; }
  function mmToMil(v) { return v / MIL; }
  /* 自動間距寫回時往下取整（mil 取 0.1、mm 取 0.001），保證仍然排得下 */
  function floorTo(v, step) { return Math.floor(v / step + 1e-9) * step; }

  var api = {
    K_CU: K_CU, K_FR4: K_FR4, EDGE: EDGE, MIL: MIL, HEX: HEX,
    FILLS: FILLS, PLATINGS: PLATINGS, PLATING_DEFAULT: PLATING_DEFAULT,
    num: num, pos: pos, fillOf: fillOf,
    padArea: padArea, rOut: rOut, missing: missing, calc: calc,
    grid: grid, layout: layout, check: check, autoPitch: autoPitch, maxCount: maxCount,
    milToMm: milToMm, mmToMil: mmToMil, floorTo: floorTo,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ViaCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
