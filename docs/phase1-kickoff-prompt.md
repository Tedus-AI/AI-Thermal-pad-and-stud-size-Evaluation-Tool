# Phase 1 啟動 Prompt — graphListsDb.js Feedback CRUD

> **使用方式**：複製整份內容（從 `---` 開始那段）到新的 Claude Code session 第一則訊息。
> 這份 prompt 是 self-contained，Claude Code 在乾淨 session 開始也能直接讀懂上下文。

---

我要啟動 Phase 1：寫 `aithermal-tool/graphListsDb.js` 的 feedback CRUD methods。

## 第一步：請依序讀完這幾份檔案，讀完 STOP

在動任何 code 之前，按順序讀完：

1. **`docs/lists-migration.md`** ← 這是 Phase 0 的完整成果，是 Phase 1 的合約。重點看：
   - 「🎉 Phase 0 結案紀錄」（doc 最上方）
   - 「環境資訊」（siteId / listId / scope 狀態）
   - 「Columns 對照表」（17 個欄位的 internal name / type / required / notes）
   - 「已知 Gotchas」**所有章節**（特別是：OData `$` prefix、PATCH endpoint 寫法、dateTime 毫秒 lossy、null dateTime 缺 key、etag 412/resourceModified、JWT atob、MSAL CDN fallback）
   - 「Phase 2 設計：Dual-write UI 策略（設計 C）」
   - 「並行控制機制演進」

2. **`graphDb.js`** ← 既有的 SharePoint JSON 讀寫實作。新的 `graphListsDb.js` 要 **mirror 它的 collection-style API pattern**（method signature 形狀、error handling 風格、MSAL token 取得邏輯）。token 邏輯如果可以**重用**就重用，不要重寫一份。

3. **`config.js`** / **`dbAdapter.js`** / **`fileDb.js`** ← 看結構就好，了解整體 db 抽象怎麼接。

讀完之後 STOP，跟我說「文件讀完了，準備進入 Milestone 1」，**不要直接開始寫 code**。

如果讀的過程中發現 doc 跟既有 code 不一致、或 doc 有 ambiguity，提出來讓我釐清。

## Phase 1 目標

實作 `aithermal-tool/graphListsDb.js`，提供 feedback collection 的完整 CRUD methods，讓 Phase 2 dual-write 能直接使用。

## 嚴格範圍邊界

**DO（允許動）**：
- 新增 `aithermal-tool/graphListsDb.js`
- 修改 `aithermal-tool/config.js`（加 `FEATURE_FLAGS` 區塊）
- 修改 `aithermal-tool/dbAdapter.js`（加路由層，但 default flag false 時行為**完全不變**）

**DO NOT（嚴格禁止動）**：
- ❌ 不動 `index.html` 任何一行
- ❌ 不動 `fileDb.js` / `graphDb.js` 既有邏輯（既有 JSON 鎖、setDoc、deleteDoc 等全部保留）
- ❌ 不動測試 / 部署 / GitHub Actions
- ❌ 不動 5G-RRU repo 任何檔案（這份 Phase 1 只動 AI-Thermal）
- ❌ 不刪除既有任何 method、class、export
- ❌ 不引入新的 npm / CDN 依賴

## 工作方式：4 milestone，每個結束 STOP 給我 review

**不要一次寫完 Phase 1 所有東西**。分 4 個 milestone，每個結束停下來給我看 code + 怎麼驗證。我說「進 Milestone N」才繼續下一個。

---

### Milestone 1：graphListsDb.js 純 List code

實作這 5 個 method（mirror `graphDb.js` 的 collection-style，但只先做 feedback collection）：

```js
listsDb.feedback.add(item)                      // POST /items，回 { id, etag, raw }
listsDb.feedback.get(itemId)                    // GET /items/{id}?$expand=fields
listsDb.feedback.list(filterObj)                // GET /items?$expand=fields[&$filter=...]
listsDb.feedback.update(itemId, fields, etag)   // PATCH /items/{id} + If-Match
listsDb.feedback.delete(itemId, etag)           // DELETE /items/{id} + If-Match
```

要處理：
- **MSAL token 取得**：重用既有 graphDb 的 token logic，**不要重寫**。可以 import 或共用同個 module function
- **所有 9 大 gotchas**，最關鍵這幾個：
  - 所有 OData query parameter 加 `$` prefix（`$expand=fields` / `$filter` / `$orderby`）
  - PATCH endpoint 是 `/items/{id}` + body `{ fields: {...} }`，**不是** `/items/{id}/fields` + 扁平 body
  - 412 / `resourceModified` → throw 自訂的 `ConflictError`（讓 caller 區分並行衝突 vs 其他錯誤）
  - 5 個 indexed columns（Status / Type / Tab / Priority / CreatedAt）查詢不需 Prefer header；其他欄位 `$filter` 預設加 `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` 保險
- **JSON↔List field mapping 暫時用 identity**：先讓 plain POST/GET 跑通，轉換邏輯留到 Milestone 2

**寫完 STOP，提供**：
- file 結構（class / module / exports）
- 5 個 method 各自的 signature + return shape
- 怎麼手動 smoke test（例如：在 browser console 開個 throwaway function 呼叫一次每個 method，或寫一個 `__listsDbSmokeTest()` 全域 function 我手動跑）
- 有任何 design 決策不確定的提出來

---

### Milestone 2：JSON↔List 轉換層

加兩個 pure function 並接到 Milestone 1 的 method 裡：

- **`toListFields(jsonItem)`**：JSON 物件（如 `feedback_items[id]` 整筆）→ POST/PATCH 用的 fields 物件
  - 處理 `attachments` → `FbAttachments: JSON.stringify(attachments)`
  - 處理 JSON 端的空字串 → SharePoint 端 `null`（dateTime 欄位 SharePoint 不接受空字串）
  - 處理 `id` 對應 → `Title` 欄位
  - dateTime 保持 ISO 含毫秒寫入（讓 SharePoint 自己截斷）
  - field name mapping 用 doc 「Columns 對照表」的 internal name

- **`fromListFields(listFields)`**：List GET response.fields → JSON 形狀物件
  - 處理 `ClosedAt` 缺失 → `''`（lossy 反向還原）
  - 處理 dateTime 毫秒缺失（接受 lossy，**不**虛構毫秒補回）
  - `FbAttachments` JSON.parse 回 array
  - 過濾掉 SharePoint 內建欄位（`AuthorLookupId` / `Created` / `Modified` / `Editor` 等）不放進 JSON 形狀

**寫完 STOP，提供**：
- 兩個 function 的單元測試方式
- 怎麼跑 round-trip 驗證：拿現有 baseline item id=5（FB-20260508-113328-DYUP），JSON → toListFields → POST 新筆 → GET → fromListFields → 應該 ≈ 原 JSON（容許已知 lossy）
- 列出測試完要刪掉的 test item id

---

### Milestone 3：feature flags + dbAdapter 包裝

- **`config.js`** 加：
  ```js
  window.FEATURE_FLAGS = {
    DUAL_WRITE_FEEDBACK: false,
    SHOW_DEV_PANEL: false,
    PRIMARY_FEEDBACK: 'json'   // 'json' or 'list'
  };
  ```

- **`dbAdapter.js`** 內部根據 flag 決定走 file/graph/lists，但**只動 feedback_items 這個 collection**，其他 collection（projects/rf_library/digital_library/pwr_library）的邏輯完全不動。

- **Critical 驗證**：default flag 全 false 時，dbAdapter 對 feedback_items 的所有操作行為**跟現在一模一樣**，使用者完全感覺不到任何改變。

**寫完 STOP，提供**：
- 改動清單（dbAdapter 加了哪幾個 if 分支）
- 怎麼跑 regression test：開 index.html，feedback tab 走一遍既有完整流程（新增 / 編輯 / 刪除 / 載入），確認跟改動前行為一致
- 怎麼啟用 dual-write 試試：把 `DUAL_WRITE_FEEDBACK: true`，submit 一筆，預期 JSON 跟 List 兩邊都有資料

---

### Milestone 4：Phase 1 收尾

- 更新 `docs/lists-migration.md`：
  - Phase 1 checklist 全打勾
  - 加 Phase 1 的 retrospective（有沒有跟 doc 不符的地方、有沒有新發現的 gotcha）
  - 列出 Phase 2 啟動條件
- 跑一次 full smoke test 報告

**寫完 STOP，跟我說「Phase 1 結束，等候 review」**

---

## Code Style 提醒

- ES6+ class 或 module pattern 都可以，但要跟既有 `graphDb.js` 風格一致
- Error class：`class ConflictError extends Error` 區分 412 vs 其他錯誤（class name 跟既有保持一致；若已有就重用）
- 不要引入新的 npm/CDN 依賴（純 fetch + 既有 MSAL）
- Comment 寫繁體中文 OK，跟既有 code 一致
- **不要做提早優化**（例如 caching layer / batch queue / retry decorator），這些等 Phase 2 之後有實際需求再加

## 你不用再驗證的事（Phase 0 已實測過）

doc 裡都有，提示一下這幾個關鍵點：
- `siteId` / `listId` 已 hardcode 在 doc，**不用重新查**
- 5 個 columns 已 indexed（Status / Type / Tab / Priority / CreatedAt），`$filter` 不需 Prefer header
- `Sites.ReadWrite.All` scope 已生效
- Feedback List 上有 baseline item id=5（FB-20260508-113328-DYUP），可以拿來做 Milestone 2 round-trip reference
- MSAL CDN `alcdn.msauth.net` 在 Tedus 公司網路可能被擋，但既有 `index.html` 引用的 v2.38 目前還是能跑（這個課題留到日後另議，不在 Phase 1 範圍）

## Token 效率提醒

我注意 Claude Code session 的 token 消耗。請：
- 用 `str_replace` 而不是整檔覆寫
- 不要重複貼大段既有 code 在回覆裡，只貼 diff
- Milestone 之間我會 review，**review 期間不要 proactively 寫下個 milestone**，等我說「進 Milestone N」

---

**第一個動作：讀 `docs/lists-migration.md`，讀完跟我說「文件讀完了，準備進入 Milestone 1」**。

如果讀的過程中有任何疑問或發現 doc/code 不一致，**先提問再開工**。
