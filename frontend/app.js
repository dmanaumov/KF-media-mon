// Client cabinet — anonymous link /l/:token. Shows the client exactly their
// published facts + reach, nothing else. See backend /api/links and /api/tasks.

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const norm = (s) => String(s || '').trim().toLowerCase();

const brandTitle = document.getElementById('brandTitle');
const brandSub = document.getElementById('brandSub');
const statLink = document.getElementById('statLink');
const reachSummary = document.getElementById('reachSummary');
const filtersEl = document.getElementById('filters');
const listEl = document.getElementById('list');
const loading = document.getElementById('loading');
const empty = document.getElementById('empty');
const errorBox = document.getElementById('errorBox');
const toast = document.getElementById('toast');

let currentTasks = [];
let activeStatuses = null;

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toggleToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toggleToast._t);
  toggleToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

function deadlineLabel(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  return `${+m[3]} ${MONTHS_RU[+m[2] - 1]}`;
}

function formatReach(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function statusClass(label) {
  const l = norm(label);
  if (l.includes('опубликован')) return 'published';
  if (l.includes('отмен') || l.includes('отказ')) return 'rejected';
  if (l.includes('заверш') || l.includes('сдал')) return 'done';
  if (l.includes('в процесс') || l.includes('правк') || l.includes('готов')) return 'ongoing';
  return 'gray';
}

function renderChips(statuses) {
  filtersEl.innerHTML = statuses.map(({ label }) => {
    const key = norm(label);
    const active = activeStatuses && activeStatuses.has(key);
    return `<button type="button" class="filter${active ? ' active' : ''}" data-status="${esc(key)}">${esc(label)}</button>`;
  }).join('');
}

function displayReach(reach) {
  return reach ? formatReach(reach) : '—';
}

function cardHtml(t) {
  const chip = t.status && t.status.label
    ? `<span class="status ${statusClass(t.status.label)}">${esc(t.status.label)}</span>`
    : '';
  const metaBits = [
    t.smi ? `📰 ${esc(t.smi)}` : '',
    t.type ? `${esc(t.type)}` : '',
    t.deadline ? `🗓 ${deadlineLabel(t.deadline)}` : '',
  ].filter(Boolean).join('  ·  ');
  return `
    <article class="card">
      <div class="meta">
        <div class="meta-left">
          ${metaBits ? `<div class="eyebrow">${metaBits}</div>` : ''}
          <h2>${esc(t.title)}</h2>
          ${t.isFact ? `<div class="post-link"><a href="${esc(t.pubUrl)}" target="_blank" rel="noopener">${esc(t.pubUrl)}</a></div>` : ''}
        </div>
        ${chip ? `<div class="badges">${chip}</div>` : ''}
      </div>
      ${t.isFact ? `<div class="reach">Охват: <b>${displayReach(t.uvm)}</b></div>` : ''}
    </article>
  `;
}

function render() {
  const visible = activeStatuses
    ? currentTasks.filter((t) => !t.status || t.status.label === null || activeStatuses.has(norm(t.status.label)))
    : currentTasks;
  if (!visible.length) {
    empty.textContent = currentTasks.length
      ? 'По выбранным фильтрам фактов нет.'
      : 'Опубликованных фактов пока нет — заходите позже.';
    empty.hidden = false;
    listEl.innerHTML = '';
    return;
  }
  empty.hidden = true;
  listEl.innerHTML = visible.map(cardHtml).join('');
}

function renderSummary() {
  const facts = currentTasks.filter((t) => t.isFact);
  const published = facts.filter((t) => norm(t.status && t.status.label).includes('опубликован'));
  const reachTotal = facts.reduce((acc, t) => acc + (t.uvm || 0), 0);
  reachSummary.innerHTML = `
    <div class="reach-stat"><div class="reach-stat-label">Факты</div><div class="reach-stat-value">${facts.length}</div></div>
    <div class="reach-stat"><div class="reach-stat-label">Опубликовано</div><div class="reach-stat-value">${published.length} <small>/ ${facts.length}</small></div></div>
    <div class="reach-stat"><div class="reach-stat-label">Совокупный охват</div><div class="reach-stat-value">${formatReach(reachTotal)}</div></div>
  `;
  reachSummary.hidden = false;
}

async function load() {
  loading.hidden = false;
  errorBox.hidden = true;
  try {
    const m = window.location.pathname.match(/^\/(?:l\/)?(.+)$/);
    if (!m) throw new Error('Неверная ссылка.');
    const token = decodeURIComponent(m[1]);

    const metaRes = await fetch(`/api/links/${encodeURIComponent(token)}`);
    const metaData = await metaRes.json();
    if (!metaRes.ok) throw new Error(metaData.message || 'Ссылка не найдена.');

    brandTitle.textContent = 'PR-отчёт';
    brandSub.textContent = metaData.name || 'Проект';
    const originalTitle = document.title;
    document.title = [metaData.name, originalTitle].filter(Boolean).join(' — ');
    statLink.hidden = false;

    const res = await fetch(`/api/tasks?project=${encodeURIComponent(metaData.projectId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Не удалось загрузить отчёт.');

    currentTasks = data.tasks || [];
    const statuses = (data.meta && data.meta.statuses) || [];
    if (!activeStatuses) activeStatuses = new Set(statuses.map((s) => norm(s.label)));
    if (statuses.length > 1) {
      filtersEl.hidden = false;
      renderChips(statuses);
    }
    renderSummary();
    render();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    reachSummary.hidden = true;
    filtersEl.hidden = true;
    listEl.innerHTML = '';
  } finally {
    loading.hidden = true;
  }
}

filtersEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter');
  if (!chip || !activeStatuses) return;
  const key = chip.dataset.status;
  if (activeStatuses.has(key)) activeStatuses.delete(key);
  else activeStatuses.add(key);
  chip.classList.toggle('active');
  render();
});

load();