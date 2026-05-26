# Phase 2 啟動 Prompt — Dual-write 上線

> **使用時機**：Phase 1 結案後冷卻期過完（建議 3–7 天無異常），準備啟動 dual-write。
> 複製整份內容（從 `---` 開始那段）貼到新的 Claude Code session。

---

我要啟動 Phase 2：Dual-write 上線（採用「設計 C：透明寫入 + 顯式驗證讀取」）。

## 第一步：請依序讀完這幾份檔案

在動任何 code 之前，按順序讀完：

1. **`docs/lists-migration.md`** ← 重點章節：
   - 「Milestone 進度」確認 Phase 1 已 100% 完成
   - 「Phase 2 設計：Dual-write UI 策略（設計 C）」← Phase 2 的完整規格
   - 「並行控制機制演進」← 鎖怎麼共存
   - 「Dual-write 期間的回退保險」← rollback 機制
   - 「已知 Gotchas」**全部章節**

2. **`graphListsDb.js`** ← Phase 1 完成的 List 端實作
3. **`dbAdapter.js`** ← Phase 1 加的路由邏輯（feedback 那段）
4. **`config.js`** ← FEATURE_FLAGS 區塊
5. **`index.html`** ← 重點：
   - `fbSubmitFeedback()` 函式（在 8481 行附近）
   - Tab5 feedback 區塊的 HTML 結構
   - `switchTab()` / `fbOnTabActivate()` 函式（切到 Tab5 時的 hook 點；注意：實際函式名為 `switchTab()`，切到 feedback 時呼叫 `fbOnTabActivate()`，**不是** `fbSwitchTab()`）

讀完之後 STOP，跟我說「文件讀完了，準備進入 Phase 2 實作」，**不要直接開始寫 code**。

如果讀的過程中發現：
- doc 跟 code 不一致
- Phase 1 留下的 TODO 還沒處理
- 任何潛在阻擋

**先提問再開工**。

## Phase 2 範圍

實作「設計 C」：

| 行為 | 目標 |
|---|---|
| **寫入** | 透明 dual-write，使用者按一次「儲存回饋」同時寫 JSON + List |
| **讀取（一般）** | 維持讀 JSON（PRIMARY_FEEDBACK='json'） |
| **讀取（驗證）** | 加開發者驗證區（摺疊式），給 Tedus 個人手動比對 |

## 嚴格範圍邊界

**DO（允許動）**：
- 修改 `index.html`：
  - 加 `<script src="graphListsDb.js"></script>`
  - 修改 `fbSubmitFeedback()` 加 dual-write 邏輯
  - 加開發者驗證區 HTML + CSS
  - 加 `fbCompareWithList()` / `fbShowDualWriteLog()` / `fbForceListPush()` 三個 function
  - 修改 `fbOnTabActivate()` 在 feedback tab 啟用時根據 SHOW_DEV_PANEL flag 顯示驗證區（**不是 switchTab()，那是全 app 共用 tab switcher**）
- 修改 `config.js`：保持 flags 結構，但 default 仍全 false
- 修改 `dbAdapter.js`：完善 dual-write 路由邏輯（如果 Phase 1 還沒完整）

**DO NOT（嚴格禁止動）**：
- ❌ 不動 `graphListsDb.js`（Phase 1 已完成，Phase 2 只是接上）
- ❌ 不動 `graphDb.js` / `fileDb.js` 既有邏輯
- ❌ 不引入新的 npm/CDN 依賴
- ❌ 不要在沒明確指示下啟用 FEATURE_FLAGS（保持 false，由 Tedus 親手 commit 啟用）
- ❌ 不動 5G-RRU repo

## 工作方式：4 milestone，每個結束 STOP 給我 review

### Milestone 2.1：透明 dual-write 寫入端 ✅（PR #113 已 merge）

**內容**：
- `index.html` 加 `<script src="graphListsDb.js"></script>`（插在 `graphDb.js` 之後、`dbAdapter.js` 之前）✅
- 確認 `fbSubmitFeedback()` → `fbSaveItem()` → `dbAdapter.setDoc()` 這條路徑跟 Phase 1 M3 已實作的 shadow-write 路由正確銜接
  - Phase 1 M3 在 `dbAdapter.setDoc('feedback_items', ...)` 內部已實作 fire-and-forget shadow write + `_fbLog` 記錄
  - **不要在 `fbSubmitFeedback()` 重複加 shadow write 邏輯**
  - **不要在 index.html 另立 `_dualWriteLog`**，Milestone 2.3 的 `fbShowDualWriteLog()` 直接讀 `dbAdapter.getDualWriteLog()`
- 確認 `graphListsDb.js` 沒載入時 `dbAdapter._shadowAdd()` 會 silently bail out（無 ReferenceError）✅

**Review 點**：
- flag 仍 default false，使用者完全無感 ✅
- flag 開啟測試時，JSON 寫入失敗等於整個操作失敗（既有行為）
- flag 開啟測試時，List 寫入失敗不影響使用者，但記到 `_fbLog`
- 不存在「shadow write 改成 await 同步等待」的需求（fire-and-forget 是設計選擇，避免 List throttle 拖慢使用者）

### Milestone 2.2：開發者驗證區 UI

**內容**：
- Tab5 工具列底部加摺疊式 `<details>` 結構
- 三個按鈕：
  - 📋 從 List 載入這筆並比對
  - 📝 dual-write log（最近 20 筆）
  - ⬆️ 強制 push 所有 JSON 到 List
- 一個 `<div id="fb-dev-output">` 結果展示區
- `fbOnTabActivate()` 內根據 `FEATURE_FLAGS.SHOW_DEV_PANEL` 決定 display（**不動 `switchTab()`**）
- 同時在 `fbShowDetail(id)` 開頭加 `window._currentFbItemId = id`；`fbCloseDetail()` 加 `window._currentFbItemId = null`（供 `fbCompareWithList()` 使用）

**Review 點**：
- SHOW_DEV_PANEL=false 時，正式使用者完全看不到驗證區
- SHOW_DEV_PANEL=true 時，驗證區出現但**預設摺疊**（不主動展開）
- UI 風格跟既有 Tab5 一致，不要突兀

### Milestone 2.3：三個驗證 function 實作

**內容**：
- **`fbCompareWithList()`**：當下開啟某筆 feedback 詳情時觸發
  - 從 `window._currentFbItemId` 取得當下開啟的 feedback id（`fbShowDetail()` 設入，`fbCloseDetail()` 清空）
  - 從 JSON 拿該筆：透過 `dbAdapter.getDoc('feedback_items', id)`
  - 從 List 拿該筆：用 `graphListsDb.feedback.list({ Title: id })` + 取 `[0]`（Title 已 indexed，效能 OK；**不加 `findByFeedbackId` method**）
  - 處理「List 找不到該筆」的情況（提示「可能還沒 dual-write 過」）
  - 用 `graphListsDb.fromListFields()` 還原成 JSON 形狀後再 diff
  - 並排顯示 + diff 視覺化（三種狀態：✅完全一致 / ⚠️已知lossy / ❌真diff）
  
- **`fbShowDualWriteLog()`**：呼叫 `dbAdapter.getDualWriteLog()` 取最近 20 筆，顯示 timestamp + id + ok/fail + error msg（**不讀 `_dualWriteLog`，直接讀 dbAdapter 的 `_fbLog`**）

- **`fbForceListPush()`**：
  - confirm 對話框（強調這是一次性同步工具）
  - 讀所有 `feedback_items` from JSON
  - 對每筆呼叫 `graphListsDb.feedback.upsert()`（已存在則 PATCH，不存在則 POST，需要新加 method 或用 add + fallback）
  - 結束彈出「成功 N / 失敗 M」

**Review 點**：
- diff 視覺化的「已知 lossy」清單：`created_at`/`updated_at`/`closed_at`（如果是 null 與空字串差異）
- forceListPush 不會無限重試、有明確失敗回報
- 三個 function 都不會在沒按按鈕時自動觸發

### Milestone 2.4：Phase 2 啟動前最終測試 + Doc 更新

**內容**：
- 寫一份「Phase 2 啟動 checklist」給 Tedus 手動驗證：
  - [ ] FEATURE_FLAGS 全 false 時行為跟 Phase 1 結尾完全一致
  - [ ] 只開 SHOW_DEV_PANEL=true 時，看得到驗證區但 dual-write 還沒啟動
  - [ ] 開 SHOW_DEV_PANEL + DUAL_WRITE_FEEDBACK，submit 一筆，JSON 跟 List 都有
  - [ ] 用 fbCompareWithList 載入該筆，diff 結果符合預期（已知 lossy 黃色 ⚠️，其他全綠 ✅）
  - [ ] 用 fbForceListPush 跑一次，確認既有 JSON feedback 全部同步到 List
  - [ ] dual-write log 顯示正常
  
- 更新 `docs/lists-migration.md`：
  - Milestone 進度打勾 2.1-2.4
  - Phase 2 啟動 retrospective（有沒有新 gotcha）
  - 加一節「Phase 2 啟動後 7 天觀察期 checklist」

**寫完 STOP，提供**：
- Phase 2 啟動 checklist（Tedus 手動跑的）
- 預期 commit history
- 啟用 flag 的具體 git workflow（建議用一個 separate commit 「Enable dual-write for feedback」方便回滾）

---

## Code Style 提醒

- 跟既有 `index.html` 風格一致（function 命名 `fb*`、CSS class `fb-*`）
- diff 視覺化用 inline CSS 或 `<style>` block，**不要引入外部 CSS framework**
- 中文 UI 字串
- console.warn / console.error 使用既有風格

## 你不用再驗證的事

- siteId / listId / scope / Lists schema：Phase 0 已凍結
- graphListsDb CRUD：Phase 1 驗過
- ConflictError instanceof 跨 module 邊界：Milestone 2 驗過
- dbAdapter 路由邏輯：Phase 1 M3 驗過

## Token 效率提醒

- 用 `str_replace` 不要整檔覆寫（特別 index.html 很大）
- 不要重複貼 Phase 1 的 code 在回覆
- Milestone 之間 STOP 等 review，不要 proactively 寫下個

---

**第一個動作：讀檔案，讀完跟我說「文件讀完了，準備進入 Milestone 2.1」**。

如果讀的過程中有任何疑問或發現 doc/code 不一致，**先提問再開工**。
