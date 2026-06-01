(function () {
  /* graphListsDb.js — Feedback List CRUD（Phase 1 / Milestone 2）
   *
   * 依賴（必須在本檔案之前載入）：
   *   window.ConflictError   — fileDb.js 定義，直接重用，不重複宣告
   *   window.graphDb         — graphDb.js；重用 graphDb._getAccessToken()（既有 public method，非新增）
   *                            ⚠️ 如需重構 graphDb.js，請保留 _getAccessToken 為 public method
   *                            或抽出共用 utility 並同步更新本檔引用（見 lists-migration.md gotcha #13）
   *   window.SHAREPOINT_CONFIG — config.js 定義
   */

  const _SITE_ID  = 'deltao365.sharepoint.com,7c5179cc-7bcc-42f3-928f-aeaaeb860787,f30d898c-bf60-4d5e-a6b3-306e3ea83cce';
  const _LIST_ID  = 'f916276f-d0ac-45fd-90f0-c9be2e7938e6';
  const _BASE_URL = `https://graph.microsoft.com/v1.0/sites/${_SITE_ID}/lists/${_LIST_ID}`;

  // 已建索引的 5 個 columns — $filter 不需 Prefer header
  const _INDEXED_COLS = new Set(['Status', 'Type', 'Tab', 'Priority', 'CreatedAt']);

  /* ── JSON key → List internal name 對照表 ───────────────────────
   * 完整 17 欄，依 docs/lists-migration.md「Columns 對照表」
   * （snake_case JSON key → PascalCase List internal name）
   */
  const _J2L = {
    id:               'Title',
    type:             'Type',
    tab:              'Tab',
    title:            'FbTitle',
    priority:         'Priority',
    reporter:         'Reporter',
    contact:          'Contact',
    description:      'Description',
    current_behavior: 'CurrentBehavior',
    expected_behavior:'ExpectedBehavior',
    attachments:      'FbAttachments',
    note:             'Note',
    admin_note:       'AdminNote',
    status:           'Status',
    closed_at:        'ClosedAt',
    created_at:       'CreatedAt',
    updated_at:       'UpdatedAt',
  };

  /* ── 純函式：JSON item → List fields（POST/PATCH 用）───────────
   * - 支援全欄（新增）或 partial 物件（更新），undefined 欄位自動跳過
   * - attachments array → JSON.stringify
   * - dateTime 空字串 → null（SharePoint 不接受空字串 dateTime）
   * - 其他空字串保留（text/note 欄位接受空字串）
   * - dateTime 含毫秒直接寫入，SharePoint 自動截斷（lossy，已知）
   * ⚠️  caller 責任：item 必須包含 id 欄位（FeedbackId，如 'FB-...'）
   *    feedback_items[docId] 的 inner object 沒有 id，呼叫前要補：
   *    toListFields({ ...item, id: docId })
   */
  function toListFields(jsonItem) {
    const out = {};
    for (const [jk, lk] of Object.entries(_J2L)) {
      if (!(jk in jsonItem)) continue;
      const v = jsonItem[jk];
      if (jk === 'attachments') {
        out[lk] = JSON.stringify(v ?? []);
      } else if (jk === 'closed_at' || jk === 'created_at' || jk === 'updated_at') {
        // dateTime：空字串 → null；非空字串原樣送出
        out[lk] = v || null;
      } else {
        out[lk] = v;
      }
    }
    return out;
  }

  /* ── 純函式：List GET response.fields → JSON 形狀物件 ───────────
   * - ClosedAt key 缺失（null dateTime GET 行為，已知 gotcha #4）→ ''
   * - dateTime 毫秒缺失（lossy，已知 gotcha #3），接受不補回
   * - FbAttachments JSON.parse 回 array；parse 失敗時回 []
   * - 過濾掉 SharePoint 內建欄位（Created/Modified/Author/Editor 等）
   * - 回傳物件含 id 欄位（對應 Title）方便 caller 識別
   */
  function fromListFields(f) {
    if (!f.Title) {
      // Title（FeedbackId）遺失時資料會無聲 corrupt，提早警告
      console.warn('[fromListFields] item 缺少 Title (FeedbackId)，id 將為空字串');
    }

    let attachments = [];
    try {
      if (f.FbAttachments) attachments = JSON.parse(f.FbAttachments);
    } catch {}

    return {
      id:               f.Title         ?? '',
      type:             f.Type          ?? '',
      tab:              f.Tab           ?? '',
      title:            f.FbTitle       ?? '',
      priority:         f.Priority      ?? '',
      reporter:         f.Reporter      ?? '',
      contact:          f.Contact       ?? '',
      description:      f.Description   ?? '',
      current_behavior: f.CurrentBehavior  ?? '',
      expected_behavior:f.ExpectedBehavior ?? '',
      attachments,
      note:             f.Note          ?? '',
      admin_note:       f.AdminNote     ?? '',
      status:           f.Status        ?? '',
      closed_at:        f.ClosedAt      ?? '',   // key 缺失（null dateTime）→ ''
      created_at:       f.CreatedAt     ?? '',
      updated_at:       f.UpdatedAt     ?? '',
    };
  }

  // 重用 graphDb 的 MSAL instance 取 token，不另起 PublicClientApplication
  async function _getToken() {
    return await graphDb._getAccessToken(true);
  }

  /**
   * 核心 fetch helper
   * - 412 → throw ConflictError（含 .code / .status 屬性）
   * - 其他 4xx/5xx → throw Error（含 .status）
   */
  async function _req(method, url, { body, etag, needPrefer } = {}) {
    const token = await _getToken();
    const headers = { 'Authorization': `Bearer ${token}` };

    if (body      !== undefined) headers['Content-Type'] = 'application/json';
    if (etag)                    headers['If-Match']     = etag;
    if (needPrefer)              headers['Prefer']       = 'HonorNonIndexedQueriesWarningMayFailRandomly';

    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);

    // SharePoint 對格式正確但過時的 etag 回 412；對完全無效的 etag 字串回 409
    // 兩者都視為並行衝突，throw ConflictError
    if (resp.status === 412 || resp.status === 409) {
      let code = 'resourceModified';
      try { code = (await resp.json()).error?.code ?? code; } catch {}
      const e = new ConflictError('資料已被他人更新，請重新整理後再試');
      e.code   = code;
      e.status = resp.status;
      throw e;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const e = new Error(`[graphListsDb] ${method} → ${resp.status} ${resp.statusText} — ${text}`);
      e.status = resp.status;
      throw e;
    }

    return resp;
  }

  /* ── 統一 return shape helper ─────────────────────────────────
   * 所有 CRUD 回傳帶 spItemId + etag（供後續 update/delete 用），
   * 加上 data（fromListFields 還原的 JSON 形狀）。
   * 若 PATCH 回 204 No Content，data 為 null。
   */
  function _wrapResult(raw) {
    return {
      spItemId: raw.id,
      etag:     raw['@odata.etag'] ?? null,
      data:     raw.fields ? fromListFields(raw.fields) : null,
    };
  }

  const graphListsDb = {

    /* ── 公開轉換函式（供 Phase 2 caller 直接測試）─────────────── */
    toListFields,
    fromListFields,

    feedback: {
      /**
       * 新增 feedback item
       * @param {object} jsonItem  - JSON 形狀物件（含 id 欄位作為 FeedbackId）
       * @returns {{ spItemId, etag, data }}
       *   spItemId = SharePoint 數字 item ID（後續 update/delete 用）
       *   etag     = @odata.etag（optimistic concurrency 用）
       *   data     = fromListFields 還原的 JSON 形狀
       */
      async add(jsonItem) {
        const resp = await _req('POST', `${_BASE_URL}/items`, {
          body: { fields: toListFields(jsonItem) }
        });
        const raw = await resp.json();
        // POST 回傳不含 $expand=fields，再 GET 一次取 fromListFields 結果
        const got = await graphListsDb.feedback.get(raw.id);
        return { spItemId: raw.id, etag: got.etag, data: got.data };
      },

      /**
       * 讀取單一 item
       * @param {string} spItemId  - SharePoint 數字 item ID
       * @returns {{ spItemId, etag, data }}
       */
      async get(spItemId) {
        const resp = await _req(
          'GET',
          `${_BASE_URL}/items/${encodeURIComponent(spItemId)}?$expand=fields`
        );
        const raw = await resp.json();
        return _wrapResult(raw);
      },

      /**
       * 列出 feedback items，可選 filter
       * @param {object} filterObj  - 使用 List internal name（PascalCase）
       *   indexed columns（Status/Type/Tab/Priority/CreatedAt）直接查
       *   其他 columns 自動加 Prefer header
       * @returns {Array<{ spItemId, etag, data }>}
       */
      async list(filterObj = {}) {
        const entries = Object.entries(filterObj);
        let filterStr  = '';
        let needPrefer = false;

        if (entries.length > 0) {
          const parts = entries.map(([k, v]) => {
            if (!_INDEXED_COLS.has(k)) needPrefer = true;
            const escaped = String(v).replace(/'/g, "''");
            return `fields/${k} eq '${escaped}'`;
          });
          filterStr = parts.join(' and ');
        }

        let url = `${_BASE_URL}/items?$expand=fields`;
        if (filterStr) url += `&$filter=${encodeURIComponent(filterStr)}`;

        const resp = await _req('GET', url, { needPrefer });
        const data = await resp.json();
        const mapped = (data.value ?? []).map(_wrapResult);
        if (mapped.length >= 200) {
          console.warn('[graphListsDb] feedback 達 200 筆上限，可能被截斷，需實作分頁');
        }
        return mapped;
      },

      /**
       * 更新 item（partial update）
       * ⚠️  endpoint 用 PATCH /items/{id} + { fields: {...} } wrapper
       *     不用 /items/{id}/fields 扁平 body（此 tenant 實測 400）
       * @param {string} spItemId   - SharePoint 數字 item ID
       * @param {object} jsonFields - JSON 形狀的 partial 物件（toListFields 自動跳過 undefined key）
       * @param {string} etag       - 從前次 get/add 取得；不符合 → throw ConflictError
       * @returns {{ spItemId, etag, data }}  data 為 null 若 PATCH 回 204
       */
      async update(spItemId, jsonFields, etag) {
        const resp = await _req(
          'PATCH',
          `${_BASE_URL}/items/${encodeURIComponent(spItemId)}`,
          { body: { fields: toListFields(jsonFields) }, etag }
        );
        if (resp.status === 204) return { spItemId, etag: null, data: null };
        const raw = await resp.json();
        return _wrapResult(raw);
      },

      /**
       * 刪除 item
       * @param {string} spItemId  - SharePoint 數字 item ID
       * @param {string} etag      - 不符合 → throw ConflictError
       */
      async delete(spItemId, etag) {
        await _req(
          'DELETE',
          `${_BASE_URL}/items/${encodeURIComponent(spItemId)}`,
          { etag }
        );
      }
    },

    /* ── 開發用 smoke test（正式流程不呼叫）─────────────────────── */
    /**
     * 執行方式：在 browser console 輸入 graphListsDb.__smokeTest()
     *
     * 6 步驟：
     *   1. add（JSON key）
     *   2. get（spItemId）
     *   3. list（Status filter）
     *   4. 412 ConflictError assertion（故意用錯 etag）
     *   5. update（partial, JSON key）
     *   6. delete
     * 全部成功後無殘留資料。若中途失敗印出需手動清除的 spItemId。
     */
    async __smokeTest() {
      console.group('[graphListsDb __smokeTest]');
      let spItemId = null;
      let etag     = null;

      try {
        // ── Step 1: ADD ──────────────────────────────────────────
        console.log('1/6  add (JSON keys)...');
        const ts    = new Date().toISOString();
        const added = await graphListsDb.feedback.add({
          id:               `SMOKE-${Date.now()}`,
          type:             'Bug',
          tab:              '整體工具',
          title:            'Milestone 2 smoke test',
          priority:         '低',
          reporter:         'smoke-test',
          contact:          'smoke@test.local',
          description:      'Auto smoke test — will be deleted',
          current_behavior: '',
          expected_behavior:'',
          attachments:      [],
          note:             '',
          admin_note:       '',
          status:           '待處理',
          closed_at:        '',
          created_at:       ts,
          updated_at:       ts,
        });
        spItemId = added.spItemId;
        etag     = added.etag;
        console.log('  ✅ add OK  spItemId=' + spItemId + '  id(FeedbackId)=' + added.data?.id);

        // ── Step 2: GET ──────────────────────────────────────────
        console.log('2/6  get...');
        const got = await graphListsDb.feedback.get(spItemId);
        console.log('  ✅ get OK  title=' + got.data?.title + '  closed_at="' + got.data?.closed_at + '"');

        // ── Step 3: LIST（Status filter，indexed column）────────
        console.log('3/6  list(Status=待處理)...');
        const items = await graphListsDb.feedback.list({ Status: '待處理' });
        console.log(`  ✅ list OK  ${items.length} item(s)  data[0] keys: ${items[0] ? Object.keys(items[0].data).join(',') : 'n/a'}`);

        // ── Step 4: 412 ConflictError assertion ──────────────────
        console.log('4/6  412 ConflictError (stale etag)...');
        try {
          await graphListsDb.feedback.update(spItemId, { title: 'SHOULD_NOT_SAVE' }, 'INVALID_ETAG');
          console.error('  ❌ 應該 throw ConflictError 但沒 throw');
        } catch (e) {
          if (e instanceof ConflictError) {
            console.log('  ✅ ConflictError instanceof OK  code=' + e.code + '  status=' + e.status);
          } else {
            console.error('  ❌ throw 了但不是 ConflictError，型別:', e.constructor.name, e);
          }
        }

        // ── Step 5: UPDATE（partial, JSON key）──────────────────
        console.log('5/6  update (partial: title only)...');
        const updated = await graphListsDb.feedback.update(
          spItemId,
          { title: 'Smoke test UPDATED', updated_at: new Date().toISOString() },
          etag
        );
        etag = updated.etag ?? etag;
        console.log('  ✅ update OK  new etag=' + etag);

        // ── Step 6: DELETE ───────────────────────────────────────
        console.log('6/6  delete...');
        await graphListsDb.feedback.delete(spItemId, etag);
        console.log('  ✅ delete OK  (no residual data)');

        console.log('🎉 All 6 steps PASSED');
      } catch (e) {
        console.error('❌ Smoke test FAILED:', e);
        if (spItemId) {
          console.warn(
            '⚠️  Cleanup needed — please DELETE this item manually via Graph Explorer:\n' +
            `    DELETE ${_BASE_URL}/items/${spItemId}\n` +
            '    (or re-run smoke test; it will create a new item)'
          );
        }
      }

      console.groupEnd();
    },

    /* ── Round-trip 驗證 helper（Milestone 2 驗收用）───────────────
     * 用法：graphListsDb.__roundTripTest(baselineJsonItem, feedbackId)
     *
     * 流程：
     *   1. toListFields(jsonItem)  →  檢查 key 數量 / 型別
     *   2. POST 新筆（不覆蓋 baseline）
     *   3. GET 回來 → fromListFields
     *   4. 比對 JSON vs round-trip，列出 lossy（dateTime 毫秒）vs 真正 diff
     *   5. 刪除 step 2 建立的 test item
     *
     * @param {object} jsonItem   - 從 dbAdapter 拿到的 feedback_items[id] 整筆
     * @param {string} feedbackId - 例如 'FB-20260508-113328-DYUP'
     */
    async __roundTripTest(jsonItem, feedbackId) {
      console.group(`[graphListsDb round-trip test]  feedbackId=${feedbackId}`);
      let spItemId = null;
      let etag     = null;

      // 已知 lossy 欄位（dateTime 毫秒會被截掉）
      const LOSSY_KEYS = new Set(['created_at', 'updated_at', 'closed_at']);

      try {
        // Step 1: toListFields 檢查
        const listFields = toListFields({ ...jsonItem, id: feedbackId });
        console.log('1/4  toListFields OK, keys:', Object.keys(listFields).join(', '));

        // Step 2: POST
        console.log('2/4  POST...');
        const added = await graphListsDb.feedback.add({ ...jsonItem, id: feedbackId + '-RT-TEST' });
        spItemId = added.spItemId;
        etag     = added.etag;
        console.log('  spItemId=' + spItemId);

        // Step 3: GET → fromListFields
        console.log('3/4  GET → fromListFields...');
        const got = await graphListsDb.feedback.get(spItemId);
        const rt  = got.data;

        // Step 4: 比對
        console.log('4/4  比對...');
        let hasTrueDiff = false;
        for (const k of Object.keys(jsonItem)) {
          const orig = jsonItem[k];
          const back = rt[k];
          const origS = JSON.stringify(orig);
          const backS = JSON.stringify(back);

          if (origS === backS) {
            // 完全一致
          } else if (LOSSY_KEYS.has(k)) {
            // dateTime 毫秒 lossy：去毫秒後再比
            const truncOrig = typeof orig === 'string' ? orig.replace(/\.\d{3}Z$/, 'Z') : orig;
            const truncBack = typeof back === 'string' ? back.replace(/\.\d{3}Z$/, 'Z') : back;
            if (JSON.stringify(truncOrig) === JSON.stringify(truncBack)) {
              console.log(`  ⚠️  ${k}: lossy (毫秒截斷)  orig="${orig}"  rt="${back}"`);
            } else {
              console.error(`  ❌ ${k}: UNEXPECTED DIFF  orig=${origS}  rt=${backS}`);
              hasTrueDiff = true;
            }
          } else if (k === 'attachments') {
            // attachments：orig 可能是 undefined（JSON inner object 無此 key）
            // fromListFields 一律回 []，所以 undefined/null/[] 都視為「空附件」一致
            const origArr = Array.isArray(orig) ? orig : [];
            const backArr = Array.isArray(back) ? back : [];
            if (JSON.stringify(origArr) === JSON.stringify(backArr)) {
              // ok
            } else {
              console.error(`  ❌ ${k}: attachments diff  orig=${JSON.stringify(origArr)}  rt=${JSON.stringify(backArr)}`);
              hasTrueDiff = true;
            }
          } else {
            console.error(`  ❌ ${k}: UNEXPECTED DIFF  orig=${origS}  rt=${backS}`);
            hasTrueDiff = true;
          }
        }

        if (!hasTrueDiff) console.log('  ✅ Round-trip PASSED（僅已知 lossy 差異）');
        else console.error('  ❌ Round-trip FAILED（有不預期的 diff）');

        // 刪除 test item
        await graphListsDb.feedback.delete(spItemId, etag);
        console.log('  test item 已刪除');

      } catch (e) {
        console.error('❌ round-trip test FAILED:', e);
        if (spItemId) {
          console.warn('⚠️  Cleanup needed — spItemId=' + spItemId);
        }
      }

      console.groupEnd();
    }
  };

  window.graphListsDb = graphListsDb;
})();
