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
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
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
    try {
      dbCache = JSON.parse(text);
    } catch {
      dbCache = { rf_library: {}, digital_library: {}, pwr_library: {}, projects: {} };
    }
  },

  async _writeFile() {
    await this._resolveDriveItemId();
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
    await this._writeFile();
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
        await this._writeFile();
      }
    } catch (e) {
      console.warn('[graphDb] releaseLock failed:', e);
    }
    currentLock = null;
  },

  hasLock() {
    return currentLock !== null;
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
    const existing = dbCache[colName]?.[docId] ?? {};
    dbCache[colName][docId] = { ...existing, ...fields };
    await this._writeFile();
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
