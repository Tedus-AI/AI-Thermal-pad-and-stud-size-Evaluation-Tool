# Phase 4 正式啟動 Checklist

> **使用時機**：M4.1–M4.2 全部 merge 到 main，Phase 3 shadow-read 觀察期數據持續綠，
> 準備正式切 `PRIMARY_FEEDBACK='list'`。
> 由 Tedus 在 GitHub 網頁操作，全程不需要本機 git 或 CLI。
> 完成 Step 6 的 commit 即為 Phase 4 觀察期起點，之後進入 14 天觀察期（不可壓縮）。

---

## 前置確認

- [ ] M4.1–M4.2 相關 PR 已全部 merge 到 main，GitHub Pages 最新版已部署
- [ ] 開啟工具後 console 無任何 `ReferenceError`
- [ ] `window.FEATURE_FLAGS.PRIMARY_FEEDBACK === 'json'`（M4.1 煙霧測試後已 revert）
- [ ] `window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK === true`（dual-write 持續中）
- [ ] `window.FEATURE_FLAGS.SHADOW_READ_FEEDBACK === true`（Phase 3 shadow-read 持續中）
- [ ] Phase 3 觀察期數據 OK：`real_diff: 0`，`error` 無持續異常，5 個主動測試全綠

---

## Step 1：GitHub 網頁編輯 config.js，切 PRIMARY_FEEDBACK='list'

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按右上角鉛筆圖示（Edit this file）
3. 將 `PRIMARY_FEEDBACK` 改為 `'list'`：
   ```js
   PRIMARY_FEEDBACK: 'list',
   ```
4. Commit message 填：`Phase 4 cutover: PRIMARY_FEEDBACK='list' (observation period begins)`
5. 選 **Commit directly to `main`** → 按 Commit changes
6. 等待 GitHub Pages 部署完成（Actions tab 出現綠色勾，約 1–2 分鐘）
7. - [ ] Ctrl+F5 強制重整，console 確認 `window.FEATURE_FLAGS.PRIMARY_FEEDBACK === 'list'`

---

## Step 2：驗證列表從 List 載入

- [ ] 切到 Tab 5（使用者建議與改善）
- [ ] feedback 列表正常顯示，筆數與切換前一致（dual-write 持續雙寫，兩邊應相等）
- [ ] console 確認：`window.FEATURE_FLAGS.PRIMARY_FEEDBACK === 'list'`

---

## Step 3：驗證單筆 detail 從 List 讀

- [ ] 點任意一筆「閱讀 👁️」，開 detail modal
- [ ] 詳情 17 欄顯示正常（標題、狀態、提出人、說明等）
- [ ] 展開「🔧 開發者驗證（dual-write 測試）」→ 按「📊 查看 shadow-read 報告」
- [ ] 預期：最新 entry 的 `result` = `consistent`（或 `lossy_only`），且 `primary` = `'list'`
  ```js
  // console 確認
  dbAdapter.getShadowReadLog()[0].primary   // 預期 'list'
  ```
- [ ] **若出現 `real_diff > 0`**：立刻停止，展開紅色 row 查看欄位 diff，**先不要執行 Revert**，截圖並回報

---

## Step 4：驗證 list_missing 路徑

- [ ] F12 → Console，輸入並按 Enter：
  ```js
  dbAdapter.getDoc('feedback_items', 'FB-NONEXISTENT-' + Date.now())
  ```
- [ ] 預期：Promise resolve → `null`
- [ ] 再按「📊 查看 shadow-read 報告」
- [ ] 預期最新 entry：
  - `result` 欄：`list_missing`
  - `primary`：`'list'`（console 確認：`dbAdapter.getShadowReadLog()[0].primary`）
  - 摘要欄：`List 端找不到該筆`
  - 背景色：橙色（`#fff3e0`）

---

## Step 5：回退演練（確認緊急出口可用）

1. 開啟 config.js（同 Step 1 路徑）
2. 按鉛筆圖示，將 `PRIMARY_FEEDBACK` 改回 `'json'`：
   ```js
   PRIMARY_FEEDBACK: 'json',
   ```
3. Commit message：`test(phase4-activation): verify rollback path`
4. **Commit directly to `main`** → 等 Actions tab 綠勾 → Ctrl+F5 重整
5. - [ ] console 確認 `window.FEATURE_FLAGS.PRIMARY_FEEDBACK === 'json'`
6. - [ ] 切到 Tab 5，確認列表仍正常顯示（回到 JSON source，行為與 Phase 3 一致）
7. - [ ] 點幾筆 feedback detail → 按「📊 查看 shadow-read 報告」
8. - [ ] 預期：新進 entry 的 `primary` = `'json'`（shadow-read 自動回到 Phase 3 方向）

---

## Step 6：最終啟動（Phase 4 觀察期起點）

1. 開啟 config.js（同 Step 1 路徑）
2. 按鉛筆圖示，將 `PRIMARY_FEEDBACK` 改回 `'list'`：
   ```js
   PRIMARY_FEEDBACK: 'list',
   ```
3. Commit message：`Re-enable Phase 4 cutover after rollback verification (YYYY-MM-DD)`
4. **Commit directly to `main`** → 等 Actions tab 綠勾 → Ctrl+F5 重整
5. - [ ] console 確認 `window.FEATURE_FLAGS.PRIMARY_FEEDBACK === 'list'`
6. - [ ] 切到 Tab 5，確認列表載入正常

> 🎉 **此 commit 的瞬間即為 Phase 4 觀察期起點。**
> 若觀察期出現 `real_diff > 0`、`json_missing > 0` 或 `error` 持續偏高，
> 直接在 GitHub 網頁將 `PRIMARY_FEEDBACK` 改回 `'json'` 即可立即回退，
> 不需要改任何 code，系統立即回到 JSON-primary 狀態。

---

## Step 7：進入 14 天觀察期（不可壓縮）

> ⚠️ Phase 4 觀察期不可壓縮。Phase 3 觀察期已壓縮，風險已轉移到此處。

每天至少開幾筆 feedback detail，讓 reverse shadow-read 累積資料。
每 3–4 天用「📋 從 List 載入這筆並比對」隨機抽查 2–3 筆（手動並排 diff 驗證）。
定期按「📊 查看 shadow-read 報告」確認：

| 指標 | 正常範圍 | 異常處理 |
|---|---|---|
| `real_diff` | 0 | 立刻展開 diff，比對欄位，必要時將 `PRIMARY_FEEDBACK` 改回 `'json'` 回退 |
| `json_missing` | 0 | 不應發生（dual-write 持續，JSON 端有的 List 也應有），若有代表某筆沒雙寫成功 |
| `list_missing` | 0 | 不應發生，若有代表某筆只在 JSON 沒在 List |
| `error` | 0–4（偶發 network 問題可接受） | 若持續 > 5 筆，排查 Graph API 連線 |
| `consistent` | 持續增加 | 正常現象 |

**進入 Phase 5 的條件**：
- [ ] 連續 14 天 `real_diff: 0`
- [ ] `json_missing: 0`（或已確認原因）
- [ ] `list_missing: 0`（或已確認原因並補齊）
- [ ] `error` 無持續性異常（偶發 < 5 可接受）
- [ ] 更新 `lists-migration.md` 的 4.3 checkbox ✅
