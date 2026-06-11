# Claude Code 啟動說明

## 共用資料庫（thermal_db.json）寫入規則 ⚠️

本工具與 `5G-RRU-Quick-Volume-Evaluation-Tool` **共用同一份 `thermal_db.json`**。多工具寫同一份 DB 時，**永遠不要假設自己擁有整顆 document**。

### Schema 概觀

頂層 collections（各工具會用到的 keys 用括號標註）：

```
{
  "rf_library":      { ... },   // 共用
  "digital_library": { ... },   // 共用
  "pwr_library":     { ... },   // 共用
  "projects": {
    "<project_id>": {
      // 5G-RRU 寫: meta, project_name, global_params, rf_data, digital_data, pwr_data
      // AI-Thermal Tab2 寫: thermal_specs, hidden_components,
      //                     param_temp, param_temp_custom,
      //                     param_backoff, param_backoff_rt,
      //                     param_duplex, param_duplex_rt,
      //                     tcPlacement
      // AI-Thermal Tab3 寫: validation_data, vd_hidden_components
      // global_params 兩邊都會碰（key set 幾乎重疊但不完全相同，例如 Draft_Angle 只有 RRU 有）
    }
  },
  "feedback_items":  { ... },   // AI-Thermal Tab5
  "version":         <number>
}
```

### 規則

1. **存 project 一律用 `updateDoc('projects', id, fields)`，不要用 `setDoc`。**
   `setDoc(col, id, data)` 是「整顆 document 替換」，會把其他工具寫進去但你不認識的欄位全部抹掉。
   `updateDoc` 在 `fileDb` / `graphDb` 都是 shallow merge，是安全做法。
2. **`global_params` 是 nested object，shallow merge 救不了它。** 寫之前要先 `getDoc` 把舊的 `global_params` 撈出來，把自己的 keys 蓋上去再寫回，否則對方工具獨有的 key（例如 `Draft_Angle`、`fin_tech_selector_v2`）會被吃掉。
3. **新加欄位前先想：這個欄位該掛在 `projects[id]` 底下，還是另開一個頂層 collection？**
   頂層 collection（像 `feedback_items`）天然就跟其他工具的寫入隔離；放進 `projects[id]` 就要遵守上面兩條。
4. **跨工具共用 schema 變更時，兩個 repo 的 CLAUDE.md 都要同步更新本段表格。**
5. **壞檔唯讀保護（兩個 repo 的 DB backend 都必須具備）**：`_readFile` 解析失敗時
   **絕不可** fallback 成空骨架（否則下一次寫入會把整份共用 DB 抹掉），必須保留舊快取、
   設 `dbCorrupted = true` 進入唯讀；`_writeFile` 開頭一律過 `_assertWritable`：
   (a) `dbCorrupted` → 拒寫；(b) `projects` 筆數從本 session 高水位（非零）突然歸零
   且非刻意刪除（`deleteDoc('projects', …)` 例外放行並下修基準）→ 拒寫。
   只有「內容為空字串的全新檔案」才允許 bootstrap 空骨架。
   參考實作：本 repo 的 `fileDb.js` / `graphDb.js`（`_assertWritable`、`maxProjectsSeen`），
   對應 5G-RRU PR #64。

### 反例（造成 Bug 的寫法）

```js
// ❌ 會抹掉 thermal_specs / validation_data / tcPlacement / param_* / hidden_components 等
const d = { meta, project_name, global_params, rf_data, digital_data, pwr_data };
await dbAdapter.setDoc('projects', docId, d);
```

### 正確寫法

```js
// ✅ 保留 sibling tool 寫入的欄位
const existing = await dbAdapter.getDoc('projects', docId) || {};
const mergedGlobals = { ...(existing.global_params || {}), ...myGlobals };
await dbAdapter.updateDoc('projects', docId, {
  meta, project_name,
  global_params: mergedGlobals,
  rf_data, digital_data, pwr_data,
});
```

參考歷史 fix：5G-RRU PR #53（`claude/fix-database-overwrite-bug-W1bT1`）。

## 軟體版本戳記是「自動」的，不要手改 ⚠️

本工具有一套「使用者載入到舊版會被醒目橫幅提醒更新」的機制，版本號**完全由 CI 自動產生**，
任何 session（包含未來的你）改 code 時**都不需要、也不應該手動更新版本號**。

### 運作方式

- 原始碼裡只放佔位符 `__APP_VERSION__`（出現在 `index.html` 的 `window.APP_VERSION`、
  6 支本地 JS 的 `?v=__APP_VERSION__` 快取戳記、以及 `version.json`）。
- `.github/workflows/deploy-pages.yml` 在每次 push 到 `main` 時，用
  `TZ='Asia/Taipei' date +%Y.%m.%d.%H%M`＋短 SHA 算出版本號，`sed` 戳進上述佔位符，
  再部署到 GitHub Pages。**因此每次 push 都會自動戳新版本，不靠人記憶。**
- 前端（`index.html` 的 `setupUpdateChecker`）載入後延遲首檢、每 5 分鐘、切回分頁時，
  以 `cache:'no-store'` 抓 `version.json` 與烙印的 `APP_VERSION` 比對；不同才跳橫幅，
  相同則完全靜默。

### 規則

1. **不要把 `__APP_VERSION__` 換成真實版本字串**，那是 CI 的工作。新增需要快取戳記的
   本地 JS 時，在 script 標籤後面加 `?v=__APP_VERSION__` 即可。
2. **停用偵測的守衛刻意寫成 `'__APP_' + 'VERSION__'`**（拆字串），這樣 CI 的
   `sed s/__APP_VERSION__/.../g` 不會把它換掉、導致 production 誤判為「未戳版本」而停用偵測。
   改這段時務必保持拆字串寫法。
3. **GitHub Pages 的 Source 必須設為「GitHub Actions」**（Settings → Pages），
   否則 workflow 戳的版本不會上線。
4. 參考 PR #140（`claude/version-conflict-single-user-IQ20W`）。
