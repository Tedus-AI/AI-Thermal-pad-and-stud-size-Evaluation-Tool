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
  "login_history":   { "<id>": { name, email, at, tool } },  // AI-Thermal 登入稽核(管理面板查詢用)
  "version":         <number>
}
```

> `login_history`：登入時節流(同 email 60 分鐘一筆)逐筆 `setDoc` 一個唯一 id doc，超過上限刪最舊；
> 系統管理員面板「🕘 使用者登入紀錄」讀出依時間列出。頂層 collection 天然與其他工具寫入隔離；
> **僅本工具會寫**，要含 5G-RRU 端登入需 5G-RRU 同步記錄到同一 collection。

#### 元件物件（`rf_data` / `digital_data` / `pwr_data` 的每一筆）欄位歸屬

同一顆元件物件由兩個工具共寫，各自只畫得出自己那一半欄位：

| 欄位 | 誰有畫面可編輯 | 備註 |
|---|---|---|
| `Component` | 兩邊 | 名稱即 key |
| `Qty`、`Power(W)` | 兩邊 | |
| `Limit(C)` | 兩邊 | AI-Thermal 在 Tab1「限溫(°C)」欄（Qty 右側）|
| `Type`、`Power_RT(W)`、`TV_ID_mil`、`TV_Qty`、`Temp_Sensor`、`Local_Qty`、`Remote_Qty`、`note`、`Rth`、`SpecFile` | 只有 AI-Thermal | 5G-RRU 不顯示但會原樣保留 |
| `Board_Type`、`Pad_L`、`Pad_W` | AI-Thermal **推導**（Tab2）| 由 Tab2「主散熱路徑」＋元件大小／E-PAD 大小推導，見下節 |
| `R_jc` | AI-Thermal **推導**（Tab1）| 由熱阻表的 θJC 推導，見下節 |
| `Height(mm)`、`Thick(mm)` | **只有 5G-RRU** | ⚠ AI-Thermal **一律不寫這兩個 key**，見下方「不捏造」 |

##### ⚠ 不捏造 5G-RRU 專屬欄位（`sgMakeComp`）

AI-Thermal 原本有一份 `SG_DEFAULTS`，與 5G-RRU 的 `RF_DEFAULT`/`DIG_DEFAULT`/`PWR_DEFAULT`
**完全同值**，等於本工具先塞一份假資料、5G-RRU 端再也分不出「工程師真的填了 250」還是
「AI-Thermal 自動塞的 250」。已移除，新元件一律**不建立**這些 key。

**空值一定要「不寫 key」，不可寫 `''`**：5G-RRU 快選是 `Object.assign({}, RF_DEFAULT, src)`，
key 不存在 → 套它自己的預設（行為與過去相同）；寫 `''` 會**覆蓋掉**預設值，而它的 `calcRow`
對空字串多半不會噴 NaN，而是靜默算成 0（實測：`Thick` 空 → `R_int`=0、`Board_Type` 空 →
`R_int`=0、`Pad_L/W` 空 → 面積用字串算出假值、`Limit(C)` 空 → 裕度變超大負數），
**方向是低估熱阻＝樂觀**，比 NaN 更危險。`sgCarrySrc` 會跳過 `undefined`，故快選不受影響。
清空 Tab1「限溫」欄時 `sgOnCompEdit` 也是 `delete` key 而非寫 `''`。

⚠ **「從資料庫快選」的 carry 白名單兩邊都必須列全所有欄位**（AI-Thermal 的
`SG_VARIANT_CARRY` / 5G-RRU 的 `VARIANT_CARRY`）。漏列的 key 會被各自的分類預設值蓋掉，
複製完再存回共用 DB 就等於把對方工具填的真實值洗成罐頭值。新增任何每元件欄位時，
**同一個 commit 內要把它加進本工具的白名單，並在另一個 repo 同步補上**。
物件／陣列型欄位（`Rth`、`SpecFile`）carry 時必須深拷貝，否則新元件與來源共用參照。

> `SpecFile` 是檔案參照不是複本（實體檔在來源專案的 `SPEC/<專案名>/` 底下）。快選帶入時
> 會標 `SpecFile._from = <來源專案名>`，本專案刪除／換檔時只解除參照，不得刪來源檔。

> `R_jc` 由 AI-Thermal 的熱阻表自動推導（見下節），不是使用者在 AI-Thermal 直接填的。

#### `R_jc` 的單一事實來源：AI-Thermal 的 `comp.Rth`

`comp.Rth = [{ type, value, cond, primary }]` 逐筆記錄 datasheet 的熱阻標法。
存檔時 `sgSyncRjcAll` 會把其中的 **θJC** 寫進 `comp.R_jc` 供 5G-RRU 算 Tj：

- 取值順序：標「主要」的 θJC → 第一筆 `JC_bot` → 第一筆 `JC_top`，來源記在 `comp._rjc_from`。
- **只有 θJC 可以當 `R_jc`**。5G-RRU 的熱路徑是 `Tj = Tc + P×R_jc`、
  `Tc = T_hsk + P×(R_int + R_TIM)`，其「殼」是元件底面 → 對應 θJC,bottom；
  θJA 含到環境的整條路徑、θJB 到板子、Ψ 是特性參數，硬塞會讓 Tj 重複計算而失真。
- 沒有任何 θJC 時不動 `R_jc`（保留既有值），只清掉 `_rjc_from`。

#### `Board_Type` / `Pad_L` / `Pad_W` 的單一事實來源：Tab2「主散熱路徑」

Tab2 原本的「散熱方向」（`IC top`/`IC bot`/`雙向`）改為 **「主散熱路徑」**，選項直接對應
5G-RRU 的導熱方式，並同時決定 `Pad_L`/`Pad_W` 取哪個尺寸（`HEAT_PATH_MAP`）：

| 主散熱路徑 | `Board_Type` | `Pad_L`/`Pad_W` 取自 |
|---|---|---|
| `Copper Coin` | `Copper Coin` | `heatSourceSize`（元件大小）|
| `Thermal Via` | `Thermal Via` | `epadSize`（**E-PAD 大小**，選此值才出現的分支欄）|
| `IC top` | `None` | `heatSourceSize`（不穿板；5G-RRU 會退回以元件上表面積算 `R_TIM`）|
| `None` | `None` | `0` |

- `Pad_L`/`Pad_W` 是 **E-PAD（散熱焊墊）尺寸，不是 IC 外型尺寸**。Copper Coin 也需要它
  （5G-RRU 的 die-attach solder 項是 `t_Solder/(K_Solder × pa × Voiding)`，直接除以 `pa`），
  不能只靠它參數控制台的 coin L/W。
- 未選主散熱路徑，或尺寸解析不出來 → **不寫任何 key**（不寫半套、不寫 `''`）。
- 舊值 `IC bot`/`雙向` 在新選項無對應（資料裡看不出是 Coin 還是 Via）→ 載入時顯示空白＋
  琥珀色「需重選」提示（`HEAT_PATH_LEGACY`），匯出也不輸出該值。
- 推導時機在 `saveAllTabs`（`sgDeriveAllFromSpecs`）。⚠ `thermal_specs` 與 `rf_data` 同屬一個
  專案 document，但 Tab1/Tab2 各有獨立的專案選單且各持一份 `rf_data` 副本，所以只在
  「同一專案的兩半都在記憶體裡」時推導：兩頁同專案 → 推到 **Tab1 的副本**（否則 Tab1 的
  寫入會蓋回去）；Tab2 單獨載入別的專案 → 推到 Tab2 的副本並把三個陣列補進 Tab2 的寫入。
- `TIM_Type` 尚未連動（第二階段：Tab2 的 `timType` → `TIM_Type`，並把 5G-RRU 的 `Pad2`
  收斂成「`Pad` + 型號」，型號→{k, 厚度} 對照表放頂層 collection `tim_library`）。

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

## 備份必須「自包含」＋離線模式不可回寫 SharePoint ⚠️

元件位置標註（Tab1 TC Placement）的圖檔**不在 `thermal_db.json` 裡**：SharePoint 模式下由
`uploadTcpImage` 存到同層的 `tcp_images/` 資料夾，JSON 內只留 `page.imageData = 'sp:<路徑>'` 參照。

1. **`exportBackup` 必須內嵌圖片**：`graphDb.exportBackup(onProgress)` 會深拷貝 `dbCache`、
   走訪整棵 JSON 找出所有 `sp:` 字串（schema-agnostic，含陣列），逐張 `getTcpImageSrc` → fetch →
   轉 data URL 回填，輸出**單一自包含 JSON**。個別圖片失敗時保留該筆 `sp:` 並回報
   `{ total, embedded }`，不中斷整體備份。**不要退回只 dump `dbCache`**，否則備份只有斷鏈參照。
   `fileDb.exportBackup` 簽章對齊（本機模式圖片本就是 data URL，回傳 `{total:0,embedded:0}`）。
2. **離線載入要切 `dbAdapter.setOfflineMode(true)`**（不要直接 monkey-patch `_backend`）。
   離線時 `isSharePointMode()` 必須回報 **false**，否則存檔時 `tcpNormalizeSPImages` 會把標註圖片
   上傳到 SharePoint、並把 `sp:` 參照寫進本地離線檔，離線檔就再也看不到圖。離線時圖片一律維持 data URL。

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
