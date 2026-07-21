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
   (a) `dbCorrupted` → 拒寫；(b) `projects` 由「上次讀檔筆數」(`lastReadProjects`，反映磁碟現況、
   非 session 高水位) 非零突然歸零、且非刻意刪除（`deleteDoc('projects', …)` 例外放行並下修基準）→ 拒寫。
   **空檔判斷**：只有「從未持有過實際資料（`sawRealData=false`）的全新空檔」才允許 bootstrap 空骨架；
   若先前已有資料卻讀到 0-byte（截斷）→ 比照壞檔進唯讀。
   參考實作：本 repo 的 `fileDb.js` / `graphDb.js`（`_assertWritable`、`lastReadProjects`、`sawRealData`），
   對應 5G-RRU PR #64/#66。
6. **檔案級樂觀並發（SharePoint backend）**：整檔 PUT 必帶 `If-Match: <eTag>`；`_readFile` 取
   DriveItem metadata 的 `eTag` 為基準（content GET 經 302 轉址後的 ETag 不可靠），`_writeFile`
   成功後由 PUT 回應更新 `eTag`。寫入走 `_withOptimisticWrite(mutateFn)`：412 時重讀最新內容＋新
   eTag，於最新狀態上重跑 mutateFn 後重試（上限 4 次）。如此 (a) 取鎖 read-check-write 成為原子
   CAS（兩人不會同時取得鎖）、(b) 他人對其他 doc/collection 的寫入不會被我們的整檔 PUT 回滾、
   (c) releaseLock 衝突時只刪自己的鎖。**兩個 repo 要同步實作**（共用同一份檔案，並發保護取決於最弱的寫入者）。
   參考實作：本 repo 的 `graphDb.js`（`_withOptimisticWrite`、`currentEtag`），對應 5G-RRU PR #66。
7. **系統管理員強制請離（共用 `lock` 物件新增欄位）**：`cache.lock` 除 `lockedBy/lockedByEmail/
   lockedAt/expiresAt` 外，新增 `evictRequested`(bool)、`evictBy`(name)、`evictAt`(iso)。系統管理員
   （密碼 `0420`，頂部「🛡 管理」）以 `requestEvict(byName)` 在**目前持鎖者**的鎖上標記 `evictRequested`
   （不搶鎖，走樂觀寫入）；持鎖者的 60 秒輪詢 `_maintainLock` 偵測到「旗標在自己鎖上」→ `_handleEviction`：
   **先自動 `saveAllTabs`（此時仍持鎖、驗鎖通過）再 `releaseLock` + 退回上鎖**。離線/無回應時管理員可
   `forceReleaseLock()` 硬清鎖（對方未存變更會遺失，最後手段）。⚠ **跨工具限制**：5G-RRU 的
   `acquireLock` 續約會以全新 lock 物件覆寫（不含旗標），故要**請離 5G-RRU 端使用者，5G-RRU 也必須
   同步實作** `requestEvict/forceReleaseLock` 與 `_handleEviction` 偵測，否則對 5G-RRU 佔用者只能靠硬清鎖或等逾時。
   參考實作：本 repo `graphDb.js`（`requestEvict`/`forceReleaseLock`）＋ `index.html`（`_handleEviction`、
   `admin*` 面板）。

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

## 使用者體驗（UX）慣例 ⚠️ — 動任何 UI 前必讀

開發或修改任何 UI 前，先讀 `docs/UX-KNOWLEDGE-BASE.md`。那是從五個 repo 約 300 個
commit 的修 bug 歷史提煉出的慣例；**使用者不會每次重新描述這些需求，預設你已遵守。**

最核心的十二條（完整版與踩坑出處見文件）：

1. **輸入中絕不整區重繪**（游標會跳開）；重繪後還原捲動位置；表格支援 Excel 貼上。
2. **自動帶入欄位一律「鎖定＋✂ 解鎖逃生口」**；純參照值顯示白底黑字純文字，
   不用反灰 disabled input。
3. **能自動判定就不讓使用者手選**（如 Verdict 由 Margin 推導）；自動帶入要有
   fallback，不能只認 happy path。
4. **單一事實來源**：改名連動更新所有參照；鏡像欄位做成唯讀；重複輸入用
   「一鍵帶入」消滅；建議值 click-to-apply 不直接改使用者輸入。
5. **螢幕／預覽／PDF 三方永遠同步**：改編輯器就同一 commit 同步 PDF builder；
   色值字級抽共用常數；PDF 分頁門檻用實測座標校準（CJK 字型量測會低估）。
6. **小螢幕（17 吋筆電）策略是加寬整頁**回收留白，不是硬塞 A4；header 元素
   流動排列防重疊；浮動框 clamp 在 viewport 內。
7. **紅色保留給 Fail/錯誤**；分類色彼此區隔；圖表疊加元素要與「所有可能的
   底色」都有對比；深淺主題都要檢查。
8. **標註/畫布座標一律存相對座標（0~1）**防重開飄移；跨螢幕等比縮放；
   編輯模式與標註模式互斥；存檔時對帳清理孤兒附件。
9. **鎖定/唯讀狀態要全面**：所有寫入入口反灰＋給唯讀檢視；切換前攔截未儲存
   變更（儲存/放棄/取消）；顯示誰持有鎖。
10. **按任一儲存鍵＝存全部分頁**；破壞性操作要確認關卡＋連帶清理關聯資料，
    且刪除入口要可見。
11. **外部 fetch 一律 timeout＋retry**；UI 每個數字標註來源與取樣範圍；
    文案（含中英雙語、methodology、PDF）必須與程式實際行為一致；溫差用 °C。
12. **每個 UI 改動 headless 驗證後才交付**；改共用元件檢查所有呼叫端。
