// Team cabinet — Mattermost login, tasks list (+project/status filters) and
// deadline calendar overview. Read-only: see backend /api/team/* routes.

const MONTHS_RU_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const norm = (s) => String(s || '').trim().toLowerCase();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentTasks = [];
let activeStatuses = null;
let statusOptions = [];
let projectFilterId = '';
let currentUser = null;
let currentAccess = null;
let calYear = null;
let calMonth = null;
const PROJECT_FILTER_KEY = 'kf.team.projectFilter.v1';
try { projectFilterId = localStorage.getItem(PROJECT_FILTER_KEY) || ''; } catch (e) {}

const loginApp = document.getElementById('loginApp');
const teamApp = document.getElementById('teamApp');
const loginLogin = document.getElementById('loginLogin');
const loginPassword = document.getElementById('loginPassword');
const loginSubmit = document.getElementById('loginSubmit');
const loginError = document.getElementById('loginError');
const teamUserName = document.getElementById('teamUserName');
const statLink = document.getElementById('statLink');
const adminLink = document.getElementById('adminLink');
const teamLoading = document.getElementById('teamLoading');
const teamEmpty = document.getElementById('teamEmpty');
const teamList = document.getElementById('teamList');
const teamFilters = document.getElementById('teamFilters');
const teamProjectFilterRow = document.getElementById('teamProjectFilterRow');
const teamProjectFilter = document.getElementById('teamProjectFilter');
const teamCalendarToggle = document.getElementById('teamCalendarToggle');
const teamListView = document.getElementById('teamListView');
const teamCalendarView = document.getElementById('teamCalendarView');
const teamCalBack = document.getElementById('teamCalBack');
const teamCalPrev = document.getElementById('teamCalPrev');
const teamCalNext = document.getElementById('teamCalNext');
const teamCalTitle = document.getElementById('teamCalTitle');
const teamCalendarGrid = document.getElementById('teamCalendarGrid');
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
  statLink.hidden = true;
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
    loadTasks();
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

function deadlineShort(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${+m[3]}.${String(+m[2]).padStart(2, '0')}`;
}

function saveFilters() {
  try { localStorage.setItem(PROJECT_FILTER_KEY, projectFilterId); } catch (e) {}
}

function renderChips() {
  teamFilters.innerHTML = statusOptions.map(({ label }) => {
    const key = norm(label);
    const active = activeStatuses && activeStatuses.has(key);
    return `<button type="button" class="filter${active ? ' active' : ''}" data-status="${esc(key)}">${esc(label)}</button>`;
  }).join('');
}

function renderProjectFilter() {
  const seen = new Map();
  currentTasks.forEach((t) => {
    if (t.project && t.project.id && !seen.has(t.project.id)) seen.set(t.project.id, t.project.label || t.project.id);
  });
  if (seen.size < 2) {
    teamProjectFilterRow.hidden = true;
    if (projectFilterId && ![...seen.keys()].includes(projectFilterId)) {
      projectFilterId = '';
      saveFilters();
    }
    return;
  }
  teamProjectFilterRow.hidden = false;
  if (projectFilterId && !seen.has(projectFilterId)) projectFilterId = '';
  teamProjectFilter.innerHTML =
    '<option value="">Все проекты</option>' +
    [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'))
      .map(([id, label]) => `<option value="${esc(id)}"${id === projectFilterId ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

function projectFiltered(tasks) {
  return projectFilterId ? tasks.filter((t) => !t.project || t.project.id === projectFilterId) : tasks;
}

function taskCardHtml(t) {
  const chip = t.status && t.status.label ? `<span class="status ${statusClass(t.status.label)}">${esc(t.status.label)}</span>` : '';
  const metaBits = [
    t.project && t.project.label ? `${esc(t.project.label)}` : '',
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
  const byProject = projectFiltered(currentTasks);
  const visible = activeStatuses
    ? byProject.filter((t) => !t.status || t.status.label === null || activeStatuses.has(norm(t.status.label)))
    : byProject;
  if (!visible.length) {
    teamEmpty.textContent = currentTasks.length ? 'Нет задач с выбранными статусами/проектом.' : 'Пока нет ни одной задачи.';
    teamEmpty.hidden = false;
    teamList.innerHTML = '';
    return;
  }
  teamEmpty.hidden = true;
  teamList.innerHTML = visible.map(taskCardHtml).join('');
}

function calMarkerHtml(t) {
  return `<span class="cal-mark-dot ${t.pubUrl ? 'published' : 'gray'}" style="${t.pubUrl ? '' : ''}"></span>`;
}

function renderCalendar() {
  if (calYear == null) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
  teamCalTitle.textContent = `${MONTHS_RU_FULL[calMonth]} ${calYear}`;

  const byDate = new Map();
  for (const t of projectFiltered(currentTasks)) {
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
      const tip = [t.project && t.project.label, t.deadlineShort || deadlineShort(t.deadline), t.status && t.status.label, t.title, t.smi && `📰 ${t.smi}`].filter(Boolean).join('\n');
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

async function loadTasks() {
  teamLoading.hidden = false;
  teamEmpty.hidden = true;
  teamList.innerHTML = '';
  try {
    const data = await teamApi('/tasks');
    teamLoading.hidden = true;
    const statuses = data.meta && data.meta.statuses || [];
    statusOptions = statuses;
    if (!activeStatuses) activeStatuses = new Set(statuses.map((s) => norm(s.label)));
    currentTasks = (data.tasks || []).slice().sort((a, b) => (b.deadline || '').localeCompare(a.deadline || '') || b.createAt - a.createAt);
    renderChips();
    renderProjectFilter();
    renderTasks();
    if (!teamCalendarView.hidden) renderCalendar();
  } catch (err) {
    teamLoading.hidden = true;
    if (err.message !== 'Сессия истекла.') showToast('Не удалось загрузить задачи: ' + err.message);
  }
}

async function init() {
  try {
    const data = await teamApi('/me');
    currentUser = data.user;
    currentAccess = data.access;
    showApp(data.user, data.access);
    loadTasks();
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

teamProjectFilter.addEventListener('change', () => {
  projectFilterId = teamProjectFilter.value;
  saveFilters();
  renderTasks();
  if (!teamCalendarView.hidden) renderCalendar();
});

teamCalendarToggle.addEventListener('click', () => {
  if (teamCalendarView.hidden) openCalendar();
  else closeCalendar();
});
teamCalBack.addEventListener('click', closeCalendar);
teamCalPrev.addEventListener('click', () => { calMonth -= 1; if (calMonth < 0) { calMonth = 11; calYear -= 1; } renderCalendar(); });
teamCalNext.addEventListener('click', () => { calMonth += 1; if (calMonth > 11) { calMonth = 0; calYear += 1; } renderCalendar(); });

init();