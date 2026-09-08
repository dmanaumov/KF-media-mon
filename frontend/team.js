// Team cabinet — Mattermost login, project switcher, and three tabs:
// "Текущие задачи" (tasks + deadline calendar, as before), "WEB" (manually
// logged mentions with sentiment/urgency), "Статистика" (monthly media
// index chart from those mentions). See backend /api/team/* routes.

const MONTHS_RU_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const norm = (s) => String(s || '').trim().toLowerCase();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PROJECT_KEY = 'kf.team.project.v2';

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
const teamFilters = document.getElementById('teamFilters');
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
  else if (activeTab === 'web') renderMentions();
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
}

// ==================== Текущие задачи ====================

function renderChips() {
  teamFilters.innerHTML = statusOptions.map(({ label }) => {
    const key = norm(label);
    const active = activeStatuses && activeStatuses.has(key);
    return `<button type="button" class="filter${active ? ' active' : ''}" data-status="${esc(key)}">${esc(label)}</button>`;
  }).join('');
}

function taskCardHtml(t) {
  const chip = t.status && t.status.label ? `<span class="status ${statusClass(t.status.label)}">${esc(t.status.label)}</span>` : '';
  const metaBits = [
    !selectedProjectId && t.project && t.project.label ? `${esc(t.project.label)}` : '',
    t.smi ? `📰 ${esc(t.smi)}` : '',
    t.type ? `${esc(t.type)}` : '',
    t.priority ? `⚑ ${esc(t.priority)}` : '',
    t.deadline ? `🗓 ${deadlineLabel(t.deadline)}` : '',
  ].filter(Boolean).join('  ·  ');
  const reach = t.uvm ? `Охват: <b>${formatReach(t.uvm)}</b>` : '';
  return `
    <article class="card">
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
    if (!activeStatuses) activeStatuses = new Set(statuses.map((s) => norm(s.label)));
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

function mentionCardHtml(m) {
  const isAlert = m.sentiment === 'negative' || m.urgent;
  const icons = [m.urgent ? '🚨' : '', m.sentiment === 'negative' ? '🔥' : ''].filter(Boolean).join(' ');
  const heading = m.source || m.url || 'Упоминание';
  const metaBits = [
    m.source ? `📰 ${esc(m.source)}` : '',
    m.publishedAt ? `🗓 ${deadlineLabel(m.publishedAt)}` : '',
    m.createdBy ? `👤 ${esc(m.createdBy)}` : '',
  ].filter(Boolean).join('  ·  ');
  return `
    <article class="card mention-card${isAlert ? ' alert' : ''}" data-id="${m.id}">
      <div class="meta">
        <div class="meta-left">
          ${metaBits ? `<div class="eyebrow">${metaBits}</div>` : ''}
          <h2 class="${isAlert ? 'alert-title' : ''}">${icons ? icons + ' ' : ''}${esc(heading)}</h2>
          ${m.url ? `<div class="post-link"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a></div>` : ''}
          ${m.comment ? `<div class="meta-sub">${esc(m.comment)}</div>` : ''}
        </div>
        <div class="badges">
          <span class="status ${SENTIMENT_CLASS[m.sentiment] || 'gray'}">${SENTIMENT_LABEL[m.sentiment] || 'Нейтрально'}</span>
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
  webList.innerHTML = currentMentions.map(mentionCardHtml).join('');
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

async function loadStatsTab() {
  statsLoading.hidden = false;
  statsEmpty.hidden = true;
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
    if (!currentStats.length) {
      statsEmpty.textContent = 'Пока нет данных для статистики — добавьте упоминания во вкладке «WEB».';
      statsEmpty.hidden = false;
      return;
    }
    renderStatsSummary(currentStats);
    chartCard.hidden = false;
    renderChart(statsChart, currentStats);
  } catch (err) {
    statsLoading.hidden = true;
    statsEmpty.textContent = 'Не удалось загрузить статистику: ' + err.message;
    statsEmpty.hidden = false;
  }
}

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

teamFilters.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter');
  if (!chip || !activeStatuses) return;
  const key = chip.dataset.status;
  if (activeStatuses.has(key)) activeStatuses.delete(key);
  else activeStatuses.add(key);
  chip.classList.toggle('active');
  renderTasks();
});

teamCalendarToggle.addEventListener('click', () => {
  if (teamCalendarView.hidden) openCalendar();
  else closeCalendar();
});
teamCalBack.addEventListener('click', closeCalendar);
teamCalPrev.addEventListener('click', () => { calMonth -= 1; if (calMonth < 0) { calMonth = 11; calYear -= 1; } renderCalendar(); });
teamCalNext.addEventListener('click', () => { calMonth += 1; if (calMonth > 11) { calMonth = 0; calYear += 1; } renderCalendar(); });

init();
