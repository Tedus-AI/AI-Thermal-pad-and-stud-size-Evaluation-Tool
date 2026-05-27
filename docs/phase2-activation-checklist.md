# Phase 2 正式啟動 Checklist

> **使用時機**：Smoke test 全通過後，準備對真實使用者資料正式啟用 dual-write。
> 由 Tedus 在 GitHub 網頁上操作，全程不需要本機 git 或 CLI。
> 完成 Step 8 的瞬間即為 Phase 2 正式啟動點，之後進入 7 天觀察期。

---

## 前置確認

- [ ] PR #117 已 merge 到 main，GitHub Pages 最新版已部署
- [ ] 開啟工具後 console 無任何 `ReferenceError`
- [ ] `window.FEATURE_FLAGS` 存在，三個 flag 均為預設值（`false` / `'json'`）

---

## Step 1：GitHub 網頁編輯 config.js，啟用兩個 flag

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按右上角鉛筆圖示（Edit this file）
3. 將以下兩行改為 `true`：
   ```js
   DUAL_WRITE_FEEDBACK: true,
   SHOW_DEV_PANEL:      true,
   ```
4. Commit message 填：`Enable dual-write for feedback (Phase 2 activation)`
5. 選 **Commit directly to `main`** → 按 Commit changes
6. 等待 GitHub Pages 部署完成（Actions tab 出現綠色勾，約 1–2 分鐘）
7. - [ ] 重整工具頁面，console 確認 `window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK === true`

---

## Step 2：驗證開發者驗證區 UI

- [ ] 切到 Feedback tab（Tab 5），捲到底部
- [ ] 出現「🔧 開發者驗證（dual-write 測試）」折疊區（預設摺疊）
- [ ] 展開後看到三個按鈕：📋 📝 🔄
- [ ] 在**未開啟任何 feedback 詳細**的狀態下，按「📋 從 List 載入這筆並比對」→ 應顯示「請先開啟某筆回饋」提示（guard 正常）

---

## Step 3：提交測試 feedback，確認雙寫入

- [ ] 填寫並提交一筆測試 feedback（例如標題「Phase 2 啟動驗證 - 可刪」）
- [ ] 工具顯示「儲存成功」，使用者體驗無任何異常
- [ ] 開啟 SharePoint List（`/sites/Thermal-Spec-DB/Lists/Feedback`）確認該筆已出現

---

## Step 4：dual-write log 驗證

- [ ] 展開「🔧 開發者驗證」→ 按「📝 查看寫入記錄（最近 20 筆）」
- [ ] 最近一筆顯示 `op: add  ✅ ok`，無 `❌ fail`

---

## Step 5：fbCompareWithList diff 比對

- [ ] 在列表找到剛才的測試 feedback，按「閱讀 👁️」
- [ ] modal 底部出現「📋 與 SharePoint List 比對」按鈕，按下
- [ ] diff 結果：
  - 全欄位 **✅ 綠色**，或
  - `created_at` / `updated_at` 顯示 **⚠️ 黃色**（毫秒截斷，已知 lossy，正常）
  - **0 筆紅色 ❌**

---

## Step 6：fbForceListPush（補齊歷史資料）

> 僅在「啟動 dual-write 之前已有歷史 feedback」時需要跑。若所有 feedback 都是啟用後才建立則跳過。

- [ ] 展開「🔧 開發者驗證」→ 按「🔄 同步既有 JSON 到 List」
- [ ] confirm 後執行，結果顯示「成功 N / 失敗 0」
- [ ] 至 SharePoint List 確認筆數 ≥ JSON 端 `feedback_items` 總數

---

## Step 7：回退路徑演練

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按鉛筆圖示編輯，將兩行改回 `false`：
   ```js
   DUAL_WRITE_FEEDBACK: false,
   SHOW_DEV_PANEL:      false,
   ```
3. Commit message：`test: temporarily disable dual-write for rollback verification`
4. **Commit directly to `main`** → 等部署完成 → 重整工具
5. - [ ] console 確認 `window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK === false`
6. - [ ] Feedback tab 底部**無**開發者驗證區
7. - [ ] 提交一筆 feedback → 工具顯示成功 → 至 SharePoint List 確認**無新增**（dual-write 確實停止）

---

## Step 8：最終啟動（Phase 2 正式啟動點）

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按鉛筆圖示編輯，將兩行改回 `true`：
   ```js
   DUAL_WRITE_FEEDBACK: true,
   SHOW_DEV_PANEL:      true,
   ```
3. Commit message：`Enable dual-write for feedback (Phase 2 officially begins YYYY-MM-DD)`
4. **Commit directly to `main`** → 等部署完成 → 重整工具
5. - [ ] 提交一筆 feedback → 至 SharePoint List 確認有新增

> 🎉 **此 commit 的瞬間即為 Phase 2 正式啟動點。**
> 若日後需要緊急回退，`git revert` 此 commit 或直接在 GitHub 網頁編輯 config.js 將兩個 flag 改回 `false` 即可。

---

## Step 9：進入 7 天觀察期

詳見 `docs/lists-migration.md`「Phase 2 啟動後 7 天觀察期 checklist」章節。

進入 Phase 3 的條件（7 天後評估）：
- [ ] 連續 7 天 dual-write log 無 `❌ fail`
- [ ] 隨機抽查 3 筆 `fbCompareWithList` 無紅色 ❌
- [ ] `fbForceListPush()` 確認歷史資料已完整同步
- [ ] 更新 `lists-migration.md` 的 2.7 checkbox ✅
