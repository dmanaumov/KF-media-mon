// Admin panel — client link generator + per-client facts summary.
// See backend /api/projects and /api/projects/:id/regenerate-link.

const norm = (s) => String(s || '').trim().toLowerCase();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const summaryEl = document.getElementById('summary');
const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const addCard = document.getElementById('addCard');
const tableWrap = document.getElementById('tableWrap');
const rowsEl = document.getElementById('rows');
const empty = document.getElementById('empty');
const toast = document.getElementById('toast');

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
    <tr>
      <td><b>${esc(p.label)}</b></td>
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
      <td style="text-align:right">
        <button type="button" class="icon-btn regen-btn" data-project="${esc(p.projectId)}">${p.token ? 'Пересоздать' : 'Создать'}</button>
      </td>
    </tr>
  `;
}

function render(data) {
  const projects = data.projects || [];
  if (!projects.length) {
    empty.textContent = 'На борде пока нет проектов (клиентов).';
    empty.hidden = false;
    tableWrap.hidden = true;
    return;
  }
  rowsEl.innerHTML = projects.map(rowHtml).join('');
  tableWrap.hidden = false;
  empty.hidden = true;

  const factsTotal = projects.reduce((a, p) => a + p.factsCount, 0);
  const publishedTotal = projects.reduce((a, p) => a + p.publishedCount, 0);
  const reachTotal = projects.reduce((a, p) => a + p.reachSum, 0);
  summaryEl.innerHTML = `
    <div class="reach-stat"><div class="reach-stat-label">Проектов</div><div class="reach-stat-value">${projects.length}</div></div>
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

load();