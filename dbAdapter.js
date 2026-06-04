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

/* ── shadow-read 私有 helpers（Phase 3+）──────────────────────────
 * 讀 List 端資料並與 JSON 端 diff，結果記到 _shadowReadLog。
 * 任何失敗 silent（不影響主流程）。
 * 觸發點在 dbAdapter.getDoc（Milestone 3.2 整合）。
 */
const _shadowReadLog = [];   // 最近 100 筆 shadow-read diff 結果

function _logShadowRead(entry) {
  _shadowReadLog.unshift({ ts: Date.now(), ...entry });
  if (_shadowReadLog.length > 100) _shadowReadLog.pop();
}

const _shadowReadOn = () => !!(window.FEATURE_FLAGS?.SHADOW_READ_FEEDBACK);

// 17 欄比對 key 清單 + 已知 lossy 欄位（與 fbCompareWithList 邏輯一致）
const _SR_KEYS  = ['id','type','tab','title','priority','reporter','contact',
  'description','current_behavior','expected_behavior','attachments',
  'note','admin_note','status','closed_at','created_at','updated_at'];
const _SR_LOSSY = new Set(['created_at','updated_at','closed_at']);

async function _doShadowReadDiff(id, jsonItem) {
  if (typeof graphListsDb === 'undefined') return;
  try {
    const found = await graphListsDb.feedback.list({ Title: id });
    if (!found.length) {
      _logShadowRead({ id, result: 'list_missing', diffs: [] });
      return;
    }
    const listItem = found[0].data;
    const jObj = { ...jsonItem, id };   // 確保 id 欄位存在

    const realDiffs = [];
    let hasLossy = false;

    for (const k of _SR_KEYS) {
      let jv = jObj[k]     ?? '';
      let lv = listItem[k] ?? '';

      if (k === 'attachments') {
        jv = JSON.stringify(Array.isArray(jv) ? jv : []);
        lv = JSON.stringify(Array.isArray(lv) ? lv : []);
      }
      if (_SR_LOSSY.has(k)) {
        jv = typeof jv === 'string' ? jv.replace(/\.\d{3}Z$/, 'Z') : '';
        lv = typeof lv === 'string' ? lv.replace(/\.\d{3}Z$/, 'Z') : '';
      }

      if (String(jv) !== String(lv)) {
        if (_SR_LOSSY.has(k)) hasLossy = true;
        else realDiffs.push({ field: k, jsonValue: jv, listValue: lv });
      }
    }

    if      (realDiffs.length > 0) _logShadowRead({ id, result: 'real_diff',   diffs: realDiffs });
    else if (hasLossy)             _logShadowRead({ id, result: 'lossy_only'  });
    else                           _logShadowRead({ id, result: 'consistent'  });
  } catch (e) {
    console.warn('[shadow-read] diff failed:', e);
    _logShadowRead({ id, result: 'error', diffs: [], error: e.message });
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
    const result = await this._backend().getDoc(colName, docId);
    // Phase 3+：shadow-read fire-and-forget（不 await，立刻回傳 result）
    if (_isFb(colName) && _shadowReadOn() && result) {
      setTimeout(() => _doShadowReadDiff(docId, result), 0);
    }
    return result;
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

  /**
   * Batched multi-doc write (single flush + single version check).
   * Used for project saves that touch many docs at once. Not used for
   * feedback_items, so no dual-write shadowing is needed here.
   * ops: [{ type:'set'|'update', col, id, data?, fields? }]
   */
  async writeBatch(ops) {
    return await this._backend().writeBatch(ops);
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

  async listTcpImages(projectId) {
    if (DB_MODE !== 'sharepoint') return [];
    return await graphDb.listTcpImages(projectId);
  },

  /* ─── dual-write log（Phase 2 dev panel 用）──────────────────── */
  getDualWriteLog() {
    return _fbLog.slice();
  },

  /* ─── shadow-read log（Phase 3 dev panel 用）─────────────────── */
  getShadowReadLog() {
    return _shadowReadLog.slice();
  }
};

window.dbAdapter = dbAdapter;
