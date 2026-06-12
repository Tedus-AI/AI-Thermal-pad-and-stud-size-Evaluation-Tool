(function () {
  /* ---- Constants ---- */
  const FUNCTIONS = ['TH/ME', 'EE', 'RF'];

  /* ---- Module state ---- */
  let _siteId       = null;
  let _listId       = null;
  let _membersCache = {};
  let _isModalOpen  = false;

  /* ---- Utils ---- */
  function getCurrentProjectId() {
    for (const sel of ['#project-select', '#vd-project-select', '#sg-project-select']) {
      const el = document.querySelector(sel);
      if (el && el.value) return el.value;
    }
    return null;
  }

  function _getSelectedAction() {
    const sel = document.getElementById('tc-action-select');
    return sel ? sel.value : '';
  }

  function _buildPreviewText(name, projectId) {
    return `Hi ${name}，\n${projectId} ${_getSelectedAction()}\n${window.location.href}`;
  }

  function _refreshPreview(name) {
    const previewEl  = document.getElementById('tc-msg-preview');
    const projectId  = document.getElementById('tc-project-title');
    if (previewEl && projectId && projectId.textContent) {
      previewEl.value = _buildPreviewText(name, projectId.textContent);
    }
  }

  /* ---- Graph API helpers ---- */
  async function _getSiteId() {
    if (_siteId) return _siteId;
    const resp = await graphDb._graphGet(
      `https://graph.microsoft.com/v1.0/sites/${SHAREPOINT_CONFIG.siteHostname}:${SHAREPOINT_CONFIG.sitePath}`
    );
    const data = await resp.json();
    _siteId = data.id;
    return _siteId;
  }

  async function _getListId() {
    if (_listId) return _listId;
    const siteId = await _getSiteId();
    const resp = await graphDb._graphGet(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists?$filter=displayName eq 'Project_Members'`
    );
    const data = await resp.json();
    if (!data.value || !data.value.length) {
      const err = new Error('Project_Members 清單未建立');
      err.code = 'LIST_NOT_FOUND';
      throw err;
    }
    _listId = data.value[0].id;
    return _listId;
  }

  async function fetchMembers(projectId) {
    if (_membersCache[projectId]) return _membersCache[projectId];

    const siteId = await _getSiteId();
    const listId = await _getListId();
    const filter = encodeURIComponent(`fields/Title eq '${projectId}'`);
    const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?$expand=fields&$filter=${filter}`;

    const token = await graphDb._getAccessToken();
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Prefer': 'HonorNonIndexedQueriesWarningMayFailRandomly'
      }
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(`Graph API 錯誤：${resp.status}`);
      err.status = resp.status;
      err.body = text;
      throw err;
    }

    const data = await resp.json();
    const members = (data.value || [])
      .filter(item => item.fields.IsActive !== false)
      .map(item => ({
        name:  item.fields.MemberName,
        email: item.fields.MemberEmail,
        func:  item.fields.Function || 'TH/ME',
      }));

    _membersCache[projectId] = members;
    return members;
  }

  function invalidateCache() {
    _membersCache = {};
  }

  function groupByFunction(members) {
    const groups = {};
    FUNCTIONS.forEach(f => { groups[f] = []; });
    members.forEach(m => {
      if (!(m.func in groups)) groups[m.func] = [];
      groups[m.func].push(m);
    });
    return groups;
  }

  /* ---- Teams deep link ---- */
  function openTeamsChat(email, message) {
    const url = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}&message=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  }

  /* ---- UI helpers ---- */
  function _setLoading(on) {
    const spinner = document.getElementById('tc-spinner');
    if (spinner) spinner.style.display = on ? 'flex' : 'none';
  }

  /* HTML 逸出（& < > " ' 五字元）：成員名單來自 SharePoint List（多人可編輯），
     插入 innerHTML 前一律過這層 */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _showError(msg) {
    const body = document.getElementById('tc-modal-body');
    if (body) body.innerHTML = `<div class="tc-empty">${_esc(msg)}</div>`;
    const tabs = document.getElementById('tc-tabs');
    if (tabs) tabs.innerHTML = '';
  }

  function _buildMemberCard(member, projectId) {
    const card = document.createElement('div');
    card.className = 'tc-member-card';
    card.innerHTML = `
      <div class="tc-member-info">
        <span class="tc-member-name">\u{1F464} ${_esc(member.name)}</span>
        <span class="tc-member-email">${_esc(member.email)}</span>
      </div>
      <button class="tc-send-btn" type="button">\u{1F4E8} 傳訊息</button>
    `;

    // Hover → fill this member's name into preview
    card.addEventListener('mouseenter', () => _refreshPreview(member.name));

    // Send → substitute [Name] with actual name (covers case where user didn't hover)
    card.querySelector('.tc-send-btn').addEventListener('click', () => {
      const previewEl = document.getElementById('tc-msg-preview');
      let msg = previewEl ? previewEl.value : _buildPreviewText(member.name, projectId);
      msg = msg.replace(/\[Name\]/g, member.name);
      openTeamsChat(member.email, msg);
    });

    return card;
  }

  function _renderTab(tab, groups, projectId) {
    const body = document.getElementById('tc-modal-body');
    if (!body) return;

    body.innerHTML = '';
    const members = groups[tab] || [];

    if (!members.length) {
      body.innerHTML = '<div class="tc-empty">此分類目前無成員</div>';
    } else {
      members.forEach(m => body.appendChild(_buildMemberCard(m, projectId)));
    }

    _refreshPreview('[Name]');

    document.querySelectorAll('.tc-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.func === tab);
    });
  }

  function _renderModal(projectId, members) {
    const groups = groupByFunction(members);

    const titleEl = document.getElementById('tc-project-title');
    if (titleEl) titleEl.textContent = projectId;

    const tabsEl = document.getElementById('tc-tabs');
    if (tabsEl) {
      tabsEl.innerHTML = '';
      FUNCTIONS.forEach(f => {
        const count = (groups[f] || []).length;
        const btn = document.createElement('button');
        btn.className = 'tc-tab-btn' + (count === 0 ? ' tc-tab-empty' : '');
        btn.dataset.func = f;
        btn.type = 'button';
        btn.textContent = count ? `${f} (${count})` : f;
        if (count > 0) {
          btn.addEventListener('click', () => _renderTab(f, groups, projectId));
        }
        tabsEl.appendChild(btn);
      });
    }

    const firstWithData = FUNCTIONS.find(f => (groups[f] || []).length > 0) || FUNCTIONS[0];
    _renderTab(firstWithData, groups, projectId);
  }

  /* ---- Modal open / close ---- */
  async function openModal() {
    if (!graphDb.isSignedIn()) {
      alert('請先登入 Azure AD 後再使用此功能');
      return;
    }

    const projectId = getCurrentProjectId();
    if (!projectId) {
      alert('請先選擇一個專案');
      return;
    }

    const overlay = document.getElementById('tc-modal-overlay');
    if (!overlay) return;

    overlay.classList.add('active');
    _isModalOpen = true;
    _setLoading(true);

    const titleEl = document.getElementById('tc-project-title');
    if (titleEl) titleEl.textContent = projectId;
    const body = document.getElementById('tc-modal-body');
    if (body) body.innerHTML = '';
    const tabs = document.getElementById('tc-tabs');
    if (tabs) tabs.innerHTML = '';

    try {
      const members = await fetchMembers(projectId);
      if (!members.length) {
        _showError('該專案尚未維護成員名單，請聯絡 PM');
        const previewEl = document.getElementById('tc-msg-preview');
        if (previewEl) previewEl.value = '';
      } else {
        _renderModal(projectId, members);
      }
    } catch (err) {
      console.error('[teamsContact] fetchMembers failed:', err);
      let msg = '網路錯誤，請稍後重試';
      if (err.status === 401) msg = 'Token 已過期，請重新整理頁面後再試';
      if (err.status === 403) msg = '請聯絡管理員確認 Sites.Read.All 權限';
      if (err.code === 'LIST_NOT_FOUND') msg = 'Project_Members 清單未建立，請聯絡 IT';
      _showError(msg);
    } finally {
      _setLoading(false);
    }
  }

  function closeModal() {
    const overlay = document.getElementById('tc-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    _isModalOpen = false;
  }

  /* ---- Init ---- */
  function init() {
    const fab = document.getElementById('tc-fab');
    if (fab) fab.addEventListener('click', openModal);

    const closeBtn = document.getElementById('tc-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const overlay = document.getElementById('tc-modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) closeModal();
      });
    }

    // Dropdown change → refresh preview (keeps current [Name] placeholder)
    const actionSelect = document.getElementById('tc-action-select');
    if (actionSelect) {
      actionSelect.addEventListener('change', () => _refreshPreview('[Name]'));
    }

    // Invalidate member cache + refresh modal when project selection changes
    ['#project-select', '#vd-project-select', '#sg-project-select'].forEach(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.addEventListener('change', e => {
        invalidateCache();
        if (_isModalOpen && e.target.value) {
          _setLoading(true);
          fetchMembers(e.target.value)
            .then(members => {
              if (!members.length) {
                const titleEl = document.getElementById('tc-project-title');
                if (titleEl) titleEl.textContent = e.target.value;
                _showError('該專案尚未維護成員名單，請聯絡 PM');
              } else {
                _renderModal(e.target.value, members);
              }
            })
            .catch(err => {
              console.error('[teamsContact] refetch failed:', err);
              _showError('重新載入失敗，請關閉後重試');
            })
            .finally(() => _setLoading(false));
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.teamsContact = { openModal, closeModal, invalidateCache };
})();
