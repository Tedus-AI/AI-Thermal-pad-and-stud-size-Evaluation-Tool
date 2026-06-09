# Prompt：把 5G-RRU 的「快選」改成 AI-Thermal 的快選架構（並保留 5G-RRU 專屬欄位）

> 用法：開一個同時掛載「AI-Thermal」與「5G-RRU」兩個 repo 的新 session，把本檔
> 「==== PROMPT 開始 ====」到「==== PROMPT 結束 ====」之間的內容整段貼給它。
> 後半段「附錄：AI-Thermal 快選程式碼原文」是參考實作，可一併貼，或讓新 session 直接讀 AI-Thermal/index.html。

---

==== PROMPT 開始 ====

# 任務：把 5G-RRU 的「快選」改成 AI-Thermal 的快選架構（並保留 5G-RRU 專屬欄位）

## 背景
這個 session 同時有兩個 repo，它們**共用同一份 thermal_db.json**：
- **AI-Thermal**（AI-Thermal-pad-and-stud-size-Evaluation-Tool）：**參考來源**，快選架構已經是目標樣子，不要改它的功能。
- **5G-RRU**（5G-RRU-Quick-Volume-Evaluation-Tool）：**修改目標**，要把它的「📚 從資料庫快選」改成跟 AI-Thermal 一樣的架構。

兩個 repo 根目錄都有 CLAUDE.md，**務必先讀**（共用 DB 寫入規則、版本戳記自動化規則）。

## 目標架構（AI-Thermal 的快選長怎樣）
AI-Thermal 的「📚 從資料庫快選」是「**跨專案即時聚合 + 白名單複製**」。關鍵元件（用函式/常數名找，行號會漂移；原文見本 prompt 附錄）：
- `SG_VARIANT_CARRY`（const）：複製元件時要一併帶過去的**欄位白名單**。
- `sgAggregateVariants(projects, category)`：**純讀取**，掃整個 projects collection，依「元件名稱 + Power(W)」聚合成 variant 清單；去重時用 `meta.timestamp` 取最早建立者；`src` 只收 `SG_VARIANT_CARRY` 內的欄位。
- `sgLoadVariantsCache()` / `sgVariantsCache` / `sgVariantsLoading`：讀一次 `getCollection('projects')` 聚合三分類（RF/Digital/PWR）並快取；`sgVariantsCache = null` 在專案集合變動（刪專案等）時失效重載。
- `sgMakeComp(cat, overrides)`：依分類的**固定欄位模板**（配 `SG_DEFAULTS`）建一顆元件。
- `sgAddFromVariant(cat)`：把選到的 variant 用 `sgMakeComp(cat, { Component, ...v.src, _ref_origin_project, _ref_origin_id, _ref_locked:true })` push 進目前專案的 rf_data/digital_data/pwr_data，並標記「參照」（瓦數鎖定 + 記來源）。
- `sgDetachRef(cat, idx)`：解除參照（解鎖瓦數使其可編輯，保留來源追溯）。
- UI：`📚 從資料庫快選：` label + `sg-lib-sel-<cat>` 下拉 + 載入中狀態（找 `sg-lib-label`、`quickAdd`）。
- **重要設計**：存檔時**不再自動 upsert 到共用 \*_library**；快選一律即時掃 projects 聚合（避免累積孤兒、也不再無聲覆寫共用目錄）。

## 核心要求：保留「5G-RRU 專屬欄位數值」（重點，分兩層）

### 第①層 — 每顆元件上的 RRU 專屬欄位（最容易掉值）
AI-Thermal 的快選是「白名單複製」，只帶 `SG_VARIANT_CARRY` + `sgMakeComp` 模板裡的欄位，**其餘欄位在複製時會被丟掉**。
移植到 5G-RRU 時**必須**：
1. 先盤點 5G-RRU 每顆元件（rf_data/digital_data/pwr_data 內的物件）實際有哪些欄位 —— 拿幾筆現有專案的元件物件出來列 keys。
2. 把 5G-RRU 專屬的每元件欄位**全部加進移植版的 carry 白名單，並補進 `sgMakeComp` 模板（或當 overrides 帶入）**。
3. 確認改完後「快選一顆 → 它的 RRU 專屬欄位值都還在」。

### 第②層 — 專案層級 / 別工具的欄位（存檔時才會被吃掉）
快選是純讀，不會刪這些；真正風險在**存檔**。務必遵守共用 DB 規則（見兩邊 CLAUDE.md）：
- 存 project 一律 `updateDoc`（shallow merge），**絕不用 `setDoc`** 整顆替換。
- `global_params` 是巢狀物件，shallow merge 救不了 → 寫前先 `getDoc` 撈舊的，把自己的 keys merge 上去再寫回（否則 RRU 專屬的 `Draft_Angle`、`fin_tech_selector_v2` 等會被吃掉）。
- 不要動到 AI-Thermal 寫的欄位：`thermal_specs`、`hidden_components`、`validation_data`、`vd_hidden_components`、`param_*`、`tcPlacement`。

## 執行步驟
1. 讀兩邊 CLAUDE.md + AI-Thermal index.html 的上述快選函式（當規格；或直接用本 prompt 附錄）。
2. 讀 5G-RRU index.html：現有快選怎麼做（可能是吃 \*_library）、元件 schema、存檔（save/write）路徑。
3. 盤點 5G-RRU 每元件欄位 + `global_params` 的 RRU 專屬 keys。
4. 在 5G-RRU 實作快選移植：跨專案聚合 + 白名單（**含 RRU 專屬欄位**）+ 固定模板 + 參照標記/解除。
5. 檢查存檔路徑符合 `updateDoc` / `global_params` deep-merge 規則（若原本就對，就別亂改）。
6. 若有共用 schema 變更，**兩個 repo 的 CLAUDE.md 對照表都要同步更新**（CLAUDE.md 規則 4）。
7. **不要手改 `__APP_VERSION__`**（版本號由 CI 自動戳，見 CLAUDE.md）。

## 驗收清單
- [ ] 5G-RRU 快選變成跨專案即時聚合（不依賴 \*_library 也能列出元件）。
- [ ] 快選加入一顆元件 → 它的 RRU 專屬每元件欄位值都完整帶入（沒掉值）。
- [ ] 存檔後重載：該專案的 `global_params`（含 `Draft_Angle` 等）與 AI-Thermal 寫的欄位都還在。
- [ ] 用 AI-Thermal 開同一份 DB，`thermal_specs` / `validation_data` 等沒被 5G-RRU 存檔吃掉。
- [ ] 參照鎖定 / 解除行為與 AI-Thermal 一致。

## 分支與提交
- 在各 repo 指定的開發分支上開發、commit、push（沿用該 repo 的分支慣例；不確定就先問或開新分支）。
- push 後若無 PR 則開 draft PR。

==== PROMPT 結束 ====

---

# 附錄：AI-Thermal 快選程式碼原文（參考實作，照抄改即可）

> 來源：AI-Thermal/index.html。函式內以 `sg` 前綴，分類為 RF / Digital / PWR。
> 移植時的兩個改點：(1) `SG_VARIANT_CARRY` 與 `sgMakeComp` 要補上 5G-RRU 專屬每元件欄位；
> (2) 5G-RRU 的分類/預設值（`SG_CAT_MAP` / `SG_DEFAULTS`）以 5G-RRU 為準。

## 分類對應與預設值

```js
const SG_CAT_MAP = {
  RF:      { field: 'rf_data',      label: 'RF 射頻元件',     css: 'rf',      icon: '&#128225;', collection: 'rf_library' },
  Digital: { field: 'digital_data', label: 'Digital 數位元件', css: 'digital', icon: '&#128178;', collection: 'digital_library' },
  PWR:     { field: 'pwr_data',     label: 'PWR 電源元件',    css: 'pwr',     icon: '&#9889;',   collection: 'pwr_library' }
};

const SG_DEFAULTS = {
  RF:      { height: 250, padL: 10, padW: 10, thick: 2.5, boardType: 'Copper Coin', limit: 200, rjc: 1.5, timType: 'Grease' },
  Digital: { height: 50,  padL: 10, padW: 10, thick: 0,   boardType: 'Thermal Via', limit: 100, rjc: 0.5, timType: 'Putty' },
  PWR:     { height: 30,  padL: 20, padW: 20, thick: 0,   boardType: 'None',        limit: 95,  rjc: 0,   timType: 'Grease' }
};
```

## variant 聚合（跨專案、純讀取）

```js
let sgVariantsCache = null;      // { RF:[...], Digital:[...], PWR:[...] } 或 null（未載入）
let sgVariantsLoading = false;

/* 從資料庫快選複製元件時，要一併帶過去的 Tab1 欄位（Type / Thermal Via / Temp Sensor / 備註 等） */
/* ⚠ 移植到 5G-RRU 時，把 5G-RRU 專屬的每元件欄位也加進這份白名單 */
const SG_VARIANT_CARRY = ['Type','Qty','Power(W)','Power_RT(W)','TV_ID_mil','TV_Qty','Temp_Sensor','Local_Qty','Remote_Qty','note'];

/* 純函式：用一份 projects 物件聚合出某分類的 variant 陣列 */
function sgAggregateVariants(projects, category) {
  const field = SG_CAT_MAP[category]?.field;
  if (!field) return [];
  const byKey = new Map();   // key = `${name} ${power}` -> variant（保留最早建立者）
  for (const [pid, proj] of Object.entries(projects || {})) {
    const items = Array.isArray(proj?.[field]) ? proj[field] : [];
    const projName = proj?.project_name || pid;
    const ts = Date.parse(proj?.meta?.timestamp || '') || Infinity;   // 無時戳 -> 最晚，不誤判為 origin
    for (const comp of items) {
      const name = String(comp?.Component || '').trim();
      if (!name) continue;
      const power = comp?.['Power(W)'] ?? '';
      const key = name + ' ' + String(power);
      const prev = byKey.get(key);
      if (!prev || ts < prev._ts) {
        const src = {};
        SG_VARIANT_CARRY.forEach(k => { if (comp[k] !== undefined) src[k] = comp[k]; });
        byKey.set(key, {
          name, power,
          power_rt: comp?.['Power_RT(W)'] ?? '',
          qty: comp?.Qty ?? 1,
          originProjectName: projName,
          originProjectId: pid,
          src,
          _ts: ts,
        });
      }
    }
  }
  return Array.from(byKey.values()).map(({ _ts, ...v }) => v)
    .sort((a, b) => a.name.localeCompare(b.name) || (parseFloat(a.power) || 0) - (parseFloat(b.power) || 0));
}

/* 讀一次 projects，聚合三個分類並快取到 sgVariantsCache */
async function sgLoadVariantsCache() {
  let projects;
  try {
    projects = await dbAdapter.getCollection('projects');
  } catch (e) {
    console.warn('[variants] 讀取 projects 失敗：', e);
    sgVariantsCache = { RF: [], Digital: [], PWR: [] };
    return sgVariantsCache;
  }
  sgVariantsCache = {
    RF:      sgAggregateVariants(projects, 'RF'),
    Digital: sgAggregateVariants(projects, 'Digital'),
    PWR:     sgAggregateVariants(projects, 'PWR'),
  };
  return sgVariantsCache;
}

/* 單一分類（console 驗證用）：await sgDebugVariants('RF' | 'Digital' | 'PWR') */
async function sgCollectComponentVariants(category) {
  let projects;
  try { projects = await dbAdapter.getCollection('projects'); }
  catch (e) { console.warn('[variants] 讀取 projects 失敗：', e); return []; }
  return sgAggregateVariants(projects, category);
}
async function sgDebugVariants(category = 'RF') {
  const list = await sgCollectComponentVariants(category);
  try { console.table(list); } catch (_) { console.log(list); }
  console.info(`[variants] ${category}：跨全部專案聚合得 ${list.length} 筆`);
  return list;
}
window.sgDebugVariants = sgDebugVariants;
```

## 建立元件模板 + 從 variant 加入 + 解除參照

```js
/* 依分類預設建立一顆元件物件（可帶 overrides），供新增空白列 / 從資料庫快選共用 */
/* ⚠ 移植到 5G-RRU 時，模板要包含 5G-RRU 專屬的每元件欄位 */
function sgMakeComp(cat, overrides) {
  const d = SG_DEFAULTS[cat];
  return Object.assign({
    Component: '', Type: '', Qty: 1, 'Power(W)': '', 'Power_RT(W)': '',
    TV_ID_mil: 'N/A', TV_Qty: 'N/A',
    'Height(mm)': d.height, Pad_L: d.padL, Pad_W: d.padW, 'Thick(mm)': d.thick,
    Board_Type: d.boardType, 'Limit(C)': d.limit, R_jc: d.rjc, TIM_Type: d.timType,
    Temp_Sensor: 'N', Local_Qty: '', Remote_Qty: '',
  }, overrides || {});
}

/* 從資料庫快選新增一顆元件到目前專案 */
function sgAddFromVariant(cat) {
  if (!sgProjectData) return;
  const sel = document.getElementById('sg-lib-sel-' + cat);
  if (!sel || sel.value === '') return;
  const v = (sgVariantsCache?.[cat] || [])[parseInt(sel.value, 10)];
  if (!v) return;
  const fieldKey = SG_CAT_MAP[cat].field;
  if (!sgProjectData[fieldKey]) sgProjectData[fieldKey] = [];
  // 帶齊來源元件的欄位，並標記為「參照」：瓦數鎖定、記錄來源專案，避免改到舊案已驗證的值。
  sgProjectData[fieldKey].push(sgMakeComp(cat, {
    Component: v.name,
    ...(v.src || {}),
    _ref_origin_project: v.originProjectName,
    _ref_origin_id: v.originProjectId,
    _ref_locked: true,
  }));
  sgRenderProjectComponents();
}

/* 解除參照：解鎖瓦數使其可編輯；保留 _ref_origin_* 以淡灰「曾參照自 X」追溯。 */
function sgDetachRef(cat, idx) {
  const fieldKey = SG_CAT_MAP[cat]?.field;
  const comp = sgProjectData?.[fieldKey]?.[idx];
  if (!comp) return;
  comp._ref_locked = false;
  sgRenderProjectComponents();
}
```

## UI：在 render 中觸發快取載入 + 快選下拉

```js
// 在 sgRenderProjectComponents() 內：首次/失效時載入 variant 快取，完成後重繪
if (sgVariantsCache === null && !sgVariantsLoading) {
  sgVariantsLoading = true;
  sgLoadVariantsCache().finally(() => { sgVariantsLoading = false; sgRenderProjectComponents(); });
}

// 每個分類的快選下拉（vopts 已用 presentNames 過濾掉目前專案已存在的元件）：
const quickAdd = (sgVariantsCache === null)
  ? `<span class="sg-lib-label">📚 從資料庫快選：</span><select disabled><option>載入中…</option></select>`
  : `<span class="sg-lib-label">📚 從資料庫快選：</span>
     <select id="sg-lib-sel-${catKey}">
       <option value="">${vopts ? '（請選擇：名稱・瓦數・來源專案）' : '（目前無可新增的元件）'}</option>
       ${vopts}
     </select>
     <button class="sg-comp-add-btn" onclick="sgAddFromVariant('${catKey}')">&#10133; 加入</button>`;
```

## 快取失效時機（專案集合改變時）

```js
// 例：刪除專案後
sgVariantsCache = null;          // 專案集合改變 → 失效快選快取
await sgLoadProjects();          // 重讀並刷新下拉
```

## 存檔路徑（共用 DB 安全寫法的範例 — 用 update，不用 setDoc）

```js
// AI-Thermal 的存檔：用 update ops（shallow merge），只寫自己擁有的 keys
const ops = [];
ops.push({ type: 'update', col: 'projects', id: sgProjectId, fields: {
  rf_data: sgProjectData.rf_data || [],
  digital_data: sgProjectData.digital_data || [],
  pwr_data: sgProjectData.pwr_data || [],
  param_temp: sgProjectData.param_temp || '55',
  param_temp_custom: sgProjectData.param_temp_custom || '',
  param_backoff: sgProjectData.param_backoff || '',
  param_duplex: sgProjectData.param_duplex || 'TDD 75%',
  param_backoff_rt: sgProjectData.param_backoff_rt || '',
  param_duplex_rt: sgProjectData.param_duplex_rt || 'TDD 75%',
  tcPlacement: tcpStripTransient(sgProjectData.tcPlacement)
} });
await dbAdapter.writeBatch(ops);
// 註：本工具不再「存檔時自動 upsert 元件到共用 *_library」。
// ⚠ 5G-RRU 若有寫 global_params，記得先 getDoc 撈舊的再 deep-merge（見 CLAUDE.md 規則 2）。
```
