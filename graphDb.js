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
let maxProjectsSeen = 0;     // 本 session 看過的 projects 筆數高水位（歸零保險絲用）

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
    dbCorrupted = false;
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

  async _graphPut(url, body, contentType = 'application/json') {
    const token = await this._getAccessToken(true);
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType
      },
      body: body
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Graph API PUT failed: ${resp.status} ${resp.statusText} — ${errText}`);
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

  async _readFile() {
    await this._resolveDriveItemId();
    const resp = await this._graphGet(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/items/${driveItemId}/content`
    );
    const text = await resp.text();
    let parsed;
    if (text.trim() === '') {
      // 全新空檔（首次建庫）才允許 bootstrap 空骨架
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
    if (currentVersion && parsed.version < currentVersion &&
        dbCache && Object.keys(dbCache).length) {
      console.warn(`[graphDb] 忽略較舊的讀取結果 (server v${parsed.version} < local v${currentVersion})，保留本地較新版本`);
      return;
    }
    dbCache = parsed;
    currentVersion = dbCache.version;
    const n = Object.keys((dbCache && dbCache.projects) || {}).length;
    if (n > maxProjectsSeen) maxProjectsSeen = n;
  },

  /* 寫入前安全檢查：壞檔唯讀 + projects 突然歸零保險絲 */
  _assertWritable(allowEmptyProjects) {
    if (dbCorrupted) {
      throw new Error('資料庫檔案損毀（JSON 解析失敗），已進入唯讀保護模式，本次寫入已擋下以免覆蓋共用資料庫。請至 SharePoint 檢查 thermal_db.json（文件庫「版本歷史」可還原），修復後重新整理頁面。');
    }
    if (!allowEmptyProjects) {
      const n = Object.keys((dbCache && dbCache.projects) || {}).length;
      if (n === 0 && maxProjectsSeen > 0) {
        throw new Error('安全保護：projects 集合由 ' + maxProjectsSeen + ' 筆突然變成 0 筆，寫入已擋下以免抹除共用資料庫。請先至 SharePoint 檢查 thermal_db.json（可用版本歷史還原）；若確認為正常狀態，重新整理頁面即可解除。');
      }
    }
  },

  async _writeFile(opts) {
    this._assertWritable(!!(opts && opts.allowEmptyProjects));
    await this._resolveDriveItemId();

    if (!(opts && opts.skipVersionCheck)) {
      // Re-fetch latest file and compare version (optimistic locking)
      const chkResp = await this._graphGet(
        `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/items/${driveItemId}/content`,
        false
      );
      const chkText = await chkResp.text();
      let latest = {};
      if (chkText.trim() !== '') {
        try { latest = JSON.parse(chkText); } catch (e) { latest = null; }
        if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
          // 寫入前發現檔案已損毀 → 進入唯讀保護（保留快取），本次寫入擋下
          dbCorrupted = true;
          throw new Error('資料庫檔案損毀（JSON 解析失敗），已進入唯讀保護模式，本次寫入已擋下以免覆蓋共用資料庫。請至 SharePoint 檢查 thermal_db.json（文件庫「版本歷史」可還原），修復後重新整理頁面。');
        }
      }
      const diskVersion = latest.version ?? 0;
      // 只有「伺服器版本比我們更新」才算真衝突(別人寫了新資料)。若伺服器版本
      // 較舊(SharePoint 寫後立即讀的延遲)不該誤判為衝突，否則會把記憶體改動丟掉。
      if (diskVersion > currentVersion) {
        dbCache = latest;
        currentVersion = diskVersion;
        throw new ConflictError('版本衝突：資料已被他人更新');
      }
    }

    // Strictly increasing version (avoids same-millisecond collisions)
    dbCache.version = Math.max(Date.now(), (currentVersion ?? 0) + 1);
    currentVersion = dbCache.version;
    const body = JSON.stringify(dbCache, null, 2);
    await this._graphPut(
      `https://graph.microsoft.com/v1.0/sites/${_siteId}/drive/items/${driveItemId}/content`,
      body,
      'application/json'
    );
  },

  /* ─── Pessimistic Locking ─────────────────────────────── */
  async acquireLock() {
    if (!msalAccount) throw new Error('尚未登入 SharePoint');

    // Always re-read from SharePoint to get the latest lock state
    await this._readFile();

    const now = new Date();
    const existingLock = dbCache.lock;

    // Check if someone else holds a non-expired lock
    if (existingLock && existingLock.lockedByEmail && existingLock.lockedByEmail !== msalAccount.username) {
      const expiresAt = new Date(existingLock.expiresAt);
      if (expiresAt > now) {
        throw new LockError(existingLock);
      }
      // Lock expired — we can take it over
    }

    // Acquire lock
    const expiresAt = new Date(now.getTime() + SHAREPOINT_CONFIG.lockTimeoutMinutes * 60 * 1000);
    dbCache.lock = {
      lockedBy: msalAccount.name,
      lockedByEmail: msalAccount.username,
      lockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    await this._writeFile({ skipVersionCheck: true });
    currentLock = dbCache.lock;
    return currentLock;
  },

  async releaseLock() {
    if (!currentLock || !msalAccount) {
      currentLock = null;
      return;
    }
    try {
      // Skip re-read: dbCache is already up-to-date (just written by save or acquireLock).
      // Re-reading risks getting a stale cached version from SharePoint CDN
      // that still contains the lock, causing it to persist.
      if (dbCache.lock && dbCache.lock.lockedByEmail === msalAccount.username) {
        delete dbCache.lock;
        await this._writeFile({ skipVersionCheck: true });
      }
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
    if (!dbCache[colName]) dbCache[colName] = {};
    dbCache[colName][docId] = data;
    await this._writeFile();
  },

  async updateDoc(colName, docId, fields) {
    if (!dbCache[colName]) dbCache[colName] = {};
    const existing = dbCache[colName][docId] ?? {};
    dbCache[colName][docId] = { ...existing, ...fields };
    await this._writeFile();
  },

  /**
   * Apply multiple set/update mutations in memory, then write ONCE.
   * Collapses the N+1 write pattern into a single round-trip + version
   * check, which is the main fix for single-user false version conflicts
   * (each extra write previously re-read SharePoint, and a stale read
   * triggered a spurious conflict).
   * ops: [{ type:'set'|'update', col, id, data?, fields? }]
   */
  async writeBatch(ops) {
    for (const op of ops) {
      if (!dbCache[op.col]) dbCache[op.col] = {};
      if (op.type === 'update') {
        const existing = dbCache[op.col][op.id] ?? {};
        dbCache[op.col][op.id] = { ...existing, ...op.fields };
      } else {
        dbCache[op.col][op.id] = op.data;
      }
    }
    await this._writeFile();
  },

  async deleteDoc(colName, docId) {
    if (dbCache[colName]) {
      delete dbCache[colName][docId];
      // 使用者刻意刪除專案（含最後一筆）是合法操作 → 放行並同步保險絲基準
      await this._writeFile({ allowEmptyProjects: colName === 'projects' });
      if (colName === 'projects') {
        maxProjectsSeen = Object.keys(dbCache.projects || {}).length;
      }
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
