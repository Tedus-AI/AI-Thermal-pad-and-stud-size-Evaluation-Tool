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
  "tim_library":     { "<id>": { model, timType, k, thickness, gapThickness, gapUnlock,
                                 vendor, note, at, by, updatedAt, updatedBy } },
                                // TIM 型號庫：全工具共用、不屬於任何專案（AI-Thermal Tab2 維護）
  "login_history":   { "<id>": { name, email, at, tool } },  // AI-Thermal 登入稽核(管理面板查詢用)
  "version":         <number>
}
```

> `login_history`：登入時節流(同 email 60 分鐘一筆)逐筆 `setDoc` 一個唯一 id doc，超過上限刪最舊；
> 系統管理員面板「🕘 使用者登入紀錄」讀出依時間列出。頂層 collection 天然與其他工具寫入隔離；
> **僅本工具會寫**，要含 5G-RRU 端登入需 5G-RRU 同步記錄到同一 collection。

> `tim_library`：TIM 型號庫（型號 → k 值 / 預設厚度 / 廠商）。**刻意放頂層 collection、
> 不掛在 `projects[id]` 底下**（共用 DB 規則第 3 條）：一顆 Pad 的 k 值只登錄一次，
> 所有專案（含之後新開的）都選用同一份，且天然與 5G-RRU 對 `projects` 的寫入隔離。
> 由 Tab2 匯出工具列的「🧪 TIM 型號庫」維護（`timLibOpen`）；未解鎖時可檢視不可編輯，
> 寫入前過 `_ensureLockBeforeWrite`。新增/修改用 `writeBatch`（單次 flush），刪除另走
> `deleteDoc`（`writeBatch` 不支援 delete）。驗證：型號必填、k 必須 > 0、同一 `timType`
> 下型號不可重複（跨工具是用**型號名字串**參照，不是 id）。`at`/`by` 是首次登錄、
> 重存不覆蓋；`updatedAt`/`updatedBy` 記錄最後修改。
> **已接上元件**：Tab2「TIM Type」底下的型號下拉會把型號名寫進 `comp.TIM_Model`
> （見下方「`TIM_Model`：Tab2 的 TIM 選型」）。
> **5G-RRU 端已接上**（其 PR #76）：`calcRow` 走 `resolveTim(row, g)` —— `TIM_Model` 在
> `tim_library` 查得到就用該型號的 `k` 與 `gapThickness`，否則 fallback 它自己
> `global_params` 的 `K_<Type>` / `t_<Type>`；`Pad2` 已從它的 UI 移除（收斂成「`Pad` + 型號」）。
> ⚠ **5G-RRU 只讀不寫 `tim_library`**：新增／修改型號的入口只有本工具 Tab2 的型號庫視窗。
> 它的參數控制台已把 TIM 的六個 `K_`/`t_` 輸入欄換成一顆「🧪 TIM 型號庫」按鈕，開出來是
> **唯讀檢視**（列出型號／類型／k／填縫厚度／預設厚度／廠商／備註 ＋ 一個前往本工具的連結），
> 沒有任何可編輯欄位或新增／儲存／刪除鍵。**k 值屬於「材料」不屬於「專案」，編輯入口只留這一個。**
> 因此在本工具的型號庫改了 k 或填縫厚度，5G-RRU 端只要重讀型號庫（載入專案／開那顆按鈕）
> 就會即時反映到它的 `R_TIM`；反過來它改不動我們的型號庫。

##### ⚠ 兩個厚度不是同一件事（`thickness` vs `gapThickness`）

| 欄位 | UI 標題 | 意義 | 對應 5G-RRU |
|---|---|---|---|
| `thickness` | 預設厚度(mm) | 材料**原始片厚**（Pad 買來 2.5mm） | 無（僅供規格書參考）|
| `gapThickness` | 填縫厚度(mm) | **壓縮後實際填在縫隙裡**的厚度 | `t_Pad` / `t_Putty` / `t_Grease` |
| `k` | k (W/m·K) | 導熱係數 | `K_Pad` / `K_Putty` / `K_Grease` |

5G-RRU 的 `calcRow` 是 `rt = (ti.t / 1000) / (ti.k × ta)`，`ti.t` 取自型號的 `gapThickness`；
沒選型號時才 fallback 到該專案 `global_params` 的 `t_<Type>`（單位 mm）。
**要餵給它的是 `gapThickness`，不是 `thickness`。**

> `K_<Type>`/`t_<Type>` 這六個 key 在 5G-RRU 端**仍存在於 `global_params`、仍是 fallback**，
> 只是它的參數控制台已經沒有輸入欄（改成上面那顆唯讀按鈕）→ 使用者實際看得到、改得動的
> k 與填縫厚度**只剩本工具的型號庫**。沒有型號可選的專案才會吃到那組 fallback 值。

佐證（兩邊預設值互相對照）：5G-RRU `t_Pad = 1.7` 等於本工具 Tab2 的「IC 距離 HSK = 1.7」，
而不是「TIM 厚度 = 2.5」→ 它要的就是壓縮後的縫隙厚度。Putty（0.5）與 Grease（0.05）
兩邊數字一致，因為這類材料填滿縫隙、沒有原始片厚的概念。

因此：**`timType` 為 `Grease`/`Putty` 時 `gapThickness` 自動同步為 `thickness`**
（`TIM_LIB_GAP_SYNCED`／`timLibApplyGapSync`），畫面上顯示為白底黑字純文字＋`✂` 解鎖口
（UX 慣例 2）；按 `✂` 後 `gapUnlock = true`，兩欄改為各自獨立。`Pad` 一律獨立輸入。
`gapThickness` **必填且須 > 0**（它是 R_TIM 的分子，留空會讓 5G-RRU 的 R_TIM 變 0 ＝ 低估熱阻）；
同步中的列若缺值，錯誤訊息與紅框會導向來源的「預設厚度」欄。

#### 元件物件（`rf_data` / `digital_data` / `pwr_data` 的每一筆）欄位歸屬

同一顆元件物件由兩個工具共寫，各自只畫得出自己那一半欄位：

| 欄位 | 誰有畫面可編輯 | 備註 |
|---|---|---|
| `Component` | 兩邊 | 名稱即 key |
| `Qty`、`Power(W)` | 兩邊 | |
| `Limit(C)` | 兩邊 | AI-Thermal 在 Tab1「限溫(°C)」欄（Qty 右側）|
| `Limit_Ref` | 兩邊 | **限溫對象** `'Tj'`／`'Tc'`：限溫欄底下的小下拉（兩個工具都有）。沒有 key＝自動判定，見下方「限溫對象」 |
| `Type`、`Power_RT(W)`、`TV_ID_mil`、`TV_Qty`、`Temp_Sensor`、`Local_Qty`、`Remote_Qty`、`note`、`Rth`、`SpecFile` | 只有 AI-Thermal | 5G-RRU 不顯示但會原樣保留 |
| `Board_Type`、`Pad_L`、`Pad_W` | AI-Thermal **推導**（Tab2）| 由 Tab2「主散熱路徑」＋元件大小／E-PAD 大小推導，見下節 |
| `TIM_Model` | AI-Thermal **推導**（Tab2）| 由 Tab2「TIM Type」底下的型號下拉推導；值是 `tim_library` 的**型號名** |
| `TIM_Type` | 兩邊（AI-Thermal Tab2 有選類型時覆寫）| 見下方「`TIM_Type` 也由 Tab2 推導」的兩個守則 |
| `R_jc` | AI-Thermal **推導**（Tab1）| 由熱阻表的 θJC 推導，見下節。⚠ 5G-RRU 端**已改成鎖定不可編輯**（有 `_rjc_from` 就顯示白底黑字純文字＋🔒，tooltip 指路回本工具的熱阻表）—— 熱阻是規格書的值，編輯入口只留這裡一個 |
| `Height(mm)`、`Thick(mm)` | **只有 5G-RRU** | ⚠ AI-Thermal **一律不寫這兩個 key**，見下方「不捏造」。`Thick(mm)` 在 5G-RRU 端已改為由它參數控制台的「PCB 板厚度」(`t_PCB`) 與「銅塊厚度」(`Coin_T_Setting`) 依 `Board_Type` 推導（`IC top`/`None` 則為 0），本工具更不該碰它 |

> ⚠ 上表**每一個** per-component 欄位都必須出現在 `SG_VARIANT_CARRY`（含推導出來的
> `Board_Type`/`Pad_L`/`Pad_W`/`R_jc`/`TIM_Model`/`TIM_Type`）。漏一個，快選複製元件時就會掉值。
> 目前應為 22 項，與上表一致（含 `Limit_Ref`）。
>
> 內部欄位（底線開頭，兩個工具都原樣保留、**不列入** carry 白名單）：`_cid`（元件 id，存檔三方合併配對用，
> 兩邊都會補發，見下方「存檔三方合併」）、`_defaults_ok`（5G-RRU 寫：使用者確認過這顆不是舊版罐頭預設值）、
> `_rjc_from`／`_bt_from`／`_pad_from`（本工具寫：推導來源）、`_excluded`／`_ref_*`（5G-RRU 的排除與快選參照）、
> `_renamed_from`（5G-RRU 寫：改過名的元件，本工具以名稱當 key 的資料還掛在哪個名稱底下；本工具存檔搬完就清掉，
> 見下方「元件改名」）、`_limit_ok`（兩邊都會寫：使用者確認「限溫疑似範例值」其實是實際規格時，記下**確認的那個限溫數字**，
> 見下方「限溫對象」）。

#### 限溫對象（`Limit_Ref`）與限溫疑似範例值（`_limit_ok`）⚠️ 兩個工具共用規則

「限溫」指的是 Tj（晶片接面）還是 Tc（外殼／本體）。原本只有 5G-RRU 用名稱猜（PWR 類或名稱含 ddr → Tc），
本工具看不到也改不了；而且 5G-RRU 的允許溫升一律扣 P×Rjc，Tc 類元件 Rjc > 0 時會低估允許溫升。

- **`Limit_Ref`**：`'Tj'`／`'Tc'`，沒有 key＝自動判定（選「自動」一律 `delete`，不寫 `''`）。Tab1 限溫欄底下的小下拉
  （`sgLimitExtraHtml`：`自動·Tc`／`Tj 接面`／`Tc 外殼`，「自動」直接寫出判定結果；值不認得時補「（未知值）」選項，
  不靜默改掉）。改限溫、類型、名稱時 `sgRefreshLimitCell` **就地**更新那一格與上方橫幅（不整表重繪，UX 慣例 1）。
- **單一事實來源 `CompMerge.limitRef(comp, cat)`**（兩邊逐字相同的 `compMerge.js`）：有填照填的；沒填 →
  先看本工具的元件類型（`DDR`／`eMMC`／`SFP`／`GPS module`／`Power Modules`／`filter`／`CR` → Tc；
  PA、DC-DC、LDO、CPU 等 IC 類型 → Tj），沒有類型才用舊規則（PWR 類、名稱含 DDR 或 SFP → Tc，其餘 Tj）。
  ⚠ 所以**改元件類型會改變 5G-RRU 的判定溫度**（只在沒指定 `Limit_Ref` 時）。
- 5G-RRU 端：內部溫降＝從判定溫度的位置到散熱器，**Tc 不含 Rjc**；允許溫升、裕度、溫升組成因此一致。
  備份真實資料的體積與瓶頸完全不變（Tc 類元件 Rjc 都是 0）。
- **限溫疑似範例值 `CompMerge.limitSuspect`**（只提醒、不擋計算，琥珀色）：光模組 > 85 °C、DDR > 105 °C、
  功放以外 ≥ 200 °C（5G-RRU 內建範例的 SFP、Cavity Filter 都是 200，有專案原封不動沿用）。Tab1 限溫格虛線框＋
  「⚠ 疑似範例值 [確認]」、元件清單上方 `#sg-lim-sus-banner` 橫幅。按確認 → 寫 `_limit_ok` ＝ 當時的限溫；
  之後改成別的值會再提醒。未解鎖時下拉與確認鈕由 `applyReadonlyLock` 一起停用。
- 快選白名單 `SG_VARIANT_CARRY` 含 `Limit_Ref`（`_limit_ok` 不帶）；參照同步 `SG_REF_SPEC_FIELDS` 含 `Limit_Ref`
  （屬於這顆料本身）；Excel 匯出在限溫後面多一欄「限溫對象」。三方合併：`Limit(C)`＋`Limit_Ref` 綁成一組。
- 契約測試：`tests/limit-ref.test.js`；規則本身在共用的 `tests/comp-merge.unit.test.js` [M]／[N]。
  5G-RRU 端的計算與畫面見它的 CLAUDE.md「限溫對象」一節。

##### ⚠ 不捏造 5G-RRU 專屬欄位（`sgMakeComp`）

AI-Thermal 原本有一份 `SG_DEFAULTS`，與 5G-RRU 的 `RF_DEFAULT`/`DIG_DEFAULT`/`PWR_DEFAULT`
**完全同值**，等於本工具先塞一份假資料、5G-RRU 端再也分不出「工程師真的填了 250」還是
「AI-Thermal 自動塞的 250」。已移除，新元件一律**不建立**這些 key。

**空值一定要「不寫 key」，不可寫 `''`**：`''` 在舊版 5G-RRU 的 `calcRow` 多半不會噴 NaN，而是靜默算成 0
（實測：`Thick` 空 → `R_int`=0、`Board_Type` 空 → `R_int`=0、`Pad_L/W` 空 → 面積用字串算出假值、
`Limit(C)` 空 → 裕度變超大負數），**方向是低估熱阻＝樂觀**，比 NaN 更危險。現在的 5G-RRU 載入時會把 `''`
刪掉並當成「沒填」擋下計算，但共用 DB 的規則不變：空值不寫 key。`sgCarrySrc` 會跳過 `undefined`，故快選不受影響。
- `sgMakeComp` **不建立 `Power(W)`**（原本寫 `''`）；使用者填了才有。
- 清空 Tab1 的共用數字欄（`SG_SHARED_NUM_FIELDS` = 限溫／瓦數／數量）時 `sgOnCompEdit` 一律 `delete` key。
- 存檔時元件清單經 `CompMerge.normalizeComp` 整理：共用數字欄轉成數字、`''`／非數字 → 不寫 key。

> ⚠ **這個「不捏造」在 5G-RRU 端的後果，已由它自己處理，不要為了消 NaN 而改成捏值**：
> 本工具建立的元件沒有 `Height(mm)`／`R_jc` 等 key，5G-RRU 載入後 `calcThermalResistance`
> 會拿 `undefined` 做算術 → Tj／裕度／允許溫升整列 NaN（而它的元件表 `value="(row[col]||0)"`
> 會把缺值顯示成 0，看起來跟正常元件一樣，使用者只會覺得「建法一樣為什麼只有這幾顆 NaN」）。
> 5G-RRU 端的處理（其 PR #87 起）：**元件欄位一律不補預設值**，缺必填（數量、瓦數；會發熱的另加高度、限溫、
> Rjc、導熱方式、介面材料、E-Pad 長寬）→ 紅框「必填」並**擋下計算**，直到使用者補齊或按 👁 排除。
> 另外 7 個欄位**全部**等於本工具舊版 `SG_DEFAULTS` 的元件（2026-09-18 以前建立的，例：Cygnus 40 顆）
> 會被標成「疑似舊版自動帶入的預設值」，一樣擋計算，使用者改成實際值或按「確認是實際值」（寫
> `_defaults_ok: true`）才解除。**本工具仍然不寫這些 key** —— 值要由擁有該欄位的工具給、而且要是實際值；
> 本工具能推導的（`Board_Type`／`Pad_L`／`Pad_W`／`R_jc`／`TIM_Type`）推導得越完整，使用者在 5G-RRU
> 要補的就越少。

⚠ **「從資料庫快選」的 carry 白名單兩邊都必須列全所有欄位**（AI-Thermal 的
`SG_VARIANT_CARRY` / 5G-RRU 的 `VARIANT_CARRY`）。漏列的 key 快選時就不會被帶過來（5G-RRU 已不套
分類預設 → 變成缺值被必填檢查擋下；本工具專屬欄位則整個掉失），複製完再存回共用 DB 就等於把對方工具填的真實值丟掉。新增任何每元件欄位時，
**同一個 commit 內要把它加進本工具的白名單，並在另一個 repo 同步補上**。
物件／陣列型欄位（`Rth`、`SpecFile`）carry 時必須深拷貝，否則新元件與來源共用參照。

> `SpecFile` 是檔案參照不是複本（實體檔在來源專案的 `SPEC/<專案名>/` 底下）。快選帶入時
> 會標 `SpecFile._from = <來源專案名>`，本專案刪除／換檔時只解除參照，不得刪來源檔。

#### ⚠ `SpecFile`：一顆元件可以有「多份」規格書（形狀會變，兩個 repo 都要照規矩讀）

同一顆料常常有 datasheet／application note／errata 好幾份 → 一顆元件可存多份規格書。
為了讓既有資料與 5G-RRU 端完全不受影響，**欄位仍叫 `SpecFile`，形狀隨份數變**：

| 份數 | `comp.SpecFile` |
|---|---|
| 0 | **key 不存在**（`delete`，不可寫 `''`／`[]`）|
| 1 | `{ path, name, at, by, _from? }` ← **與舊格式完全相同** |
| ≥2 | `[{ … }, { … }, …]`（陣列，每筆同上） |

- **讀一律 `sgSpecList(comp)`**（回陣列，吃得下單一物件）、**寫一律 `sgSpecStore(comp, list)`**
  （0 → delete key、1 → 寫回單一物件、≥2 → 陣列）。不要直接碰 `comp.SpecFile.path`。
- 之所以「1 份維持舊形狀」：既有專案在共用 DB 裡的內容一個位元都不用動（diff 最小），
  而且使用者瀏覽器若還快取著舊版前端，單份規格書照樣看得到（多份才會顯示成未上傳）。
- **`_from` 要逐份標**（`sgSpecMarkFrom(holder, projName)`）。漏標的那幾份會被當成本專案
  自己的檔案，刪除時就把來源專案的原始檔刪掉了。⚠ **5G-RRU 端同步實作** `specMarkFrom()`
  （其快選 `addFromVariant` 也會複製 `SpecFile`）—— 原本的 `if(src.SpecFile.path)` 只認單一
  物件，遇到陣列會整批漏標。
- UI（外層按鈕數量不變，仍是五顆）：`👁` 1 份直接看／多份在預覽視窗上方給**檔案切換列**
  並在按鈕上標數量徽章；`↑` 可一次選多檔並附加，**同檔名＝取代該筆**（同名上傳本來就會覆蓋
  SharePoint 上同一個路徑，若再新增一筆就會有兩筆指向同一個檔）；`↓`／`🗑` 多份時開
  **規格書清單**讓使用者挑；`🕘` 就是那個清單（逐份檢視／下載／🔄 取代／🗑 刪除＋上傳紀錄）。
- 取代（`🔄` 或同檔名上傳）：新檔上傳成功後才處理舊檔，且路徑相同（同名覆蓋）或舊檔是
  `_from` 參照時不刪。刪除一份只 `splice` 那一筆，其餘保留。
- ⚠ **實體檔一律等「儲存元件變更」成功後才刪**（`sgQueueSpecDelete` → `sgPendingSpecDeletes` →
  `saveAllTabs` 成功後 `sgFlushSpecDeletes`）。原本按 🗑 就立刻刪 SharePoint 上的檔，但移除參照要存檔才寫進
  資料庫 → 沒存就離開（換專案、放棄修改）時資料庫指著一個已經不存在的檔。換專案時待刪清單清空（沒存＝不刪）。
  真正刪之前再掃一次**所有專案**：還有任何元件指著同一個路徑（同名重新上傳、別的專案的快選參照）就不刪。
- 上限 `SG_SPEC_MAX = 20`。
- **TH/ME 頁（Tab2）只有 `👁`**：`th2SpecCell()` 讀的是 Tab2 自己的專案副本（`sgSpecView(cat, idx, k, 'tab2')`），
  因為兩頁各有獨立的專案選單。上傳／取代／刪除的入口**只留 Tab1**（UX 慣例 4：同一份檔案
  不開兩個寫入入口）；清單視窗從 Tab2 開啟時也只給檢視／下載。

> **快選面板可調整大小**：`.sg-picker-pop` 是 flex 直排（搜尋框與底部把手固定高、
> `.sg-picker-list` 用 `flex:1; min-height:0` 吃掉剩餘高度），所以拉高面板時變長的是
> 清單本身，而不是只把外框撐大。開啟時的 `display` 必須是 `flex` 不能是 `block`
> （否則清單吃不到剩餘高度）。⚠ 面板由 `sgRenderProjectComponents` 重繪時**重建**，
> 尺寸一定要記在 localStorage（`sgThermal.pickerSize`，三個分類共用）並在開啟時
> `sgPickerApplySize` 套回去，否則每次重繪就跳回預設；套回去時夾在 92vw／82vh 內
> （換小螢幕不會爆出畫面）。
>
> ⚠ **面板必須 `position: fixed`，不可用 `absolute`**：外層 `.sg-panel` 是 `overflow: hidden`，
> 元件表一長，動作列就落在 `.sg-panel` 底部，絕對定位的面板往下開出去的那一段
> **會被整片裁掉**（連把手一起），使用者只看到半截面板、也按不到任何地方調大小
> （實測 420px 高就被裁掉 78px、700px 高裁掉 358px；`elementFromPoint` 命中不到底部把手）。
> `fixed` 只受 transform／filter 類 containing block 影響（本頁祖先都沒有），不吃 overflow 裁切。
> 位置由 `sgPickerPlace()` 依觸發鈕算出並夾在視窗內（下方放不下就往上推、往左收，
> UX 慣例 6）；`fixed` 不跟著頁面走 → 開啟時掛 `scroll`／`resize` → `sgPickerReflow()`，
> 關閉時**必須移除**這兩個監聽。z-index 1200（在表格之上、各種 modal 1400+ 之下）。
>
> ⚠ **調整大小的把手要「看得見」，不要只靠 CSS `resize: both`**：原生把手只是右下角幾條
> 淡斜線、又疊在內容上，使用者回報「沒有可以手動調整視窗大小的地方」。現在是兩個明確的
> 把手：底部整列 `.sg-pk-footer`（`cursor: ns-resize` ＋文案＋`.sg-pk-grabber` 抓握紋路，
> 往下拖＝拉高，最常用）與右下角 `.sg-pk-grip`（18px 斜線格柵、`cursor: nwse-resize`，
> 寬高一起調），都走 `sgPickerDragStart(ev, cat, axis)`：拖曳中只改 inline style ＋
> `sgPickerPlace()` 重夾（底部不可掉出視窗，否則把手又抓不到），**放手才寫 localStorage**
> （不在 `mousemove` 裡碰 storage）。「重設大小」按鈕要 `onmousedown="event.stopPropagation()"`，
> 否則點它會先被當成一次拖曳。已不再使用 `ResizeObserver`（原本的兩個守衛連同它一起移除）。

> **快選是「一次性快照」，不是 live link**：`sgPickerAdd` 把來源元件的欄位整份抄進本專案，
> 之後兩邊各走各的（唯一真的連動的是 `SpecFile` 的路徑與 `tim_library` 的型號）。
> 來源後來補了熱阻，本專案不會自己變 → `sgRefSyncBadge` 每次重繪拿 `sgProjectTreeCache`
> （快選面板本來就讀好的全專案元件，不必多讀 DB）比對 `SG_REF_SPEC_FIELDS`
> （`Rth`／`SpecFile`／`Limit(C)`／`Limit_Ref`／`Type`／`Temp_Sensor`／`Local_Qty`／`Remote_Qty`
> —— 只有「屬於這顆料本身」的欄位），有差異就在元件名稱下方標「↻ 來源有更新 (n)」，
> 點開 `sgRefSyncOpen` 列出「目前 vs 來源」逐欄勾選套用。守則：
> **絕不自動覆蓋**（本專案可能刻意填不同值）；功耗／E-Pad 尺寸／導熱方式／TIM／備註
> **不在同步範圍**（跟著各專案自己的工況與散熱設計）；來源已清空的欄位**預設不勾**，
> 勾了是 `delete` key 而非寫 `''`；套用物件欄位要深拷貝（否則與 `sgProjectTreeCache` 共用參照）；
> `SpecFile` 套用後要重標 `_from`；改到 `Rth` 就呼叫 `sgSyncRjc(comp)` 讓 `R_jc` 跟著重算。
> 來源專案或同名元件不見了 → 顯示「來源已不存在」，不給更新鈕也不報錯。

#### ⚠ 參照也涵蓋 Tab2 的「元件大小／元件高度」（值不在元件物件上）

`heatSourceSize`（元件大小 L×W）與 `heatSourceHeight`（元件高度 max）是**這顆料的封裝規格**，
不是各專案自己的散熱設計 → 列入 `SG_REF_SPEC2_FIELDS`，快選時一起帶、來源有更新也會出現在
「↻ 來源有更新」清單裡（標「（TH/ME 頁）」）。凸台大小／TIM／E-PAD／IC 距離 HSK **不列入**。

⚠ 這兩個值存在 `thermal_specs[sgSpecKey(元件名)]`（Tab2 的資料），**不在元件物件上**，
而 Tab1/Tab2 各有獨立的專案選單 → 一律走 `sgApplySpec2(projId, compName, vals, force)`：

- **(a) Tab2 正好載入同一個專案** → 直接寫進記憶體的 `thermalSpecs`，畫面即時反映。
- **(b) 沒有** → 寫進 Tab2 的副本就是污染「別的專案」的資料 → 先存進 `sgPendingSpec2[projId]`，
  由 `saveAllTabs` 讀回該專案現有的 `thermal_specs`、**只填空格**後併進 **Tab1 的那一筆 op**
  （所以 Tab1 的存檔在這個情況下會寫 `thermal_specs`，是唯一的例外；讀-改-寫在持鎖狀態下進行）。
  Tab1 換專案時 `sgPendingSpec2 = {}` —— 未存檔的快選元件本來就會一起被丟掉。
- 快選帶入一律**只填空格**（本專案可能刻意量到不同尺寸）；`sgRefSyncApply` 是使用者逐欄勾選，
  才用 `force=true` 覆蓋。來源沒填 → 什麼都不做（不寫 `''`、不建立空的 spec 物件）。
- **差異比對只在「兩頁同專案」時進行**（`currentProjectId === sgProjectId`），否則本專案的現值
  根本不在記憶體裡，比了就是誤報 —— 這條與 `sgDeriveAllFromSpecs` 的「兩半都在記憶體裡才推導」
  是同一個道理。視窗說明文字有寫這個前提，不要拿掉。
- 寫入 `heatSourceSize` 後要走 `applyHeatSourceSizeEffects(specKey)`（Pad → 重算凸台/TIM Size；
  Putty ＋「自動帶入」→ 凸台同步）。這段是從 `onCellChange` 抽出來共用的，
  **兩邊都要走同一個函式**，否則「手動改」與「參照帶入」的連動行為會分岔。

> **規格書線上預覽（Tab1 規格書欄的 👁）**：`sgSpecView` 用 `dbAdapter.getSpecMeta(path)`
> 取回 `downloadUrl`／`webUrl`，把 bytes 抓下來做成 blob URL 就地顯示 —— PDF 走 iframe
> （瀏覽器內建檢視器）、圖片走 `<img>`、純文字逸出後放 `<pre>`；Office 檔瀏覽器沒有檢視器，
> 改給 SharePoint `webUrl`（Office Online，一樣不必下載），其餘格式說明不能預覽並指向下載。
> ⚠ **blob 的 MIME 一律由副檔名決定，不可改用伺服器回的 content-type**：blob: URL 會繼承本頁
> origin，讓瀏覽器把某個上傳檔當成 HTML 解析，等於給它在本站 origin 執行腳本的機會。
> 預覽只讀不寫 → 按鈕標 `sg-spec-ro`，未解鎖（唯讀）時照樣能看；關閉時要 `revokeObjectURL`
> 並以序號讓仍在飛的非同步結果失效。`graphDb.getSpecSrc` 現在是 `getSpecMeta` 的薄包裝
> （單一事實來源）。

> `R_jc` 由 AI-Thermal 的熱阻表自動推導（見下節），不是使用者在 AI-Thermal 直接填的。

#### `R_jc` 的單一事實來源：AI-Thermal 的 `comp.Rth`

`comp.Rth = [{ type, value, cond, primary }]` 逐筆記錄 datasheet 的熱阻標法。
存檔時 `sgSyncRjcAll` 會把其中的 **θJC** 寫進 `comp.R_jc` 供 5G-RRU 算 Tj：

- **依主散熱路徑取用**（`sgHeatPathOf` → `sgRjcWantFor` → `sgRjcFromRth`）：熱從哪一面出去，就用那一面的 θJC。
  `IC top`（熱從封裝上表面經 TIM 出去、5G-RRU 端 `R_int = 0`）→ **θJC,top**；
  `Copper Coin`／`Thermal Via`（穿板、從底面出去）→ **θJC,bottom**。同一種有多筆 → 標「主要」的優先。
  主散熱路徑取自 Tab2（兩頁同專案用 TH/ME 頁記憶體裡的最新值），沒有就看元件上的 `Board_Type`。
  ⚠ 原本一律優先取標「主要」／θJC,bottom：露銅焊墊封裝的 θJC,bottom 通常比 θJC,top 小很多 →
  IC top 元件的 Tj 被低估（偏樂觀）。
- 熱阻表沒有對應的那一種 → 暫用另一種、回傳 `fallback: true`：熱阻視窗顯示琥珀色提醒（`.sg-rth-fallback`），
  Tab1 熱阻按鈕的 tooltip 也寫出來；5G-RRU 端看 `Board_Type` 與 `_rjc_from` 對不上時標 ⚠。
- 沒選主散熱路徑 → 維持原本順序（標「主要」的 → 第一筆 `JC_bot` → 第一筆 `JC_top`）。來源記在 `comp._rjc_from`。
- **只有 θJC 可以當 `R_jc`**。5G-RRU 的熱路徑是 `Tj = Tc + P×R_jc`、
  `Tc = T_hsk + P×(R_int + R_TIM)`；θJA 含到環境的整條路徑、θJB 到板子、Ψ 是特性參數，
  硬塞會讓 Tj 重複計算而失真。
- 沒有任何 θJC 時不動 `R_jc`（保留既有值），只清掉 `_rjc_from`。
  ⚠ 這也是 5G-RRU 端**唯一**還能自行輸入 Rjc 的情況：它以 `_rjc_from` 判斷要不要鎖欄位，
  沒有標記就當成「本工具沒推導過」而開放輸入。所以不要為了「清乾淨」而在沒有 θJC 時
  順手寫 `R_jc = 0` —— 那會把對方填的值洗掉，且方向是低估熱阻。

#### `Board_Type` / `Pad_L` / `Pad_W` 的單一事實來源：Tab2「主散熱路徑」

Tab2 原本的「散熱方向」（`IC top`/`IC bot`/`雙向`）改為 **「主散熱路徑」**，選項直接對應
5G-RRU 的導熱方式，並同時決定 `Pad_L`/`Pad_W` 取哪個尺寸（`HEAT_PATH_MAP`）：

| 主散熱路徑 | `Board_Type` | `Pad_L`/`Pad_W` 取自 |
|---|---|---|
| `Copper Coin` | `Copper Coin` | `heatSourceSize`（元件大小）|
| `Thermal Via` | `Thermal Via` | `epadSize`（**E-PAD 大小**，選此值才出現的分支欄）|
| `IC top` | `IC top` | `heatSourceSize`（不穿板：5G-RRU 端 `R_int = 0`、`R_TIM` 以元件上表面積 `Pad_L×Pad_W` 計算）|
| `None` | `None` | `0` |

- `Pad_L`/`Pad_W` 是 **E-PAD（散熱焊墊）尺寸，不是 IC 外型尺寸**。Copper Coin 也需要它
  （5G-RRU 的 die-attach solder 項是 `t_Solder/(K_Solder × pa × Voiding)`，直接除以 `pa`），
  不能只靠它參數控制台的 coin L/W。
- 未選主散熱路徑，或尺寸解析不出來 → **不寫任何 key**（不寫半套、不寫 `''`）。
- 舊值 `IC bot`/`雙向` 在新選項無對應（資料裡看不出是 Coin 還是 Via）→ 載入時顯示空白＋
  琥珀色「需重選」提示（`HEAT_PATH_LEGACY`），匯出也不輸出該值。
- 寫 `Board_Type` 時一併寫 `comp._bt_from = 'heatDirection'`（Pad 則是既有的 `comp._pad_from`
  = `epadSize`／`heatSourceSize`／`none`，`R_jc` 是 `comp._rjc_from`）。這三個是**來源標記**，
  5G-RRU 端據此在元件清單把該欄標成「AI-Thermal 推導值」（欄位左側藍邊＋tooltip），
  提醒 RRU 端改了會被下次存檔覆寫。標記是內部欄位（底線開頭），不列入 carry 白名單。
- ⚠ `IC top` 原本壓成 `Board_Type='None'`，5G-RRU 因此分不出「不穿板但從上表面散熱」與
  「不計基板路徑」，且它的 `None` 會把接觸面積算成 `(Pad_L+Thick)×(Pad_W+Thick)`（高估面積
  ＝低估 `R_TIM`）。5G-RRU 已新增同名的 `IC top` 選項，此處才改為直接寫 `'IC top'`。
  既有以 `IC top` 推導出的元件在下次存檔時會由 `None` 變成 `IC top`，該元件的 `R_TIM`
  會**變大**（面積改回 `Pad_L×Pad_W`）——方向是保守的，屬修正。
- 推導時機在 `saveAllTabs`（`sgDeriveAllFromSpecs`）。⚠ `thermal_specs` 與 `rf_data` 同屬一個
  專案 document，但 Tab1/Tab2 各有獨立的專案選單且各持一份 `rf_data` 副本，所以只在
  「同一專案的兩半都在記憶體裡」時推導：兩頁同專案 → 推到 **Tab1 的副本**（否則 Tab1 的
  寫入會蓋回去）；Tab2 單獨載入別的專案 → 推到 Tab2 的副本並把三個陣列補進 Tab2 的寫入。

#### `TIM_Model`：Tab2 的 TIM 選型

Tab2「TIM Type」欄底下多一個**型號**下拉，只列出 `tim_library` 中 `timType` 相符的型號
（`timLibModelCell` / `onTimModelChange`），存 `thermal_specs[key].timModel`（型號名）。
存檔時 `sgDeriveFromSpec` 寫成 `comp.TIM_Model`；取消選型則 `delete` 該 key（不寫 `''`）。

- **選了型號 → Tab2 的「TIM 厚度」改由該型號的 `thickness`（預設厚度）帶入並鎖定**，
  優先於 `TIM_PRESETS` 的分類預設，且不再受 `TIM_THICKNESS_OPTIONS` 固定清單限制
  （型號可能是 1.2mm 這種清單裡沒有的值）。鎖定值顯示為純文字＋`✂`，tooltip 標明來源型號。
- 換型號會 `delete padUnlock.timThickness`，讓新型號的厚度生效（來源變動要跟隨）。
  換 TIM 類型會 `delete spec.timModel` —— 型號隸屬於某個類型。
- 型號庫裡沒有該類型的型號時，顯示「型號庫無 X 型號」並指路到工具列按鈕，不給空下拉。
- 型號在庫裡被刪掉時，下拉仍把舊值列出來並標「（已從型號庫移除）」＋琥珀色，
  **不靜默改掉使用者填的內容**。
- 型號庫是頂層 collection、與專案無關，但選型下拉需要它 → Tab2 載入專案後背景
  `timLibLoad()`，讀完再 `renderAllCategories()` 一次。

#### `TIM_Type` 也由 Tab2 推導（5G-RRU 移除 `Pad2` 之後才開的連動）

5G-RRU 的 TIM 類型已收斂成與本工具相同的 `Grease / Pad / Putty / None`（其 PR #76 移除
`Pad2`），因此 `sgDeriveFromSpec` 現在把 Tab2 的 `spec.timType` 一併寫成 `comp.TIM_Type`。
兩個守則不可拿掉：

1. **只有「Tab2 這一列有選 TIM 類型」時才管這顆元件的 TIM 欄位。** 沒選（顯示「—」）
   或 Tab2 根本沒有這一列 → `TIM_Type` 與 `TIM_Model` 兩個 key 都不動。
   5G-RRU 端也選得了型號，Tab2 沒填就清掉對方的 `TIM_Model`，等於靜默把它的 k/t
   換回 `K_<Type>`/`t_<Type>`，方向是低估熱阻。
2. **舊類型（`SG_TIM_LEGACY_TYPES` = `Pad2` / `Solder`）沒有「連型號一起寫」就不覆寫。**
   它們吃的是別組 global 參數（`Pad2` → `K_Pad2`/`t_Pad2`），只換類型不換 k/t 來源
   等於靜默改變計算結果。有選型號時才收斂成 `Pad` ＋型號（＝完成遷移）。

取消選型一律 `delete comp.TIM_Model`，不可寫 `''`。

> 5G-RRU 端對舊資料仍保有讀取相容（`TIM_LEGACY_PARAM`）：`TIM_Type: 'Pad2'` 的元件繼續
> 以該專案殘留的 `K_Pad2`/`t_Pad2` 計算，並在畫面上提示改用「`Pad` ＋型號」；
> 它的參數控制台已不再有 `K_Pad2` / `t_Pad2` 欄位（也不再寫入這兩個 key，但既有專案的值保留）。

#### 專案「改名」只改 `project_name`，**絕不動 document id**

Tab1 的「✏️ 重新命名」（`sgAskRenameProject` / `sgConfirmRenameProject`）只寫
`updateDoc('projects', id, { project_name })`。

- **id 是所有東西的錨點**：三個頁籤的專案選單、標註圖片路徑（`tcp_images/<projectId>_…`）、
  跨頁載入都靠它。改 id 等於搬家，必須整批搬移參照 —— 所以不做。
- **不要順手更新 `meta`**：它是 nested object，shallow merge 會整顆換掉 5G-RRU 寫的內容。
- 改完**不可呼叫 `sgLoadProjects()`** 來刷新下拉 —— 它會 `dbAdapter.refresh()` 重讀磁碟，
  把使用者尚未儲存的元件編輯整個丟掉。改為 `_sgApplyRenameToUI()` 就地換掉三個下拉的
  `<option>` 文字，並同步三份已載入的 `*ProjectData.project_name`。
- 驗證：名稱不可空白；**不可與其他專案同名** —— 規格書路徑是 `SPEC/<專案名>/…`，
  撞名會讓兩個專案共用同一個資料夾。
- ⚠ **既有規格書檔案不會跟著搬**：每顆元件的 `SpecFile.path` 存的是完整路徑，所以下載
  照常；只有改名後「新上傳」的檔案會進新資料夾。這點在彈窗說明裡有明講，不要拿掉。

#### 元件改名 → 以元件名稱當 key 的資料一起搬（兩個工具都能改名）⚠️

本工具有好幾份資料用「元件名稱」當 key，改名時全部要跟著搬，否則變孤兒（TH/ME 頁那一列變空白、推導不出
導熱方式／E-Pad → 到 5G-RRU 變必填紅框；實測值掛在舊名稱底下、新名稱另外多一列空白的）：

| 資料 | 位置 | key |
|---|---|---|
| TH/ME 頁規格、隱藏清單 | `thermal_specs`、`hidden_components` | `sgSpecKey(名稱)`（不分分類）|
| Tab3 實測、要驗證清單 | `validation_data[分類][].component`、`vd_hidden_components` | 名稱、`分類\|名稱` |
| Tab1 標註 | `tcPlacement[分類].pages[].annotations[].componentRef` | 名稱 |

改名有兩個來源，最後都在**存檔時、寫入當下的最新內容上**統一搬（`sgCollectRenames` → `sgApplyRenames`）：

- **本工具 Tab1 改名**（`sgOnCompEdit` → `sgRenameSpecRefs`）：畫面上正好載入同一個專案的 TH/ME 頁／Tab3 當場搬
  （它們那份元件清單的名稱一起改），快選帶入還沒存的尺寸（`sgPendingSpec2`）也跟著走。沒載入的頁**不必記下來**
  （原本的 `sgPendingRenames` 已移除）：存檔時比對「資料庫裡這顆元件的名稱」與「要寫的名稱」就知道要搬。
- **5G-RRU 改名**：它不碰這些資料，存檔時在元件上標 **`_renamed_from` ＝ 資料庫裡這些資料掛在哪個名稱底下**
  （它寫入當下拿資料庫最新內容算：沒改名不標、改回原名不標、連改兩次仍指向最早的名稱）。本工具：
  - 載入各頁時（`sgLoadRenames`：Tab1 的標註與手上那份 `thermal_specs`、TH/ME 頁、Tab3）先照標記搬**記憶體**裡那一份，
    畫面才對得上，並提示「存檔後寫回資料庫」；Tab1 同專案有還沒存的改名時，也把該頁的元件清單副本換成 Tab1 的名稱。
  - 存檔時搬好**所有**以名稱當 key 的資料，才在同一次寫入裡清掉 `_renamed_from`（`sgClearRenameMarks`）。
- 存檔時每顆元件的「候選舊名」＝它的 `_renamed_from`＋資料庫最新／畫面／載入時快照裡的名稱（用 `_cid` 對；
  資料庫舊資料還沒有 id 時用快照裡的名稱對）。同一個專案在一批寫入裡可能有三筆（Tab1／TH/ME 頁／Tab3）：
  **寫元件清單的那一筆算出改名**，同批後面的寫入沿用（`writeBatch` 依序計算）、各自搬自己要寫的那份；
  沒有頁面載入的那份就在資料庫最新內容上搬（`moveDbStores`）。寫入時搬的是複本，成功後記憶體再套同一批改名。
- 守則：**新名稱已經有資料 → 不覆蓋**（兩份都保留、提示）；Tab3 新名稱只有自動產生的空白列（沒有任何量測值／備註）
  → 用舊名稱那一列取代。**舊名稱現在是另一顆元件的名稱 → 不搬**（那是它的資料）。
- 合併時不比對 `_renamed_from`（`SG_MERGE_DERIVED`；兩個工具寫入時都會重新決定它），不會為它跳衝突。
- 契約測試：`tests/merge-save.test.js` [E]／[J]／[K]；5G-RRU 端 `tests/merge-save.test.js` [I]。

#### 存檔三方合併（`compMerge.js`）⚠️ 兩個 repo 共用同一份

兩個工具存檔時都會把整份元件清單（`rf_data`／`digital_data`／`pwr_data`）用自己畫面上的副本寫回。
直接寫回 → 對方在我們**載入之後**存的修改被整批蓋掉（例：本工具開著專案 → 5G-RRU 補了元件高度存檔 →
回本工具改瓦數存檔 → 高度被蓋回沒有）。

- **`compMerge.js`（＋`tests/comp-merge.unit.test.js`）在兩個 repo 內容逐字相同**，改一邊就同步另一邊。
  它也放了兩個**共用元件語意**函式（`limitRef`／`limitSuspect`）：兩個工具的畫面與計算必須判斷一致。
- 快照：`sgProjectBase`（Tab1 載入時）、`clProjectBase`（Tab2 載入時；TH/ME 頁單獨推導別的專案、把三個陣列
  補進 Tab2 的寫入時用）。載入時 `CompMerge.ensureProjectCids` 補發 `_cid`，快照與畫面同一份 id；
  `sgMakeComp`（含快選）一律給**新的** `_cid`。
- `saveAllTabs` 的 Tab1／Tab2 寫入改成 **fields 函式**：`dbAdapter.writeBatch` 在「寫入當下的最新內容」上呼叫
  （412 重讀後重算；本機檔模式的 `ConflictError` 由 `CompMerge.saveWithMerge` 重試），逐顆元件、逐欄比對：
  我沒改 → 用資料庫的；只有我改 → 用我的；**兩邊改得不一樣 → 存檔前跳衝突視窗**，每一列選「用我的／用資料庫的」，
  全部選完才能存；取消 → 什麼都不寫、狀態列說明。相依欄位整組比對（E-Pad 長寬＋`_pad_from`、`R_jc`＋`_rjc_from`、
  `Board_Type`＋`_bt_from`、`TIM_Type`＋`TIM_Model`、`Limit(C)`＋`Limit_Ref`）。本工具自己推導的欄位（`sgSyncRjcAll`、`sgDeriveAllFromSpecs`
  在存檔前算好）屬於「我的修改」，照常寫入。
- 本工具專屬、不與 5G-RRU 共寫的欄位（`param_*`、`tcPlacement`、`thermal_specs`、`validation_data`…）不做三方合併。
- 存檔成功 → 畫面換成實際寫入的內容（含併入的 5G-RRU 修改）並當作新快照；兩頁同專案時 TH/ME 頁那份元件清單
  也一起換；狀態列附一句「已合併：併入資料庫最新的 N 項修改…」。
- **`graphDb`／`fileDb` 的 `getDoc` 回複本、`setDoc`／`updateDoc`／`writeBatch` 存複本**：畫面不可再持有 DB 快取
  的活參照（原本 Tab1 還沒存的修改，可能在存 TIM 型號庫之類的其他寫檔動作時被一起寫進資料庫）。
  `writeBatch` **先把整批要寫的內容算完才動快取**：任何一筆丟例外（例如合併有未決定的衝突）→ 整批不寫。
  `getCollection` 仍回快取本身，呼叫端只能讀。
- 契約測試：`tests/merge-save.test.js`、`tests/comp-merge.unit.test.js`、`tests/optimistic-concurrency.test.js`（T12–T16）。

#### 標註圖片清孤兒：專案 id 要「完全相同」（`listTcpImages`）

檔名是 `${projectId}_${catKey}_${ts}.jpg`，專案 id 本身可能含底線 → 從右邊拆出分類與時間戳，剩下的才是專案 id，
必須完全相等。⚠ 原本用 `startsWith(projectId + '_')`：專案 `FDD_4T4R_60W` 每次存檔清孤兒時，會把
`FDD_4T4R_60W_v2`（5G-RRU「複製專案」取名「FDD 4T4R 60W v2」就會產生這種 id）的圖當成孤兒刪掉；刪專案時也一樣。
檔名對不上格式的一律不列（不認得的檔案不刪）。

#### SharePoint 讀寫防護（`graphDb.js`）

- `_graphGet`：`cache:'no-store'`＋no-cache；逾時 30 秒；逾時／斷線／429／5xx 自動重試 2 次，其他 4xx 直接丟出。
  `_graphPut` 逾時 90 秒；`_withOptimisticWrite` 除了 412，逾時／斷線／429／5xx 也重讀（force）後重試。
- **防版本回退時不可換 eTag**：`_readFile` 忽略「比手上舊」的內容時，eTag 也保留舊的。原本照樣換成新 eTag →
  下一次寫入的 If-Match 會對上，把這份過時的快取整檔寫回，蓋掉磁碟上的內容（例：SharePoint「版本歷史」還原、
  或不遞增 version 的另一個工具的寫入）。保留舊 eTag → 下一次寫入得到 412 → 以磁碟為準重讀再合併。
- metadata 多取 `size`：**本 session 第一次讀檔就讀到空內容、但檔案大小不是 0（或拿不到大小）→ 唯讀保護**，
  不可 bootstrap 空骨架（否則下一次寫入就把整份共用 DB 抹掉）；真的是 0 bytes 才建立空骨架。

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
  7 支本地 JS（含兩個 repo 共用的 `compMerge.js`）的 `?v=__APP_VERSION__` 快取戳記、以及 `version.json`）。
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
