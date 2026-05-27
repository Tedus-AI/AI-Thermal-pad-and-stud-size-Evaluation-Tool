# Phase 3 啟動 Prompt — Shadow-read + 自動 Diff Verification

> **使用時機**：Phase 2 dual-write 已啟動且驗證資料一致（手動抽查 3 筆全綠），
> 準備從「使用者手動點按鈕比對」升級到「工具自動 shadow-read + 累積 diff log」。
> 複製整份內容（從 `---` 開始那段）貼到新的 Claude Code session。

---

我要啟動 Phase 3：Shadow-read + 自動 diff verification。

## 第一步：請依序讀完這幾份檔案

在動任何 code 之前，按順序讀完：

1. **`docs/lists-migration.md`** ← 重點章節：
   - 「Milestone 進度」確認 Phase 2 已 100% 完成
   - 「Phase 2 設計：Dual-write UI 策略（設計 C）」← 理解既有比對邏輯
   - 「並行控制機制演進」
   - 「已知 Gotchas」**全部章節**（特別是 dateTime / closed_at lossy）

2. **`docs/phase2-activation-checklist.md`** ← 確認 Phase 2 啟動狀態

3. **`graphListsDb.js`** ← list / get 邏輯
4. **`dbAdapter.js`** ← 現有 dual-write 路由
5. **`config.js`** ← FEATURE_FLAGS
6. **`index.html`** ← 重點：
   - `fbCompareWithList()` 函式（Phase 2 已寫的手動比對邏輯，要參考其 normalize/diff 邏輯）
   - `dbAdapter.getDoc('feedback_items', id)` 的呼叫端

讀完之後 STOP，跟我說「文件讀完了，準備進入 Phase 3 設計討論」，**不要直接開始寫 code**。

## Phase 3 目標

實作「自動 shadow-read」：

| 行為 | 目標 |
|---|---|
| **使用者讀 feedback（一般情境）** | 跟現在一樣讀 JSON，毫秒級回應，**完全不被 shadow-read 拖慢** |
| **背景** | 工具偷偷讀 List 端同樣資料，自動 diff JSON vs List |
| **diff 不一致時** | 記到 `_shadowReadLog`，**不彈出錯誤、不打擾使用者** |
| **維護者（Tedus）查看** | 開發者驗證區加新按鈕「查看 shadow-read diff 報告」 |

## 嚴格範圍邊界

**DO（允許動）**：
- 修改 `dbAdapter.js`：加 shadow-read 邏輯（在 `getDoc('feedback_items', id)` 內）
- 修改 `index.html`：開發者驗證區加新按鈕 + 結果顯示
- 修改 `config.js`：加新 flag `SHADOW_READ_FEEDBACK`（default false）
- 在 `dbAdapter` 內新增 `_shadowReadLog` array + `getShadowReadLog()` public method

**DO NOT（嚴格禁止動）**：
- ❌ 不動 `graphListsDb.js`（讀邏輯已存在）
- ❌ 不改 primary read 路徑（JSON 讀取流程**完全不變**）
- ❌ 不讓 shadow-read 失敗影響使用者操作
- ❌ 不引入新的 npm/CDN 依賴
- ❌ 不要在沒明確指示下啟用 SHADOW_READ_FEEDBACK（保持 false）
- ❌ **絕對不要改變 `getDoc()` 的 return 行為**——shadow-read 是 fire-and-forget，
     primary read 立刻回傳 JSON 端資料

## 關鍵設計原則

### 1. Primary read 永遠先回傳

```js
async function getDoc(collection, id) {
  const result = await readFromJson(collection, id);  // primary
  
  // shadow-read fire-and-forget
  if (collection === 'feedback_items' && window.FEATURE_FLAGS?.SHADOW_READ_FEEDBACK) {
    setTimeout(() => doShadowReadDiff(id, result), 0);  // 非同步，不 await
  }
  
  return result;  // 立刻回傳，使用者不被拖
}
```

### 2. Shadow-read 觸發點：getDoc + fbShowDetail

**重要設計決策**（Phase 3 M3.1 之前的 grep finding 確認）：
- `dbAdapter.getDoc('feedback_items', id)` 在既有 code 只有一個呼叫端（`fbCompareWithList`）
- `fbShowDetail(id)` 直接讀 `fbItems[id]` in-memory cache，不走 getDoc
- 所以光在 getDoc 加 hook 不夠，**還要在 `fbShowDetail` 內手動觸發 getDoc（純為了 shadow-read）**

```js
function fbShowDetail(id) {
  // 既有：用 fbItems[id] 渲染 UI
  // ... existing code ...
  
  // Phase 3：背景觸發 shadow-read（fire-and-forget）
  // 不 await、回傳值丟掉，純粹利用 getDoc 內部的 shadow-read hook
  if (window.FEATURE_FLAGS?.SHADOW_READ_FEEDBACK) {
    dbAdapter.getDoc('feedback_items', id).catch(e => 
      console.warn('[shadow-read trigger] getDoc failed', e)
    );
  }
}
```

為什麼選這個設計：
- 統一觸發點在 `getDoc` 邊界
- 拿 fresh JSON（從 SharePoint thermal_db.json）而不是 in-memory cache，比對的是 dual-write 真實一致性
- 未來新增 feedback UI 入口時，只要走 getDoc 自動就 shadow-read

### 3. Shadow-read 失敗一律 silent

任何 throw 都被 catch 起來、記 log、不重試（避免拖慢使用者下次操作）。

### 4. Diff log 結構

```js
_shadowReadLog = [
  {
    ts: 1748345234567,
    id: 'FB-20260527-141524-TFXY',
    result: 'consistent' | 'lossy_only' | 'real_diff' | 'list_missing' | 'error',
    diffs: [{field, jsonValue, listValue}, ...],  // only when real_diff
    error: '...'  // only when error
  }
]
```

### 5. 三筆抽查 finding（Phase 2 結案時的發現）

實測 Phase 2 累積資料**全部 0 lossy**（dateTime 兩邊都不含毫秒）。
這代表：
- Phase 3 diff 規則可以直接 `===` 比對，**不需要做 dateTime normalize tolerance**
- 但 Phase 2 的 `fbCompareWithList` 已實作 lossy normalize（為了安全），Phase 3 可以**複用相同 normalize 邏輯**確保未來如果有路徑寫入帶毫秒的 timestamp 不會誤報

### 6. Paired-entry pattern（throttle 之觀察依據）

選定上述觸發點後，會出現以下 paired pattern：
- 使用者點「閱讀 👁️」開 detail → 觸發一次 shadow-read（Phase 3 新增 trigger）
- 使用者再點「📋 比對」 → 觸發另一次 shadow-read（既有 fbCompareWithList getDoc 路徑）

**14 天觀察期看 `_shadowReadLog`**：若同一個 id 在 5 秒內出現 2 次的比率 > 30%，
代表 paired pattern 嚴重，加 throttle 處理。否則維持簡實作。

## 工作方式：4 milestone

### Milestone 3.1：dbAdapter shadow-read 核心邏輯

**內容**：
- `_shadowReadLog` array（最近 100 筆，自動 drop oldest）
- `_doShadowReadDiff(id, jsonItem)` 私有 function：
  - 用 `graphListsDb.feedback.list({ Title: id })` 讀 List 端
  - 處理「List 端缺失」case → log `list_missing`
  - 跑 17 欄 diff（複用 fbCompareWithList 的 normalize 邏輯，但**只 log 不 render**）
  - 分類：consistent / lossy_only / real_diff
- `getShadowReadLog()` public method

**Review 點**：
- flag default false，無任何行為改變
- flag 開啟，使用者讀任一筆 feedback 時：
  - JSON 端立刻回傳（< 50ms）
  - shadow-read 在背景非同步跑（不影響 UI）
  - 結果記到 `_shadowReadLog`

### Milestone 3.2：getDoc 整合 + 防呆

**內容**：
- 修改 `dbAdapter.getDoc('feedback_items', id)`：在 primary read 之後觸發 shadow-read
- **保證 shadow-read 失敗絕不 throw 出 getDoc 邊界**
- **不要預先加 throttle**：先用最簡實作，14 天觀察期看 `_shadowReadLog` 重複 entry 比率，
  若實證有問題（同一筆 id 短時間內 shadow-read 5+ 次）再加 throttle。
  YAGNI 原則，避免引入不必要的狀態管理複雜度。

**Review 點**：
- 手動把 graphListsDb 改成會 throw error 的 stub，確認 getDoc 還是正常回傳 JSON
- shadow-read 的 console.warn / log 是否會干擾正常 console 使用

### Milestone 3.3：開發者驗證區新按鈕 + diff 報告 UI

**內容**：
- 開發者驗證區加新按鈕「📊 查看 shadow-read 報告」
- 點下後顯示：
  - 統計區：consistent N / lossy_only M / real_diff K / list_missing P / error Q
  - 表格列出最近 20 筆 shadow-read（id、result、diffs 摘要）
  - real_diff 那筆**紅色高亮**並可展開看欄位 diff

**Review 點**：
- 不影響既有比對按鈕功能
- 統計數字明顯
- 真 diff 看了能直接 debug

### Milestone 3.4：Smoke test + doc 更新

**內容**：
- 寫 Phase 3 啟動 checklist（給 Tedus 手動跑）：
  - 開 SHADOW_READ_FEEDBACK=true
  - 開幾筆 feedback detail → 確認 shadow-read 在背景跑（看 log）
  - 確認統計區數字增加
  - 確認 0 real_diff（因為 Phase 2 已驗過資料一致）
- 更新 `docs/lists-migration.md`：M3.1-3.4 打勾、Phase 3 retrospective
- 寫獨立的 `docs/phase3-activation-checklist.md`

**寫完 STOP，提供**：
- Phase 3 啟動 checklist（GitHub 網頁編輯 + 瀏覽器驗證流程）
- 觀察期建議：Phase 3 啟動後 14 天觀察期（比 Phase 2 久，因為這次累積資料更多）

---

## Code Style 提醒

- 跟既有 dbAdapter 風格一致（fire-and-forget pattern 已在 dual-write 用過）
- Console log 使用既有風格
- 不引入新 dependency

## 你不用再驗證的事

- siteId / listId / scope：Phase 0 已凍結
- graphListsDb CRUD：Phase 1 驗過
- dbAdapter 寫入路由：Phase 1 M3 驗過
- dual-write 真實 production：Phase 2 啟動驗證過
- 兩邊資料一致性：Phase 2 結案時 3 筆抽查全綠

## Token 效率提醒

- 用 `str_replace` 不要整檔覆寫
- 不要重複貼 Phase 1/2 的 code 在回覆
- Milestone 之間 STOP 等 review，不要 proactively 寫下個

---

**第一個動作：讀檔案，讀完跟我說「文件讀完了，準備進入 Phase 3 設計討論」**。

如果讀的過程中有任何疑問或發現 doc/code 不一致，**先提問再開工**。
