/* viaCalc.js — Thermal Via 等效 K 值計算（純函式，畫面、匯出與測試共用）
 *
 * ⚠ 本檔與 tests/via-calc.unit.test.js 在 AI-Thermal 與 5G-RRU 兩個 repo 內容逐字相同（同 compMerge.js），
 *   改一邊就同步另一邊：AI-Thermal 的 Thermal Via 計算頁與 5G-RRU 的基板熱阻 R_int 用同一份算法，
 *   各自從資料庫的原始輸入（thermal_specs[元件].via＋元件欄位）當場算，不存結果（見 keffForComp）。
 *   熱網路工具（RRU-Thermal-Network-Visualizer）02 匯入 AI-Thermal 專案時也放了一份逐字相同的副本，
 *   用 keffForComp 把 via 設計換成「自訂導熱孔 K」。
 *   板厚（只影響 R_th，不影響 K_eff）：本頁指定 → AI-Thermal 該分類的 PCB 板厚（pcb_thickness，見 pcbOf）
 *   → 5G-RRU 專案參數 t_PCB。
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

  /* ── 從資料庫的原始輸入解析一顆元件的 via 設計（兩個工具共用）──────────────────
     資料在同一個專案 document：thermal_specs[specKey(元件名)]（AI-Thermal TH/ME 頁＋Thermal Via 計算頁寫）
     ＋元件物件（rf_data／digital_data／pwr_data：TV_Qty、TV_ID_mil、Board_Type、Pad_L/W、_pad_from、_renamed_from）
     ＋pcb_thickness[RF|Digital|PWR]（AI-Thermal EE/RF/PWR 頁三個分類標題列的 PCB 板厚，板厚的主要來源）
     ＋global_params.t_PCB（5G-RRU 參數控制台寫，該分類沒有設定板厚時才用）。這裡只讀，不寫任何東西。 */

  /* 這個分類的 PCB 板厚（mm）：pcb_thickness 是 { RF, Digital, PWR }；cat 吃得下兩個工具的寫法
     （'RF'／'rf'／'rf_data'、'Digital'／'digital'、'PWR'／'pwr'）。沒有設定、不是正數 → null */
  function pcbOf(pcbThickness, cat) {
    if (!pcbThickness || typeof pcbThickness !== 'object') return null;
    var c = String(cat || '').toLowerCase().replace(/_data$/, '');
    var key = c === 'rf' ? 'RF' : c === 'digital' ? 'Digital' : c === 'pwr' ? 'PWR' : null;
    return key ? pos(pcbThickness[key]) : null;
  }

  // thermal_specs 的 key（＝AI-Thermal 的 sgSpecKey）：空白 → _、/ → -
  function specKey(name) { return String(name || '').replace(/ /g, '_').replace(/\//g, '-'); }
  // 解析 "L×W"（也吃 x / X / *）；只填一個數字視為正方形；解析不出來回 null（＝AI-Thermal 的 sgParseLW）
  function parseLW(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return null;
    var m = t.match(/(\d+\.?\d*)\s*[×xX*]\s*(\d+\.?\d*)/);
    if (m) return { L: parseFloat(m[1]), W: parseFloat(m[2]) };
    var one = t.match(/^(\d+\.?\d*)$/);
    if (one) { var v = parseFloat(one[1]); return { L: v, W: v }; }
    return null;
  }
  // EE 清單的 TH Via 內徑／Qty：'N/A'、空白、0 都算「沒填」
  function tvNum(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (!s || s.toUpperCase() === 'N/A') return null;
    var n = parseFloat(s);
    return (isFinite(n) && n > 0) ? n : null;
  }
  // 找這顆元件的 spec：先用名稱；查不到、且元件有 _renamed_from（5G-RRU 改了名、AI-Thermal 還沒把資料搬過去）→ 用舊名稱
  function specFor(comp, specs) {
    var S = (specs && typeof specs === 'object') ? specs : {};
    var c = comp || {};
    var k = specKey(c.Component);
    if (S[k]) return { key: k, spec: S[k], renamed: false };
    if (c._renamed_from) {
      var k2 = specKey(c._renamed_from);
      if (S[k2]) return { key: k2, spec: S[k2], renamed: true };
    }
    return { key: k, spec: null, renamed: false };
  }

  /* 一顆元件的有效輸入（含每個值的來源）。AI-Thermal 的 Thermal Via 計算頁（viaResolve）與 keffForComp 共用。
     - E-PAD：矩形取 spec.epadSize；沒填（空白）且元件的導熱方式是 Thermal Via 或 _pad_from = epadSize
       → 暫用元件的 Pad_L/Pad_W（5G-RRU 端的 E-Pad 長寬）。圓形取 via.padD。
     - 數量／內徑：via.qty／via.diaMil 有 key＝AI-Thermal 頁面的試算值，沒有 key 才取 EE 清單的 TV_Qty／TV_ID_mil。
     - 板厚：via.pcbT 有 key＝頁面指定；沒有 → pcbT（呼叫端給的 AI-Thermal 該分類 PCB 板厚，見 pcbOf）；
       也沒有 → global_params.t_PCB（5G-RRU）。srcT＝不看頁面指定時的板厚，srcTFrom＝'pcb'／'rru'／null。
     - 鍍銅厚度：via.plating 沒有 key＝預設 1 mil。塞孔材料必填、沒有預設。 */
  function resolve(comp, spec, globalParams, pcbT) {
    spec = spec || {};
    var v = spec.via || {}, c = comp || {}, gp = globalParams || {};
    var shape = v.shape === 'circle' ? 'circle' : 'rect';
    var L = null, W = null, padSrc = null;
    var epadRaw = String(spec.epadSize || '').trim();
    if (shape === 'rect') {
      var lw = parseLW(epadRaw);
      if (lw && lw.L > 0 && lw.W > 0) { L = lw.L; W = lw.W; padSrc = 'epad'; }
      else if (!epadRaw) {
        var pl = parseFloat(c.Pad_L), pw = parseFloat(c.Pad_W);
        if ((c.Board_Type === 'Thermal Via' || c._pad_from === 'epadSize') && pl > 0 && pw > 0) { L = pl; W = pw; padSrc = 'rru'; }
      }
    }
    var D = shape === 'circle' ? pos(v.padD) : null;
    var srcQty = tvNum(c.TV_Qty), srcDia = tvNum(c.TV_ID_mil);
    var pcbSrc = pos(pcbT), rruT = pos(gp.t_PCB);
    var srcT = pcbSrc !== null ? pcbSrc : rruT;
    var srcTFrom = pcbSrc !== null ? 'pcb' : (rruT !== null ? 'rru' : null);
    var qtyLocal = v.qty !== undefined, diaLocal = v.diaMil !== undefined, tLocal = v.pcbT !== undefined;
    var qty = qtyLocal ? num(v.qty) : srcQty;
    var diaMil = diaLocal ? num(v.diaMil) : srcDia;
    var t = tLocal ? num(v.pcbT) : srcT;
    var platingSet = num(v.plating);
    var plating = v.plating !== undefined ? platingSet : PLATING_DEFAULT;
    var fillDef = fillOf(v.fill);
    var kFill = !fillDef ? null : (fillDef.key === 'custom' ? num(v.fillK) : fillDef.k);
    var pitchMil = num(v.pitchMil);
    var d = {
      shape: shape, L: L, W: W, D: D, pattern: v.pattern === 'staggered' ? 'staggered' : 'matrix',
      n: qty, dia: diaMil !== null ? diaMil * MIL : null, pitch: pitchMil !== null ? pitchMil * MIL : null,
      t: t, plating: plating, kFill: kFill,
    };
    return { d: d, v: v, spec: spec, epadRaw: epadRaw, padSrc: padSrc, srcQty: srcQty, srcDia: srcDia, srcT: srcT, srcTFrom: srcTFrom,
             qtyLocal: qtyLocal, diaLocal: diaLocal, tLocal: tLocal, qty: qty, diaMil: diaMil, t: t, pitchMil: pitchMil,
             platingDefault: v.plating === undefined, fill: fillDef ? fillDef.key : null };
  }

  var MISS_LABEL = { pad: 'E-PAD 尺寸', n: 'Via 數量', dia: 'Via 內徑', pitch: '中心間距', t: 'PCB 厚度', plating: '鍍銅厚度', fill: '塞孔材料' };
  function missLabel(k, shape) { return (k === 'pad' && shape === 'circle') ? '焊盤直徑' : (MISS_LABEL[k] || k); }
  // K_eff 只需要這幾項（與 PCB 厚度、中心間距無關）
  var KEFF_NEED = ['pad', 'n', 'dia', 'plating', 'fill'];
  var CHECK_MAX = 2000;   // 數量太大（多半是打錯）時不排列、不檢查（與 AI-Thermal 頁面同一個上限）

  /* 元件 → 逐顆等效 K（5G-RRU 的基板熱阻 R_int 與 AI-Thermal 頁面的說明共用）。
     回傳 { ok, keff, aPad(mm²), reason, missing[], issues[], src{…}, … }：
       ok:true  → keff 可用；issues 是配置問題（孔壁超出焊盤／重疊、沒填中心間距沒辦法檢查…）—— 不影響 K_eff 公式，照用、由呼叫端標 ⚠
       reason   → 'nodata'（沒有 via 設計）／'skip'（暫不納入熱流評估）／'missing'（缺 K_eff 需要的輸入）／
                  'over'（via 佔用面積超過焊盤，K_eff 不成立）→ 呼叫端改用通用值
     試算值（via.qty／via.diaMil）照用：與 AI-Thermal 頁面上看到的 K_eff 一致。
     pcbT（選填）＝這顆所屬分類的 AI-Thermal PCB 板厚（pcbOf），只影響回傳的 t／rth，K_eff 與板厚無關。 */
  function keffForComp(comp, thermalSpecs, globalParams, pcbT) {
    var sf = specFor(comp, thermalSpecs);
    var out = { ok: false, keff: null, aPad: null, reason: null, missing: [], issues: [], key: sf.key, renamed: sf.renamed, src: null };
    var v = sf.spec && sf.spec.via;
    if (!v || typeof v !== 'object' || !Object.keys(v).length) { out.reason = 'nodata'; return out; }
    if (v.skip === true) { out.reason = 'skip'; out.skipNote = String(v.skipNote || ''); return out; }
    var r = resolve(comp, sf.spec, globalParams, pcbT), d = r.d;
    out.shape = d.shape; out.L = d.L; out.W = d.W; out.D = d.D;
    out.n = d.n; out.diaMil = r.diaMil; out.plating = d.plating; out.fill = r.fill; out.kFill = d.kFill; out.t = d.t;
    out.tFrom = r.tLocal ? 'via' : r.srcTFrom;
    out.srcQty = r.srcQty; out.srcDia = r.srcDia;
    out.src = { pad: d.shape === 'circle' ? 'circle' : r.padSrc, qty: r.qtyLocal ? 'via' : 'ee', dia: r.diaLocal ? 'via' : 'ee',
                plating: r.platingDefault ? 'default' : 'via' };
    out.missing = missing(d).filter(function (k) { return KEFF_NEED.indexOf(k) >= 0; });
    if (out.missing.length) { out.reason = 'missing'; return out; }
    // K_eff 與板厚無關：t 只是讓 calc 走得下去（R_th 另外用呼叫端的板厚算，見 rint）
    var res = calc(Object.assign({}, d, { t: 1 }));
    out.aPad = res.aPad; out.footRatio = res.footRatio;
    if (!res.ok) { out.reason = res.reason; return out; }
    out.ok = true; out.keff = res.keff;
    out.rth = d.t > 0 ? rint(out, d.t) : null;
    if (d.n > CHECK_MAX) out.issues.push({ lv: 'warn', code: 'many', text: 'Via 數量 ' + d.n + ' 顆太多（是不是打錯？），沒有檢查配置' });
    else if (d.n > 1 && !(d.pitch > 0)) out.issues.push({ lv: 'warn', code: 'nopitch', text: '沒填中心間距，沒辦法檢查配置（孔壁會不會超出焊盤、互相重疊）' });
    else {
      var chk = check(d, layout(d, d.pitch));
      if (chk.nOut) out.issues.push({ lv: 'err', code: 'out', text: chk.nOut + ' 顆 via 的孔壁超出焊盤' });
      if (chk.nOverlap) out.issues.push({ lv: 'err', code: 'overlap', text: chk.nOverlap + ' 顆 via 的孔壁互相重疊' });
    }
    return out;
  }
  // 穿板熱阻 R = t ÷ (K_eff × A_pad)（°C/W；t mm、A_pad mm²）＝ AI-Thermal 頁面的 R_th。不 ok → NaN（不偷偷當 0）
  function rint(r, tMm) {
    var t = typeof tMm === 'number' ? tMm : parseFloat(tMm);
    return (r && r.ok && r.keff > 0 && r.aPad > 0) ? t / (r.keff * r.aPad) * 1000 : NaN;
  }
  // 不 ok 的原因（給使用者看的一句話；兩個工具同一套文字）
  function reasonText(r) {
    if (!r || r.ok) return '';
    if (r.reason === 'nodata') return 'AI-Thermal「Thermal Via 計算」還沒有這顆的 via 設計';
    if (r.reason === 'skip') return 'AI-Thermal 標為「暫不納入熱流評估」' + (r.skipNote ? '（' + r.skipNote + '）' : '');
    if (r.reason === 'missing') return 'via 設計還缺：' + r.missing.map(function (k) { return missLabel(k, r.shape); }).join('、');
    if (r.reason === 'over') return 'via 佔用面積是焊盤的 ' + Math.round((r.footRatio || 0) * 100) + '%（超過焊盤），K_eff 不成立';
    return '';
  }

  var api = {
    K_CU: K_CU, K_FR4: K_FR4, EDGE: EDGE, MIL: MIL, HEX: HEX,
    FILLS: FILLS, PLATINGS: PLATINGS, PLATING_DEFAULT: PLATING_DEFAULT,
    num: num, pos: pos, fillOf: fillOf,
    padArea: padArea, rOut: rOut, missing: missing, calc: calc,
    grid: grid, layout: layout, check: check, autoPitch: autoPitch, maxCount: maxCount,
    milToMm: milToMm, mmToMil: mmToMil, floorTo: floorTo,
    MISS_LABEL: MISS_LABEL, KEFF_NEED: KEFF_NEED, CHECK_MAX: CHECK_MAX,
    specKey: specKey, parseLW: parseLW, tvNum: tvNum, specFor: specFor, pcbOf: pcbOf, resolve: resolve, missLabel: missLabel,
    keffForComp: keffForComp, rint: rint, reasonText: reasonText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ViaCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
