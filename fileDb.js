/* ---- ConflictError ---- */
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}
window.ConflictError = ConflictError;

let fileHandle = null;
let dbCache = {};
let currentVersion = 0;

const fileDb = {
  async openFile() {
    const savedHandle = await this._loadSavedHandle();
    if (savedHandle) {
      try {
        const permission = await savedHandle.requestPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          fileHandle = savedHandle;
          await this._readFile();
          return { success: true, filename: fileHandle.name };
        }
      } catch(e) {}
    }
    return await this.pickFile();
  },

  async pickFile() {
    try {
      [fileHandle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON Database', accept: { 'application/json': ['.json'] } }],
        multiple: false
      });
      await this._readFile();
      await this._saveHandle(fileHandle);
      return { success: true, filename: fileHandle.name };
    } catch(e) {
      if (e.name === 'AbortError') return { success: false, reason: 'cancelled' };
      throw e;
    }
  },

  async createFile() {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: 'thermal_db.json',
        types: [{ description: 'JSON Database', accept: { 'application/json': ['.json'] } }]
      });
      dbCache = { version: Date.now(), rf_library: {}, digital_library: {}, pwr_library: {}, projects: {} };
      currentVersion = dbCache.version;
      await this._writeFileRaw();
      await this._saveHandle(fileHandle);
      return { success: true, filename: fileHandle.name, isNew: true };
    } catch(e) {
      if (e.name === 'AbortError') return { success: false, reason: 'cancelled' };
      throw e;
    }
  },

  isReady() { return fileHandle !== null; },
  getFilename() { return fileHandle ? fileHandle.name : null; },

  async getCollection(colName) {
    this._assertReady();
    return dbCache[colName] ?? {};
  },

  async getDoc(colName, docId) {
    this._assertReady();
    return dbCache[colName]?.[docId] ?? null;
  },

  async setDoc(colName, docId, data) {
    this._assertReady();
    if (!dbCache[colName]) dbCache[colName] = {};
    dbCache[colName][docId] = data;
    await this._writeFile();
  },

  async updateDoc(colName, docId, fields) {
    this._assertReady();
    const existing = dbCache[colName]?.[docId] ?? {};
    dbCache[colName][docId] = { ...existing, ...fields };
    await this._writeFile();
  },

  async getProjectsSorted() {
    this._assertReady();
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
    a.download = `thermal_db_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  async _readFile() {
    const file = await fileHandle.getFile();
    const text = await file.text();
    try { dbCache = JSON.parse(text); }
    catch { dbCache = { rf_library: {}, digital_library: {}, pwr_library: {}, projects: {} }; }

    // Migration: add version if missing
    if (!dbCache.version) {
      dbCache.version = Date.now();
      await this._writeFileRaw();
    }
    currentVersion = dbCache.version;
  },

  /** Write with optimistic locking: re-fetch and compare version before writing */
  async _writeFile() {
    // Step 1: Re-fetch latest from disk
    const file = await fileHandle.getFile();
    const text = await file.text();
    let latestDb;
    try { latestDb = JSON.parse(text); }
    catch { latestDb = {}; }

    // Step 2: Compare version
    const diskVersion = latestDb.version ?? 0;
    if (diskVersion !== currentVersion) {
      // Conflict detected — update dbCache with latest disk data
      dbCache = latestDb;
      currentVersion = diskVersion;
      throw new ConflictError('版本衝突：資料已被他人更新');
    }

    // Step 3: Write with new version
    dbCache.version = Date.now();
    currentVersion = dbCache.version;
    await this._writeFileRaw();
  },

  /** Raw write without version check (used for migration and createFile) */
  async _writeFileRaw() {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dbCache, null, 2));
    await writable.close();
  },

  _assertReady() {
    if (!fileHandle) throw new Error('[fileDb] 尚未開啟資料庫');
  },

  async _saveHandle(handle) {
    try {
      const idb = await this._openIdb();
      const tx = idb.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'thermal_db');
    } catch(e) {}
  },

  async _loadSavedHandle() {
    try {
      const idb = await this._openIdb();
      return await new Promise((resolve) => {
        const tx = idb.transaction('handles', 'readonly');
        const req = tx.objectStore('handles').get('thermal_db');
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  },

  async _openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('fileDbMeta_thermalPad', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = reject;
    });
  }
};

window.fileDb = fileDb;
