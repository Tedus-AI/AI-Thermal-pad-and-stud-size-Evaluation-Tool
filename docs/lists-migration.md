# SharePoint Lists 遷移筆記

> 這份文件記錄 AI-Thermal-pad-and-stud-size-Evaluation-Tool 從 single JSON file
> 遷移到 SharePoint Lists 的所有環境參數、schema 對照、已知 gotchas 跟進度。
>
> **Phase 1 之後寫 code 一律以這份文件為準**，不要回頭重跑 Graph Explorer 抓參數。

---

## 🎉 Phase 0 結案紀錄

**完成日期**：2026-05-25

**Phase 0 全部 9 個 sub-step 完成（0.1–0.9 全綠）**：

- ✅ Feedback List + 17 columns 建立
- ✅ siteId / listId / 所有 internal name 取得並驗證
- ✅ Graph Explorer 跑完整 5-test CRUD（CREATE / READ / LIST+FILTER / PATCH / DELETE + 412 concurrency control）
- ✅ Baseline 一筆 feedback 資料對應 JSON 端
- ✅ 5 個 indexed columns（Status / Type / Tab / Priority / CreatedAt）
- ✅ IT 核准 Sites.ReadWrite.All
- ✅ MSAL 整合驗證（throwaway HTML 跑通 CRUD 5/5）

**累積 gotchas**（Phase 1 寫 code 全部要參考）：
1. OData parameters 一律加 `$` 前綴
2. PATCH endpoint 只接受 `/items/{id}` + fields wrapper
3. dateTime 毫秒會被吃掉（lossy）
4. null dateTime response 整個 key 不見
5. 未 indexed 欄位不能 $filter
6. 412 = `resourceModified` + atomic reject
7. MSAL CDN `alcdn.msauth.net` 在公司網路被擋（要 fallback）
8. JWT 不能用 atob 解（base64url ≠ base64），改用 MSAL `result.scopes`
9. Naming conflicts pattern（Title / Attachments / Created / Modified 用「回饋XXX」前綴避開）

**Phase 1 啟動條件全部滿足**，可以隨時開工寫 `graphListsDb.js`。

---

## 環境資訊

| 項目 | 值 |
|---|---|
| Tenant | `deltao365.sharepoint.com` |
| Site Display Name | Thermal-Spec-DB |
| Site Path | `/sites/Thermal-Spec-DB` |
| Site WebUrl | https://deltao365.sharepoint.com/sites/Thermal-Spec-DB |
| Azure AD App Client ID | `17fc1ab4-0ab0-4520-9315-6faa86d9e8ec` |
| Azure AD Tenant ID | `19f25823-17ff-421f-ad4e-8fed035aedda` |

## 目前 MSAL Scopes 狀態

| Scope | 目前狀態 | 用途 |
|---|---|---|
| `Files.ReadWrite.All` | ✅ Granted | 舊架構 thermal_db.json 讀寫 |
| `Sites.Read.All` | 可能仍存在或已被 IT 移除 | 已被 Sites.ReadWrite.All 取代 |
| `Sites.ReadWrite.All` | ✅ **Granted**（Phase 0.8 實測通過） | List 寫入需要 |

---

## Phase 0 Pilot：Feedback List

### IDs（API 呼叫用）

| 項目 | 值 |
|---|---|
| siteId | `deltao365.sharepoint.com,7c5179cc-7bcc-42f3-928f-aeaaeb860787,f30d898c-bf60-4d5e-a6b3-306e3ea83cce` |
| listId | `f916276f-d0ac-45fd-90f0-c9be2e7938e6` |
| List internal name | `Feedback` |
| List display name | `Feedback` |
| List WebUrl | https://deltao365.sharepoint.com/sites/Thermal-Spec-DB/Lists/Feedback |

### Columns 對照表

⚠️ **Internal Name 不可變、Display Name 可改**。code 永遠用 Internal Name 寫入 API。

| # | Internal Name | Display Name | Type | Required | Notes |
|---|---|---|---|---|---|
| 1 | `Title` | FeedbackId | text | ✅ | **內建欄位 repurpose**。存 `FB-YYYYMMDD-HHmmss-XXXX` 格式 ID。display name 走經典 List Settings 才改得到。 |
| 2 | `Type` | 回饋類型 | choice | ✅ | 選項：`Bug` / `改善建議` / `新功能需求` / `資料欄位問題` / `權限/登入/儲存問題` / `其他` |
| 3 | `Tab` | 發生分頁 | choice | ✅ | 選項：`EE/RF/PWR-專案元件清單` / `TH/ME-專案元件清單` / `模擬與實測驗證` / `凸台&TIM尺寸速算` / `使用者建議與改善` / `SharePoint登入/儲存` / `整體工具` / `其他` |
| 4 | `FbTitle` | 回饋標題 | text | ✅ | code key: `title`。Internal name 避開內建 `Title` 衝突。 |
| 5 | `Priority` | 優先度 | choice | ✅ | 選項：`低` / `中` / `高` / `緊急` |
| 6 | `Reporter` | 提出人 | text | ✅ | code 自動帶入 `acct.name`，使用者可手動修改（spec §6.2）。**不用 Person 型**，因為值可以是「張工程師（RF部）」這類非 AD 帳號字串。 |
| 7 | `Contact` | 聯絡方式 | text | ❌ | code 自動帶入 `acct.email`，使用者可改 |
| 8 | `Description` | 詳細說明 | note (plain) | ✅ | Plain text，**不能是 richText**（dual-write diff 會炸） |
| 9 | `CurrentBehavior` | 目前狀況 | note (plain) | ❌ | |
| 10 | `ExpectedBehavior` | 期望結果 | note (plain) | ❌ | |
| 11 | `FbAttachments` | 回饋附件 | note (plain) | ❌ | **Phase 0 暫存方案**：寫入 `JSON.stringify(attachments)`，每筆是 `[{name, data}, ...]`，data 是 base64 data URL。**Phase 2 之後改用 Document Library** 存圖片、List 只存路徑。Internal name 避開內建 `Attachments` 欄位（display: 附件）衝突。 |
| 12 | `Note` | 備註 | note (plain) | ❌ | |
| 13 | `AdminNote` | 處理備註 | note (plain) | ❌ | 維護者填寫 |
| 14 | `Status` | 狀態 | choice | ✅ | 選項：`待處理` / `評估中` / `已排入` / `修正中` / `已完成` / `不採用`。**Default value: `待處理`**（List enforce + code 也明確寫，雙保險） |
| 15 | `ClosedAt` | 完成日期 | dateTime | ❌ | **空值處理**：JSON code 寫 `''` 空字串，List 為 `null`。dual-write 比對時這個 corner case 要做 normalization。 |
| 16 | `CreatedAt` | 回饋建立時間 | dateTime | ✅ | code 寫 `new Date().toISOString()` 含毫秒。**不用內建 `Created`**，因為內建是 SharePoint server 接收時間，會跟 code 有 ms~sec 級時差，dual-write diff 會誤判。 |
| 17 | `UpdatedAt` | 回饋更新時間 | dateTime | ✅ | 同上，不用內建 `Modified`。 |

### 系統內建欄位（自動存在，不用碰）

| Internal Name | Display Name | 用途 |
|---|---|---|
| `Created` | 建立時間 | SharePoint server 接收 item 的時間（不用） |
| `Modified` | 修改時間 | SharePoint server 最後修改時間（不用） |
| `Author` | 建立者 | item 建立者的 Azure AD user（不用） |
| `Editor` | 修改者 | item 最後修改者（不用） |
| `Attachments` | 附件 | 內建附件功能（hidden，不用，但占用了 internal name `Attachments`） |

---

## 已知 Gotchas（每踩一次就補一條）

### Schema 設計

- **內建 `Title` 欄位 display name 改成 `FeedbackId` 要走經典 List Settings**：新版 UI 的「重新命名」只改 view label，不改 column metadata。從齒輪 → 清單設定 → 點 Title → 改「資料行名稱」才會 propagate。
- **內建 `Attachments` 欄位（hidden）會占住 internal name 跟「附件」display name**：custom 附件欄位用 `FbAttachments` / 回饋附件 避開。
- **Person 欄位不適合「提出人 / 聯絡方式」**：code 存的是 plain string（可能是「TEDUS.CHEN 陳慶峰」也可能是「張工程師（RF部）」），Person 欄位會強制 AD 帳號 lookup，非 AD 字串會被拒。

### Choice 欄位

- **選項大小寫敏感**：`"Bug"` ≠ `"bug"`，dual-write 要逐字一致。
- **「/」字元在 Choice 值內可以用**（例如「權限/登入/儲存問題」），但 API 用 `$filter` 查詢時要 URL-encode 成 `%2F`。
- **未在選項清單內的值會被 400 拒絕**——這是 schema enforcement 的正面驗證。

### Multi-line text 欄位

- **必須選 Plain text**（屬性 `textType: "plain"`），不能是 richText。Rich text 會把字串包成 HTML（多 `<div>` `<p>` tag），dual-write diff 必失敗。
- **每個 cell 上限約 63K 字元**——FbAttachments 塞 base64 圖片很容易超過，Phase 2 一定要改 Document Library。

### Date and Time 欄位

- **必須選「日期及時間」**，不能只選「日期」（會掉時分秒精度）。
- **「易記格式」要關**（顯示 `2026-05-21 10:00:00`，不要顯示「3 天前」）。
- **空值兩邊形狀不同**：JSON `''` vs List `null`，diff 邏輯要 normalize。
- **⚠️ `null` dateTime 欄位 GET response 會完全省略 key**（實測確認）：寫入時帶 `"ClosedAt": null`，GET 回來的 `fields` 物件**沒有 `ClosedAt` 這個 key**（不是 `null` 也不是 `""`，是 key 根本不在）。
  - 影響：Phase 1 讀 List 還原成 JSON 物件時，要用 `item.ClosedAt ?? ''` 處理，不要寫 `item.ClosedAt === null`（永遠 false）。
  - 影響：diff 邏輯比對「JSON 端 `closed_at: ''`」vs「List 端 key 不存在」要都 normalize 為「空」狀態才算一致。
- **不用內建 Created / Modified**：跟 code 寫的 ISO timestamp 會有毫秒級時差。
- **⚠️ 毫秒會被吃掉（lossy）**：實測寫入 `2026-05-08T03:33:28.859Z`，讀回變成 `2026-05-08T03:33:28Z`。
  - 影響：JSON code 寫的是含毫秒 ISO string（`new Date().toISOString()`），List 內部只存到秒。
  - Phase 2 dual-write diff 比對前要做 normalization：把 JSON 那邊也 truncate 到秒再比對，否則永遠 mismatch。
  - Phase 1 讀回 List 還原成 JSON 物件時，毫秒資訊**回不來**，要接受這個 lossy 行為（或從原 JSON 補回，雖然不必要）。
  - 寫入端不用改：JSON 繼續存含毫秒，List 自動截斷無妨。

### $filter / 欄位索引

- **🔴 OData parameters 一律加 `$` 前綴**（實測確認）：`?expand=fields`（無 `$`）會回 400 `badArgument`，必須寫 `?$expand=fields`。同理 `$filter`、`$select`、`$orderby`、`$top`、`$skip`。Microsoft Graph 對 OData spec 是嚴格遵守的。
- **🔴 未 indexed 的欄位不能用 `$filter` 或 `$orderby`**（實測確認）：query Status 會收到 400
  ```
  "Field 'Status' cannot be referenced in filter or orderby as it is not indexed."
  ```
- **臨時繞過**：加 header `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`，small list 不會 fail，但是非正規做法。
- **正規解**：在 SharePoint List Settings 經典頁建立 column index。一個 list 最多 20 個 indexed column。
- **Phase 1 啟動前要先 indexed 的欄位**（依 spec §9.1 篩選需求）：
  - `Status`（狀態篩選）
  - `Type`（類型篩選）
  - `Tab`（分頁篩選）
  - `Priority`（優先度篩選）
  - `CreatedAt`（日期排序）
- **Filter 語法注意**：
  - Choice 欄位要寫 `fields/Status eq '評估中'`（必須加 `fields/` 前綴）
  - 值用單引號 `'...'` 包，不是雙引號
  - 中文值不用 URL-encode，Graph Explorer / fetch 會自動處理
  - 比較運算子用 `eq` / `ne` / `gt` / `lt` 等 OData 寫法，不是 `==` `!=`

### MSAL CDN 載入

- **🔴 `alcdn.msauth.net`（微軟官方 MSAL CDN）在公司網路被擋**（Phase 0.8 throwaway 測試時實測）：第一順位 CDN 失敗，自動 fallback 到 `cdn.jsdelivr.net` 成功。
- **Phase 1 寫 graphListsDb.js 時的影響**：正式工具 `index.html` 用的 MSAL 來源是 `<script src="https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js"></script>` 這條，**目前工具能正常運作代表 alcdn 在使用者端某些情境是通的**，但若未來遇到登入失敗回報，CDN fallback 是要優先考慮的 root cause。
- **建議**：考慮在 `index.html` 也加入多 CDN fallback 機制（推薦順序：`alcdn.msauth.net` → `cdn.jsdelivr.net` → `unpkg.com`），增加韌性。

### ETag / 並行控制

- **兩種 ETag 格式**：
  - HTTP response header `ETag`：不含引號，例如 `f916276f-...,1`
  - JSON body `@odata.etag`：含引號 + 反斜線跳脫，例如 `"\"f916276f-...,1\""`
- **PATCH 要帶 `If-Match: <etag>` header**，optimistic concurrency 才會生效。
- **錯的 etag 會收到 412 Precondition Failed**（實測確認）：
  ```json
  {
    "error": {
      "code": "resourceModified",
      "message": "The resource has changed since the caller last read it; usually an eTag mismatch"
    }
  }
  ```
  Phase 1 catch error 判斷條件：`e.code === 'resourceModified'` 或 `e.status === 412`。
- **412 後 item 是真的沒被改的**（實測確認）：拿著舊 etag 試圖寫入 `WILL_NOT_BE_SAVED`，409/412 後 GET 確認 FbTitle 仍是原值 `TEST`，**SharePoint 是 atomic reject，不會偷偷改**。
- **If-Match 可選**：不帶等於跳過 concurrency 檢查（fire-and-forget 模式）。Phase 1 寫 code 一律帶。

### JWT decoding（取 scope 用）

- **🔴 不要用 `atob()` 直接解 JWT payload**（Phase 0.8 實測踩過）：JWT 用 base64url 編碼（含 `-` `_`，無 `=` padding），標準 `atob()` 遇到會丟 `Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded`。
- **正確做法**：直接用 MSAL `result.scopes` 拿 array of strings，不需要解 JWT。code 範例：
  ```js
  const grantedScopes = result.scopes || [];
  const hasSitesRW = grantedScopes.some(s => 
    s === 'Sites.ReadWrite.All' || s.endsWith('/Sites.ReadWrite.All')
  );
  ```
- **Scope 字串兩種格式都要處理**：`Sites.ReadWrite.All` 或 `https://graph.microsoft.com/Sites.ReadWrite.All`，用 `endsWith()` 兩種都接受。

### PATCH endpoint pattern（🔴 重要 implementation note）

Microsoft Graph 文件對 List item update 列了兩種端點寫法：

| 端點 | Body 格式 | 此 tenant 實測 |
|---|---|---|
| `PATCH /items/{id}/fields` | 扁平 `{ "FieldA": "v1", "FieldB": "v2" }` | ❌ **400 Invalid request** |
| `PATCH /items/{id}` | wrapper `{ "fields": { "FieldA": "v1" } }` | ✅ 成功 |

**Phase 1 寫 graphListsDb.js 一律用 `PATCH /items/{id}` 配 fields wrapper**，不要照官方文件主推的 /fields endpoint。

可能原因：Microsoft Graph 對 SharePoint Lists 的 `/fields` PATCH 端點在某些 tenant 或版本下行為不穩；items endpoint 是 PnP 庫長期使用的方式，相容性最好。

### 模糊錯誤訊息的標準除錯流程

Graph API 對 List 操作的錯誤訊息常常是模糊的 `"Invalid request"`，沒有具體欄位指引。除錯方法：

1. **從最小 payload 開始**：先 PATCH 一個純英文 text 欄位，例如 `{ "fields": { "FbTitle": "TEST" } }`
2. **確認最小 payload 成功**後，逐一加回其他欄位
3. **逐一加回時測試**：Choice、dateTime、null 值各自獨立試
4. **錯誤訊息固定的情況下**，問題通常在：(a) URL 端點寫法 (b) body 是否包 fields wrapper (c) header 缺 Content-Type

### Naming conflicts 統整

新版 UI 的「重新命名」遇到 display name 已存在會擋。歸納實際撞名：

| 想用的中文 display | 撞到的內建欄位 | 解法 |
|---|---|---|
| 標題 | 內建 Title (display: 標題) | FbTitle 改叫 `回饋標題` |
| 附件 | 內建 Attachments (display: 附件) | FbAttachments 改叫 `回饋附件` |
| 建立時間 | 內建 Created (display: 建立時間) | CreatedAt 改叫 `回饋建立時間` |
| 修改時間 | 內建 Modified (display: 修改時間) | UpdatedAt 改叫 `回饋更新時間` |

**Pattern：自建欄位的 display name 加「回饋」前綴避開**。

---

## Useful Graph API URLs（複製貼上即用）

### Site / List 基本

```
# 取得 site
GET https://graph.microsoft.com/v1.0/sites/deltao365.sharepoint.com:/sites/Thermal-Spec-DB

# 列出所有 list
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists

# 列出 Feedback list 所有欄位（schema 驗證用）
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/columns
```

### Feedback Items CRUD

```
# 列出所有 item（含完整欄位）
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items?$expand=fields

# 取得單一 item
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items/{itemId}?$expand=fields

# 依 Status filter（需要加 Prefer header 如果 Status 未 indexed）
GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items?$expand=fields&$filter=fields/Status eq '待處理'
Headers (如果沒建索引):
  Prefer: HonorNonIndexedQueriesWarningMayFailRandomly

# 新增 item
POST https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items
Body: { "fields": { ... } }

# Partial update（只改指定欄位，其他欄位不動）
# ⚠️ 兩種端點寫法，這個 tenant 只接受下列 (a)，不接受 (b)：
#   (a) PATCH /items/{id}     + body { "fields": { ... } }    ✅ 實測通過
#   (b) PATCH /items/{id}/fields + body { ... } (扁平)         ❌ 實測 400 Invalid request
PATCH https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items/{itemId}
Headers: 
  Content-Type: application/json
  If-Match: <etag>     ← 可選；不帶等於跳過 optimistic concurrency
Body: { "fields": { "Status": "已完成", "ClosedAt": "..." } }

# 刪除 item
DELETE https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items/{itemId}
Headers: If-Match: <etag>
```

⚠️ **OData query parameters 一律帶 `$` 前綴**：`$expand` / `$filter` / `$select` / `$orderby` / `$top` / `$skip`。實測 `?expand=fields`（無 `$`）會回 400 badArgument，必須寫 `?$expand=fields`。

把 `{siteId}` 替換為：
```
deltao365.sharepoint.com,7c5179cc-7bcc-42f3-928f-aeaaeb860787,f30d898c-bf60-4d5e-a6b3-306e3ea83cce
```

把 `{listId}` 替換為：
```
f916276f-d0ac-45fd-90f0-c9be2e7938e6
```

---

## Phase 進度追蹤

### Phase 0：環境探勘 + Pilot List 建立（✅ 全部完成）

- [x] 0.1　在 SharePoint 建 Feedback List
- [x] 0.2　設計並建立 17 個 column（schema 對應現有 `feedback_items`）
- [x] 0.3　拿 siteId / listId、驗證所有 internal name
- [x] 0.4　Graph Explorer 跑完整 CRUD（CREATE / READ / LIST+FILTER / PATCH partial / DELETE）
- [x] 0.5　把現有 `feedback_items` 既有 1 筆資料匯入 List 當 baseline（已清掉所有測試殘留 + POST 一筆乾淨 FB-20260508-113328-DYUP）
- [x] 0.6　文件累積完成（本文件，6 大 gotcha 全部記錄）
- [x] 0.7　寄 IT 申請 Sites.ReadWrite.All（已寄出，等待回覆）
- [x] 0.8　**已完成**：MSAL 整合驗證通過（throwaway HTML 頁實測 5 步驟全綠：MSAL 載入 → 登入 → Token + scope 驗證 → CREATE 成功）
- [x] 0.9　5 個 column index 建好（Status / Type / Tab / Priority / CreatedAt），實測 Status filter 無需 Prefer header 即可運作

### Phase 1+（後續規劃，暫未動工）

- [ ] **Phase 1**：寫 `graphListsDb.js` 的 feedback CRUD methods（mirror 現有 graphDb collection API）
- [ ] **Phase 2**：啟動 dual-write（採用「設計 C：透明寫入 + 顯式驗證讀取」，詳見下方「Phase 2 設計」章節）
  - [ ] 2.1 加 feature flag `DUAL_WRITE_FEEDBACK` / `SHOW_DEV_PANEL` / `PRIMARY_FEEDBACK`
  - [ ] 2.2 `fbSubmitFeedback()` 加上 shadow write 邏輯
  - [ ] 2.3 加開發者驗證區 UI（摺疊式 details）
  - [ ] 2.4 實作 `fbCompareWithList()` 並排 diff 視覺化
  - [ ] 2.5 實作 `fbShowDualWriteLog()` 顯示最近寫入結果
  - [ ] 2.6 實作 `fbForceListPush()` 一次性同步既有 JSON 資料到 List
  - [ ] 2.7 dual-write 跑 7 天觀察期 + 進入 Phase 3 條件驗證
- [ ] **Phase 3**：Shadow-read 自動 diff（讀仍走 JSON，但同時讀 List 做 diff verification）
- [ ] **Phase 4**：Cutover（`PRIMARY_FEEDBACK: 'list'`，仍 dual-write 保險）
- [ ] **Phase 5**：Decommission JSON 的 feedback_items 區塊（`DUAL_WRITE_FEEDBACK: false`）
- [ ] **Phase 2+ 額外**：FbAttachments 改用 Document Library 存圖片，List 只存路徑
- [ ] **Phase 5+ 額外**：移除 JSON 端鎖相關 code（見下方「並行控制機制演進」）

---

## 並行控制機制演進（locking strategy）

⚠️ **這是 Phase 1 設計的重要前提**：List 不會「自動消除多人共編問題」，鎖的需求不會消失，只是粒度從整檔變到 item。

### 不同階段的鎖機制對照

| Phase | JSON 端鎖 | List 端鎖 | 說明 |
|---|---|---|---|
| 現況 / Phase 0 | ✅ 悲觀鎖（`lockedByEmail` + `expiresAt`）+ 整檔樂觀鎖（`version`） | n/a | List 還沒寫 code |
| Phase 1 | ✅ 不動 | ✅ etag 帶上但沒人 call | graphListsDb.js 寫好但未接上 |
| Phase 2 | ✅ 不動（JSON 仍 source of truth） | ✅ 帶 If-Match，shadow write 失敗不擋 | dual-write 啟動 |
| Phase 3 | ✅ 不動 | ✅ 同上 | shadow-read + diff |
| Phase 4 | ✅ 不動（仍 dual-write 保險） | ✅ Cutover 後 List 成為 primary | 讀走 List |
| Phase 5 | ⚠️ 已無人寫入但鎖 code 保留 | ✅ 唯一並行控制 | 停寫 JSON |
| Phase 6（可選） | ❌ 移除 lockedByEmail / expiresAt / acquireLock / releaseLock | ✅ | 確認穩定後再清 |

### 為什麼 List 不能消除鎖

| 情境 | JSON 整檔覆蓋 | List partial PATCH |
|---|---|---|
| A 改 project X tab2、B 改 project Y component | ❌ 後寫的覆蓋前者 | ✅ 不同 item，PATCH 不會碰彼此 |
| A 改 item X 的 Status、B 同時改 item X 的 AdminNote（不同欄位） | ❌ 後寫的覆蓋前者整個項目 | ✅ partial update 互不干擾 |
| A 跟 B **同時改 item X 的同一欄位**（例如 Status） | ❌ 後寫的覆蓋 | ⚠️ 後寫的覆蓋（除非帶 If-Match） |
| A 基於舊資料計算後寫回（例如「總功耗 += 5」） | ❌ 計算基礎被覆蓋 | ⚠️ 計算基礎被覆蓋（除非帶 If-Match） |

**結論：跨 item 的衝突 List 結構上消除；同一 item 的衝突仍需 etag 樂觀鎖**。

### Phase 5 之後的最終並行控制 pattern

```js
// 標準 update 流程（graphListsDb.js 內部）
async updateFeedback(itemId, fieldsToUpdate) {
  // 1. 讀最新 item 拿 etag
  const item = await this._fetchItem(itemId);
  const etag = item['@odata.etag'];   // 例如 "\"f937...,3\""
  
  // 2. PATCH 帶 If-Match
  try {
    return await this._patchItem(itemId, fieldsToUpdate, etag);
  } catch (e) {
    if (e.code === 'resourceModified' || e.status === 412) {
      throw new ConflictError('資料已被他人更新，請重新整理後再試');
    }
    throw e;
  }
}
```

UI 層 catch `ConflictError` 後的處理：
- 提示「資料已被他人更新」
- 強制 refresh
- 由 user 決定要不要重新編輯

### Phase 5+ 可以移除的 code（估計）

依現有 graphDb.js（第 217–280 行附近）：

- `acquireLock()` / `releaseLock()` / `LockError`
- `lock` 物件 / `lockedByEmail` / `expiresAt` / `lockTimeoutMinutes`
- 鎖過期 timeout 處理
- Teams deep-link「聯絡目前編輯者」UI

**但這些 code 可以「保留但不 call」當死碼**，不是非刪不可。「保留死碼 vs 刪除」的決策完全看 Phase 5 之後的信心度，**這個決定不在 Phase 1 範圍**。

### Dual-write 期間的回退保險

**Phase 5 之前的任何時間點**，回到 JSON-only 都只需要：

```js
// config.js
window.FEATURE_FLAGS = {
  DUAL_WRITE_FEEDBACK: false,    // ← 切回 false
  SHADOW_READ_FEEDBACK: false,
  PRIMARY_FEEDBACK: 'json'       // ← 切回 'json'
};
```

切一個 boolean，系統瞬間回到「JSON-only + 悲觀鎖」原狀。List 那邊資料留著當紀念，**不會破壞任何東西**。這是 dual-write 設計的核心安全網。

---

## Phase 2 設計：Dual-write UI 策略（設計 C）

採用 **「透明寫入 + 顯式驗證讀取」** 設計。

### 核心原則

| 行為 | 一般使用者體感 | 維護者（Tedus）操作 |
|---|---|---|
| **寫入** | 跟現在一樣按「儲存回饋」即可，UI 沒變化 | 同上，但背後同時寫 JSON + List |
| **讀取（一般）** | 跟現在一樣自動載入從 JSON 讀 | 同上 |
| **讀取（驗證）** | 看不到這個入口（摺疊在開發者驗證區） | 點「從 List 載入」並排比對 JSON vs List 內容 |

**設計理念**：使用者完全無感（不會被新按鈕困惑），但維護者隨時可以親手驗證兩邊資料一致性，比 console.log 可靠很多。

### 寫入端：透明 dual-write

現有「儲存回饋」按鈕 (`fb-submit-btn`) 行為不變，內部 `fbSubmitFeedback()` 加上 dual-write 邏輯：

```js
async function fbSubmitFeedback() {
  const item = { /* 既有的 18 欄位構造邏輯 */ };
  
  // ── Primary write：JSON（必須成功，失敗就 throw）──
  await dbAdapter.setDoc('feedback_items', item.id, item);
  
  // ── Shadow write：List（失敗只 log，不影響主流程）──
  if (window.FEATURE_FLAGS?.DUAL_WRITE_FEEDBACK) {
    try {
      await listsDb.feedback.add(item);
      _dualWriteLog.push({ ts: Date.now(), id: item.id, ok: true });
    } catch (e) {
      console.warn('[dual-write] List write failed:', e);
      _dualWriteLog.push({ ts: Date.now(), id: item.id, ok: false, error: e.message });
    }
  }
  
  // 後續 UI 更新邏輯不變
}
```

關鍵設計原則：

1. **JSON 寫入失敗** → 立刻 throw，使用者看到錯誤訊息（跟現在一樣）
2. **List 寫入失敗** → 只記到 `_dualWriteLog` 跟 console，**不影響使用者操作**
3. **`_dualWriteLog` 累積最近 20 次寫入結果**，開發者驗證區可以查看
4. **使用者完全感覺不到 List 在做什麼**

### 讀取端：默認 JSON + 顯式 List 載入按鈕

#### 一般使用者看到的（不變）

Tab5 feedback 列表自動載入時 → 走現有 `fbLoadItems()` → 讀 JSON → 顯示。

#### 開發者驗證區（新增）

在 Tab5 的工具列**最下方**加一個摺疊式區塊：

```html
<details class="fb-dev-panel" id="fb-dev-panel" style="display:none">
  <summary>🔧 開發者驗證（dual-write 測試）</summary>
  <div class="fb-dev-content">
    <button onclick="fbCompareWithList()">📋 從 List 載入這筆並比對</button>
    <button onclick="fbShowDualWriteLog()">📝 dual-write log（最近 20 筆）</button>
    <button onclick="fbForceListPush()">⬆️ 強制 push 所有 JSON 到 List</button>
    <div id="fb-dev-output"></div>
  </div>
</details>
```

**預設 hidden**，透過 feature flag `SHOW_DEV_PANEL` 啟用：

```js
// 在 fbSwitchTab() 切到 Tab5 時
if (window.FEATURE_FLAGS?.SHOW_DEV_PANEL) {
  document.getElementById('fb-dev-panel').style.display = '';
}
```

#### 按鈕 1：「從 List 載入這筆並比對」 — 核心驗證功能

當使用者在 feedback 詳情頁時觸發：

```js
async function fbCompareWithList() {
  const currentId = _currentFbItemId;  // 當下開啟的 feedback id (FB-...)
  
  // 從 JSON 拿
  const fromJson = await dbAdapter.getDoc('feedback_items', currentId);
  
  // 從 List 拿（用 Title 欄位 search 對應的 item）
  const fromList = await listsDb.feedback.findByFeedbackId(currentId);
  
  // 並排顯示 + diff 標示
  renderDiffView(fromJson, fromList);
}
```

#### Diff 視覺化規格

並排顯示時，對每個欄位三種狀態：

| 狀態 | 顯示 | 範例 |
|---|---|---|
| ✅ 完全一致 | 綠色背景，無 badge | `Status: 評估中` / `Status: 評估中` |
| ⚠️ 已知 lossy（不警告） | 黃色背景 + ⓘ icon | `CreatedAt: ...859Z` / `CreatedAt: ...000Z`（毫秒被吃） |
| ❌ 不該不一致（警告） | 紅色背景 + ⚠️ icon | `FbTitle: TEST` / `FbTitle: TES` |

**已知 lossy 案例**（不算 bug，UI 顯示為 ⚠️ 但不視為錯誤）：
- `CreatedAt` / `UpdatedAt` / `ClosedAt`：毫秒會被截掉（List dateTime lossy）
- `ClosedAt` 為 null 時：JSON `''` vs List 整個 key 不存在（兩邊都算「空」）

**真正的 diff**（紅色 ⚠️，需要查 bug）：
- 任何 Choice 欄位的值不一致（例如 Status / Type / Priority / Tab）
- 任何 text 欄位的內容不一致（FbTitle / Reporter / Description / ...）
- 預期該存在的欄位在某一邊缺失

#### 按鈕 2：「dual-write log」

顯示 `_dualWriteLog` 內容：
```
[2026-05-22T10:15:23Z] FB-20260522-101523-XXXX ✅ ok
[2026-05-22T10:32:01Z] FB-20260522-103201-YYYY ✅ ok
[2026-05-22T10:45:12Z] FB-20260522-104512-ZZZZ ❌ fail: throttled (429)
```

**最近 20 筆**就夠了，超過自動 drop oldest。

#### 按鈕 3：「強制 push 所有 JSON 到 List」（一次性同步工具）

Phase 2 啟動初期可能會發現「啟用 dual-write 之前累積的 feedback，只在 JSON 裡，List 沒有」——這個按鈕可以一次性補齊：

```js
async function fbForceListPush() {
  if (!confirm('確定要把所有 JSON feedback 推到 List？已存在的會被 upsert。')) return;
  
  const allFb = await dbAdapter.getCollection('feedback_items');
  let ok = 0, fail = 0;
  for (const id of Object.keys(allFb)) {
    try {
      await listsDb.feedback.upsert(allFb[id]);  // 已存在則 PATCH，不存在則 POST
      ok++;
    } catch (e) {
      console.warn('push fail', id, e);
      fail++;
    }
  }
  alert(`Push 完成：成功 ${ok} / 失敗 ${fail}`);
}
```

**注意**：這個按鈕是一次性工具，跑完一次後通常用不到。但保留著以備不時之需（例如 dual-write 中途有人改了 flag 又改回來，造成兩邊不同步）。

### Feature flag 控制

`config.js` 新增：

```js
window.FEATURE_FLAGS = {
  // Phase 2 啟動時開
  DUAL_WRITE_FEEDBACK: false,   // 寫 JSON 時也寫 List（shadow）
  
  // 維護者開（Tedus 自己用，正式使用者預設 false）
  SHOW_DEV_PANEL: false,        // 顯示開發者驗證區
  
  // Phase 4 啟動時切
  PRIMARY_FEEDBACK: 'json',     // 'json' or 'list'，控制讀取來源
};
```

**啟動 / 回退 都只是改 flag**：

| 行為 | DUAL_WRITE | SHOW_PANEL | PRIMARY |
|---|---|---|---|
| Phase 1 結束（List code 寫好但沒接） | false | false | json |
| Phase 2 啟動 | **true** | **true**（給 Tedus 自己用） | json |
| Phase 2 中遇到問題回退 | **false** | true | json |
| Phase 3（shadow-read） | true | true | json |
| Phase 4（cutover） | true | true | **list** |
| Phase 5（停寫 JSON） | **false** | true | list |

### 進入 Phase 3 的條件

Phase 2 dual-write 跑一段時間後，當以下都符合才進 Phase 3：

- [ ] 連續 7 天 dual-write 沒有 fail（`_dualWriteLog` 全綠）
- [ ] 對任意 feedback 點「從 List 載入並比對」→ 沒有紅色 ⚠️ 不該存在的 diff
- [ ] 已知 lossy 案例（毫秒、null dateTime）的處理邏輯 code 寫好（用於 Phase 3 自動 diff）
- [ ] `fbForceListPush()` 跑過一次，確認所有歷史 feedback 都在 List 上

### 為什麼這套設計能讓使用者無感卻又讓你有掌握感

| 角度 | 設計 | 效果 |
|---|---|---|
| 使用者體驗 | 寫入是現有按鈕 + 透明 dual-write | 完全不會被新按鈕困惑 |
| 維護者驗證 | 「從 List 載入」按鈕讓你親手比對 | 任何時候都能用眼睛驗證 |
| 自動化驗證 | dual-write log 累積、Phase 3 shadow-read | 不用全靠人眼 |
| 緊急回退 | 兩個 flag 切回 false | 1 秒回到 JSON-only 原狀 |
| 資料一致性 | 寫入永遠同步雙寫 | Phase 4 cutover 時 List 已是完整 source of truth |

---

## 維護指引

### 新增欄位的標準流程

1. **建立**：用純英文 internal name（避開 `_x...` encoded 地雷）
2. **驗證 internal name**：用 Graph Explorer `/columns` 查 `name` 屬性
3. **改 display name**：新版 UI 編輯 → 名稱改中文。如果撞名走經典 List Settings。
4. **更新本文件的 columns 對照表**
5. **更新 graphListsDb.js（Phase 1 之後）**

### Schema 變更原則

- **加欄位**：低風險，可直接做
- **改欄位型別**：高風險，等同 schema migration，需 dual-write 期間做
- **刪欄位**：必須先確認 code 跟 dual-write 都沒在用
- **改 Choice 選項**：低風險但要同步 code 跟 SharePoint UI 兩邊

### 與 5G-RRU 工具的協作

⚠️ Feedback 目前**只有 AI-Thermal 寫**（CLAUDE.md 第 28 行明示）。5G-RRU 不寫 feedback_items，所以 Phase 0–5 的所有 List 操作只動 AI-Thermal repo，**不影響 5G-RRU 工具**。

未來如果 5G-RRU 也要寫 feedback（例如統一 feedback 入口），規劃時要先：
1. 雙方 CLAUDE.md 同步註明
2. 確認 dual-write merge 邏輯不會撞車
3. 兩邊 repo 同步遷移到 Lists 模式
