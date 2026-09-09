// Team cabinet — Mattermost login, project switcher, and three tabs:
// "Текущие задачи" (tasks + deadline calendar, as before), "WEB" (manually
// logged mentions with sentiment/urgency), "Статистика" (monthly media
// index chart from those mentions). See backend /api/team/* routes.

const MONTHS_RU_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const norm = (s) => String(s || '').trim().toLowerCase();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PROJECT_KEY = 'kf.team.project.v2';
const STATUS_KEY = 'kf.team.statusFilter.v1';
const PERIOD_KEY = 'kf.team.statsPeriod.v1';

function loadSavedStatusFilter() {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : null;
  } catch (e) {
    return null;
  }
}

function saveStatusFilter() {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify([...(activeStatuses || [])])); } catch (e) {}
}

let currentTasks = [];
let activeStatuses = null;
let statusOptions = [];
let currentUser = null;
let currentAccess = null;
let calYear = null;
let calMonth = null;

let projects = [];
let selectedProjectId = '';
let activeTab = 'tasks';
let currentMentions = [];
let editingMentionId = null;
let currentStats = [];
let statsPeriod = (() => {
  try { return localStorage.getItem(PERIOD_KEY) || 'all'; } catch (e) { return 'all'; }
})();

const loginApp = document.getElementById('loginApp');
const teamApp = document.getElementById('teamApp');
const loginLogin = document.getElementById('loginLogin');
const loginPassword = document.getElementById('loginPassword');
const loginSubmit = document.getElementById('loginSubmit');
const loginError = document.getElementById('loginError');
const teamUserName = document.getElementById('teamUserName');
const adminLink = document.getElementById('adminLink');

const teamProjectSelect = document.getElementById('teamProjectSelect');
const teamTabBar = document.getElementById('teamTabBar');
const panelTasks = document.getElementById('panelTasks');
const panelWeb = document.getElementById('panelWeb');
const panelStats = document.getElementById('panelStats');
const webAlertBadge = document.getElementById('webAlertBadge');

const teamLoading = document.getElementById('teamLoading');
const teamEmpty = document.getElementById('teamEmpty');
const teamList = document.getElementById('teamList');
const statusFilterWrap = document.getElementById('statusFilterWrap');
const statusFilterBtn = document.getElementById('statusFilterBtn');
const statusFilterLabelEl = document.getElementById('statusFilterLabel');
const statusFilterPanel = document.getElementById('statusFilterPanel');
const statusFilterList = document.getElementById('statusFilterList');
const statusFilterAll = document.getElementById('statusFilterAll');
const statusFilterNone = document.getElementById('statusFilterNone');
const teamCalendarToggle = document.getElementById('teamCalendarToggle');
const teamListView = document.getElementById('teamListView');
const teamCalendarView = document.getElementById('teamCalendarView');
const teamCalBack = document.getElementById('teamCalBack');
const teamCalPrev = document.getElementById('teamCalPrev');
const teamCalNext = document.getElementById('teamCalNext');
const teamCalTitle = document.getElementById('teamCalTitle');
const teamCalendarGrid = document.getElementById('teamCalendarGrid');

const webScopeHint = document.getElementById('webScopeHint');
const addMentionBtn = document.getElementById('addMentionBtn');
const webLoading = document.getElementById('webLoading');
const webList = document.getElementById('webList');
const webEmpty = document.getElementById('webEmpty');

const statsPeriodWrap = document.getElementById('statsPeriodWrap');
const statsSummary = document.getElementById('statsSummary');
const chartCard = document.getElementById('chartCard');
const statsChart = document.getElementById('statsChart');
const statsLoading = document.getElementById('statsLoading');
const statsEmpty = document.getElementById('statsEmpty');

const mentionModalOverlay = document.getElementById('mentionModalOverlay');
const mentionModalTitle = document.getElementById('mentionModalTitle');
const mentionUrl = document.getElementById('mentionUrl');
const mentionSource = document.getElementById('mentionSource');
const mentionDate = document.getElementById('mentionDate');
const mentionSentiment = document.getElementById('mentionSentiment');
const mentionUrgent = document.getElementById('mentionUrgent');
const mentionComment = document.getElementById('mentionComment');
const mentionCancelBtn = document.getElementById('mentionCancelBtn');
const mentionSaveBtn = document.getElementById('mentionSaveBtn');
const mentionDeleteBtn = document.getElementById('mentionDeleteBtn');

const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function teamApi(path, opts) {
  opts = opts || {};
  const res = await fetch(`/api/team${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401) { showLogin(); throw new Error('Сессия истекла.'); }
  if (!res.ok) throw new Error(data.message || data.error || 'Ошибка запроса');
  return data;
}

function showLogin() {
  loginApp.hidden = false;
  teamApp.hidden = true;
}

function showApp(user, access) {
  loginApp.hidden = true;
  teamApp.hidden = false;
  teamUserName.textContent = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Команда';
  adminLink.hidden = !(access && access.admin);
  if (access && access.admin) adminLink.href = access.staffProjectsPath || '/admin';
}

async function login() {
  const loginVal = loginLogin.value.trim();
  const password = loginPassword.value;
  loginError.hidden = true;
  if (!loginVal || !password) {
    loginError.textContent = 'Введите логин и пароль.';
    loginError.hidden = false;
    return;
  }
  loginSubmit.disabled = true;
  const originalText = loginSubmit.textContent;
  loginSubmit.textContent = 'Входим…';
  try {
    const data = await teamApi('/login', { method: 'POST', body: { login_id: loginVal, password } });
    loginPassword.value = '';
    currentUser = data.user;
    currentAccess = data.access;
    showApp(data.user, data.access);
    loadProjects();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = originalText;
  }
}

async function logout() {
  try { await fetch('/api/team/logout', { method: 'POST' }); } catch (e) {}
  currentUser = null;
  currentAccess = null;
  showLogin();
}

function statusClass(label) {
  const l = norm(label);
  if (l.includes('опубликован')) return 'published';
  if (l.includes('отмен') || l.includes('отказ')) return 'rejected';
  if (l.includes('заверш') || l.includes('сдал')) return 'done';
  if (l.includes('в процесс') || l.includes('правк') || l.includes('готов')) return 'ongoing';
  return 'gray';
}

function formatReach(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function deadlineLabel(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${+m[3]} ${MONTHS_RU[+m[2] - 1]}`;
}

// ==================== Project switcher ====================

function projectLabelFor(id) {
  const p = projects.find((x) => x.id === id);
  return p ? p.label : '';
}

async function loadProjects() {
  try {
    const data = await teamApi('/projects');
    projects = data.projects || [];
  } catch (err) {
    projects = [];
  }
  let saved = '';
  try { saved = localStorage.getItem(PROJECT_KEY) || ''; } catch (e) {}
  selectedProjectId = projects.some((p) => p.id === saved) ? saved : '';
  teamProjectSelect.innerHTML =
    '<option value="">Все проекты</option>' +
    projects
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'))
      .map((p) => `<option value="${esc(p.id)}"${p.id === selectedProjectId ? ' selected' : ''}>${esc(p.label)}</option>`)
      .join('');
  await fetchMentionsForProject();
  setActiveTab('tasks');
}

teamProjectSelect.addEventListener('change', async () => {
  selectedProjectId = teamProjectSelect.value;
  try { localStorage.setItem(PROJECT_KEY, selectedProjectId); } catch (e) {}
  await fetchMentionsForProject();
  if (activeTab === 'tasks') loadTasks();
  else if (activeTab === 'web') {
    renderMentions();
    if (!scenariosPanel.hidden) renderScenariosPanel(scenariosPanel);
  }
  else if (activeTab === 'stats') loadStatsTab();
});

// ==================== Tabs ====================

teamTabBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  const tab = btn.dataset.tab;
  if ((tab === 'web' || tab === 'stats') && !selectedProjectId) {
    showToast('Сначала выберите проект в списке выше.');
    teamProjectSelect.focus();
    return;
  }
  setActiveTab(tab);
});

function setActiveTab(tab) {
  activeTab = tab;
  [...teamTabBar.children].forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  panelTasks.hidden = tab !== 'tasks';
  panelWeb.hidden = tab !== 'web';
  panelStats.hidden = tab !== 'stats';
  teamCalendarToggle.hidden = tab !== 'tasks';
  if (tab === 'tasks') loadTasks();
  else if (tab === 'web') loadWebTab();
  else if (tab === 'stats') loadStatsTab();
  if (tab !== 'web') hideScenariosPanel();
}

// ==================== Текущие задачи ====================

// Compact status filter: a single button opens a checkbox panel instead of
// a wall of chips (a PR pipeline can have 7-10 statuses — chips overflowed
// the screen and looked overwhelming).
function updateStatusFilterLabel() {
  const total = statusOptions.length;
  const n = activeStatuses ? activeStatuses.size : total;
  if (!total || n === total) statusFilterLabelEl.textContent = 'Статус: все';
  else if (n === 0) statusFilterLabelEl.textContent = 'Статус: ничего';
  else if (n === 1) {
    const key = [...activeStatuses][0];
    const found = statusOptions.find((s) => norm(s.label) === key);
    statusFilterLabelEl.textContent = `Статус: ${found ? found.label : '1'}`;
  } else {
    statusFilterLabelEl.textContent = `Статус: выбрано ${n}`;
  }
}

function renderChips() {
  statusFilterList.innerHTML = statusOptions.map(({ label }) => {
    const key = norm(label);
    const checked = activeStatuses && activeStatuses.has(key);
    return `<label class="status-filter-item"><input type="checkbox" data-status="${esc(key)}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  }).join('');
  updateStatusFilterLabel();
}

function closeStatusFilterPanel() {
  statusFilterPanel.hidden = true;
  statusFilterWrap.classList.remove('open');
}

statusFilterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = statusFilterPanel.hidden;
  statusFilterPanel.hidden = !willOpen;
  statusFilterWrap.classList.toggle('open', willOpen);
});
document.addEventListener('click', (e) => {
  if (!statusFilterWrap.contains(e.target)) closeStatusFilterPanel();
});
statusFilterList.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"]');
  if (!cb || !activeStatuses) return;
  const key = cb.dataset.status;
  if (cb.checked) activeStatuses.add(key);
  else activeStatuses.delete(key);
  updateStatusFilterLabel();
  saveStatusFilter();
  renderTasks();
});
statusFilterAll.addEventListener('click', () => {
  activeStatuses = new Set(statusOptions.map((s) => norm(s.label)));
  renderChips();
  saveStatusFilter();
  renderTasks();
});
statusFilterNone.addEventListener('click', () => {
  activeStatuses = new Set();
  renderChips();
  saveStatusFilter();
  renderTasks();
});

function taskCardHtml(t) {
  const chip = t.status && t.status.label ? `<span class="status ${statusClass(t.status.label)}">${esc(t.status.label)}</span>` : '';
  const metaBits = [
    !selectedProjectId && t.project && t.project.label ? `${esc(t.project.label)}` : '',
    t.smi ? `📰 ${esc(t.smi)}` : '',
    t.type ? `${esc(t.type)}` : '',
    t.priority ? `⚑ ${esc(t.priority)}` : '',
    t.assignee && t.assignee.label ? `👤 ${esc(t.assignee.label)}` : '',
    t.deadline ? `🗓 ${deadlineLabel(t.deadline)}` : '',
  ].filter(Boolean).join('  ·  ');
  const reach = t.uvm ? `Охват: <b>${formatReach(t.uvm)}</b>` : '';
  return `
    <article class="card task-card" data-id="${esc(t.id)}">
      <div class="meta">
        <div class="meta-left">
          ${metaBits ? `<div class="eyebrow">${metaBits}</div>` : ''}
          <h2>${esc(t.title)}</h2>
          ${t.pubUrl ? `<div class="post-link"><a href="${esc(t.pubUrl)}" target="_blank" rel="noopener">${esc(t.pubUrl)}</a></div>` : ''}
        </div>
        ${chip ? `<div class="badges">${chip}</div>` : ''}
      </div>
      ${reach ? `<div class="reach">${reach}</div>` : ''}
    </article>
  `;
}

teamList.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.task-card');
  if (!card) return;
  openTaskModal(card.dataset.id);
});

function renderTasks() {
  const visible = activeStatuses
    ? currentTasks.filter((t) => !t.status || t.status.label === null || activeStatuses.has(norm(t.status.label)))
    : currentTasks;
  if (!visible.length) {
    teamEmpty.textContent = currentTasks.length ? 'Нет задач с выбранным статусом.' : 'Пока нет ни одной задачи.';
    teamEmpty.hidden = false;
    teamList.innerHTML = '';
    return;
  }
  teamEmpty.hidden = true;
  teamList.innerHTML = visible.map(taskCardHtml).join('');
}

async function loadTasks() {
  teamLoading.hidden = false;
  teamEmpty.hidden = true;
  teamList.innerHTML = '';
  try {
    const qs = selectedProjectId ? `?project=${encodeURIComponent(selectedProjectId)}` : '';
    const data = await teamApi(`/tasks${qs}`);
    teamLoading.hidden = true;
    const statuses = (data.meta && data.meta.statuses) || [];
    statusOptions = statuses;
    if (!activeStatuses) {
      const saved = loadSavedStatusFilter();
      if (saved) {
        // Keep only statuses that still exist on the board — drops stale
        // entries if a status was renamed/removed since the last save.
        const validKeys = new Set(statuses.map((s) => norm(s.label)));
        activeStatuses = new Set([...saved].filter((k) => validKeys.has(k)));
      } else {
        activeStatuses = new Set(statuses.map((s) => norm(s.label)));
      }
    }
    currentTasks = (data.tasks || []).slice().sort((a, b) => (b.deadline || '').localeCompare(a.deadline || '') || b.createAt - a.createAt);
    renderChips();
    renderTasks();
    if (!teamCalendarView.hidden) renderCalendar();
  } catch (err) {
    teamLoading.hidden = true;
    if (err.message !== 'Сессия истекла.') showToast('Не удалось загрузить задачи: ' + err.message);
  }
}

function calMarkerHtml(t) {
  return `<span class="cal-mark-dot ${t.pubUrl ? 'published' : 'gray'}"></span>`;
}

function deadlineShort(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${+m[3]}.${String(+m[2]).padStart(2, '0')}`;
}

function renderCalendar() {
  if (calYear == null) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
  teamCalTitle.textContent = `${MONTHS_RU_FULL[calMonth]} ${calYear}`;

  const byDate = new Map();
  for (const t of currentTasks) {
    if (!t.deadline) continue;
    if (!byDate.has(t.deadline)) byDate.set(t.deadline, []);
    byDate.get(t.deadline).push(t);
  }

  const first = new Date(Date.UTC(calYear, calMonth, 1));
  const leadDow = first.getUTCDay() || 7;
  const lead = leadDow - 1;
  const daysInMonth = new Date(Date.UTC(calYear, calMonth + 1, 0)).getUTCDate();
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const gridStart = new Date(Date.UTC(calYear, calMonth, 1 - lead));

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const inMonth = d.getUTCMonth() === calMonth;
    const dayTasks = byDate.get(dateStr) || [];
    const posts = dayTasks.map((t) => {
      const tip = [t.project && t.project.label, deadlineShort(t.deadline), t.status && t.status.label, t.title, t.smi && `📰 ${t.smi}`].filter(Boolean).join('\n');
      return `<button type="button" class="cal-post" title="${esc(tip)}">${calMarkerHtml(t)}<span class="cal-post-title">${esc(t.title)}</span></button>`;
    }).join('');
    const cls = `cal-day${inMonth ? '' : ' other-month'}${dateStr === todayStr ? ' today' : ''}`;
    cells.push(`<div class="${cls}" data-date="${dateStr}"><div class="cal-day-num">${d.getUTCDate()}</div>${posts}</div>`);
  }
  teamCalendarGrid.innerHTML = cells.join('');
}

function updateCalendarToggleIcon(calendarOpen) {
  if (calendarOpen) {
    teamCalendarToggle.textContent = '📋';
    teamCalendarToggle.title = 'Доска задач';
    teamCalendarToggle.setAttribute('aria-label', 'Доска задач');
  } else {
    teamCalendarToggle.textContent = '🗓️';
    teamCalendarToggle.title = 'Календарь';
    teamCalendarToggle.setAttribute('aria-label', 'Календарь');
  }
}

function openCalendar() {
  teamListView.hidden = true;
  teamCalendarView.hidden = false;
  updateCalendarToggleIcon(true);
  renderCalendar();
}

function closeCalendar() {
  teamCalendarView.hidden = true;
  teamListView.hidden = false;
  updateCalendarToggleIcon(false);
}

// ==================== Карточка задачи (просмотр/редактирование) ====================

const taskModalOverlay = document.getElementById('taskModalOverlay');
const taskTitle = document.getElementById('taskTitle');
const taskModalClose = document.getElementById('taskModalClose');
const taskModalLoading = document.getElementById('taskModalLoading');
const taskModalBody = document.getElementById('taskModalBody');
const taskStatus = document.getElementById('taskStatus');
const taskProject = document.getElementById('taskProject');
const taskAssignee = document.getElementById('taskAssignee');
const taskSmi = document.getElementById('taskSmi');
const taskDeadline = document.getElementById('taskDeadline');
const taskUvm = document.getElementById('taskUvm');
const taskUrl = document.getElementById('taskUrl');
const taskText = document.getElementById('taskText');
const taskAttachmentsEl = document.getElementById('taskAttachments');
const taskUploadZone = document.getElementById('taskUploadZone');
const taskFileInput = document.getElementById('taskFileInput');
const taskCommentList = document.getElementById('taskCommentList');
const taskCommentInput = document.getElementById('taskCommentInput');
const taskCommentSend = document.getElementById('taskCommentSend');
const taskModalCancel = document.getElementById('taskModalCancel');
const taskModalSave = document.getElementById('taskModalSave');

let openTaskId = null;

function autoGrowTitle() {
  taskTitle.style.height = 'auto';
  taskTitle.style.height = `${taskTitle.scrollHeight}px`;
}
taskTitle.addEventListener('input', autoGrowTitle);

function fillSelect(el, options, currentId, placeholder) {
  el.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
    (options || []).map((o) => `<option value="${esc(o.id)}"${o.id === currentId ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

function commentInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function commentTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderComments(comments) {
  if (!comments || !comments.length) {
    taskCommentList.innerHTML = '<div class="task-chat-empty">Пока нет сообщений — начните обсуждение.</div>';
    return;
  }
  taskCommentList.innerHTML = comments.map((c) => `
    <div class="task-chat-item">
      <div class="chat-avatar">${esc(commentInitials(c.author))}</div>
      <div class="chat-bubble">
        <div class="chat-meta"><b>${esc(c.author)}</b><span>${esc(commentTime(c.createdAt))}</span></div>
        <div class="chat-text">${esc(c.text)}</div>
      </div>
    </div>
  `).join('');
  taskCommentList.scrollTop = taskCommentList.scrollHeight;
}

const ATTACHMENT_ICON = { image: '🖼', attachment: '📎' };
function renderAttachments(list) {
  if (!list || !list.length) { taskAttachmentsEl.innerHTML = ''; return; }
  taskAttachmentsEl.innerHTML = list.map((a) => {
    const href = a.fileId ? `/api/team/tasks/${encodeURIComponent(openTaskId)}/attachments/${encodeURIComponent(a.fileId)}` : '#';
    return `<a class="attachment-chip" href="${esc(href)}" target="_blank" rel="noopener">${ATTACHMENT_ICON[a.type] || '📎'} ${esc(a.title)}</a>`;
  }).join('');
}

function fillTaskForm(detail, meta) {
  taskTitle.value = detail.title === '(без названия)' ? '' : detail.title;
  autoGrowTitle();
  fillSelect(taskStatus, meta.statuses, detail.status && detail.status.id, null);
  fillSelect(taskProject, meta.projects, detail.project && detail.project.id, null);
  fillSelect(taskAssignee, meta.assignee && meta.assignee.options, detail.assignee && detail.assignee.id, '—');
  taskSmi.value = detail.smi || '';
  taskDeadline.value = detail.deadline || '';
  taskUvm.value = detail.uvm != null ? detail.uvm : '';
  taskUrl.value = detail.pubUrl || '';
  taskText.value = detail.text || '';
  renderAttachments(detail.attachments);
  renderComments(detail.comments);
}

async function openTaskModal(taskId) {
  openTaskId = taskId;
  taskModalOverlay.hidden = false;
  taskModalBody.hidden = true;
  taskModalLoading.hidden = false;
  taskModalSave.disabled = true;
  try {
    const data = await teamApi(`/tasks/${encodeURIComponent(taskId)}`);
    taskModalLoading.hidden = true;
    taskModalBody.hidden = false;
    taskModalSave.disabled = false;
    fillTaskForm(data.task, data.meta);
  } catch (err) {
    taskModalLoading.hidden = true;
    showToast('Не удалось открыть карточку: ' + err.message);
    closeTaskModal();
  }
}

function closeTaskModal() {
  taskModalOverlay.hidden = true;
  openTaskId = null;
}

taskModalClose.addEventListener('click', closeTaskModal);
taskModalCancel.addEventListener('click', closeTaskModal);
taskModalOverlay.addEventListener('click', (e) => { if (e.target === taskModalOverlay) closeTaskModal(); });

taskModalSave.addEventListener('click', async () => {
  if (!openTaskId) return;
  const uvmRaw = taskUvm.value.trim();
  const body = {
    title: taskTitle.value.trim(),
    statusId: taskStatus.value || null,
    projectId: taskProject.value || null,
    assigneeId: taskAssignee.value || null,
    smi: taskSmi.value.trim(),
    deadline: taskDeadline.value || null,
    uvm: uvmRaw ? uvmRaw.replace(/[^\d.]/g, '') : null,
    url: taskUrl.value.trim(),
    text: taskText.value,
  };
  taskModalSave.disabled = true;
  const originalLabel = taskModalSave.textContent;
  taskModalSave.textContent = 'Сохраняем…';
  try {
    await teamApi(`/tasks/${encodeURIComponent(openTaskId)}`, { method: 'PATCH', body });
    showToast('Карточка сохранена.');
    closeTaskModal();
    loadTasks();
  } catch (err) {
    showToast(err.message);
  } finally {
    taskModalSave.disabled = false;
    taskModalSave.textContent = originalLabel;
  }
});

taskCommentSend.addEventListener('click', async () => {
  const text = taskCommentInput.value.trim();
  if (!text || !openTaskId) return;
  taskCommentSend.disabled = true;
  try {
    await teamApi(`/tasks/${encodeURIComponent(openTaskId)}/comments`, { method: 'POST', body: { text } });
    taskCommentInput.value = '';
    const data = await teamApi(`/tasks/${encodeURIComponent(openTaskId)}`);
    renderComments(data.task.comments);
  } catch (err) {
    showToast(err.message);
  } finally {
    taskCommentSend.disabled = false;
  }
});
taskCommentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') taskCommentSend.click(); });

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

taskUploadZone.addEventListener('click', (e) => { e.preventDefault(); taskFileInput.click(); });
taskFileInput.addEventListener('change', async () => {
  const file = taskFileInput.files && taskFileInput.files[0];
  taskFileInput.value = '';
  if (!file || !openTaskId) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showToast('Файл больше 8 МБ — выберите файл меньшего размера.');
    return;
  }
  showToast('Загружаем файл…');
  try {
    const dataBase64 = await readFileAsBase64(file);
    await teamApi(`/tasks/${encodeURIComponent(openTaskId)}/attachments`, {
      method: 'POST',
      body: { filename: file.name, mimeType: file.type, dataBase64 },
    });
    const data = await teamApi(`/tasks/${encodeURIComponent(openTaskId)}`);
    renderAttachments(data.task.attachments);
    showToast('Файл прикреплён.');
  } catch (err) {
    showToast('Не удалось загрузить файл: ' + err.message);
  }
});

// ==================== WEB: упоминания ====================

async function fetchMentionsForProject() {
  if (!selectedProjectId) {
    currentMentions = [];
    updateWebBadge();
    return;
  }
  try {
    const data = await teamApi(`/mentions?project=${encodeURIComponent(selectedProjectId)}`);
    currentMentions = data.mentions || [];
  } catch (err) {
    currentMentions = [];
  }
  updateWebBadge();
}

function updateWebBadge() {
  const alerts = currentMentions.filter((m) => m.sentiment === 'negative' || m.urgent).length;
  webAlertBadge.hidden = alerts === 0;
  webAlertBadge.textContent = alerts > 9 ? '9+' : String(alerts);
}

const SENTIMENT_LABEL = { positive: 'Позитив', neutral: 'Нейтрально', negative: 'Негатив' };
const SENTIMENT_CLASS = { positive: 'published', neutral: 'gray', negative: 'rejected' };
const EVENT_TYPE_LABEL = { article: 'Статья / публикация', news: 'Новость' };

function mentionCardHtml(m) {
  const isAlert = m.sentiment === 'negative' || m.urgent;
  const icons = [m.urgent ? '🚨' : '', m.sentiment === 'negative' ? '🔥' : ''].filter(Boolean).join(' ');
  const heading = m.title || m.source || 'Упоминание';
  const metaBits = [
    m.title && m.source ? `📰 ${esc(m.source)}` : '',
    m.publishedAt ? `🗓 ${deadlineLabel(m.publishedAt)}` : '',
    m.createdBy ? `👤 ${esc(m.createdBy)}` : '',
  ].filter(Boolean).join('  ·  ');
  return `
    <article class="card mention-card${isAlert ? ' alert' : ''}" data-id="${m.id}">
      <div class="meta">
        <div class="meta-left">
          ${metaBits ? `<div class="eyebrow">${metaBits}</div>` : ''}
          <h2 class="${isAlert ? 'alert-title' : ''}">${icons ? icons + ' ' : ''}${esc(heading)}</h2>
          ${m.comment ? `<div class="meta-sub">${esc(m.comment)}</div>` : ''}
          ${m.url ? `<div class="mention-link"><a href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.url)}">${esc(m.url)}</a></div>` : ''}
        </div>
        <div class="badges">
          <span class="status ${SENTIMENT_CLASS[m.sentiment] || 'gray'}">${SENTIMENT_LABEL[m.sentiment] || 'Нейтрально'}</span>
          <span class="status gray">${EVENT_TYPE_LABEL[m.eventType] || 'Новость'}</span>
          ${m.urgent ? '<span class="status urgent-badge">🚨 Срочно</span>' : ''}
        </div>
      </div>
    </article>
  `;
}

function renderMentions() {
  webScopeHint.textContent = selectedProjectId ? `Проект: ${projectLabelFor(selectedProjectId)}` : '';
  if (!currentMentions.length) {
    webEmpty.textContent = 'Пока нет ни одного упоминания. Добавьте первое вручную — кнопка выше.';
    webEmpty.hidden = false;
    webList.innerHTML = '';
    return;
  }
  webEmpty.hidden = true;
  webList.innerHTML = currentMentions.map((m) => {
    try {
      return mentionCardHtml(m);
    } catch (err) {
      console.error('[web] card render failed:', err);
      return '';
    }
  }).join('');
}

async function loadWebTab() {
  webLoading.hidden = false;
  webEmpty.hidden = true;
  webList.innerHTML = '';
  await fetchMentionsForProject();
  webLoading.hidden = true;
  renderMentions();
}

webList.addEventListener('click', (e) => {
  const card = e.target.closest('.mention-card');
  if (!card) return;
  const m = currentMentions.find((x) => String(x.id) === card.dataset.id);
  if (m) openMentionModal(m);
});

function openMentionModal(mention) {
  editingMentionId = mention ? mention.id : null;
  mentionModalTitle.textContent = mention ? 'Изменить упоминание' : 'Новое упоминание';
  mentionUrl.value = mention ? mention.url : '';
  mentionSource.value = mention ? mention.source : '';
  mentionDate.value = mention ? mention.publishedAt : '';
  mentionSentiment.value = mention ? mention.sentiment : 'neutral';
  mentionUrgent.checked = mention ? mention.urgent : false;
  mentionComment.value = mention ? mention.comment : '';
  mentionDeleteBtn.hidden = !mention;
  mentionModalOverlay.hidden = false;
}

function closeMentionModal() {
  mentionModalOverlay.hidden = true;
  editingMentionId = null;
}

addMentionBtn.addEventListener('click', () => openMentionModal(null));
mentionCancelBtn.addEventListener('click', closeMentionModal);
mentionModalOverlay.addEventListener('click', (e) => { if (e.target === mentionModalOverlay) closeMentionModal(); });

async function afterMentionsChanged() {
  await fetchMentionsForProject();
  if (activeTab === 'web') renderMentions();
  if (activeTab === 'stats') loadStatsTab();
}

mentionSaveBtn.addEventListener('click', async () => {
  if (!selectedProjectId) return;
  const body = {
    project: selectedProjectId,
    url: mentionUrl.value.trim(),
    source: mentionSource.value.trim(),
    publishedAt: mentionDate.value || null,
    sentiment: mentionSentiment.value,
    urgent: mentionUrgent.checked,
    comment: mentionComment.value.trim(),
  };
  mentionSaveBtn.disabled = true;
  try {
    const path = editingMentionId
      ? `/mentions/${editingMentionId}?project=${encodeURIComponent(selectedProjectId)}`
      : `/mentions?project=${encodeURIComponent(selectedProjectId)}`;
    await teamApi(path, { method: editingMentionId ? 'PUT' : 'POST', body });
    showToast('Упоминание сохранено.');
    closeMentionModal();
    await afterMentionsChanged();
  } catch (err) {
    showToast(err.message);
  } finally {
    mentionSaveBtn.disabled = false;
  }
});

mentionDeleteBtn.addEventListener('click', async () => {
  if (!editingMentionId || !selectedProjectId) return;
  mentionDeleteBtn.disabled = true;
  try {
    await teamApi(`/mentions/${editingMentionId}?project=${encodeURIComponent(selectedProjectId)}`, { method: 'DELETE' });
    showToast('Упоминание удалено.');
    closeMentionModal();
    await afterMentionsChanged();
  } catch (err) {
    showToast(err.message);
  } finally {
    mentionDeleteBtn.disabled = false;
  }
});

// ==================== Статистика ====================

function renderStatsSummary(stats) {
  const total = stats.reduce((a, s) => a + s.total, 0);
  const negative = stats.reduce((a, s) => a + s.negative, 0);
  const mediaIndex = stats.reduce((a, s) => a + s.mediaIndex, 0);
  const negShare = total ? Math.round((negative / total) * 100) : 0;
  statsSummary.innerHTML = `
    <div class="reach-stat"><div class="reach-stat-label">Упоминаний всего</div><div class="reach-stat-value">${total}</div></div>
    <div class="reach-stat"><div class="reach-stat-label">Медиаиндекс</div><div class="reach-stat-value">${mediaIndex > 0 ? '+' : ''}${mediaIndex}</div></div>
    <div class="reach-stat"><div class="reach-stat-label">Доля негатива</div><div class="reach-stat-value">${negShare}%</div></div>
  `;
  statsSummary.hidden = false;
}

function monthShort(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return `${MONTHS_RU[+m[2] - 1]} ${m[1].slice(2)}`;
}

function renderChart(el, stats) {
  if (!stats.length) { el.innerHTML = ''; return; }
  const W = Math.max(340, stats.length * 68);
  const H = 220;
  const padL = 8, padR = 8, padT = 14, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxTotal = Math.max(1, ...stats.map((s) => s.total));
  const maxAbsIndex = Math.max(1, ...stats.map((s) => Math.abs(s.mediaIndex)));
  const bw = plotW / stats.length;
  const barW = Math.min(30, bw * 0.46);
  const zeroY = padT + plotH / 2;

  let bars = '';
  const points = [];
  stats.forEach((s, i) => {
    const cx = padL + bw * i + bw / 2;
    const barH = (s.total / maxTotal) * (plotH / 2 - 4);
    const by = padT + plotH - barH;
    bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="6" class="chart-bar"></rect>`;
    const ly = zeroY - (s.mediaIndex / maxAbsIndex) * (plotH / 2 - 6);
    points.push([cx, ly]);
    bars += `<text x="${cx.toFixed(1)}" y="${H - 10}" class="chart-x-label" text-anchor="middle">${esc(monthShort(s.month))}</text>`;
  });
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const dots = points
    .map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" class="chart-dot ${stats[i].mediaIndex < 0 ? 'neg' : 'pos'}"></circle>`)
    .join('');
  const zeroLine = `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" class="chart-zero"></line>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMinYMid meet">${zeroLine}${bars}<path d="${linePath}" class="chart-line"></path>${dots}</svg>`;
}

// Period presets narrow the (sparse, months-with-data-only) stats array to
// a calendar cutoff — purely client-side, no re-fetch needed since the
// backend already returns the full history for the project.
function filterStatsByPeriod(stats, period) {
  if (period === 'all') return stats;
  const n = parseInt(period, 10);
  if (!n) return stats;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  return stats.filter((s) => s.month >= cutoffKey);
}

function syncPeriodButtons() {
  [...statsPeriodWrap.children].forEach((b) => b.classList.toggle('active', b.dataset.period === statsPeriod));
}

function renderStatsTabContent() {
  if (!currentStats.length) {
    statsPeriodWrap.hidden = true;
    chartCard.hidden = true;
    statsSummary.hidden = true;
    statsEmpty.textContent = 'Пока нет данных для статистики — добавьте упоминания во вкладке «WEB».';
    statsEmpty.hidden = false;
    return;
  }
  statsPeriodWrap.hidden = false;
  syncPeriodButtons();
  const visible = filterStatsByPeriod(currentStats, statsPeriod);
  if (!visible.length) {
    chartCard.hidden = true;
    statsSummary.hidden = true;
    statsEmpty.textContent = 'Нет упоминаний за выбранный период.';
    statsEmpty.hidden = false;
    return;
  }
  statsEmpty.hidden = true;
  renderStatsSummary(visible);
  chartCard.hidden = false;
  renderChart(statsChart, visible);
}

statsPeriodWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('.period-btn');
  if (!btn) return;
  statsPeriod = btn.dataset.period;
  try { localStorage.setItem(PERIOD_KEY, statsPeriod); } catch (e) {}
  renderStatsTabContent();
});

async function loadStatsTab() {
  statsLoading.hidden = false;
  statsEmpty.hidden = true;
  statsPeriodWrap.hidden = true;
  chartCard.hidden = true;
  statsSummary.hidden = true;
  if (!selectedProjectId) {
    statsLoading.hidden = true;
    statsEmpty.textContent = 'Выберите проект, чтобы увидеть статистику.';
    statsEmpty.hidden = false;
    return;
  }
  try {
    const data = await teamApi(`/mentions/stats?project=${encodeURIComponent(selectedProjectId)}`);
    currentStats = data.stats || [];
    statsLoading.hidden = true;
    renderStatsTabContent();
  } catch (err) {
    statsLoading.hidden = true;
    statsEmpty.textContent = 'Не удалось загрузить статистику: ' + err.message;
    statsEmpty.hidden = false;
  }
}

// ==================== Сценарии поиска (команда) ====================

let currentScenarios = [];
let editingScenarioId = null;
const scenariosBtn = document.getElementById('scenariosBtn');
const scenariosPanel = document.getElementById('scenariosPanel');
const scenarioModalOverlay = document.getElementById('scenarioModalOverlay');
const scenarioModalTitle = document.getElementById('scenarioModalTitle');
const scnName = document.getElementById('scnName');
const scnProject = document.getElementById('scnProject');
const scnKeywords = document.getElementById('scnKeywords');
const scnSources = document.getElementById('scnSources');
const scnNegative = document.getElementById('scnNegative');
const scnPositive = document.getElementById('scnPositive');
const scnDays = document.getElementById('scnDays');
const scnCancel = document.getElementById('scnCancel');
const scnSave = document.getElementById('scnSave');

function tagChips(keywords, cls) {
  return (keywords || []).length
    ? `<div class="tag-list">${keywords.slice(0, 20).map((k) => `<span class="tag${cls ? ' ' + cls : ''}">${esc(k)}</span>`).join('')}${keywords.length > 20 ? `<span class="tag">+${keywords.length - 20}</span>` : ''}</div>`
    : '';
}

function openScenarioModal(scenario) {
  scnProject.innerHTML = '<option value="">Выберите проект</option>' +
    projects.slice().sort((a, b) => a.label.localeCompare(b.label, 'ru'))
      .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  editingScenarioId = scenario ? scenario.id : null;
  scenarioModalTitle.textContent = scenario ? 'Изменить сценарий' : 'Новый сценарий';
  scnName.value = scenario ? scenario.name : '';
  scnProject.value = scenario ? scenario.projectId : (selectedProjectId || '');
  scnKeywords.value = scenario ? (scenario.keywords || []).join(', ') : '';
  scnSources.value = scenario ? (scenario.sources || []).join(', ') : '';
  scnNegative.value = scenario ? (scenario.negativeKeywords || []).join(', ') : '';
  scnPositive.value = scenario ? (scenario.positiveKeywords || []).join(', ') : '';
  scenarioModalOverlay.hidden = false;
}

function closeScenarioModal() {
  scenarioModalOverlay.hidden = true;
  editingScenarioId = null;
}

function renderScenariosPanel(container) {
  const list = selectedProjectId
    ? currentScenarios.filter((s) => s.projectId === selectedProjectId)
    : currentScenarios;
  if (!list.length) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px"><div class="scenarios-title">Сценарии поиска</div><button type="button" class="icon-btn" data-close-scenarios>×</button></div><div class="scenarios-empty">' +
      (currentScenarios.length ? 'Пока нет сценариев поиска для этого проекта.' : 'Сценариев пока нет. Создайте первый — и он будет выполняться автоматически раз в сутки.') +
      '<br><br><button type="button" class="btn approve small" id="addFirstScenarioBtn">+ Создать сценарий</button></div>';
    const addBtn = container.querySelector('#addFirstScenarioBtn');
    if (addBtn) addBtn.addEventListener('click', () => openScenarioModal(null));
    return;
  }
  container.innerHTML =
    '<div class="scenarios-header"><div class="scenarios-title">Сценарии поиска</div>' +
    '<div style="display:flex;gap:8px"><button type="button" class="btn approve small" id="addScenarioBtn">+ Создать</button>' +
    '<button type="button" class="icon-btn" data-close-scenarios>×</button></div></div>' +
    list.map((s) => `
      <div class="scenario-row${s.archived ? ' is-archived' : ''}">
        <div class="scenario-row-main">
          <div class="scenario-name">${esc(s.name || 'Без названия')}${s.archived ? '<span class="badge-archived">деактивирован</span>' : ''}</div>
          <div class="scenario-meta">${esc(projectLabelFor(s.projectId) || s.projectId)}${s.days ? ' · последние ' + s.days + ' дн.' : ''}</div>
          ${tagChips(s.keywords)}
          ${tagChips(s.negativeKeywords, 'neg')}
          ${tagChips(s.positiveKeywords, 'pos')}
          ${s.sources && s.sources.length ? `<div class="scenario-meta" style="margin-top:6px">🔗 ${esc(s.sources.slice(0, 3).join(' · '))}${s.sources.length > 3 ? '…' : ''}</div>` : ''}
        </div>
        <div class="scenario-actions">
          <button type="button" class="scenario-act-btn" data-edit-scenario="${s.id}" title="Изменить">✏️</button>
          <button type="button" class="scenario-act-btn" data-copy-scenario="${s.id}" title="Дублировать">⧉</button>
          <button type="button" class="scenario-act-btn" data-toggle-scenario="${s.id}" title="${s.archived ? 'Активировать' : 'Деактивировать'}">${s.archived ? '▶️' : '⏸'}</button>
          <button type="button" class="scenario-act-btn danger" data-del-scenario="${s.id}" title="Удалить">🗑️</button>
        </div>
      </div>`).join('');
  const addBtn = container.querySelector('#addScenarioBtn');
  if (addBtn) addBtn.addEventListener('click', () => openScenarioModal(null));
}

async function loadScenarios() {
  try {
    const data = await teamApi('/search-scenarios');
    currentScenarios = data.scenarios || [];
  } catch (err) {
    currentScenarios = [];
    showToast('Не удалось загрузить сценарии: ' + err.message);
  }
}

function hideScenariosPanel() {
  scenariosPanel.hidden = true;
}

scenariosBtn.addEventListener('click', async () => {
  if (!scenariosPanel.hidden) {
    scenariosPanel.hidden = true;
    return;
  }
  await loadScenarios();
  scenariosPanel.hidden = false;
  renderScenariosPanel(scenariosPanel);
});

scenariosPanel.addEventListener('click', async (e) => {
  const close = e.target.closest('[data-close-scenarios]');
  const edit = e.target.closest('[data-edit-scenario]');
  const copy = e.target.closest('[data-copy-scenario]');
  const toggle = e.target.closest('[data-toggle-scenario]');
  const del = e.target.closest('[data-del-scenario]');
  if (close) { hideScenariosPanel(); return; }
  if (edit) {
    const s = currentScenarios.find((x) => String(x.id) === edit.dataset.editScenario);
    openScenarioModal(s);
    return;
  }
  if (copy) {
    const s = currentScenarios.find((x) => String(x.id) === copy.dataset.copyScenario);
    if (!s) return;
    try {
      await teamApi('/search-scenarios', {
        method: 'POST',
        body: {
          projectId: s.projectId || '',
          name: (s.name || '') + ' (копия)',
          keywords: s.keywords || [],
          sources: s.sources || [],
          negativeKeywords: s.negativeKeywords || [],
          positiveKeywords: s.positiveKeywords || [],
          regex: s.regex || '',
          feedUrl: s.feedUrl || '',
        },
      });
      showToast('Сценарий продублирован.');
      await loadScenarios();
      renderScenariosPanel(scenariosPanel);
    } catch (err) {
      showToast(err.message);
    }
    return;
  }
  if (toggle) {
    const s = currentScenarios.find((x) => String(x.id) === toggle.dataset.toggleScenario);
    if (!s) return;
    if (!confirm(s.archived ? 'Активировать сценарий? Автоматический поиск снова будет выполняться.' : 'Деактивировать сценарий? Автоматический поиск перестанет выполняться.')) return;
    try {
      await teamApi(`/search-scenarios/${s.id}`, {
        method: 'PUT',
        body: {
          name: s.name || '',
          projectId: s.projectId || '',
          keywords: s.keywords || [],
          sources: s.sources || [],
          negativeKeywords: s.negativeKeywords || [],
          positiveKeywords: s.positiveKeywords || [],
          regex: s.regex || '',
          feedUrl: s.feedUrl || '',
          archived: !s.archived,
        },
      });
      showToast(s.archived ? 'Сценарий активирован.' : 'Сценарий деактивирован.');
      await loadScenarios();
      renderScenariosPanel(scenariosPanel);
    } catch (err) {
      showToast(err.message);
    }
    return;
  }
  if (del && confirm('Удалить сценарий? Останется ли у проекта его настройка — проверьте.')) {
    try {
      await teamApi(`/search-scenarios/${del.dataset.delScenario}`, { method: 'DELETE' });
      showToast('Сценарий удалён.');
      await loadScenarios();
      renderScenariosPanel(scenariosPanel);
    } catch (err) {
      showToast(err.message);
    }
  }
});

scnCancel.addEventListener('click', closeScenarioModal);
scenarioModalOverlay.addEventListener('click', (e) => { if (e.target === scenarioModalOverlay) closeScenarioModal(); });

scnSave.addEventListener('click', async () => {
  const projectId = scnProject.value;
  if (!projectId) { showToast('Выберите проект.'); return; }
  const split = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  const body = {
    projectId,
    name: scnName.value.trim(),
    keywords: split(scnKeywords.value),
    sources: split(scnSources.value),
    negativeKeywords: split(scnNegative.value),
    positiveKeywords: split(scnPositive.value),
  };
  scnSave.disabled = true;
  try {
    const path = editingScenarioId ? `/search-scenarios/${editingScenarioId}` : '/search-scenarios';
    await teamApi(path, { method: editingScenarioId ? 'PUT' : 'POST', body });
    showToast('Сценарий сохранён.');
    closeScenarioModal();
    await loadScenarios();
    const panel = document.getElementById('scenariosPanel');
    if (panel) renderScenariosPanel(panel);
  } catch (err) {
    showToast(err.message);
  } finally {
    scnSave.disabled = false;
  }
});

// ==================== Логи поиска (история запусков автоматизации) ====================

const searchLogsBtn = document.getElementById('searchLogsBtn');
const searchLogsModalOverlay = document.getElementById('searchLogsModalOverlay');
const searchLogsCloseBtn = document.getElementById('searchLogsCloseBtn');
const searchLogList = document.getElementById('searchLogList');
const searchLogsEmpty = document.getElementById('searchLogsEmpty');
const searchLogsLoading = document.getElementById('searchLogsLoading');
const logSeverityFilter = document.getElementById('logSeverityFilter');

let currentSearchLogs = [];
let searchLogSeverity = 'all';

const SEVERITY_LABEL = { info: 'Инфо', debug: 'Отладка', important: 'Важно' };
const SEVERITY_CLASS = { info: 'gray', debug: 'ongoing', important: 'rejected' };
const LOG_STATUS_LABEL = { ok: '✓ Успешно', error: '✗ Ошибка', partial: '~ Частично', skipped: '∅ Пропущено' };

async function fetchSearchLogs() {
  const data = await teamApi('/search-logs?limit=200');
  currentSearchLogs = data.logs || [];
}

function renderSearchLogs() {
  const list = searchLogSeverity === 'all'
    ? currentSearchLogs
    : currentSearchLogs.filter((l) => l.severity === searchLogSeverity);
  searchLogsEmpty.hidden = currentSearchLogs.length > 0;
  searchLogsEmpty.textContent = currentSearchLogs.length
    ? 'Нет записей с такой критичностью.'
    : 'Логов пока нет. Они появятся, когда автоматизация запустит сценарии.';
  searchLogList.innerHTML = list.map((l) => `
    <div class="log-row">
      <div class="log-row-head">
        <b class="log-name">${esc(l.scenarioName)}</b>
        <span class="status ${SEVERITY_CLASS[l.severity] || 'gray'}">${SEVERITY_LABEL[l.severity] || l.severity}</span>
      </div>
      <div class="log-meta">${LOG_STATUS_LABEL[l.status] || esc(l.status || '')} · ${logTimeLabel(l.createdAt)}${l.createdBy ? ' · ' + esc(l.createdBy) : ''}</div>
      ${l.note ? `<div class="log-note">${esc(l.note)}</div>` : ''}
    </div>`).join('');
}

function logTimeLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function openSearchLogs() {
  searchLogsModalOverlay.hidden = false;
  searchLogsLoading.hidden = false;
  searchLogsEmpty.hidden = true;
  searchLogList.innerHTML = '';
  try {
    await fetchSearchLogs();
  } catch (err) {
    currentSearchLogs = [];
    showToast('Не удалось загрузить логи: ' + err.message);
  }
  searchLogsLoading.hidden = true;
  renderSearchLogs();
}

function closeSearchLogs() {
  searchLogsModalOverlay.hidden = true;
}

searchLogsBtn.addEventListener('click', openSearchLogs);
searchLogsCloseBtn.addEventListener('click', closeSearchLogs);
searchLogsModalOverlay.addEventListener('click', (e) => { if (e.target === searchLogsModalOverlay) closeSearchLogs(); });

logSeverityFilter.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-sev]');
  if (!chip) return;
  searchLogSeverity = chip.dataset.sev;
  [...logSeverityFilter.children].forEach((b) => b.classList.toggle('active', b === chip));
  renderSearchLogs();
});

// ==================== Init ====================

async function init() {
  try {
    const data = await teamApi('/me');
    currentUser = data.user;
    currentAccess = data.access;
    showApp(data.user, data.access);
    loadProjects();
  } catch (err) {
    showLogin();
  }
}

loginSubmit.addEventListener('click', login);
[loginLogin, loginPassword].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); }));
document.getElementById('logoutBtn').addEventListener('click', logout);

teamCalendarToggle.addEventListener('click', () => {
  if (teamCalendarView.hidden) openCalendar();
  else closeCalendar();
});
teamCalBack.addEventListener('click', closeCalendar);
teamCalPrev.addEventListener('click', () => { calMonth -= 1; if (calMonth < 0) { calMonth = 11; calYear -= 1; } renderCalendar(); });
teamCalNext.addEventListener('click', () => { calMonth += 1; if (calMonth > 11) { calMonth = 0; calYear += 1; } renderCalendar(); });

init();
