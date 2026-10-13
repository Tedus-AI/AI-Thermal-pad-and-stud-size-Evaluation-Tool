# Prompt：讓 5G-RRU 的 Thermal Via 元件改用 AI-Thermal「Thermal Via 計算」算出的逐顆等效 K 值

> **狀態：已實作（2026-10）**。動手前使用者的三個決定：
> 1. **R_int 照 AI-Thermal 的 R_th**：`R_int = 5G-RRU 板厚 ÷ (K_eff × A_pad)`，不加擴散面積、不除 `Via_Eff`
>    （via 只在焊盤底下；K_eff 已含銅壁／塞孔／FR4）。`Via_Eff` 與擴散面積只留給通用值 `K_Via`。
> 2. **試算值照用**（`via.qty`／`via.diaMil`）：與 AI-Thermal 畫面上的 K_eff 一致。
> 3. **配置有問題照用 K_eff＋標 ⚠**（孔壁超出／重疊、沒填中心間距）；via 面積超過焊盤則退回通用值。
>
> 實作細節見兩個 repo 的 CLAUDE.md（AI-Thermal「Thermal Via 計算頁」→「5G-RRU 逐顆 K_eff」、5G-RRU「Thermal Via 逐顆 K_eff」）。
> 下面是原始 prompt（保留作為決策紀錄）。

> 用法：開一個同時掛載「AI-Thermal」與「5G-RRU」兩個 repo 的新 session，把本檔
> 「==== PROMPT 開始 ====」到「==== PROMPT 結束 ====」之間的內容整段貼給它。

---

==== PROMPT 開始 ====

# 任務：5G-RRU 的 Thermal Via 元件改用逐顆等效 K 值（抓不到才用通用值）

## 背景
這個 session 同時有兩個 repo，它們**共用同一份 thermal_db.json**：
- **AI-Thermal**（AI-Thermal-pad-and-stud-size-Evaluation-Tool）：有「Thermal Via 計算」頁，逐顆元件算出 via 區的等效 K（K_eff）。
- **5G-RRU**（5G-RRU-Quick-Volume-Evaluation-Tool）：目前所有導熱方式＝Thermal Via 的元件，共用專案參數 `global_params.K_Via`（通常 30 W/m·K），
  另有 `Via_Eff`（例 0.9）。

兩個 repo 根目錄都有 CLAUDE.md，**務必先讀**（共用 DB 寫入規則、`compMerge.js` 兩邊逐字相同的規則、版本戳記自動化）。
AI-Thermal 的 CLAUDE.md「Thermal Via 計算頁」一節是這次的規格來源。

**目標**：5G-RRU 計算 `Board_Type === 'Thermal Via'` 的元件時，若這顆在 AI-Thermal 的 Thermal Via 計算頁有完整的 via 設計，
就用它的 K_eff；抓不到（沒有設計、資料不完整、勾了「暫不納入熱流評估」…）就照舊用通用值 `K_Via`。

## 資料在哪裡（都在同一個專案 document `projects[id]` 裡）
| 輸入 | 位置 | 說明 |
|---|---|---|
| E-PAD L×W | `thermal_specs[key].epadSize`（字串 "L×W"，也吃 x/X/*） | key = `sgSpecKey(元件名)`＝空白→`_`、`/`→`-` |
| 圓形焊盤 | `thermal_specs[key].via.shape === 'circle'`、`via.padD` | |
| Via 數量 | `via.qty`（本頁試算值）→ 沒有 key 才用元件的 `TV_Qty` | `'N/A'`／空白／0＝沒填；須為正整數 |
| Via 內徑 | `via.diaMil`（mil）→ 沒有 key 才用元件的 `TV_ID_mil`（mil） | 內徑＝成品孔徑 |
| 鍍銅厚度 | `via.plating`（mm）→ 沒有 key＝預設 0.0254 mm（1 mil） | 孔壁電鍍銅，不是表層銅箔 |
| 塞孔材料 | `via.fill`（`air`/`epoxy`/`solder`/`copper`/`custom`）＋`via.fillK` | **必填、沒有預設** |
| 暫不納入 | `via.skip === true` | 使用者刻意不評估 → 用通用值 |

計算核心是 AI-Thermal 的 **`viaCalc.js`**（純函式、無 DOM）。K_eff 只跟焊盤面積、數量、內徑、鍍銅厚度、塞孔 K 有關，
**與 PCB 厚度、中心間距無關**（`K_eff = (N·A_cu·K_Cu + N·A_fill·K_fill + A_FR4·K_FR4) ÷ A_pad`）。
驗算用例：8.6×8.6 mm、134 顆 8 mil、鍍銅 1 mil、導熱膠（K=2）→ **K_eff = 13.114 W/m·K**。

## 架構決定（建議做法：共用「算法」，不共用「結果」）
**不要**讓 AI-Thermal 在存檔時把 K_eff 寫成元件欄位（例如 `comp.Via_K`）給 5G-RRU 讀：
- 快選複製元件時會把它帶到別的專案，但那個專案沒有對應的 via 設計 → 過期的值被 5G-RRU 拿去算；
- AI-Thermal 的推導只在「兩頁同專案都載入」時才跑（見 `sgDeriveAllFromSpecs`），容易沒更新；
- 新的每元件欄位還得加進兩邊的 carry 白名單。

**改成**：兩邊用同一份算法，各自從資料庫的原始輸入當場算 —— 跟 `compMerge.js` 一樣的模式：
1. **AI-Thermal**：把 `index.html` 裡 `viaResolve()` 的「輸入解析」搬進 `viaCalc.js`，變成純函式，例如
   `ViaCalc.keffForComp(comp, thermalSpecs, globalParams)` → `{ ok, keff, reason, missing, src }`
   （reason：`'nodata'`／`'missing'`／`'skip'`／`'over'`）。
   - 同時把 `sgSpecKey`、`sgParseLW` 的同等邏輯放進 viaCalc.js（不可依賴 index.html 的全域函式）。
   - 查 spec：先用 `sgSpecKey(comp.Component)`，找不到且元件有 `_renamed_from`（5G-RRU 改名、AI-Thermal 還沒搬資料）
     → 再用 `sgSpecKey(comp._renamed_from)`。
   - E-PAD 的 fallback 規則照搬：`epadSize` 空白、且元件 `Board_Type === 'Thermal Via'` 或 `_pad_from === 'epadSize'`
     → 用元件的 `Pad_L`/`Pad_W`。
   - AI-Thermal 的頁面改呼叫這個函式（**行為不可變**；`tests/via-calc.unit.test.js`、`tests/via-tab.test.js` 必須全過），
     並在 `tests/via-calc.unit.test.js` 補 `keffForComp` 的案例。
2. **viaCalc.js 與 tests/via-calc.unit.test.js 兩個 repo 逐字相同**（同 `compMerge.js` 規則）：複製到 5G-RRU，
   `<script src="viaCalc.js?v=__APP_VERSION__">`（**不要手改版本號**）。兩邊 CLAUDE.md 都寫上這條。
3. **5G-RRU**：先 `grep -n "K_Via\|Via_Eff"` 找出它算 Thermal Via 元件基板熱阻（R_int）的地方，弄清楚
   `K_Via`、`Via_Eff`、面積 `pa`、厚度 `Thick` 怎麼用。在用到 `K_Via` 的地方改成：
   `const r = ViaCalc.keffForComp(row, project.thermal_specs || {}, g);` → `r.ok ? r.keff : K_Via`。
   - **只讀** `thermal_specs`，5G-RRU 永遠不寫它（updateDoc 原樣保留）。
   - 不是 Thermal Via 的元件，計算結果必須完全不變。

## 動手前先問使用者（列出選項與你的建議，等回覆再做）
1. **`Via_Eff` 要不要乘在逐顆 K_eff 上？** 先讀 5G-RRU 程式說明它目前代表什麼（有效面積比？品質折減？），
   再說明兩種做法的差異與建議。
2. **試算值**：AI-Thermal 頁面上 ✂ 改的「本頁試算值」（`via.qty`／`via.diaMil`）要不要給 5G-RRU 用？
   建議：用（與 AI-Thermal 畫面看到的 K_eff 一致，單一事實來源）；頁面上本來就會標「與 EE 清單不同」。
3. **有干涉的設計**（孔壁超出焊盤、重疊；不影響 K_eff 公式）要不要照用？建議：照用 K_eff，但在 5G-RRU 標 ⚠。

## 5G-RRU 畫面（使用者要看得出「這顆用的是哪個 K」）
- Thermal Via 元件在元件清單上標出 K 來源，沿用 5G-RRU 既有「AI-Thermal 推導值」的樣式（左側藍邊＋tooltip）：
  - 用逐顆：`K_eff 13.1 W/m·K（AI-Thermal Thermal Via 計算）`
  - 用通用值：`通用值 K_Via 30 W/m·K` ＋原因（沒有 via 設計／缺：塞孔材料…／暫不納入熱流評估／via 面積超過焊盤）
- 參數控制台的 `K_Via` 標成「通用值（抓不到逐顆 K_eff 時使用）」。
- 不要讓使用者在 5G-RRU 改 K_eff（編輯入口只在 AI-Thermal，同 R_jc／TIM 型號庫的作法）。

## AI-Thermal 畫面同步
Thermal Via 計算頁現在有一則「5G-RRU 目前所有 Thermal Via 元件共用專案參數 K_Via…」的比較說明 → 改成說實話：
`keffForComp` ok 時寫「5G-RRU 會用這個 K_eff 計算（取代通用值 K_Via = 30）」；不 ok 時寫「5G-RRU 會用通用值 K_Via = 30（原因…）」。
文案必須與 5G-RRU 實際行為一致（AI-Thermal CLAUDE.md UX 慣例 11）。

## 文件與測試
- 兩邊 CLAUDE.md：共用 DB schema 概觀補上「5G-RRU 唯讀 `thermal_specs[*].via`、`epadSize`」；`viaCalc.js` 兩邊逐字相同；
  K 值的選用規則與 fallback 原因。（CLAUDE.md 規則 4：跨工具 schema 變更兩邊都要改。）
- 共用單元測試補：ok、缺塞孔材料 → fallback、skip → fallback、`_renamed_from` 查得到、via 面積 > 焊盤 → fallback、
  E-PAD 用 `Pad_L`/`Pad_W` fallback、`N/A` 當沒填。
- 5G-RRU 測試：Thermal Via 元件有完整設計 → 用 K_eff；沒有 → 用 K_Via；非 Thermal Via 元件結果完全不變。
- 用 AI-Thermal repo 的 `thermal_db_backup_2026-09-21.json` 比較改前改後：只有「有完整 via 設計」的元件結果會變，列出差異給使用者看。

## 驗收清單
- [ ] `viaCalc.js`、`tests/via-calc.unit.test.js` 兩個 repo 逐字相同（`diff` 無輸出），兩邊單元測試全過。
- [ ] AI-Thermal 既有測試全過（特別是 `tests/via-tab.test.js`），Thermal Via 頁行為不變、比較說明改成實際行為。
- [ ] 5G-RRU：Thermal Via 元件抓得到 → 用 K_eff；抓不到 → 用 K_Via，且畫面看得出用的是哪個、為什麼。
- [ ] 5G-RRU 存檔後用 AI-Thermal 開同一份 DB：`thermal_specs`（含 `via`）完全沒被動到。
- [ ] 兩邊 CLAUDE.md 已更新；沒有手改 `__APP_VERSION__`。

==== PROMPT 結束 ====
