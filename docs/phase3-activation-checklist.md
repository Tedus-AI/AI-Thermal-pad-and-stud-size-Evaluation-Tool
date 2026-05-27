# Phase 3 正式啟動 Checklist

> **使用時機**：M3.1–M3.4 全部 merge 到 main，準備正式啟用 shadow-read。
> 由 Tedus 在 GitHub 網頁操作，全程不需要本機 git 或 CLI。
> 完成 Step 7 的 commit 即為 Phase 3 觀察期起點，之後進入 14 天觀察期。

---

## 前置確認

- [ ] M3.1–M3.4 相關 PR 已全部 merge 到 main，GitHub Pages 最新版已部署
- [ ] 開啟工具後 console 無任何 `ReferenceError`
- [ ] `window.FEATURE_FLAGS.SHADOW_READ_FEEDBACK === false`（尚未啟用）
- [ ] Phase 2 dual-write 仍正常運作（`fbShowDualWriteLog()` 最近 7 天無 `❌ fail`）

---

## Step 1：GitHub 網頁編輯 config.js，啟用兩個 flag

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按右上角鉛筆圖示（Edit this file）
3. 將以下兩行改為 `true`：
   ```js
   SHOW_DEV_PANEL:       true,
   SHADOW_READ_FEEDBACK: true,
   ```
4. Commit message 填：`Enable shadow-read for Phase 3 activation test`
5. 選 **Commit directly to `main`** → 按 Commit changes
6. 等待 GitHub Pages 部署完成（Actions tab 出現綠色勾，約 1–2 分鐘）
7. - [ ] Ctrl+F5 強制重整，console 確認 `window.FEATURE_FLAGS.SHADOW_READ_FEEDBACK === true`

---

## Step 2：驗證開發者驗證區有 4 顆按鈕

- [ ] 切到 Feedback tab（Tab 5），捲到最底部
- [ ] 展開「🔧 開發者驗證（dual-write 測試）」折疊區
- [ ] 確認 4 顆按鈕全部出現：
  - 📋 從 List 載入這筆並比對
  - 📝 查看寫入記錄（最近 20 筆）
  - 🔄 同步既有 JSON 到 List
  - 📊 查看 shadow-read 報告
- [ ] 按「📊 查看 shadow-read 報告」
- [ ] 預期顯示：「（尚無 shadow-read 記錄。請開啟 SHADOW_READ_FEEDBACK 並讀取 feedback。）」

---

## Step 3：觸發 shadow-read（讀 3 筆 feedback）

- [ ] 在 feedback 列表點任意 3 筆的「閱讀 👁️」（各點一下開 detail modal，看完後關閉）
- [ ] 每次點開 detail 會在背景觸發一次 shadow-read（`fbShowDetail` → `getDoc` → `_doShadowReadDiff`）
- [ ] 不需要等待或確認，背景自動執行

---

## Step 4：查看 shadow-read 報告，確認資料一致

- [ ] 展開「🔧 開發者驗證」→ 按「📊 查看 shadow-read 報告」
- [ ] 預期統計區：`consistent: 3　lossy_only: 0　real_diff: 0　list_missing: 0　error: 0`
- [ ] 預期表格：3 行，全綠色背景（`#e8f5e9`），摘要欄顯示 `-`
- [ ] **若出現 `real_diff > 0`**：立刻停止，展開紅色 row 查看哪些欄位不一致，回報後再繼續

---

## Step 5（深度驗證）：觀察 paired entry pattern

- [ ] 開一筆 feedback detail（點「閱讀 👁️」）
- [ ] 在 modal 開著的情況下，按 modal 底部「📋 與 SharePoint List 比對」按鈕
- [ ] 關閉 modal，按「📊 查看 shadow-read 報告」
- [ ] 預期：log 裡同一 id 出現 2 次（一次來自 `fbShowDetail`，一次來自 `fbCompareWithList`）
- [ ] 這是預期的 paired entry pattern，確認正常即可

---

## Step 6：回退驗證（確認緊急出口可用）

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按鉛筆圖示，將 `SHADOW_READ_FEEDBACK` 改回 `false`：
   ```js
   SHADOW_READ_FEEDBACK: false,
   ```
3. Commit message：`test: temporarily disable shadow-read for rollback verification`
4. **Commit directly to `main`** → 等部署完成 → Ctrl+F5 重整
5. - [ ] console 確認 `window.FEATURE_FLAGS.SHADOW_READ_FEEDBACK === false`
6. - [ ] 點幾筆 feedback detail → 按「📊 查看 shadow-read 報告」
7. - [ ] 預期：報告數字**未增加**（log 凍結，新讀的 feedback 不 trigger shadow-read）

---

## Step 7：最終啟動（Phase 3 觀察期起點）

1. 開啟 `https://github.com/Tedus-AI/AI-Thermal-pad-and-stud-size-Evaluation-Tool/blob/main/config.js`
2. 按鉛筆圖示，將 `SHADOW_READ_FEEDBACK` 改回 `true`：
   ```js
   SHADOW_READ_FEEDBACK: true,
   ```
3. Commit message：`Re-enable shadow-read for Phase 3 official observation period (YYYY-MM-DD)`
4. **Commit directly to `main`** → 等部署完成 → Ctrl+F5 重整
5. - [ ] 點幾筆 feedback detail，確認 shadow-read 正常 trigger（報告數字增加）

> 🎉 **此 commit 的瞬間即為 Phase 3 觀察期起點。**
> 若觀察期出現 `real_diff > 0` 或 `error` 持續偏高，直接在 GitHub 網頁將
> `SHADOW_READ_FEEDBACK` 改回 `false` 即可立即回退。

---

## Step 8：進入 14 天觀察期

每天至少開幾筆 feedback detail，讓 shadow-read 累積資料。
定期按「📊 查看 shadow-read 報告」確認：

| 指標 | 正常範圍 | 異常處理 |
|---|---|---|
| `real_diff` | 0 | 立刻展開查看欄位 diff，比對資料，回報 |
| `error` | 0–4（偶發 network 問題可接受） | 若持續 > 5 筆，排查 Graph API 連線 |
| `list_missing` | 0 | 不應發生（Phase 2 dual-write 持續中），若有代表有 feedback 沒雙寫成功 |
| `consistent` | 持續增加 | 正常現象 |

**Paired entry 比率觀察**：14 天後看 `_shadowReadLog`，若同一 id 在 5 秒內出現 2 次的筆數佔總數 > 30%，加 throttle；< 30% 維持簡實作。

**進入 Phase 4 的條件**：
- [ ] 連續 14 天 `real_diff: 0`
- [ ] `list_missing: 0`（或已確認原因並補齊）
- [ ] `error` 無持續性異常（偶發 < 5 可接受）
- [ ] 更新 `lists-migration.md` 的 3.5 checkbox ✅
