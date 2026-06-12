(function () {
/* ---- LockError ---- */
class LockError extends Error {
  constructor(lockInfo) {
    super(`資料庫已被 ${lockInfo.lockedBy} 鎖定`);
    this.name = 'LockError';
    this.lockedBy = lockInfo.lockedBy;
    this.lockedByEmail = lockInfo.lockedByEmail;
    this.lockedAt = lockInfo.lockedAt;
    this.expiresAt = lockInfo.expiresAt;
  }
}
window.LockError = LockError;

/* ---- Module state (scoped to this IIFE) ---- */
let msalInstance = null;
let msalAccount = null;
let dbCache = {};
let driveItemId = null;
let _siteId = null;
let currentLock = null;
let currentVersion = null;
let dbCorrupted = false;     // 壞檔唯讀保護：JSON 解析失敗時禁止一切寫入
let lastReadProjects = 0;    // 上次成功讀檔時的 projects 筆數（歸零保險絲基準）
let sawRealData = false;     // 本 session 是否曾持有實際資料（區分「全新空庫」vs「截斷成空檔」）
let currentEtag = null;      // 最近一次讀檔的 DriveItem eTag（樂觀並發 If-Match 基準）

const graphDb = {
  /* ─── MSAL Initialization ─────────────────────────────── */
  async initMsal() {
    if (msalInstance) return;

    const msalConfig = {
      auth: {
        clientId: SHAREPOINT_CONFIG.clientId,
        authority: SHAREPOINT_CONFIG.authority,
        redirectUri: SHAREPOINT_CONFIG.redirectUri
      },
      cache: {
        cacheLocation: 'localStorage',
        storeAuthStateInCookie: false
      }
    };

    msalInstance = new msal.PublicClientApplication(msalConfig);
    await msalInstance.initialize();

    // Handle redirect response (if any)
    try {
      const response = await msalInstance.handleRedirectPromise();
      if (response) {
        msalAccount = response.account;
      }
    } catch (e) {
      console.warn('[graphDb] handleRedirectPromise failed:', e);
    }

    // Restore cached account
    if (!msalAccount) {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) msalAccount = accounts[0];
    }
  },

  /* ─── Authentication ──────────────────────────────────── */
  async signIn() {
    if (!msalInstance) await this.initMsal();
    try {
      const response = await msalInstance.loginPopup({
        scopes: SHAREPOINT_CONFIG.scopes,
        prompt: 'select_account'
      });
      msalAccount = response.account;
      return { success: true, account: msalAccount };
    } catch (e) {
      if (e.errorCode === 'user_cancelled' || e.errorCode === 'popup_window_error') {
        return { success: false, reason: 'cancelled' };
      }
      throw e;
    }
  },

  async signOut() {
    if (!msalInstance) return;
    try {
      await msalInstance.logoutPopup({ account: msalAccount });
    } catch (e) {
      console.warn('[graphDb] logout failed:', e);
    }
    msalAccount = null;
    dbCache = {};
    driveItemId = null;
    _siteId = null;
    currentLock = null;
    currentVersion = null;
    dbCorrupted = false;
    currentEtag = null;
    lastReadProjects = 0;
    sawRealData = false;
  },

  isSignedIn() {
    return msalAccount !== null;
  },

  getAccountInfo() {
    if (!msalAccount) return null;
    return { name: msalAccount.name, email: msalAccount.username };
  },

  async _getAccessToken(allowInteractive = true) {
    if (!msalAccount) throw new Error('尚未登入 SharePoint');
    try {
      const response = await msalInstance.acquireTokenSilent({
        scopes: SHAREPOINT_CONFIG.scopes,
        account: msalAccount
      });
      return response.accessToken;
    } catch (e) {
      if (!allowInteractive) throw e;
      // Silent token acquisition failed — fall back to interactive (requires user gesture)
      const response = await msalInstance.acquireTokenPopup({
        scopes: SHAREPOINT_CONFIG.scopes
      });
      msalAccount = response.account;
      return response.accessToken;
    }
  },

  /* ─── Graph API Helpers ───────────────────────────────── */
  async _graphGet(url, allowInteractive = true) {
    const token = await this._getAccessToken(allowInteractive);
    // cache:'no-store' + no-cache headers prevent the browser/proxy from
    // serving a stale copy, which would make the version check read an old
    // version and falsely report a conflict.
    const resp = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Graph API GET failed: ${resp.status} ${resp.statusText} — ${errText}`);
    }
    return resp;
  },

  async _graphPut(url, body, contentType = 'application/json', extraHeaders = {}) {
    const token = await this._getAccessToken(true);
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        ...extraHeaders
      },
      body: body
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const err = new Error(`Graph API PUT failed: ${resp.status} ${resp.statusText} — ${errText}`);
      err.status = resp.status;   // 供 _withOptimisticWrite 偵測 412 Precondition Failed
      throw err;
    }
    return resp;
  },

  /* ─── Site/Drive Resolution & File I/O ────────────────── */
  async _resolveDriveItemId() {
    if (driveItemId && _siteId) return driveItemId;

    // Step 1: Get site ID
    const siteResp = await this._graphGet(
      `https://graph.microsoft.com/v1.0/sites/${SHAREPOINT_CONFIG.siteHostname}:${SHAREPOINT_CONFIG.sitePath}`
    );
    const site = await siteResp.json();
    _siteId = site.id;

    // Step 2: Get drive item by path
    const itemResp = await this._graphGet(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/root:${SHAREPOINT_CONFIG.filePath}`
    );
    const item = await itemResp.json();
    driveItemId = item.id;

    return driveItemId;
  },

  async _readFile(opts) {
    await this._resolveDriveItemId();
    // 先取 metadata 拿 eTag 作為樂觀並發基準。content GET 會被 302 導到下載主機，
    // 其 ETag 是儲存層的、不可用於 Graph 的 If-Match，所以要單獨取 DriveItem 的 eTag。
    try {
      const metaResp = await this._graphGet(
        `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/items/${driveItemId}?$select=id,eTag,cTag`
      );
      const meta = await metaResp.json();
      currentEtag = meta.eTag || meta.cTag || null;
    } catch (e) {
      currentEtag = null;   // 拿不到 etag → 退化為無 If-Match（不比現況差）
    }
    const resp = await this._graphGet(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/items/${driveItemId}/content`
    );
    const text = await resp.text();
    let parsed;
    if (text.trim() === '') {
      if (sawRealData) {
        // 先前已持有實際資料、現在卻讀到空檔 → 截斷異常，保留舊快取進唯讀，
        // 絕不可 bootstrap 空骨架後寫回（否則把整份共用 DB 抹掉）。
        dbCorrupted = true;
        console.error('[graphDb] 讀到空檔但先前已有資料 → 截斷疑慮，進入唯讀保護');
        return;
      }
      // 真正的全新空檔（首次建庫）→ bootstrap 空骨架
      parsed = { rf_library: {}, digital_library: {}, pwr_library: {}, projects: {} };
      dbCorrupted = false;
    } else {
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        dbCorrupted = false;
      } else {
        // 壞檔（非法 JSON / 非物件）→ 保留舊快取、進入唯讀保護。
        // 絕不可 fallback 成空骨架，否則下一次寫入會把整份共用 DB 抹掉。
        dbCorrupted = true;
        console.error('[graphDb] thermal_db.json 解析失敗 → 唯讀保護模式（保留先前快取，禁止寫入）');
        return;
      }
    }
    if (!parsed.version) parsed.version = Date.now();
    // 防版本回退：SharePoint 在「剛寫入後立即重讀」偶爾會回傳寫入前的舊內容
    // (服務端 read-after-write 延遲)。若伺服器版本比我們手上的還舊，保留記憶體
    // 較新的 dbCache，避免剛存好的變更在重載時看起來「消失」。
    // 例外（force）：412 衝突後的重讀必須以磁碟現況為準——sibling 工具不遞增
    // version、版本歷史還原也會讓磁碟 version 變小，此時拒收會讓重試把過時
    // 快取寫回、回滾他人寫入。
    if (!(opts && opts.force) && currentVersion && parsed.version < currentVersion &&
        dbCache && Object.keys(dbCache).length) {
      console.warn(`[graphDb] 忽略較舊的讀取結果 (server v${parsed.version} < local v${currentVersion})，保留本地較新版本`);
      return;
    }
    dbCache = parsed;
    currentVersion = dbCache.version;
    // 記錄這次讀到的 projects 筆數，作為「歸零保險絲」的比較基準（反映磁碟現況，
    // 而非 session 高水位）：唯有「讀檔時有資料、寫檔時卻歸零」才視為記憶體異常丟失。
    lastReadProjects = Object.keys((dbCache && dbCache.projects) || {}).length;
    if (lastReadProjects > 0) sawRealData = true;
  },

  /* 寫入前安全檢查：壞檔唯讀 + projects 突然歸零保險絲 */
  _assertWritable(allowEmptyProjects) {
    if (dbCorrupted) {
      throw new Error('資料庫檔案損毀（JSON 解析失敗），已進入唯讀保護模式，本次寫入已擋下以免覆蓋共用資料庫。請至 SharePoint 檢查 thermal_db.json（文件庫「版本歷史」可還原），修復後重新整理頁面。');
    }
    if (!allowEmptyProjects) {
      const n = Object.keys((dbCache && dbCache.projects) || {}).length;
      // 上次讀檔有 projects、現在卻要寫入 0 筆 → 記憶體裡的 projects 異常丟失，擋下。
      // （磁碟本來就是空的情況 lastReadProjects===0 → 不誤擋取鎖等正常寫入。）
      if (n === 0 && lastReadProjects > 0) {
        throw new Error('安全保護：projects 集合由 ' + lastReadProjects + ' 筆突然變成 0 筆，寫入已擋下以免抹除共用資料庫。請先至 SharePoint 檢查 thermal_db.json（可用版本歷史還原）；若確認為正常狀態，重新整理頁面即可解除。');
      }
    }
  },

  async _writeFile(opts) {
    this._assertWritable(!!(opts && opts.allowEmptyProjects));
    await this._resolveDriveItemId();

    // 版本戳記照舊遞增（_readFile 防回退判斷用），但 currentVersion 改在 PUT 成功後
    // 才提交：If-Match 412 後的重讀才不會把「最新內容」誤判成回退而拒收。
    // 真正的並發衝突偵測交給 If-Match（原本寫前 GET 比對版本的做法有 TOCTOU 空窗，
    // 且 sibling 工具不會遞增 version，偵測不到它的寫入）。
    const newVersion = Math.max(Date.now(), (currentVersion ?? 0) + 1);
    dbCache.version = newVersion;
    const body = JSON.stringify(dbCache, null, 2);
    const headers = {};
    if (currentEtag) headers['If-Match'] = currentEtag;   // 自我們上次讀檔後若有人改過 → 412
    const resp = await this._graphPut(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/items/${driveItemId}/content`,
      body,
      'application/json',
      headers
    );
    currentVersion = newVersion;
    // 寫入成功 → 從 PUT 回應更新 etag 供下一次 If-Match；解析失敗就保留舊 etag
    // （下一次寫入會 412 → 自動重讀修正，安全但多一趟）。
    try {
      const item = await resp.json();
      if (item && (item.eTag || item.cTag)) currentEtag = item.eTag || item.cTag;
    } catch (e) { /* 回應無 JSON body：靠下一次 412 自癒 */ }
    // 已成功持久化含 projects 的資料 → 標記本 session 曾有實際資料（截斷偵測用）
    if (Object.keys((dbCache && dbCache.projects) || {}).length > 0) sawRealData = true;
  },

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

  // 樂觀並發寫入：在「目前快取」上套用 mutateFn 後寫檔；若期間他人改過檔案（If-Match 412），
  // 重讀最新內容＋新 etag，再於最新狀態上重跑 mutateFn 後重試。最多 4 次。
  // mutateFn(cache) 可：(a) 直接改 cache 後 return（預設要寫）；(b) return {skipWrite:true} 不寫；
  // (c) return {value:x} 帶回傳值；(d) throw（如 LockError）→ 立即往外丟、不重試。
  async _withOptimisticWrite(mutateFn, opts) {
    const MAX = 4;
    for (let attempt = 0; ; attempt++) {
      const decision = mutateFn(dbCache) || {};
      if (decision.skipWrite) return decision.value;
      try {
        await this._writeFile(opts);
        return decision.value;
      } catch (e) {
        if (e && e.status === 412 && attempt < MAX) {
          await this._sleep(120 * (attempt + 1));
          // 取得最新內容＋新 etag（force：衝突解決讀取一律以磁碟為準），
          // 下一圈在最新狀態上重跑 mutateFn
          await this._readFile({ force: true });
          continue;
        }
        throw e;
      }
    }
  },

  /* ─── Pessimistic Locking ─────────────────────────────── */
  async acquireLock() {
    if (!msalAccount) throw new Error('尚未登入 SharePoint');

    await this._readFile();   // 取最新狀態＋etag：明顯已被鎖時可即時丟 LockError

    // 取鎖檢查與寫入透過 If-Match 構成原子 check-and-set：
    // 若他人在我們讀檔後、寫入前搶先取鎖，PUT 會 412 → 重讀後重跑此函式，
    // 看到對方的有效鎖即丟 LockError，不會兩人同時取得鎖。
    const lock = await this._withOptimisticWrite((cache) => {
      const now = new Date();
      const existingLock = cache.lock;
      if (existingLock && existingLock.lockedByEmail && existingLock.lockedByEmail !== msalAccount.username) {
        const expiresAt = new Date(existingLock.expiresAt);
        if (expiresAt > now) throw new LockError(existingLock);
        // Lock expired — we can take it over
      }
      const expiresAt = new Date(now.getTime() + SHAREPOINT_CONFIG.lockTimeoutMinutes * 60 * 1000);
      cache.lock = {
        lockedBy: msalAccount.name,
        lockedByEmail: msalAccount.username,
        lockedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      };
      return { value: cache.lock };
    });
    currentLock = lock;   // 寫入成功才認定持鎖：LockError/412 失敗不殘留假鎖狀態
    return currentLock;
  },

  async releaseLock() {
    if (!currentLock || !msalAccount) {
      currentLock = null;
      return;
    }
    try {
      // 釋放前在最新狀態上判斷鎖是否仍屬於自己：若鎖已過期被他人接手，
      // skipWrite 不動別人的鎖與資料（避免用過期快取整檔回寫蓋掉對方）。
      await this._withOptimisticWrite((cache) => {
        if (cache.lock && cache.lock.lockedByEmail === msalAccount.username) {
          delete cache.lock;
          return {};
        }
        return { skipWrite: true };
      });
    } catch (e) {
      console.warn('[graphDb] releaseLock failed:', e);
    }
    currentLock = null;
  },

  hasLock() {
    return currentLock !== null;
  },

  getLockInfo() {
    return dbCache.lock || null;
  },

  async peekLock() {
    await this._readFile();
    return dbCache.lock || null;
  },

  /* ─── Collection/Document API (mirrors fileDb) ────────── */
  async openFile() {
    if (!msalInstance) await this.initMsal();
    if (!msalAccount) {
      const result = await this.signIn();
      if (!result.success) return result;
    }
    await this._readFile();
    return { success: true, filename: 'thermal_db.json (SharePoint)' };
  },

  async refresh() {
    await this._readFile();
  },

  isReady() {
    return msalAccount !== null && Object.keys(dbCache).length > 0;
  },

  /* 壞檔唯讀保護模式中？（UI 健康橫幅用） */
  isCorrupted() {
    return dbCorrupted;
  },

  getFilename() {
    return 'thermal_db.json (SharePoint)';
  },

  async getCollection(colName) {
    return dbCache[colName] ?? {};
  },

  async getDoc(colName, docId) {
    return dbCache[colName]?.[docId] ?? null;
  },

  async setDoc(colName, docId, data) {
    await this._withOptimisticWrite((cache) => {
      if (!cache[colName]) cache[colName] = {};
      cache[colName][docId] = data;
    });
  },

  async updateDoc(colName, docId, fields) {
    // 衝突時於最新 doc 上重做 shallow merge：他人對其他 doc／collection 的寫入
    // 不會被我們的整檔 PUT 回滾。（同一 doc 內巢狀欄位如 global_params 的競態，
    // 仍依 CLAUDE.md 規則 2 由呼叫端先 getDoc 合併。）
    await this._withOptimisticWrite((cache) => {
      if (!cache[colName]) cache[colName] = {};
      const existing = cache[colName][docId] ?? {};
      cache[colName][docId] = { ...existing, ...fields };
    });
  },

  /**
   * Apply multiple set/update mutations in memory, then write ONCE.
   * Collapses the N+1 write pattern into a single round-trip, which is the
   * main fix for single-user false version conflicts. 412 衝突時於最新狀態
   * 重放整批 ops（ops 為純資料，可安全重跑）。
   * ops: [{ type:'set'|'update', col, id, data?, fields? }]
   */
  async writeBatch(ops) {
    await this._withOptimisticWrite((cache) => {
      for (const op of ops) {
        if (!cache[op.col]) cache[op.col] = {};
        if (op.type === 'update') {
          const existing = cache[op.col][op.id] ?? {};
          cache[op.col][op.id] = { ...existing, ...op.fields };
        } else {
          cache[op.col][op.id] = op.data;
        }
      }
    });
  },

  async deleteDoc(colName, docId) {
    // 使用者刻意刪除專案（含最後一筆）是合法操作 → 放行並同步保險絲基準
    await this._withOptimisticWrite((cache) => {
      if (cache[colName] && cache[colName][docId] !== undefined) {
        delete cache[colName][docId];
        return {};
      }
      return { skipWrite: true };   // 已不存在（可能他人先刪了）→ 不需寫
    }, { allowEmptyProjects: colName === 'projects' });
    if (colName === 'projects') {
      lastReadProjects = Object.keys(dbCache.projects || {}).length;   // 刪除後磁碟即此筆數
    }
  },

  async getProjectsSorted() {
    const projects = dbCache['projects'] ?? {};
    return Object.entries(projects)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => {
        const ta = a.meta?.timestamp ?? '';
        const tb = b.meta?.timestamp ?? '';
        return tb.localeCompare(ta);
      });
  },

  /* ─── TCP Image File Storage ─────────────────────────── */
  async uploadTcpImage(projectId, catKey, jpegBlob) {
    if (!_siteId) await this._resolveDriveItemId();
    const folder = SHAREPOINT_CONFIG.filePath.replace(/[^/]+$/, '') + 'tcp_images';
    const filename = `${projectId}_${catKey}_${Date.now()}.jpg`;
    const token = await this._getAccessToken(true);
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/root:${folder}/${filename}:/content`,
      { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: jpegBlob }
    );
    if (!resp.ok) throw new Error('圖片上傳失敗 ' + resp.status);
    return `${folder}/${filename}`;
  },

  async getTcpImageSrc(spPath) {
    if (!_siteId) await this._resolveDriveItemId();
    const token = await this._getAccessToken(true);
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/root:${spPath}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!resp.ok) throw new Error('圖片讀取失敗 ' + resp.status);
    const item = await resp.json();
    return item['@microsoft.graph.downloadUrl'] || null;
  },

  async deleteTcpImage(spPath) {
    if (!_siteId) await this._resolveDriveItemId();
    const token = await this._getAccessToken(false).catch(() => null);
    if (!token) return;
    await fetch(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/root:${spPath}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
  },

  /* 列出某專案在 tcp_images 資料夾下實際存在的圖檔路徑（供對帳/垃圾回收用）。
     檔名格式為 `${projectId}_${catKey}_${ts}.jpg`，以 projectId 前綴過濾。 */
  async listTcpImages(projectId) {
    if (!_siteId) await this._resolveDriveItemId();
    const folder = SHAREPOINT_CONFIG.filePath.replace(/[^/]+$/, '') + 'tcp_images';
    const token = await this._getAccessToken(true);
    const out = [];
    let url = `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/root:${folder}:/children?$select=name&$top=200`;
    while (url) {
      const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!resp.ok) {
        if (resp.status === 404) return [];   // 資料夾尚未建立 → 視為無檔案
        throw new Error('圖片列舉失敗 ' + resp.status);
      }
      const data = await resp.json();
      for (const it of (data.value || [])) {
        if (it.folder) continue;
        if (!projectId || it.name.startsWith(projectId + '_')) out.push(`${folder}/${it.name}`);
      }
      url = data['@odata.nextLink'] || null;
    }
    return out;
  },

  exportBackup() {
    const blob = new Blob([JSON.stringify(dbCache, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `thermal_db_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
};

window.graphDb = graphDb;
})();
