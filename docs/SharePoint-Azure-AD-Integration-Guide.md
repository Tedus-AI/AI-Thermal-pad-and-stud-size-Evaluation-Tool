# SharePoint + Azure AD 認證整合標準流程

本文件記錄將前端工具（GitHub Pages 靜態網頁）整合 SharePoint 作為資料庫、透過 Azure AD 認證公司帳號的完整流程，包含實作過程中遇到的問題與結論。

---

## 一、架構總覽

```
使用者瀏覽器 (GitHub Pages)
    │
    ├─ MSAL.js ──► Azure AD (OAuth2 登入 popup)
    │                  │
    │                  ▼
    │              Access Token
    │                  │
    └─ Graph API ◄────┘
         │
         ▼
    SharePoint Online
    (thermal_db.json)
```

**三層架構**：
| 層級 | 檔案 | 職責 |
|------|------|------|
| 設定層 | `config.js` | Azure AD + SharePoint 參數 |
| 認證/API 層 | `graphDb.js` | MSAL 認證 + Graph API 讀寫 + Lock 管理 |
| 路由層 | `dbAdapter.js` | 抽象後端（SharePoint vs 本機），統一介面 |
| UI 層 | `index.html` | 登入/登出按鈕、Lock Warning Modal、密碼保護 |

---

## 二、Azure AD App Registration 設定

### 2.1 建立應用程式

1. 進入 [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**
2. 填寫：
   - **Name**：工具名稱（如 `Thermal Component Spec Management Tool`）
   - **Supported account types**：僅此組織目錄（單一租用戶）
   - **Redirect URI**：選 **SPA**，填入 GitHub Pages 網址（如 `https://xxx.github.io/tool-name/`）

### 2.2 記下關鍵 ID

| 欄位 | 用途 | 範例 |
|------|------|------|
| Application (client) ID | MSAL 初始化用 | `17fc1ab4-0ab0-...` |
| Directory (tenant) ID | Authority URL 用 | `19f25823-17ff-...` |

### 2.3 設定 API 權限

進入 **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**：

| 權限 | 類型 | 用途 | 需 Admin Consent |
|------|------|------|:---:|
| `Files.ReadWrite.All` | 已委派 | 讀寫 SharePoint 檔案 | 視租戶 |
| `Sites.Read.All` | 已委派 | 解析 SharePoint site ID | 視租戶 |
| `User.Read` | 已委派 | 登入 + 讀取使用者資料 | 否 |

設定完成後，按 **「Grant admin consent for [組織名稱]」**。

> **重要結論**：
> - 權限必須是 **「已委派」（Delegated）**，不是「應用程式」（Application）。Application 權限是給無人值守的 daemon 用的，MSAL popup 登入拿到的 token 只包含 Delegated 權限。
> - `Files.ReadWrite`（無 `.All`）只能存取使用者自己的 OneDrive，無法寫入 SharePoint 共用檔案。必須用 `Files.ReadWrite.All`。
> - `Sites.Read.All` 是唯讀，足夠解析 site ID。若需要寫入 site 的 list/權限等（非檔案），才需要 `Sites.ReadWrite.All`。

### 2.4 設定 Redirect URI

進入 **Authentication**：
- Platform：**Single-page application (SPA)**
- Redirect URI：GitHub Pages 完整網址（含尾端 `/`）
- 不要勾選 Access tokens 或 ID tokens（MSAL.js 會自動處理）

---

## 三、前端設定 (config.js)

```javascript
const DB_MODE = 'sharepoint';  // 'local' | 'sharepoint'

const SHAREPOINT_CONFIG = {
  clientId:     '<Azure AD Application (client) ID>',
  tenantId:     '<Azure AD Directory (tenant) ID>',
  authority:    'https://login.microsoftonline.com/<tenantId>',
  redirectUri:  'https://xxx.github.io/tool-name/',
  scopes:       ['Files.ReadWrite.All', 'Sites.Read.All'],
  siteHostname: '<tenant>.sharepoint.com',     // 見下方說明
  sitePath:     '/sites/<site-name>',
  filePath:     '/<library>/<filename>.json',
  lockTimeoutMinutes: 10
};
```

> **重要結論 — siteHostname**：
> SharePoint hostname **不一定**等於公司 email 網域。例如 email 是 `@deltaww.com`，但 SharePoint 可能是 `deltao365.sharepoint.com`。
> 確認方式：用瀏覽器開啟 SharePoint site，看網址列的 hostname。
> 若填錯會得到 `400 Invalid hostname for this tenancy` 錯誤。

---

## 四、MSAL.js 認證流程

### 4.1 載入 MSAL CDN

```html
<script src="https://alcdn.msauth.net/browser/2.38.2/js/msal-browser.min.js"></script>
```

> **重要結論**：版本號必須是 Microsoft CDN 上實際存在的版本。可用 `curl -I` 確認回傳 200。例如 `2.38.3` 不存在（404），`2.38.2` 才是正確版本。

### 4.2 初始化

```javascript
const msalConfig = {
  auth: {
    clientId:    SHAREPOINT_CONFIG.clientId,
    authority:   SHAREPOINT_CONFIG.authority,
    redirectUri: SHAREPOINT_CONFIG.redirectUri
  },
  cache: {
    cacheLocation: 'localStorage',    // 跨分頁保持登入
    storeAuthStateInCookie: false
  }
};

msalInstance = new msal.PublicClientApplication(msalConfig);
await msalInstance.initialize();
await msalInstance.handleRedirectPromise();  // 處理重新導向回應
```

### 4.3 登入（Popup 模式）

```javascript
const response = await msalInstance.loginPopup({
  scopes: SHAREPOINT_CONFIG.scopes,
  prompt: 'select_account'
});
msalAccount = response.account;
```

- 使用 **popup** 而非 redirect，避免遺失頁面狀態
- `prompt: 'select_account'` 讓使用者每次可選擇帳號

### 4.4 取得 Access Token

```javascript
// 優先靜默取得（從 cache）
try {
  const response = await msalInstance.acquireTokenSilent({
    scopes: SHAREPOINT_CONFIG.scopes,
    account: msalAccount
  });
  return response.accessToken;
} catch (e) {
  // 靜默失敗 → 互動式 popup（需在使用者手勢內呼叫）
  const response = await msalInstance.acquireTokenPopup({
    scopes: SHAREPOINT_CONFIG.scopes
  });
  return response.accessToken;
}
```

> **重要結論**：`acquireTokenPopup` 必須在使用者手勢（click）的呼叫鏈中執行，否則瀏覽器會擋 popup。初始化時只能用 `acquireTokenSilent`，若失敗應顯示「請重新登入」而非自動跳 popup。

---

## 五、Graph API 操作

所有 API 呼叫帶 Bearer Token：
```javascript
headers: { 'Authorization': `Bearer ${accessToken}` }
```

### 5.1 解析 Site ID

```
GET https://graph.microsoft.com/v1.0/sites/{hostname}:{sitePath}
```

注意 hostname 和 sitePath 之間有冒號 `:`。

### 5.2 解析 Drive Item ID

```
GET https://graph.microsoft.com/v1.0/sites/{siteId}/drive/root:{filePath}
```

### 5.3 讀取檔案

```
GET https://graph.microsoft.com/v1.0/sites/{siteId}/drive/items/{itemId}/content
```

### 5.4 寫入檔案

```
PUT https://graph.microsoft.com/v1.0/sites/{siteId}/drive/items/{itemId}/content
Content-Type: application/json
Body: 完整 JSON 字串
```

> **所需權限對照**：
> | 操作 | 最低權限 |
> |------|----------|
> | 解析 site | `Sites.Read.All` |
> | 讀取檔案 | `Files.ReadWrite.All` 或 `Sites.Read.All` |
> | 寫入檔案 | `Files.ReadWrite.All`（Delegated） |

---

## 六、Pessimistic Locking（悲觀鎖）

### 6.1 設計

Lock 資訊存在 JSON 檔案根層級：

```json
{
  "lock": {
    "lockedBy": "使用者姓名",
    "lockedByEmail": "user@company.com",
    "lockedAt": "2025-01-15T08:30:00.000Z",
    "expiresAt": "2025-01-15T08:40:00.000Z"
  },
  "projects": { ... },
  "rf_library": { ... }
}
```

### 6.2 取得鎖定 (acquireLock)

1. 從 SharePoint 重新讀取檔案（取得最新 lock 狀態）
2. 檢查現有 lock：
   - 別人的 + 未過期 → 拋出 `LockError`（顯示 Lock Warning Modal）
   - 別人的 + 已過期 → 可接管
   - 自己的或不存在 → 直接取得
3. 寫入新 lock（10 分鐘 timeout）
4. 寫回 SharePoint

### 6.3 釋放鎖定 (releaseLock)

1. 確認自己擁有 lock
2. 從 in-memory `dbCache` 刪除 `lock` 屬性
3. 寫回 SharePoint（不含 lock）

> **重要結論**：`releaseLock` 不應在釋放前重新讀取檔案。SharePoint CDN 有快取延遲，儲存後立即讀取可能拿到舊版（仍含 lock），導致 lock 刪了又被舊資料寫回去。直接從 in-memory cache 刪除 lock 再寫回即可。

### 6.4 安全網

- **10 分鐘自動過期**：即使使用者關閉瀏覽器沒有釋放 lock，10 分鐘後其他人可接管
- **beforeunload 事件**：頁面關閉前嘗試 best-effort 釋放 lock
- **儲存後自動鎖定**：儲存 → releaseLock → relock UI，確保寫入權限立即歸還

### 6.5 Lock Warning Modal + Teams 快速聯繫

當使用者被他人的 lock 擋住時，顯示 Modal 包含：
- 鎖定者姓名、信箱、鎖定時間、自動解鎖時間
- **Teams 深層連結按鈕**：一鍵開啟與鎖定者的 Teams 對話，預填訊息

```javascript
const teamsUrl = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}&message=${encodeURIComponent(message)}`;
```

---

## 七、儲存流程

```
使用者按儲存
    │
    ├─ dbAdapter.updateDoc() / setDoc()   ← 寫入資料到 SharePoint
    │
    ├─ dbAdapter.releaseLock()            ← 刪除 lock，寫回 SharePoint
    │
    ├─ relock()                           ← UI 回到「密碼保護啟用」狀態
    │
    └─ 重新渲染畫面                        ← 更新瓦數總和等顯示
```

---

## 八、Script 載入順序

順序很重要，不可調換：

```html
<!-- 1. MSAL 認證庫 -->
<script src="https://alcdn.msauth.net/browser/2.38.2/js/msal-browser.min.js"></script>

<!-- 2. 設定檔（定義 DB_MODE, SHAREPOINT_CONFIG） -->
<script src="config.js"></script>

<!-- 3. 本機資料庫模組 -->
<script src="fileDb.js"></script>

<!-- 4. SharePoint 資料庫模組（必須用 IIFE 包裝） -->
<script src="graphDb.js"></script>

<!-- 5. 路由層（依賴 config, fileDb, graphDb） -->
<script src="dbAdapter.js"></script>
```

> **重要結論**：`graphDb.js` 必須用 IIFE `(function(){ ... })()` 包裝。因為 `fileDb.js` 和 `graphDb.js` 都以普通 `<script>` 載入（共享 global scope），若都在 top-level 宣告相同變數名（如 `let dbCache`），第二個會觸發 `SyntaxError: Identifier has already been declared`，導致整個檔案不執行。

> **重要結論**：inline `<script>` block 不要拆成多個相鄰的 `</script><script>`。async 函式的 `await` 會讓後續 code 在 microtask 中執行，而 microtask 會在兩個 script block 之間被 drain — 此時第二個 block 的 function 尚未被 parse，會報 `ReferenceError`。

---

## 九、問題排查速查表

| 錯誤訊息 | 原因 | 解法 |
|----------|------|------|
| `msal is not defined` | MSAL CDN 版本不存在（404） | 用 `curl -I` 確認 CDN URL 回 200 |
| `graphDb is not defined` | graphDb.js 有 SyntaxError 導致整檔不執行 | 用 IIFE 包裝避免變數名碰撞 |
| `Invalid hostname for this tenancy` | `siteHostname` 填錯 | 瀏覽器開 SharePoint site 確認實際 hostname |
| `400 Bad Request` on `/sites/...` | hostname 和 sitePath 之間缺少冒號 `:` | 確認 URL 格式：`/sites/{hostname}:{sitePath}` |
| `403 Access denied` (PUT) | scope 不足或用了 Application 而非 Delegated | 確認 `Files.ReadWrite.All` 是 **Delegated** + 已 admin consent |
| `需要管理員核准` | scope 含 `.All` 需 admin consent | IT 在 Azure Portal 按「Grant admin consent」 |
| Lock 儲存後未釋放 | `releaseLock` 重新讀檔拿到 CDN 快取舊版 | `releaseLock` 不要 re-read，直接從 in-memory 刪除 lock |
| `updateDbStatusText is not defined` | 多個 inline script block 間的 microtask 時序問題 | 合併為單一 `<script>` block |

---

## 十、Checklist（新工具套用時）

- [ ] Azure Portal 建立 App Registration（單一租用戶 + SPA redirect URI）
- [ ] 記下 Client ID 和 Tenant ID
- [ ] 設定 API 權限：`Files.ReadWrite.All` + `Sites.Read.All` + `User.Read`（全部 Delegated）
- [ ] IT 按「Grant admin consent」
- [ ] 確認 SharePoint site 實際 hostname（瀏覽器網址列）
- [ ] 建立 `config.js` 填入所有參數
- [ ] 建立 `graphDb.js`（IIFE 包裝）含 MSAL 認證 + Graph API + Lock
- [ ] 建立 `dbAdapter.js` 路由層
- [ ] `index.html` 加入 MSAL CDN（確認版本存在）、script 載入順序、登入 UI、Lock Modal
- [ ] 測試登入 → 讀取 → 解鎖 → 編輯 → 儲存 → lock 釋放 → 第二使用者可接手
