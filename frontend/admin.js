// Admin panel — client link generator, per-client facts summary, and the
// project "card" (archive flag, client identity, speaker profile, socials)
// used for search later. See backend /api/projects, /api/projects/:id/regenerate-link,
// /api/admin/projects/:id/settings.

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const summaryEl = document.getElementById('summary');
const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const tableWrap = document.getElementById('tableWrap');
const rowsEl = document.getElementById('rows');
const empty = document.getElementById('empty');
const toast = document.getElementById('toast');

const settingsModalOverlay = document.getElementById('settingsModalOverlay');
const settingsModalTitle = document.getElementById('settingsModalTitle');
const setArchived = document.getElementById('setArchived');
const setNameRu = document.getElementById('setNameRu');
const setNameEn = document.getElementById('setNameEn');
const setCeo = document.getElementById('setCeo');
const setWebsite = document.getElementById('setWebsite');
const setSpeaker = document.getElementById('setSpeaker');
const setOther = document.getElementById('setOther');
const socialRowsEl = document.getElementById('socialRows');
const addSocialRow = document.getElementById('addSocialRow');
const settingsCancelBtn = document.getElementById('settingsCancelBtn');
const settingsSaveBtn = document.getElementById('settingsSaveBtn');

const adminTabBar = document.getElementById('adminTabBar');
const panelProjects = document.getElementById('panelProjects');
const panelAcl = document.getElementById('panelAcl');
const aclLoading = document.getElementById('aclLoading');
const aclErrorBox = document.getElementById('aclErrorBox');
const aclTableWrap = document.getElementById('aclTableWrap');
const aclRowsEl = document.getElementById('aclRows');
const aclEmpty = document.getElementById('aclEmpty');
const accessModalOverlay = document.getElementById('accessModalOverlay');
const accessModalTitle = document.getElementById('accessModalTitle');
const accessProjectList = document.getElementById('accessProjectList');
const accessCancelBtn = document.getElementById('accessCancelBtn');
const accessSaveBtn = document.getElementById('accessSaveBtn');

let currentProjects = [];
let settingsProjectId = null;
let currentAccess = null; // { admin, canManageProjects, canManageAcl } — from /api/team/me
let aclUsers = [];
let aclProjects = [];
let accessModalUserId = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

function formatReach(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function absUrl(link) {
  if (/^https?:\/\//i.test(link) || /^\/\//.test(link)) return link;
  return window.location.origin + link;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) {}
    ta.remove();
    return ok;
  }
}

function rowHtml(p) {
  const url = absUrl(p.link);
  return `
    <tr class="${p.archived ? 'row-archived' : ''}">
      <td><b>${esc(p.label)}</b>${p.archived ? '<span class="badge-archived">архив</span>' : ''}</td>
      <td class="num">${p.factsCount}</td>
      <td class="num">${p.publishedCount}</td>
      <td class="num">${formatReach(p.reachSum)}</td>
      <td>
        <div class="link-cell">
          ${p.token
            ? `<a href="${esc(url)}" target="_blank" rel="noopener"><code>${esc(url)}</code></a>
               <button type="button" class="mini-btn copy-btn" data-url="${esc(url)}">Копировать</button>`
            : '<span class="hint">Ссылка не создана</span>'}
        </div>
      </td>
      <td style="text-align:right;white-space:nowrap">
        <button type="button" class="icon-btn settings-btn" data-project="${esc(p.projectId)}" title="Карточка клиента">⚙ Карточка</button>
        <button type="button" class="icon-btn regen-btn" data-project="${esc(p.projectId)}">${p.token ? 'Пересоздать' : 'Создать'}</button>
      </td>
    </tr>
  `;
}

function render(data) {
  const projects = data.projects || [];
  currentProjects = projects;
  if (!projects.length) {
    empty.textContent = 'На борде пока нет проектов (клиентов).';
    empty.hidden = false;
    tableWrap.hidden = true;
    return;
  }
  rowsEl.innerHTML = projects.map(rowHtml).join('');
  tableWrap.hidden = false;
  empty.hidden = true;

  const active = projects.filter((p) => !p.archived);
  const factsTotal = active.reduce((a, p) => a + p.factsCount, 0);
  const publishedTotal = active.reduce((a, p) => a + p.publishedCount, 0);
  const reachTotal = active.reduce((a, p) => a + p.reachSum, 0);
  summaryEl.innerHTML = `
    <div class="reach-stat"><div class="reach-stat-label">Проектов</div><div class="reach-stat-value">${projects.length}${projects.length !== active.length ? ` <small>/ ${active.length} активных</small>` : ''}</div></div>
    <div class="reach-stat"><div class="reach-stat-label">Фактов всего</div><div class="reach-stat-value">${factsTotal}</div></div>
    <div class="reach-stat"><div class="reach-stat-label">Опубликовано</div><div class="reach-stat-value">${publishedTotal} <small>/ ${factsTotal}</small></div></div>
    <div class="reach-stat"><div class="reach-stat-label">Совокупный охват</div><div class="reach-stat-value">${formatReach(reachTotal)}</div></div>
  `;
  summaryEl.hidden = false;
}

async function load() {
  loading.hidden = false;
  errorBox.hidden = true;
  try {
    const res = await fetch('/api/projects');
    if (res.status === 401) {
      window.location.href = '/team';
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось загрузить проекты.');
    render(data);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    loading.hidden = true;
  }
}

rowsEl.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copy-btn');
  if (copyBtn) {
    const ok = await copyText(copyBtn.dataset.url);
    showToast(ok ? 'Ссылка скопирована.' : 'Не удалось скопировать.');
    return;
  }
  const settingsBtn = e.target.closest('.settings-btn');
  if (settingsBtn) {
    openSettings(settingsBtn.dataset.project);
    return;
  }
  const regen = e.target.closest('.regen-btn');
  if (!regen) return;
  const projectId = regen.dataset.project;
  const label = regen.textContent.replace('…', '');
  regen.disabled = true;
  regen.textContent = '…';
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/regenerate-link`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось пересоздать ссылку.');
    showToast('Ссылка обновлена.');
    load();
  } catch (err) {
    showToast(err.message);
  } finally {
    regen.disabled = false;
    regen.textContent = label;
  }
});

// --- Карточка клиента (модалка настроек проекта) ---

function socialRowHtml(platform, url) {
  return `
    <div class="social-row">
      <input class="field-input" type="text" placeholder="Платформа (VK, Telegram…)" value="${esc(platform || '')}" data-role="platform">
      <input class="field-input" type="text" placeholder="Ссылка" value="${esc(url || '')}" data-role="url">
      <button type="button" class="mini-btn remove-social" title="Удалить">✕</button>
    </div>
  `;
}

function renderSocialRows(list) {
  const rows = list && list.length ? list : [{ platform: '', url: '' }];
  socialRowsEl.innerHTML = rows.map((r) => socialRowHtml(r.platform, r.url)).join('');
}

function collectSocialRows() {
  return [...socialRowsEl.querySelectorAll('.social-row')]
    .map((row) => ({
      platform: row.querySelector('[data-role="platform"]').value.trim(),
      url: row.querySelector('[data-role="url"]').value.trim(),
    }))
    .filter((r) => r.platform || r.url);
}

socialRowsEl.addEventListener('click', (e) => {
  const rm = e.target.closest('.remove-social');
  if (!rm) return;
  const row = rm.closest('.social-row');
  if (socialRowsEl.children.length > 1) {
    row.remove();
  } else {
    row.querySelector('[data-role="platform"]').value = '';
    row.querySelector('[data-role="url"]').value = '';
  }
});

addSocialRow.addEventListener('click', () => {
  socialRowsEl.insertAdjacentHTML('beforeend', socialRowHtml('', ''));
});

async function openSettings(projectId) {
  const project = currentProjects.find((p) => p.projectId === projectId);
  settingsProjectId = projectId;
  settingsModalTitle.textContent = project ? `Карточка клиента · ${project.label}` : 'Карточка клиента';
  settingsModalOverlay.hidden = false;
  settingsSaveBtn.disabled = true;
  try {
    const res = await fetch(`/api/admin/projects/${encodeURIComponent(projectId)}/settings`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось загрузить карточку.');
    const s = data.settings || {};
    setArchived.checked = !!s.archived;
    setNameRu.value = s.clientNameRu || '';
    setNameEn.value = s.clientNameEn || '';
    setCeo.value = s.ceoName || '';
    setWebsite.value = s.website || '';
    setSpeaker.value = s.speakerProfile || '';
    setOther.value = s.otherInfo || '';
    renderSocialRows(s.socialLinks || []);
  } catch (err) {
    showToast(err.message);
    renderSocialRows([]);
  } finally {
    settingsSaveBtn.disabled = false;
  }
}

function closeSettings() {
  settingsModalOverlay.hidden = true;
  settingsProjectId = null;
}

settingsCancelBtn.addEventListener('click', closeSettings);
settingsModalOverlay.addEventListener('click', (e) => { if (e.target === settingsModalOverlay) closeSettings(); });

settingsSaveBtn.addEventListener('click', async () => {
  if (!settingsProjectId) return;
  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = 'Сохраняем…';
  try {
    const body = {
      archived: setArchived.checked,
      clientNameRu: setNameRu.value.trim(),
      clientNameEn: setNameEn.value.trim(),
      ceoName: setCeo.value.trim(),
      website: setWebsite.value.trim(),
      speakerProfile: setSpeaker.value.trim(),
      otherInfo: setOther.value.trim(),
      socialLinks: collectSocialRows(),
    };
    const res = await fetch(`/api/admin/projects/${encodeURIComponent(settingsProjectId)}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось сохранить.');
    showToast('Карточка сохранена.');
    closeSettings();
    load();
  } catch (err) {
    showToast(err.message);
  } finally {
    settingsSaveBtn.disabled = false;
    settingsSaveBtn.textContent = 'Сохранить';
  }
});

// --- ACL: кто из команды что настраивает и какие проекты видит ---

function setActiveAdminTab(tab) {
  [...adminTabBar.children].forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  panelProjects.hidden = tab !== 'projects';
  panelAcl.hidden = tab !== 'acl';
  if (tab === 'projects') load();
  else if (tab === 'acl') loadAcl();
}

adminTabBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn || btn.hidden) return;
  setActiveAdminTab(btn.dataset.tab);
});

function accessSummary(u) {
  if (u.superAdmin) return 'Все проекты (супер-админ)';
  if (!u.projectIds) return 'Все проекты';
  if (!u.projectIds.length) return 'Все проекты';
  return `Выбрано: ${u.projectIds.length} из ${aclProjects.length}`;
}

function aclRowHtml(u) {
  const disabled = u.superAdmin ? ' disabled title="Супер-админ задан переменными окружения — всегда все права и все проекты."' : '';
  return `
    <tr>
      <td><b>${esc(u.label)}</b>${u.superAdmin ? '<span class="badge-archived">супер-админ</span>' : ''}</td>
      <td><label class="check-row" style="margin:0"><input type="checkbox" class="acl-perm" data-user="${esc(u.id)}" data-perm="canManageProjects"${u.canManageProjects ? ' checked' : ''}${disabled}></label></td>
      <td><label class="check-row" style="margin:0"><input type="checkbox" class="acl-perm" data-user="${esc(u.id)}" data-perm="canManageAcl"${u.canManageAcl ? ' checked' : ''}${disabled}></label></td>
      <td>
        <div class="link-cell">
          <span class="hint">${esc(accessSummary(u))}</span>
          ${u.superAdmin ? '' : `<button type="button" class="mini-btn acl-access-btn" data-user="${esc(u.id)}">Настроить</button>`}
        </div>
      </td>
    </tr>`;
}

function renderAcl() {
  if (!aclUsers.length) {
    aclEmpty.textContent = 'В команде пока никого нет.';
    aclEmpty.hidden = false;
    aclTableWrap.hidden = true;
    return;
  }
  aclEmpty.hidden = true;
  aclTableWrap.hidden = false;
  aclRowsEl.innerHTML = aclUsers.map(aclRowHtml).join('');
}

async function loadAcl() {
  aclLoading.hidden = false;
  aclErrorBox.hidden = true;
  aclTableWrap.hidden = true;
  aclEmpty.hidden = true;
  try {
    const res = await fetch('/api/admin/acl');
    if (res.status === 401) { window.location.href = '/team'; return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось загрузить список команды.');
    aclUsers = data.users || [];
    aclProjects = data.projects || [];
    renderAcl();
  } catch (err) {
    aclErrorBox.textContent = err.message;
    aclErrorBox.hidden = false;
  } finally {
    aclLoading.hidden = true;
  }
}

aclRowsEl.addEventListener('change', async (e) => {
  const cb = e.target.closest('.acl-perm');
  if (!cb) return;
  const userId = cb.dataset.user;
  const user = aclUsers.find((u) => u.id === userId);
  if (!user) return;
  const perm = cb.dataset.perm; // 'canManageProjects' | 'canManageAcl'
  const next = { canManageProjects: user.canManageProjects, canManageAcl: user.canManageAcl, [perm]: cb.checked };
  cb.disabled = true;
  try {
    const res = await fetch(`/api/admin/acl/${encodeURIComponent(userId)}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось сохранить.');
    user.canManageProjects = next.canManageProjects;
    user.canManageAcl = next.canManageAcl;
    showToast('Сохранено.');
  } catch (err) {
    cb.checked = !cb.checked;
    showToast(err.message);
  } finally {
    cb.disabled = false;
  }
});

aclRowsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.acl-access-btn');
  if (!btn) return;
  openAccessModal(btn.dataset.user);
});

function openAccessModal(userId) {
  const user = aclUsers.find((u) => u.id === userId);
  if (!user) return;
  accessModalUserId = userId;
  accessModalTitle.textContent = `Доступ к проектам · ${user.label}`;
  const selected = new Set(user.projectIds || []);
  accessProjectList.innerHTML = aclProjects
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
    .map((p) => `<label class="status-filter-item"><input type="checkbox" data-project="${esc(p.id)}"${selected.has(p.id) ? ' checked' : ''}><span>${esc(p.label)}</span></label>`)
    .join('');
  accessModalOverlay.hidden = false;
}

function closeAccessModal() {
  accessModalOverlay.hidden = true;
  accessModalUserId = null;
}

accessCancelBtn.addEventListener('click', closeAccessModal);
accessModalOverlay.addEventListener('click', (e) => { if (e.target === accessModalOverlay) closeAccessModal(); });

accessSaveBtn.addEventListener('click', async () => {
  if (!accessModalUserId) return;
  const projectIds = [...accessProjectList.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.dataset.project);
  accessSaveBtn.disabled = true;
  try {
    const res = await fetch(`/api/admin/acl/${encodeURIComponent(accessModalUserId)}/access`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось сохранить.');
    showToast('Доступ сохранён.');
    closeAccessModal();
    await loadAcl();
  } catch (err) {
    showToast(err.message);
  } finally {
    accessSaveBtn.disabled = false;
  }
});

// --- Инициализация: какие вкладки показывать зависит от прав сотрудника ---

async function initAdmin() {
  let access = {};
  try {
    const res = await fetch('/api/team/me');
    if (res.status === 401) { window.location.href = '/team'; return; }
    const data = await res.json();
    access = data.access || {};
  } catch (err) {
    // A transient /me failure shouldn't blank the whole page — fall back to
    // showing the projects tab, the more common privilege of the two.
    access = { canManageProjects: true, canManageAcl: false };
  }
  currentAccess = access;
  const canProjects = !!access.canManageProjects;
  const canAcl = !!access.canManageAcl;
  if (!canProjects && !canAcl) {
    window.location.href = '/team';
    return;
  }
  const tabButtons = [...adminTabBar.children];
  const projectsBtn = tabButtons.find((b) => b.dataset.tab === 'projects');
  const aclBtn = tabButtons.find((b) => b.dataset.tab === 'acl');
  if (projectsBtn) projectsBtn.hidden = !canProjects;
  if (aclBtn) aclBtn.hidden = !canAcl;
  adminTabBar.hidden = !(canProjects && canAcl);
  setActiveAdminTab(canProjects ? 'projects' : 'acl');
}

initAdmin();
