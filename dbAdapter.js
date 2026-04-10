// DB_MODE is defined in config.js (loaded before this file)

const dbAdapter = {
  _backend() {
    return DB_MODE === 'sharepoint' ? graphDb : fileDb;
  },

  isSharePointMode() {
    return DB_MODE === 'sharepoint';
  },

  async init() {
    if (DB_MODE === 'sharepoint') {
      await graphDb.initMsal();
      if (graphDb.isSignedIn()) {
        try {
          await graphDb._readFile();
          return { success: true, filename: graphDb.getFilename() };
        } catch (e) {
          console.warn('[dbAdapter] auto-read failed:', e);
          return { success: false, reason: 'read_failed', error: e };
        }
      }
      return { success: false, reason: 'not_signed_in' };
    }
    return await fileDb.openFile();
  },

  isReady() {
    return this._backend().isReady();
  },

  getDbInfo() {
    if (DB_MODE === 'sharepoint') {
      const acct = graphDb.getAccountInfo();
      if (acct) return `SharePoint ｜ ${acct.name} (${acct.email})`;
      return 'SharePoint ｜ 未登入';
    }
    return `本機資料庫 ｜ ${fileDb.getFilename() ?? '未開啟'}`;
  },

  async refresh() {
    return await this._backend().refresh();
  },

  async getCollection(colName) {
    return await this._backend().getCollection(colName);
  },

  async getDoc(colName, docId) {
    return await this._backend().getDoc(colName, docId);
  },

  async setDoc(colName, docId, data) {
    return await this._backend().setDoc(colName, docId, data);
  },

  async updateDoc(colName, docId, fields) {
    return await this._backend().updateDoc(colName, docId, fields);
  },

  async getProjectsSorted() {
    return await this._backend().getProjectsSorted();
  },

  async pickFile() {
    if (DB_MODE === 'sharepoint') return await graphDb.openFile();
    return await fileDb.pickFile();
  },

  exportBackup() {
    this._backend().exportBackup();
  },

  /* ─── Auth methods (SharePoint mode) ─────────────────── */
  async signIn() {
    if (DB_MODE !== 'sharepoint') return { success: true };
    return await graphDb.signIn();
  },

  async signOut() {
    if (DB_MODE !== 'sharepoint') return;
    return await graphDb.signOut();
  },

  isSignedIn() {
    if (DB_MODE !== 'sharepoint') return true;
    return graphDb.isSignedIn();
  },

  getAccountInfo() {
    if (DB_MODE !== 'sharepoint') return null;
    return graphDb.getAccountInfo();
  },

  /* ─── Pessimistic lock methods ────────────────────────── */
  async acquireLock() {
    if (DB_MODE !== 'sharepoint') return null;
    return await graphDb.acquireLock();
  },

  async releaseLock() {
    if (DB_MODE !== 'sharepoint') return;
    return await graphDb.releaseLock();
  },

  hasLock() {
    if (DB_MODE !== 'sharepoint') return true;
    return graphDb.hasLock();
  }
};

window.dbAdapter = dbAdapter;
