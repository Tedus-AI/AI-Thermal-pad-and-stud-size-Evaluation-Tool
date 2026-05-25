(function () {
  /* graphListsDb.js — Feedback List CRUD（Phase 1 / Milestone 1）
   *
   * 依賴（必須在本檔案之前載入）：
   *   window.ConflictError   — fileDb.js 定義
   *   window.graphDb         — graphDb.js 定義（重用 MSAL token 邏輯）
   *   window.SHAREPOINT_CONFIG — config.js 定義
   *
   * Milestone 1 暫用 identity field mapping：
   *   add / update 的 fields 參數直接帶 List internal name KV 物件。
   *   Milestone 2 再加 toListFields / fromListFields 轉換層。
   */

  const _SITE_ID  = 'deltao365.sharepoint.com,7c5179cc-7bcc-42f3-928f-aeaaeb860787,f30d898c-bf60-4d5e-a6b3-306e3ea83cce';
  const _LIST_ID  = 'f916276f-d0ac-45fd-90f0-c9be2e7938e6';
  const _BASE_URL = `https://graph.microsoft.com/v1.0/sites/${_SITE_ID}/lists/${_LIST_ID}`;

  // 已建索引的 5 個 columns — $filter 不需 Prefer header
  const _INDEXED_COLS = new Set(['Status', 'Type', 'Tab', 'Priority', 'CreatedAt']);

  // 重用 graphDb 的 MSAL instance 取 token，不另起一個 PublicClientApplication
  async function _getToken() {
    return await graphDb._getAccessToken(true);
  }

  /**
   * 核心 fetch helper
   * - 統一加 Authorization / Content-Type / If-Match / Prefer header
   * - 412 → throw ConflictError（讓 caller 區分並行衝突 vs 其他錯誤）
   * - 其他 4xx/5xx → throw Error（含 status 屬性）
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

    if (resp.status === 412) {
      let code = 'resourceModified';
      try { code = (await resp.json()).error?.code ?? code; } catch {}
      const e = new ConflictError('資料已被他人更新，請重新整理後再試');
      e.code   = code;
      e.status = 412;
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

  const graphListsDb = {
    feedback: {
      /**
       * 新增 feedback item
       * @param {object} fields  - List internal name KV 物件（Milestone 1 identity mapping）
       * @returns {{ id: string, etag: string, raw: object }}
       *   id   = SharePoint 數字 item ID（後續 update/delete 用）
       *   etag = @odata.etag 字串（用於 If-Match）
       */
      async add(fields) {
        const resp = await _req('POST', `${_BASE_URL}/items`, { body: { fields } });
        const raw  = await resp.json();
        return { id: raw.id, etag: raw['@odata.etag'] ?? null, raw };
      },

      /**
       * 讀取單一 item
       * @param {string} itemId  - SharePoint 數字 item ID（不是 FeedbackId FB-...）
       * @returns {object}  raw Graph response，含 fields 子物件
       */
      async get(itemId) {
        const resp = await _req(
          'GET',
          `${_BASE_URL}/items/${encodeURIComponent(itemId)}?$expand=fields`
        );
        return await resp.json();
      },

      /**
       * 列出 feedback items，可選 filter
       * @param {object} filterObj  - { InternalFieldName: value }，全部 AND-joined eq 比較
       *   - indexed columns（Status/Type/Tab/Priority/CreatedAt）直接查
       *   - 其他 columns 自動加 Prefer header（HonorNonIndexedQueriesWarningMayFailRandomly）
       * @returns {object[]}  raw Graph item array
       */
      async list(filterObj = {}) {
        const entries = Object.entries(filterObj);
        let filterStr  = '';
        let needPrefer = false;

        if (entries.length > 0) {
          const parts = entries.map(([k, v]) => {
            if (!_INDEXED_COLS.has(k)) needPrefer = true;
            // OData 單引號跳脫規則：' → ''
            const escaped = String(v).replace(/'/g, "''");
            return `fields/${k} eq '${escaped}'`;
          });
          filterStr = parts.join(' and ');
        }

        let url = `${_BASE_URL}/items?$expand=fields`;
        if (filterStr) url += `&$filter=${encodeURIComponent(filterStr)}`;

        const resp = await _req('GET', url, { needPrefer });
        const data = await resp.json();
        return data.value ?? [];
      },

      /**
       * 更新 item（partial update）
       * ⚠️  endpoint 用 PATCH /items/{id} + { fields: {...} } wrapper
       *     不用 /items/{id}/fields 扁平 body（此 tenant 實測 400）
       * @param {string} itemId  - SharePoint 數字 item ID
       * @param {object} fields  - 只傳需要改的欄位
       * @param {string} etag    - 從前次 get/add 拿到的 @odata.etag（用於 optimistic concurrency）
       * @returns {{ id: string, etag: string|null, raw: object|null }}
       */
      async update(itemId, fields, etag) {
        const resp = await _req(
          'PATCH',
          `${_BASE_URL}/items/${encodeURIComponent(itemId)}`,
          { body: { fields }, etag }
        );
        // 部分實作回 204 No Content；graceful fallback
        if (resp.status === 204) return { id: itemId, etag: null, raw: null };
        const raw = await resp.json();
        return { id: raw.id, etag: raw['@odata.etag'] ?? null, raw };
      },

      /**
       * 刪除 item
       * @param {string} itemId  - SharePoint 數字 item ID
       * @param {string} etag    - 從前次 get/add 拿到的 @odata.etag
       */
      async delete(itemId, etag) {
        await _req(
          'DELETE',
          `${_BASE_URL}/items/${encodeURIComponent(itemId)}`,
          { etag }
        );
      }
    },

    /* ── 開發用 smoke test（正式流程不呼叫）─────────────────────── */
    /**
     * 執行方式：在 browser console 輸入 graphListsDb.__smokeTest()
     * 或在 DevTools Snippets 貼入本檔後執行 graphListsDb.__smokeTest()
     *
     * 自動新增一筆 → GET → LIST(filter) → UPDATE → DELETE
     * 全部成功後不留殘留資料。若中途失敗會印出需要手動清除的 item id。
     */
    async __smokeTest() {
      console.group('[graphListsDb __smokeTest]');
      let addedId = null;
      let etag    = null;

      try {
        // Step 1: ADD
        console.log('1/5  add...');
        const ts    = new Date().toISOString();
        const added = await graphListsDb.feedback.add({
          Title:           `SMOKE-${Date.now()}`,
          FbTitle:         'Milestone 1 smoke test',
          Type:            'Bug',
          Tab:             '整體工具',
          Priority:        '低',
          Reporter:        'smoke-test',
          Contact:         'smoke@test.local',
          Description:     'Auto smoke test — will be deleted',
          Status:          '待處理',
          CreatedAt:       ts,
          UpdatedAt:       ts
        });
        addedId = added.id;
        etag    = added.etag;
        console.log('  ✅ add OK  id=' + addedId + '  etag=' + etag);

        // Step 2: GET
        console.log('2/5  get...');
        const got = await graphListsDb.feedback.get(addedId);
        console.log('  ✅ get OK  Title=' + got.fields?.Title);

        // Step 3: LIST（Status filter，indexed column）
        console.log('3/5  list(Status=待處理)...');
        const items = await graphListsDb.feedback.list({ Status: '待處理' });
        console.log(`  ✅ list OK  ${items.length} item(s) returned`);

        // Step 4: UPDATE
        console.log('4/5  update...');
        const updated = await graphListsDb.feedback.update(
          addedId,
          { FbTitle: 'Smoke test UPDATED' },
          etag
        );
        etag = updated.etag ?? etag;
        console.log('  ✅ update OK  new etag=' + etag);

        // Step 5: DELETE
        console.log('5/5  delete...');
        await graphListsDb.feedback.delete(addedId, etag);
        console.log('  ✅ delete OK  (no residual data)');

        console.log('🎉 All 5 steps PASSED');
      } catch (e) {
        console.error('❌ Smoke test FAILED:', e);
        if (addedId) {
          console.warn(
            '⚠️  Cleanup needed — please DELETE this item manually via Graph Explorer:\n' +
            `    DELETE ${_BASE_URL}/items/${addedId}\n` +
            '    (or re-run smoke test; it will still create a new item)'
          );
        }
      }

      console.groupEnd();
    }
  };

  window.graphListsDb = graphListsDb;
})();
