// DB_MODE is defined in config.js (loaded before this file)

/* ── dual-write 私有 helpers ──────────────────────────────────────
 * 只在 dbAdapter 內部使用，不 expose 到外部。
 * 僅對 feedback_items collection 生效；其他 collection 完全不走這裡。
 */
const _fbLog = [];   // 最近 20 筆 dual-write 結果

function _logFb(entry) {
  _fbLog.unshift({ ts: Date.now(), ...entry });
  if (_fbLog.length > 20) _fbLog.pop();
}

const _isFb    = col  => col === 'feedback_items';
const _dualOn  = ()   => !!(window.FEATURE_FLAGS?.DUAL_WRITE_FEEDBACK);
const _primary = ()   => window.FEATURE_FLAGS?.PRIMARY_FEEDBACK ?? 'json';

/* shadow-write helpers（非阻擋；失敗只 log，不影響主流程）*/
function _shadowAdd(docId, data) {
  if (typeof graphListsDb === 'undefined') {
    console.warn('[dual-write] graphListsDb 未載入，略過 shadow add');
    _logFb({ id: docId, op: 'add', ok: false, error: 'graphListsDb not loaded' });
    return;
  }
  try {
    graphListsDb.feedback.add({ ...data, id: docId })
      .then(() => _logFb({ id: docId, op: 'add', ok: true }))
      .catch(e => {
        console.warn('[dual-write] List.add failed:', e);
        _logFb({ id: docId, op: 'add', ok: false, error: e.message });
      });
  } catch (e) {
    console.warn('[dual-write] _shadowAdd sync error:', e);
    _logFb({ id: docId, op: 'add', ok: false, error: e.message });
  }
}

function _shadowUpdate(docId, fields) {
  if (typeof graphListsDb === 'undefined') {
    console.warn('[dual-write] graphListsDb 未載入，略過 shadow update');
    return;
  }
  try {
    graphListsDb.feedback.list({ Title: docId })
      .then(items => {
        if (!items.length) return;
        return graphListsDb.feedback.update(items[0].spItemId, fields, items[0].etag);
      })
      .then(() => _logFb({ id: docId, op: 'update', ok: true }))
      .catch(e => {
        console.warn('[dual-write] List.update failed:', e);
        _logFb({ id: docId, op: 'update', ok: false, error: e.message });
      });
  } catch (e) {
    console.warn('[dual-write] _shadowUpdate sync error:', e);
  }
}

function _shadowDelete(docId) {
  if (typeof graphListsDb === 'undefined') {
    console.warn('[dual-write] graphListsDb 未載入，略過 shadow delete');
    return;
  }
  try {
    graphListsDb.feedback.list({ Title: docId })
      .then(items => {
        if (!items.length) return;
        return graphListsDb.feedback.delete(items[0].spItemId, items[0].etag);
      })
      .catch(e => console.warn('[dual-write] List.delete failed:', e));
  } catch (e) {
    console.warn('[dual-write] _shadowDelete sync error:', e);
  }
}

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
    // Phase 4+：PRIMARY_FEEDBACK='list' 時從 List 讀；現在預設 'json' 不走這裡
    if (_isFb(colName) && _primary() === 'list') {
      const items = await graphListsDb.feedback.list();
      const result = {};
      for (const it of items) {
        if (it.data?.id) result[it.data.id] = it.data;
      }
      return result;
    }
    return await this._backend().getCollection(colName);
  },

  async getDoc(colName, docId) {
    // Phase 4+：PRIMARY_FEEDBACK='list' 時從 List 讀
    if (_isFb(colName) && _primary() === 'list') {
      const items = await graphListsDb.feedback.list({ Title: docId });
      return items.length ? items[0].data : null;
    }
    return await this._backend().getDoc(colName, docId);
  },

  async setDoc(colName, docId, data) {
    await this._backend().setDoc(colName, docId, data);
    // Phase 2+：DUAL_WRITE_FEEDBACK=true 時 shadow-write 到 List
    if (_isFb(colName) && _dualOn()) _shadowAdd(docId, data);
  },

  async updateDoc(colName, docId, fields) {
    await this._backend().updateDoc(colName, docId, fields);
    if (_isFb(colName) && _dualOn()) _shadowUpdate(docId, fields);
  },

  async deleteDoc(colName, docId) {
    await this._backend().deleteDoc(colName, docId);
    if (_isFb(colName) && _dualOn()) _shadowDelete(docId);
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
  },

  getLockInfo() {
    if (DB_MODE !== 'sharepoint') return null;
    return graphDb.getLockInfo();
  },

  async peekLock() {
    if (DB_MODE !== 'sharepoint') return null;
    return await graphDb.peekLock();
  },

  /* ─── TCP Image File Storage ─────────────────────────── */
  async uploadTcpImage(projectId, catKey, jpegBlob) {
    if (DB_MODE !== 'sharepoint') return null;
    return await graphDb.uploadTcpImage(projectId, catKey, jpegBlob);
  },

  async getTcpImageSrc(spPath) {
    if (DB_MODE !== 'sharepoint') return null;
    return await graphDb.getTcpImageSrc(spPath);
  },

  async deleteTcpImage(spPath) {
    if (DB_MODE !== 'sharepoint') return;
    return await graphDb.deleteTcpImage(spPath);
  },

  /* ─── dual-write log（Phase 2 dev panel 用）──────────────────── */
  getDualWriteLog() {
    return _fbLog.slice();   // 回傳 copy，不讓外部直接改
  }
};

window.dbAdapter = dbAdapter;
