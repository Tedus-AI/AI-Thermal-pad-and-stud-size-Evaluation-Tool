/* compMerge.js — 元件清單「三方比對合併」＋衝突選擇視窗
 * ⚠ 5G-RRU 與 AI-Thermal 兩個 repo 各放一份，內容必須逐字相同（改一邊就同步另一邊，
 *   兩邊的 tests/comp-merge.unit.test.js 也是同一份）。
 *
 * 為什麼需要：兩個工具存檔時，都會把整份元件清單（rf_data／digital_data／pwr_data）用自己
 * 畫面上的副本寫回共用 DB。直接寫回的話，對方工具在我們「載入之後」存的修改會被整批蓋掉
 * （例：5G-RRU 開著專案 → 到 AI-Thermal 補 θJC 並存檔 → 回 5G-RRU 補高度再存 → θJC 被蓋回舊值）。
 *
 * 作法（三方比對）：
 *   base   ＝載入時的快照（當時資料庫裡的樣子）
 *   mine   ＝目前畫面上的副本（要存的內容）
 *   theirs ＝寫入當下資料庫的最新內容（寫入函式在最新狀態上執行，遇到 412 重讀後會重算一次）
 * 逐顆元件、逐欄：我沒改 → 用資料庫最新值；只有我改 → 用我的；兩邊改得一樣 → 照用；
 * 兩邊改得不一樣 → 衝突，交給使用者選（showConflictDialog），全部決定之前不寫入。
 *
 * 元件配對：先比 `_cid`（元件 id，底線開頭的內部欄位，改名不影響），對不上再比名稱
 * （舊資料還沒有 id）。相依欄位整組比對（E-Pad 長／寬／來源標記、Rjc 與來源標記、
 * 導熱方式與來源標記、介面材料與型號），不會合成出兩邊都沒有過的組合。
 *
 * opts.derivedKeys：呼叫端自己每次都會重新推導的欄位（例：5G-RRU 的 Thick(mm) 由參數控制台帶入）。
 * 這些欄位不列入比對、不算「我改過這顆」、也不會跳衝突，一律用畫面上的值，呼叫端合併後再重新推導。
 * （不排除的話，載入時自動帶入的板厚會被當成「我改過」，對方刪掉那顆元件時就變成假衝突。）
 *
 * 另外放了兩個「共用元件語意」函式（limitRef／limitSuspect）：兩個工具的畫面與計算必須判斷一致，
 * 放在這份兩邊逐字相同的檔案裡，才不會各寫一份、日後改一邊漏一邊。
 */
(function (root) {
  'use strict';

  var CATS = ['rf_data', 'digital_data', 'pwr_data'];
  var CAT_LABEL = { rf_data: 'RF', digital_data: 'Digital', pwr_data: 'PWR' };

  // 兩個工具共寫的數字欄位：比對前統一轉成數字。AI-Thermal 常存成字串、5G-RRU 存數字，
  // 不轉的話 "5.2" 與 5.2 會被當成「有改」而誤判成衝突。空字串／非數字 → 不寫 key。
  var NUM_KEYS = ['Qty', 'Power(W)', 'Height(mm)', 'Pad_L', 'Pad_W', 'Thick(mm)', 'Limit(C)', 'R_jc'];
  var STR_KEYS = ['Board_Type', 'TIM_Type', 'TIM_Model', 'Limit_Ref'];

  // 相依欄位整組比對：值與它的來源標記、成對的尺寸、型號與它所屬的類型
  var GROUPS = [
    ['Pad_L', 'Pad_W', '_pad_from'],
    ['R_jc', '_rjc_from'],
    ['Board_Type', '_bt_from'],
    ['TIM_Type', 'TIM_Model'],
    ['Limit(C)', 'Limit_Ref'],   // 限溫與它指的是 Tj 還是 Tc：不可拼出「A 的數字＋B 的對象」
  ];

  var LABELS = {
    Component: '元件名稱', Qty: '數量', 'Power(W)': '瓦數 (W)', 'Power_RT(W)': '常溫瓦數 (W)',
    'Height(mm)': '元件高度 (mm)', 'Thick(mm)': '板厚 (mm)', 'Limit(C)': '限溫 (°C)／限溫對象',
    Limit_Ref: '限溫對象 (Tj/Tc)', _limit_ok: '已確認限溫是實際值',
    Pad_L: 'E-Pad 長 × 寬', R_jc: '熱阻 Rjc', Board_Type: '導熱方式', TIM_Type: '介面材料／型號',
    Rth: '熱阻表（θ）', SpecFile: '規格書', note: '備註', Type: '類型',
    Temp_Sensor: '溫度感測', Local_Qty: 'Local 數量', Remote_Qty: 'Remote 數量',
    TV_ID_mil: 'Thermal Via 孔徑 (mil)', TV_Qty: 'Thermal Via 數量',
    _excluded: '排除計算（👁）', _defaults_ok: '已確認不是舊預設值', _ref_locked: '瓦數參照鎖定',
    project_name: '專案名稱',
  };

  /* ── 小工具 ─────────────────────────────────────────── */
  function isObj(v) { return v !== null && typeof v === 'object'; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  // 穩定序列化（key 排序）：用來判斷兩個值是否相同，與 key 的先後無關
  function canon(v) {
    if (v === undefined) return '∅';
    if (!isObj(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
      .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }
  function same(a, b) { return canon(a) === canon(b); }

  var _seq = 0;
  function newCid() {
    _seq = (_seq + 1) % 1296;
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + _seq.toString(36);
  }
  function cidOf(c) { return (c && typeof c._cid === 'string' && c._cid) ? c._cid : null; }
  function nameOf(c) { return String((c && c.Component) || '').trim(); }

  /* 共寫欄位的型別整理（回傳新物件，不改動傳入的元件）。兩個工具的比對、寫入都走這一份。 */
  function normalizeComp(c) {
    if (!isObj(c)) return c;
    var o = clone(c);
    NUM_KEYS.forEach(function (k) {
      if (!(k in o)) return;
      var v = o[k];
      var n = (typeof v === 'number') ? v : ((v === '' || v == null) ? NaN : parseFloat(v));
      if (isFinite(n)) o[k] = n; else delete o[k];
    });
    STR_KEYS.forEach(function (k) {
      if (!(k in o)) return;
      if (typeof o[k] !== 'string' || o[k].trim() === '') delete o[k];
    });
    delete o._filled;   // 舊版 5G-RRU 的 UI 標記（自動補值），不是資料
    return o;
  }
  function stripCid(c, derived) {
    var o = clone(c) || {};
    delete o._cid;
    (derived || []).forEach(function (k) { delete o[k]; });
    return o;
  }

  /* 補發元件 id：沒有 id、或同一份清單裡重複（例如整顆複製）→ 發新的。回傳補發幾顆。 */
  function ensureCids(list) {
    var seen = {}, n = 0;
    (list || []).forEach(function (c) {
      if (!isObj(c)) return;
      var id = cidOf(c);
      if (!id || seen[id]) { c._cid = newCid(); n++; }
      seen[c._cid] = true;
    });
    return n;
  }
  function ensureProjectCids(doc) {
    var n = 0;
    CATS.forEach(function (cat) { if (doc && Array.isArray(doc[cat])) n += ensureCids(doc[cat]); });
    return n;
  }

  /* 把 other 的元件配對到 base：先比 _cid，再比名稱。
     名稱只拿來配「對方沒有 id、或它的 id 不屬於 base 任何一顆」的元件（舊資料、或對方剛補發 id），
     不會用名稱去搶已經有 id、屬於 base 另一顆的元件。回傳 { pair: {baseIdx: otherIdx}, rest: [otherIdx] } */
  function matchLists(base, other) {
    var pair = {}, usedO = {}, usedB = {}, byCid = {}, baseCids = {};
    other.forEach(function (o, j) { var id = cidOf(o); if (id && !(id in byCid)) byCid[id] = j; });
    base.forEach(function (b, i) {
      var id = cidOf(b);
      if (id) baseCids[id] = true;
      if (!id || !(id in byCid) || usedO[byCid[id]]) return;
      pair[i] = byCid[id]; usedO[byCid[id]] = true; usedB[i] = true;
    });
    base.forEach(function (b, i) {
      if (usedB[i]) return;
      var nb = nameOf(b);
      if (!nb) return;
      for (var j = 0; j < other.length; j++) {
        if (usedO[j]) continue;
        var oc = cidOf(other[j]);
        if (oc && baseCids[oc]) continue;
        if (nameOf(other[j]) === nb) { pair[i] = j; usedO[j] = true; usedB[i] = true; break; }
      }
    });
    var rest = [];
    other.forEach(function (o, j) { if (!usedO[j]) rest.push(j); });
    return { pair: pair, rest: rest };
  }

  /* 要比對的單位：每個相依群組一個單位，其餘欄位各自一個（_cid 另外處理） */
  function unitsOf(items, derived) {
    var keys = {};
    items.forEach(function (x) { if (isObj(x)) Object.keys(x).forEach(function (k) { keys[k] = true; }); });
    delete keys._cid;
    (derived || []).forEach(function (k) { delete keys[k]; });
    var units = [], inGroup = {};
    GROUPS.forEach(function (g) {
      if (g.some(function (k) { return keys[k]; })) units.push(g);
      g.forEach(function (k) { inGroup[k] = true; });
    });
    Object.keys(keys).sort().forEach(function (k) { if (!inGroup[k]) units.push([k]); });
    return units;
  }
  function pick(x, unit) {
    var o = {};
    unit.forEach(function (k) { if (isObj(x) && x[k] !== undefined) o[k] = x[k]; });
    return o;
  }
  function put(out, src, unit) {
    unit.forEach(function (k) {
      if (isObj(src) && src[k] !== undefined) out[k] = clone(src[k]); else delete out[k];
    });
  }
  // 輸出的 key 順序跟著「我的 → 資料庫的 → base」走（只影響 JSON 的可讀性，不影響內容）
  function orderLike(out, refs) {
    var o = {};
    refs.forEach(function (r) { if (isObj(r)) Object.keys(r).forEach(function (k) { if (k in out && !(k in o)) o[k] = out[k]; }); });
    Object.keys(out).forEach(function (k) { if (!(k in o)) o[k] = out[k]; });
    return o;
  }
  function unitLabel(u) { return LABELS[u[0]] || u[0]; }

  function conflictBase(ctx, cid, name) {
    return { cat: ctx.cat, catLabel: CAT_LABEL[ctx.cat] || ctx.cat, cid: cid, name: name || '（未命名）' };
  }
  function decide(ctx, c) {
    ctx.conflicts.push(c);
    var r = ctx.resolutions[c.key];
    if (r !== 'mine' && r !== 'theirs') { ctx.unresolved.push(c); return null; }
    return r;
  }

  /* 單顆元件逐欄合併（b 可能是 {}：兩邊各自新增了同名元件） */
  function mergeItem(b, m, t, ctx) {
    var out = {};
    var cid = cidOf(t) || cidOf(m) || cidOf(b) || newCid();   // 資料庫已經有的 id 優先
    unitsOf([b, m, t], ctx.derived).forEach(function (u) {
      var bv = pick(b, u), mv = pick(m, u), tv = pick(t, u);
      if (same(mv, bv)) { put(out, t, u); if (!same(tv, bv)) ctx.stats.fromTheirs++; return; }
      if (same(tv, bv) || same(mv, tv)) { put(out, m, u); ctx.stats.fromMine++; return; }
      var c = conflictBase(ctx, cid, nameOf(m) || nameOf(t) || nameOf(b));
      c.key = ctx.cat + '|' + cid + '|' + u.join('+');
      c.kind = 'field'; c.fields = u; c.label = unitLabel(u);
      c.mine = mv; c.theirs = tv; c.base = bv;
      var r = decide(ctx, c);
      put(out, r === 'theirs' ? t : m, u);
    });
    // 呼叫端自己會重新推導的欄位：用畫面上的值（沒有才用資料庫的），不比對、不跳衝突
    ctx.derived.forEach(function (k) {
      var src = (isObj(m) && m[k] !== undefined) ? m : t;
      if (isObj(src) && src[k] !== undefined) out[k] = clone(src[k]);
    });
    out._cid = cid;
    return orderLike(out, [m, t, b]);
  }
  function withCid(c) { var o = clone(c); if (!cidOf(o)) o._cid = newCid(); return o; }

  function mergeList(B, M, T, ctx) {
    B = (B || []).map(normalizeComp); M = (M || []).map(normalizeComp); T = (T || []).map(normalizeComp);
    var mb = matchLists(B, M), tb = matchLists(B, T);
    var mineToBase = {};
    Object.keys(mb.pair).forEach(function (i) { mineToBase[mb.pair[i]] = +i; });
    // 兩邊各自新增、而且同名（或同 id）的元件 → 視為同一顆，逐欄合併
    var theirsRest = tb.rest.slice(), addPair = {};
    mb.rest.forEach(function (j) {
      var nm = nameOf(M[j]), mc = cidOf(M[j]);
      for (var q = 0; q < theirsRest.length; q++) {
        var t = T[theirsRest[q]];
        if ((mc && cidOf(t) === mc) || (nm && nameOf(t) === nm)) { addPair[j] = theirsRest[q]; theirsRest.splice(q, 1); return; }
      }
    });
    var out = [], handled = {};
    M.forEach(function (m, j) {
      if (j in mineToBase) {
        var i = mineToBase[j], b = B[i];
        handled[i] = true;
        if (i in tb.pair) { out.push(mergeItem(b, m, T[tb.pair[i]], ctx)); return; }
        // 資料庫裡已經沒有這顆（對方刪除了）
        if (same(stripCid(m, ctx.derived), stripCid(b, ctx.derived))) { ctx.stats.droppedByTheirs++; return; }   // 我沒改 → 接受刪除
        var cid = cidOf(m) || cidOf(b);
        var c = conflictBase(ctx, cid, nameOf(m) || nameOf(b));
        c.key = ctx.cat + '|' + cid + '|__removed'; c.kind = 'theirsDeleted'; c.label = '整顆元件';
        c.mine = m; c.theirs = undefined; c.base = b;
        if (decide(ctx, c) !== 'theirs') out.push(withCid(m));
        return;
      }
      if (j in addPair) { out.push(mergeItem({}, m, T[addPair[j]], ctx)); return; }
      out.push(withCid(m)); ctx.stats.addedMine++;
    });
    // base 裡有、畫面上已刪除的
    B.forEach(function (b, i) {
      if (handled[i] || !(i in tb.pair)) return;              // 兩邊都刪了 → 不用管
      var t = T[tb.pair[i]];
      if (same(stripCid(t, ctx.derived), stripCid(b, ctx.derived))) { ctx.stats.deletedMine++; return; }   // 對方沒改 → 照我的刪除
      var cid = cidOf(t) || cidOf(b);
      var c = conflictBase(ctx, cid, nameOf(t) || nameOf(b));
      c.key = ctx.cat + '|' + cid + '|__removed'; c.kind = 'mineDeleted'; c.label = '整顆元件';
      c.mine = undefined; c.theirs = t; c.base = b;
      if (decide(ctx, c) === 'theirs') out.push(withCid(t));
    });
    // 對方新增的
    theirsRest.forEach(function (q) { out.push(withCid(T[q])); ctx.stats.addedTheirs++; });
    return out;
  }

  /* mergeProject(base, mine, theirs, opts)
     只處理 mine 裡有出現的元件陣列（rf_data／digital_data／pwr_data）與 opts.scalars 列出的欄位。
     opts.resolutions：{ 衝突 key: 'mine' | 'theirs' }（使用者在視窗裡的選擇，重算時沿用）
     opts.derivedKeys：呼叫端每次都會重新推導的欄位（不比對、用畫面上的值，見檔頭說明）
     回傳 { fields, conflicts, unresolved, stats }；unresolved 非空時呼叫端不可寫入。 */
  function mergeProject(base, mine, theirs, opts) {
    opts = opts || {};
    var ctx = {
      resolutions: opts.resolutions || {}, conflicts: [], unresolved: [], cat: null, derived: opts.derivedKeys || [],
      stats: { fromTheirs: 0, fromMine: 0, addedMine: 0, addedTheirs: 0, droppedByTheirs: 0, deletedMine: 0 },
    };
    var fields = {};
    CATS.forEach(function (cat) {
      if (!isObj(mine) || !(cat in mine)) return;
      ctx.cat = cat;
      fields[cat] = mergeList(base && base[cat], mine[cat], theirs && theirs[cat], ctx);
    });
    ctx.cat = 'project';
    (opts.scalars || []).forEach(function (k) {
      if (!isObj(mine) || !(k in mine)) return;
      var bv = base ? base[k] : undefined, mv = mine[k], tv = theirs ? theirs[k] : undefined;
      if (same(mv, bv)) {
        fields[k] = clone(tv !== undefined ? tv : mv);
        if (!same(tv, bv) && tv !== undefined) ctx.stats.fromTheirs++;
        return;
      }
      if (same(tv, bv) || same(mv, tv) || tv === undefined) { fields[k] = clone(mv); ctx.stats.fromMine++; return; }
      var c = { cat: 'project', catLabel: '專案', cid: '', name: '（專案）', key: 'project|' + k, kind: 'scalar',
                fields: [k], label: LABELS[k] || k, mine: mv, theirs: tv, base: bv };
      var r = decide(ctx, c);
      fields[k] = clone(r === 'theirs' ? tv : mv);
    });
    return { fields: fields, conflicts: ctx.conflicts, unresolved: ctx.unresolved, stats: ctx.stats };
  }

  /* 專案「元件清單＋指定欄位」的指紋：判斷資料庫在載入之後有沒有被別人改過（忽略 _cid 與型別差異） */
  function projectDigest(doc, scalars) {
    var o = {};
    CATS.forEach(function (cat) {
      o[cat] = ((doc && doc[cat]) || []).map(function (c) { return stripCid(normalizeComp(c)); });
    });
    (scalars || []).forEach(function (k) { o[k] = doc ? doc[k] : undefined; });
    return canon(o);
  }
  function sameDoc(a, b, scalars) { return projectDigest(a, scalars) === projectDigest(b, scalars); }

  /* 寫入函式在合併出現「還沒決定的衝突」時丟這個錯誤；saveWithMerge 接到後開視窗問使用者 */
  function MergePending(conflicts) {
    var e = new Error('有 ' + conflicts.length + ' 個欄位兩邊都改了，需要選擇要保留哪一邊');
    e.name = 'MergePending';
    e.conflicts = conflicts;
    return e;
  }

  /* 存檔流程：attemptFn(resolutions) 負責真正寫入（寫入函式在最新狀態上合併，有未決定衝突就丟 MergePending）。
     opts.ask(conflicts) → Promise<resolutions|null>（預設用 showConflictDialog）
     opts.isRetryable(err) → 例如本機檔模式的版本衝突：重讀後再試一次
     回傳 { ok:true, value } 或 { ok:false, cancelled:true } */
  function saveWithMerge(attemptFn, opts) {
    opts = opts || {};
    var resolutions = Object.assign({}, opts.resolutions || {});
    var ask = opts.ask || function (cs) { return showConflictDialog(cs, opts.dialog); };
    var round = 0;
    function loop() {
      round++;
      return Promise.resolve().then(function () { return attemptFn(resolutions); }).then(
        function (v) { return { ok: true, value: v, resolutions: resolutions }; },
        function (e) {
          if (round >= 6) throw e;
          if (e && e.name === 'MergePending') {
            return Promise.resolve(ask(e.conflicts)).then(function (r) {
              if (!r) return { ok: false, cancelled: true };
              Object.assign(resolutions, r);
              return loop();
            });
          }
          if (opts.isRetryable && opts.isRetryable(e)) return loop();
          throw e;
        });
    }
    return loop();
  }

  /* ── 共用元件語意：兩個工具的畫面與計算都呼叫這裡，判斷才會一致 ─────────── */
  function typeOf(c) { return (c && typeof c.Type === 'string') ? c.Type.trim() : ''; }
  function toNum(v) { return (typeof v === 'number') ? v : ((v === '' || v == null) ? NaN : parseFloat(v)); }

  /* 限溫對象：這顆元件的「限溫」指的是 Tj（晶片接面）還是 Tc（外殼／本體）。
     有填 Limit_Ref（'Tj'／'Tc'）→ 照填的。沒填 → 自動判定：
       1. AI-Thermal 的元件類型：記憶體、光模組、模組、被動元件看外殼 → Tc；IC 看接面 → Tj
       2. 沒有類型、或類型不在下面兩張清單 → 沿用舊規則：PWR 類、名稱含 DDR 或 SFP → Tc，其餘 Tj
     cat 接受 'pwr'／'PWR'／'pwr_data'（兩個工具的分類寫法不同）。回傳 { ref, auto, why }。 */
  var LIMIT_REF_TC_TYPES = ['DDR', 'eMMC', 'SFP', 'GPS module', 'Power Modules', 'filter', 'CR'];
  var LIMIT_REF_TJ_TYPES = ['Final PA', 'Driver', 'Pre-driver', 'DC-DC', 'LDO', 'HOTSWAP', 'Power MOSFET',
    'CLK IC', 'CPU', 'Baseband Processor', 'CLK buffer', 'Ethernet Transceiver', 'retimer'];
  function limitRef(c, cat) {
    var v = c && c.Limit_Ref;
    if (v === 'Tj' || v === 'Tc') return { ref: v, auto: false, why: '已指定' };
    var t = typeOf(c);
    if (LIMIT_REF_TC_TYPES.indexOf(t) >= 0) return { ref: 'Tc', auto: true, why: '類型 ' + t };
    if (LIMIT_REF_TJ_TYPES.indexOf(t) >= 0) return { ref: 'Tj', auto: true, why: '類型 ' + t };
    var k = String(cat || '').toLowerCase();
    if (k === 'pwr' || k === 'pwr_data') return { ref: 'Tc', auto: true, why: 'PWR 類' };
    var n = nameOf(c);
    if (/ddr/i.test(n)) return { ref: 'Tc', auto: true, why: '名稱含 DDR' };
    if (/sfp|光模組/i.test(n)) return { ref: 'Tc', auto: true, why: '名稱含 SFP' };
    return { ref: 'Tj', auto: true, why: '預設' };
  }

  /* 限溫疑似範例值（只提醒、不擋計算）：限溫明顯不像實際規格，多半是從內建範例或舊資料帶過來還沒改
     （例：5G-RRU 內建範例的 SFP、腔體濾波器都是 200 °C，有專案原封不動沿用）。
     使用者按「確認是實際值」→ 元件寫 `_limit_ok` ＝ 當時的限溫；之後限溫改成別的值會再提醒。
     回傳 null 或 { id, value, note }。 */
  var PA_TYPES = ['Final PA', 'Driver', 'Pre-driver'];
  var PA_NAME_RE = /(^|[^a-z])pa([^a-z]|$)|amp|driver|gan|ldmos|功放|放大/i;
  var LIMIT_SUSPECTS = [
    { id: 'sfp', over: 85, note: '光模組的殼溫上限一般是 70 或 85 °C',
      match: function (t, n) { return t === 'SFP' || /sfp|光模組|optical/i.test(n); } },
    { id: 'ddr', over: 105, note: 'DDR 的殼溫上限一般是 85、95 或 105 °C',
      match: function (t, n) { return t === 'DDR' || /ddr/i.test(n); } },
    { id: 'hot', atLeast: 200, note: '功率放大器以外的元件，限溫很少到 200 °C',
      match: function (t, n) { return PA_TYPES.indexOf(t) < 0 && !PA_NAME_RE.test(n); } },
  ];
  function limitSuspect(c) {
    if (!isObj(c)) return null;
    var v = toNum(c['Limit(C)']);
    if (!isFinite(v) || toNum(c._limit_ok) === v) return null;
    var t = typeOf(c), n = nameOf(c);
    for (var i = 0; i < LIMIT_SUSPECTS.length; i++) {
      var r = LIMIT_SUSPECTS[i];
      if (!r.match(t, n)) continue;
      if ((r.over !== undefined && v > r.over) || (r.atLeast !== undefined && v >= r.atLeast)) return { id: r.id, value: v, note: r.note };
    }
    return null;
  }

  /* ── 畫面：衝突選擇視窗與提示 ─────────────────────────── */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtValue(v, key) {
    if (v === undefined || v === null || v === '') return null;
    if (key === 'Rth' && Array.isArray(v)) {
      return 'θ ' + v.length + ' 筆：' + v.map(function (r) { return (r && r.type || '') + ' ' + (r && r.value); }).join('、');
    }
    if (key === 'SpecFile') {
      var list = Array.isArray(v) ? v : [v];
      return '規格書 ' + list.length + ' 份：' + list.map(function (s) { return s && (s.name || s.path); }).join('、');
    }
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (isObj(v)) { var s = JSON.stringify(v); return s.length > 90 ? s.slice(0, 87) + '…' : s; }
    return String(v);
  }
  function fmtUnit(u, o) {
    o = o || {};
    if (u[0] === 'Pad_L') {
      if (o.Pad_L === undefined && o.Pad_W === undefined) return null;
      return (o.Pad_L === undefined ? '?' : o.Pad_L) + ' × ' + (o.Pad_W === undefined ? '?' : o.Pad_W) + ' mm';
    }
    if (u[0] === 'R_jc') {
      if (o.R_jc === undefined) return null;
      return o.R_jc + ' °C/W' + (o._rjc_from ? '（取自 ' + (o._rjc_from === 'JC_top' ? 'θJC,top' : 'θJC,bottom') + '）' : '');
    }
    if (u[0] === 'Board_Type') return o.Board_Type === undefined ? null : String(o.Board_Type);
    if (u[0] === 'Limit(C)') {
      if (o['Limit(C)'] === undefined && o.Limit_Ref === undefined) return null;
      return (o['Limit(C)'] === undefined ? '?' : o['Limit(C)']) + ' °C' + (o.Limit_Ref ? '（' + o.Limit_Ref + '）' : '（對象自動判定）');
    }
    if (u[0] === 'TIM_Type') {
      if (o.TIM_Type === undefined && o.TIM_Model === undefined) return null;
      return (o.TIM_Type || '—') + (o.TIM_Model ? '／型號 ' + o.TIM_Model : '');
    }
    return fmtValue(o[u[0]], u[0]);
  }
  function cellText(c, side) {
    if (c.kind === 'theirsDeleted') return side === 'mine' ? '保留這顆元件（你改過它）' : '刪除（資料庫裡已被刪除）';
    if (c.kind === 'mineDeleted') return side === 'mine' ? '刪除（你已刪除這顆）' : '保留這顆元件（對方改過它）';
    var s = fmtUnit(c.fields, side === 'mine' ? c.mine : c.theirs);
    return s === null ? null : s;
  }

  var STYLE = [
    '.cm-mask{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;}',
    '.cm-box{background:#fff;color:#1f2937;border-radius:10px;box-shadow:0 20px 50px rgba(0,0,0,.3);width:min(1000px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;font-size:14px;line-height:1.55;font-family:inherit;}',
    '.cm-head{padding:14px 18px 10px;border-bottom:1px solid #e5e7eb;}',
    '.cm-title{font-size:1.05rem;font-weight:800;color:#92400e;}',
    '.cm-sub{margin-top:4px;color:#4b5563;font-size:.86rem;}',
    '.cm-bulk{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center;}',
    '.cm-body{overflow:auto;padding:0 18px;flex:1 1 auto;min-height:0;}',
    '.cm-table{width:100%;border-collapse:collapse;margin:10px 0 12px;}',
    '.cm-table th{position:sticky;top:0;background:#f1f5f9;text-align:left;font-size:.8rem;color:#334155;padding:6px 8px;border-bottom:2px solid #cbd5e1;z-index:1;}',
    '.cm-table td{padding:7px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;}',
    '.cm-comp{font-weight:700;}',
    '.cm-cat{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;background:#e2e8f0;color:#334155;font-size:.72rem;font-weight:700;}',
    '.cm-was{color:#6b7280;font-size:.76rem;margin-top:2px;}',
    '.cm-opt{display:flex;gap:6px;align-items:flex-start;cursor:pointer;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;}',
    '.cm-opt:hover{border-color:#64748b;}',
    '.cm-opt.sel{border-color:#1d4ed8;background:#eff6ff;box-shadow:inset 0 0 0 1px #1d4ed8;}',
    '.cm-opt input{margin-top:3px;}',
    '.cm-val{word-break:break-word;}',
    '.cm-empty{color:#6b7280;font-style:italic;}',
    '.cm-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 18px;border-top:1px solid #e5e7eb;flex-wrap:wrap;}',
    '.cm-left{color:#6b7280;font-size:.84rem;}',
    '.cm-btns{display:flex;gap:8px;}',
    '.cm-btn{border:1px solid #cbd5e1;background:#fff;color:#1f2937;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:.88rem;font-family:inherit;}',
    '.cm-btn:hover{border-color:#64748b;}',
    '.cm-btn.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff;font-weight:700;}',
    '.cm-btn:disabled{opacity:.45;cursor:not-allowed;}',
    '.cm-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2937;color:#fff;padding:10px 16px;border-radius:8px;z-index:3100;font-size:.88rem;line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:min(680px,calc(100vw - 32px));opacity:0;transition:opacity .2s;pointer-events:none;}',
    '.cm-toast.show{opacity:1;}',
  ].join('\n');
  function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById('cm-style')) return;
    var s = document.createElement('style');
    s.id = 'cm-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  /* 衝突選擇視窗：每一列選「用我的」或「用資料庫的」，全部選完才能按「確定儲存」。
     回傳 Promise<{key:'mine'|'theirs'}>；按取消（或 Esc）回傳 null（不存檔）。 */
  function showConflictDialog(conflicts, o) {
    o = o || {};
    injectStyle();
    return new Promise(function (resolve) {
      var choice = {};
      var mask = document.createElement('div');
      mask.className = 'cm-mask';
      mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-modal', 'true');
      var mineLabel = o.mineLabel || '用我的（目前畫面）';
      var theirsLabel = o.theirsLabel || '用資料庫的（對方剛存的）';
      var rows = conflicts.map(function (c, i) {
        var was = (c.kind === 'field' || c.kind === 'scalar') ? fmtUnit(c.fields, c.base) : null;
        var opt = function (side, label) {
          var t = cellText(c, side);
          return '<label class="cm-opt" data-i="' + i + '" data-side="' + side + '">' +
            '<input type="radio" name="cm-r' + i + '" value="' + side + '">' +
            '<span><span style="font-size:.74rem;color:#475569;display:block;">' + esc(label) + '</span>' +
            (t === null ? '<span class="cm-empty">（空）</span>' : '<span class="cm-val">' + esc(t) + '</span>') +
            '</span></label>';
        };
        return '<tr><td><div class="cm-comp">' + esc(c.name) + '<span class="cm-cat">' + esc(c.catLabel) + '</span></div></td>' +
          '<td>' + esc(c.label) + (c.kind === 'field' || c.kind === 'scalar'
            ? '<div class="cm-was">載入時：' + (was === null ? '（空）' : esc(was)) + '</div>' : '') + '</td>' +
          '<td>' + opt('mine', mineLabel) + '</td><td>' + opt('theirs', theirsLabel) + '</td></tr>';
      }).join('');
      mask.innerHTML =
        '<div class="cm-box">' +
          '<div class="cm-head">' +
            '<div class="cm-title">' + esc(o.title || '⚠ 這個專案在你載入後，已在資料庫被更新') + '</div>' +
            '<div class="cm-sub">' + esc(o.sub || '下面這些欄位兩邊都改了、而且改得不一樣，請逐一選擇要保留哪一邊。' +
              '其餘的修改已自動合併：你改的欄位用你的，你沒改的欄位用資料庫最新的。') + '</div>' +
            '<div class="cm-bulk"><button type="button" class="cm-btn" data-bulk="mine">全部用我的</button>' +
            '<button type="button" class="cm-btn" data-bulk="theirs">全部用資料庫的</button></div>' +
          '</div>' +
          '<div class="cm-body"><table class="cm-table"><thead><tr><th style="width:24%">元件</th><th style="width:18%">欄位</th>' +
            '<th>' + esc(mineLabel) + '</th><th>' + esc(theirsLabel) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
          '<div class="cm-foot"><span class="cm-left"></span><span class="cm-btns">' +
            '<button type="button" class="cm-btn" data-act="cancel">取消（不存檔）</button>' +
            '<button type="button" class="cm-btn primary" data-act="ok" disabled>確定儲存</button></span></div>' +
        '</div>';
      var left = mask.querySelector('.cm-left'), ok = mask.querySelector('[data-act="ok"]');
      function refresh() {
        var n = conflicts.filter(function (c) { return !choice[c.key]; }).length;
        left.textContent = n ? ('還有 ' + n + ' 項沒選') : ('共 ' + conflicts.length + ' 項，都選好了');
        ok.disabled = n > 0;
        mask.querySelectorAll('.cm-opt').forEach(function (el) {
          var c = conflicts[+el.getAttribute('data-i')], side = el.getAttribute('data-side');
          var sel = choice[c.key] === side;
          el.classList.toggle('sel', sel);
          el.querySelector('input').checked = sel;
        });
      }
      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
      mask.addEventListener('click', function (e) {
        var optEl = e.target.closest ? e.target.closest('.cm-opt') : null;
        if (optEl) {
          choice[conflicts[+optEl.getAttribute('data-i')].key] = optEl.getAttribute('data-side');
          refresh();
          return;
        }
        var b = e.target.closest ? e.target.closest('[data-bulk]') : null;
        if (b) { conflicts.forEach(function (c) { choice[c.key] = b.getAttribute('data-bulk'); }); refresh(); return; }
        var a = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!a) return;
        if (a.getAttribute('data-act') === 'cancel') close(null);
        else if (!ok.disabled) close(Object.assign({}, choice));
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(mask);
      refresh();
      var first = mask.querySelector('[data-bulk="mine"]');
      if (first && first.focus) first.focus();
    });
  }

  function toast(msg, ms) {
    if (typeof document === 'undefined') return;
    injectStyle();
    var t = document.getElementById('cm-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cm-toast'; t.className = 'cm-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 4000);
  }

  /* 存檔成功後給使用者的一句話（有併入對方的修改才說） */
  function summaryText(res) {
    if (!res || !res.stats) return '';
    var s = res.stats, parts = [];
    if (s.fromTheirs) parts.push('併入資料庫最新的 ' + s.fromTheirs + ' 項修改');
    if (s.addedTheirs) parts.push('對方新增的 ' + s.addedTheirs + ' 顆元件');
    if (s.droppedByTheirs) parts.push('對方刪除的 ' + s.droppedByTheirs + ' 顆元件');
    var decided = (res.conflicts || []).length;
    if (decided) parts.push('你選擇的 ' + decided + ' 項衝突');
    return parts.length ? ('已合併：' + parts.join('、')) : '';
  }

  var api = {
    CATS: CATS, NUM_KEYS: NUM_KEYS, STR_KEYS: STR_KEYS, GROUPS: GROUPS, LABELS: LABELS,
    canon: canon, same: same, clone: clone, newCid: newCid,
    normalizeComp: normalizeComp, ensureCids: ensureCids, ensureProjectCids: ensureProjectCids,
    matchLists: matchLists, mergeProject: mergeProject, projectDigest: projectDigest, sameDoc: sameDoc,
    MergePending: MergePending, saveWithMerge: saveWithMerge,
    showConflictDialog: showConflictDialog, toast: toast, summaryText: summaryText,
    fmtUnit: fmtUnit,
    limitRef: limitRef, limitSuspect: limitSuspect,
    LIMIT_REF_TC_TYPES: LIMIT_REF_TC_TYPES, LIMIT_REF_TJ_TYPES: LIMIT_REF_TJ_TYPES, LIMIT_SUSPECTS: LIMIT_SUSPECTS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CompMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
