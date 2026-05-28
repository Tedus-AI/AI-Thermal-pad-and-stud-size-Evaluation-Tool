# Phase 4 啟動 Prompt — Cutover（讀取路徑切到 List）

> **使用時機**：Phase 3 shadow-read 已驗證資料一致（壓縮觀察期 + 5 個主動測試全綠，
> 或完整 14 天觀察期 real_diff 持續 0）。準備把使用者的讀取來源從 JSON 切到 List。
> 複製整份內容（從 `---` 開始那段）貼到新的 Claude Code session。

---

我要啟動 Phase 4：Cutover，把 feedback 讀取路徑從 JSON 切到 SharePoint List。

## ⚠️ Phase 4 特殊風險聲明（先讀）

Phase 4 跟 Phase 1/2/3 本質不同：

- Phase 1/2/3：flag 守著，使用者**完全無感**，出問題使用者看不到（讀的還是 JSON）
- **Phase 4：cutover 後使用者讀到的就是 List 端資料**。List 端任何不一致使用者立刻看到。

因此 Phase 4 的設計原則：
1. **dual-write 必須保持開啟**（JSON 持續寫，當 fallback 跟回退保險）
2. **回退路徑必須先演練**（切 'list' → 切回 'json' 要證明能立即回退）
3. **14 天觀察期不可壓縮**（Phase 3 觀察期被壓縮，風險已往後移到此處）

## 第一步：請依序讀完這幾份檔案

在動任何 code 之前，按順序讀完：

1. **`docs/lists-migration.md`** ← 重點：
   - 「Milestone 進度」確認 Phase 3 已完成
   - 「並行控制機制演進」← Phase 4 的鎖狀態（JSON 鎖仍需保留，因為還在 dual-write）
   - 「Dual-write 期間的回退保險」← flag 回退機制
   - 「已知 Gotchas」全部

2. **`docs/phase3-activation-checklist.md`** ← Phase 3 啟動狀態

3. **`dbAdapter.js`** ← 重點看 `getDoc` 內 `_primary() === 'list'` 那條 dormant code（M3.2 已預埋）

4. **`graphListsDb.js`** ← list 邏輯
5. **`config.js`** ← FEATURE_FLAGS
6. **`index.html`** ← `fbLoadList()` / `fbShowDetail()` / feedback 列表渲染邏輯

讀完之後 STOP，跟我說「文件讀完了，準備進入 Phase 4 設計討論」，**不要直接寫 code**。

如果讀的過程中發現任何 doc 跟 code 不一致、或 Phase 3 留下 TODO 沒處理，**先提問**。

## Phase 4 核心問題：getDoc 已就緒，但 fbLoadList 呢？

**M3.2 的 grep finding 很關鍵**：
- `fbShowDetail` 不走 getDoc（讀 in-memory `fbItems[id]` cache）
- feedback **列表**（fbLoadList）很可能也是讀整包 JSON / getCollection，不是逐筆 getDoc

所以 cutover **不能只靠切 `PRIMARY_FEEDBACK='list'`**——getDoc 那條 dormant code 只 cover「按 id 讀單筆」，**列表載入可能還在讀 JSON**。

**Phase 4 第一個任務是釐清讀取路徑全貌**：

請 grep 並回報：
```
grep -n "getCollection" index.html
grep -n "fbLoadList\|fbItems\s*=" index.html
grep -n "getCollection\|getDoc" dbAdapter.js
```

確認：
1. feedback **列表**是怎麼載入的？`dbAdapter.getCollection('feedback_items')`？還是別的？
2. `getCollection` 在 dbAdapter 內有沒有 `_primary() === 'list'` 分支？（M3.2 只改了 getDoc，**getCollection 很可能還沒有**）
3. 如果 getCollection 沒有 list 分支，**Phase 4 要補**——否則切 flag 後「列表還是讀 JSON、但點進去單筆讀 List」會造成不一致體驗

## 嚴格範圍邊界

**DO（允許動）**：
- 修改 `dbAdapter.js`：`getCollection('feedback_items')` 加 `_primary() === 'list'` 分支（如果還沒有）
- 修改 `config.js`：`PRIMARY_FEEDBACK` 切換（但要 Tedus 手動 commit 啟用）
- 必要時調整 `fbLoadList()` 讓它走 dbAdapter 的 primary 路由

**DO NOT（嚴格禁止動）**：
- ❌ 不關閉 dual-write（`DUAL_WRITE_FEEDBACK` 維持 true）
- ❌ 不動 `graphListsDb.js`
- ❌ 不移除 JSON 寫入邏輯（Phase 5 才做）
- ❌ 不移除 shadow-read（Phase 4 反而要靠它監控 List primary 後的一致性）
- ❌ 不引入新依賴
- ❌ 不要在沒明確指示下切 `PRIMARY_FEEDBACK='list'`（保持 'json'，Tedus 手動啟用）

## 工作方式：milestone-by-milestone

### Milestone 4.1：讀取路徑全貌釐清 + getCollection list 分支

**內容**：
- grep 回報 feedback 列表/單筆的所有讀取路徑
- 若 `getCollection('feedback_items')` 沒有 list 分支，補上：
  ```js
  // getCollection 內
  if (_isFb(colName) && _primary() === 'list') {
    const items = await graphListsDb.feedback.list({});  // 全撈
    // 轉成 { id: data } 物件形狀，跟 JSON 端 getCollection 一致
    const out = {};
    for (const it of items) { out[it.data.id] = it.data; }
    return out;
  }
  ```
- 注意 `graphListsDb.feedback.list({})` 全撈時的 **分頁問題**：Graph API List items 預設上限 200，超過要 paginate。目前 feedback 量少（< 50）安全，但要加 TODO 註記。

**Review 點**：
- `PRIMARY_FEEDBACK='json'`（default）時，getCollection 行為完全不變
- `PRIMARY_FEEDBACK='list'` 時，列表從 List 撈、形狀跟 JSON 端一致
- 列表渲染後，點單筆 detail 也從 List 讀（getDoc 已就緒），兩者一致

### Milestone 4.2：cutover 後的 shadow-read 反轉

**內容**：
- Phase 3 shadow-read 是「primary=JSON，比對 List」
- Phase 4 cutover 後 primary=List，shadow-read 應該反過來「primary=List，比對 JSON」
- 確認 shadow-read 邏輯在 `PRIMARY_FEEDBACK='list'` 時仍有意義（驗證 List 跟 JSON 還是一致，因為 dual-write 持續）
- 可能需要調整 `_doShadowReadDiff` 的方向標示（log 裡標清楚誰是 primary）

**Review 點**：
- cutover 後 shadow-read 仍正常累積
- diff 報告能反映「List primary vs JSON shadow」

### Milestone 4.3：Phase 4 啟動 checklist + 回退演練

**內容**：
- 寫 `docs/phase4-activation-checklist.md`（GitHub 網頁編輯流程）：
  - Step 1：切 `PRIMARY_FEEDBACK='list'` → commit → 部署
  - Step 2：驗證列表從 List 載入（撈出來的筆數、內容跟切換前一致）
  - Step 3：驗證單筆 detail 從 List 讀
  - Step 4：**回退演練**——切回 'json' → 確認列表瞬間回到 JSON 來源 → 再切 'list'
  - Step 5：正式啟動 commit
  - Step 6：**14 天觀察期（不可壓縮）**
- 更新 `docs/lists-migration.md`：M4.1-4.3 打勾、Phase 4 retrospective

**Review 點**：
- 回退演練證明「切回 json 立即生效」
- checklist 是 GitHub 網頁流程（Tedus 不在本機操作）

## Code Style 提醒

- 跟既有 dbAdapter 風格一致
- getCollection list 分支的 return 形狀**必須**跟 JSON 端 getCollection 完全一致（`{ id: dataObj }`），否則 fbLoadList 渲染會炸
- 不引入新依賴

## 你不用再驗證的事

- siteId / listId / scope：Phase 0 凍結
- graphListsDb CRUD：Phase 1 驗過
- dual-write：Phase 2 啟動驗過
- shadow-read 機制：Phase 3 驗過（5 個主動測試全綠：新建/編輯/特殊字元/未讀舊資料/多使用者）
- getDoc 的 list 分支：M3.2 已預埋（但 getCollection 可能還沒，要 grep 確認）

## Token 效率提醒

- str_replace 不整檔覆寫
- 不重複貼既有 code
- milestone 之間 STOP 等 review

---

**第一個動作：讀檔案 + 跑 grep 釐清讀取路徑全貌，讀完跟我說「文件讀完了，準備進入 Phase 4 設計討論」**。

特別注意 getCollection 有沒有 list 分支——這是 Phase 4 跟「只切 flag」想像最大的落差點。
