# Phase 2 正式啟動 Checklist

> **使用時機**：準備對真實使用者資料啟用 dual-write 時，由 Tedus 手動逐項確認。
> 完成後在 `lists-migration.md` 的 2.7 打勾，正式進入 7 天觀察期。

---

## 前置確認（啟動前）

- [ ] PR #117（或後續 flag 啟用 commit）已 merge 到 main，GitHub Pages 已重新部署
- [ ] 開啟工具後 console 無任何 `ReferenceError`
- [ ] `window.FEATURE_FLAGS` 存在，且所有 flag 預設為 `false` / `'json'`

---

## Step 1：啟用開發者驗證區（SHOW_DEV_PANEL only）

```js
// Browser console：
window.FEATURE_FLAGS.SHOW_DEV_PANEL = true;
fbOnTabActivate();
```

- [ ] Feedback tab 底部出現「🔧 開發者驗證（dual-write 測試）」折疊區（**預設摺疊**）
- [ ] 展開後看到三個按鈕：📋 📝 🔄
- [ ] 「📋 從 List 載入這筆並比對」按下後提示「請先開啟某筆回饋」（guard 正常）

---

## Step 2：啟用 dual-write，提交一筆測試 feedback

```js
window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK = true;
```

- [ ] 切到 Tab 5，填寫並提交一筆測試 feedback（例如標題「Phase 2 啟動驗證」）
- [ ] 工具顯示「儲存成功」，使用者體驗無任何異常
- [ ] 在 SharePoint List（`/sites/Thermal-Spec-DB/Lists/Feedback`）確認該筆出現

---

## Step 3：驗證 dual-write log

- [ ] 展開「🔧 開發者驗證」→ 按「📝 查看寫入記錄（最近 20 筆）」
- [ ] 最近一筆顯示 `op: add  ok: ✅`，無 `❌ fail`

---

## Step 4：fbCompareWithList 比對

- [ ] 在列表找到剛才的測試 feedback，按「閱讀 👁️」
- [ ] modal 底部出現「📋 與 SharePoint List 比對」按鈕（因 SHOW_DEV_PANEL=true）
- [ ] 按下後 diff 結果：
  - 全欄位 **✅ 綠色**，或
  - `created_at` / `updated_at` 顯示 **⚠️ 黃色**（毫秒截斷，屬已知 lossy，正常）
  - **0 筆紅色 ❌**

---

## Step 5：fbForceListPush（補齊歷史資料）

> 僅在「啟動 dual-write 之前已有歷史 feedback」時需要跑。若所有 feedback 都是啟用後才建立可跳過。

- [ ] 展開「🔧 開發者驗證」→ 按「🔄 同步既有 JSON 到 List」
- [ ] confirm 對話框確認後執行
- [ ] 結果顯示「成功 N / 失敗 0」
- [ ] 至 SharePoint List 確認筆數 ≥ JSON 端 `feedback_items` 總數

---

## Step 6：回退驗證（確認緊急出口可用）

```js
window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK = false;
window.FEATURE_FLAGS.SHOW_DEV_PANEL = false;
fbOnTabActivate();
```

- [ ] 驗證區消失，Feedback tab 與 Phase 1 狀態完全一致
- [ ] 再提交一筆 feedback，JSON 成功、List 無新增（dual-write 確實停了）

---

## 啟動正式 flag Commit

以上 6 步全通過後，用獨立 commit 啟用 flag（方便單獨 revert）：

```bash
# 建立獨立 branch（或直接在 main commit）
# 修改 config.js：
#   DUAL_WRITE_FEEDBACK: true,
#   SHOW_DEV_PANEL:      true,   # 可選，Tedus 個人維護用
git commit -m "Enable dual-write for feedback (Phase 2 observation period begins)"
```

> ⚠️ 這個 commit 是 Phase 2 觀察期的起點。若 7 天觀察期出現問題，`git revert` 這個 commit 即可立即回退。

---

## 啟動後——進入 7 天觀察期

詳見 `docs/lists-migration.md`「Phase 2 啟動後 7 天觀察期 checklist」章節。

7 天全綠條件：
- 連續 7 天 dual-write log 無 `❌ fail`
- 隨機抽查 3 筆 `fbCompareWithList` 無紅色 ❌
- `fbForceListPush()` 確認歷史資料已完整同步

全部達成後更新 `lists-migration.md` 2.7 checkbox，啟動 Phase 3 規劃。
