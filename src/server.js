const express = require('express');
const compression = require('compression');
const path = require('path');
const config = require('./config');
const mm = require('./mattermostClient');
const db = require('./db');
const teamAuth = require('./teamAuth');
const projectSettings = require('./projectSettings');
const mentions = require('./mentions');
const { buildTasks, projectOptions, statusOptions } = require('./taskMapper');
const newsSearcher = require('./newsSearcher');
const scenarios = require('./scenarios');

const app = express();
app.use(compression());
app.use(express.json());

// --- Board loading with lazy TTL cache (matches SMM: in-memory only) ---
const boardCache = new Map(); // boardId -> { expires, board, cards }

async function loadBoard(boardId, { fresh = false } = {}) {
  const cached = boardCache.get(boardId);
  if (!fresh && config.cacheTtlMs > 0 && cached && cached.expires > Date.now()) {
    return cached;
  }
  const [board, cards] = await Promise.all([
    mm.getBoard(boardId, config.teamId),
    mm.listCards(boardId),
  ]);
  const entry = { board, cards, expires: Date.now() + config.cacheTtlMs };
  boardCache.set(boardId, entry);
  return entry;
}

function invalidate() {
  boardCache.delete(config.mattermostBoardId);
}

async function loadTeamTasks(opts = {}) {
  const { board, cards } = await loadBoard(config.mattermostBoardId, { fresh: !!opts.fresh });
  return buildTasks(board, cards, opts);
}

async function settingsMapSafe() {
  try {
    return await projectSettings.listSettingsMap(config.mattermostBoardId);
  } catch (err) {
    console.error('[api] failed to load project settings map:', err.message);
    return new Map();
  }
}

// --- Auth routes (same mechanics as SMM /team) ---
app.post('/api/team/login', async (req, res) => {
  const { login_id, password } = req.body || {};
  if (!login_id || !password) {
    return res.status(400).json({ error: 'missing_credentials', message: 'Введите логин и пароль Mattermost.' });
  }
  try {
    const { token, user } = await mm.loginAs(String(login_id), String(password));
    const sessionId = await teamAuth.createSession(token, user);
    teamAuth.setSessionCookie(res, sessionId);
    res.json({ user, role: teamAuth.roleFor(user), access: accessFor(user) });
  } catch (err) {
    res.status(401).json({ error: 'login_failed', message: err.message || 'Неверный логин или пароль.' });
  }
});

function accessFor(user) {
  const role = teamAuth.roleFor(user);
  return { admin: role.admin, staffProjectsPath: config.adminPath };
}

app.post('/api/team/logout', (req, res) => {
  teamAuth.destroySession(teamAuth.sessionIdFromRequest(req));
  teamAuth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/team/me', (req, res) => {
  const session = teamAuth.getSession(teamAuth.sessionIdFromRequest(req));
  if (!session) return res.status(401).json({ error: 'not_logged_in' });
  res.json({ user: session.user, role: teamAuth.roleFor(session.user), access: accessFor(session.user) });
});

// --- Team cabinet data (requireTeamAuth) ---
app.get('/api/team/projects', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const { board } = await loadBoard(config.mattermostBoardId);
    const all = projectOptions(board);
    const settingsMap = await settingsMapSafe();
    const visible = all.filter((p) => !(settingsMap.get(p.id) || {}).archived);
    res.json({ projects: visible });
  } catch (err) {
    console.error('[api] /api/team/projects failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

app.get('/api/team/tasks', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const { project, status, fact } = req.query;
    const result = await loadTeamTasks({
      project: project || '',
      onlyFacts: fact === '1',
      statusFilter: status || '',
    });
    if (!project) {
      // "Все проекты" view — still hide archived clients' tasks, matching
      // their disappearance from the project dropdown.
      const settingsMap = await settingsMapSafe();
      result.tasks = result.tasks.filter(
        (t) => !t.project || !t.project.id || !(settingsMap.get(t.project.id) || {}).archived
      );
      result.meta.projects = result.meta.projects.filter((p) => !(settingsMap.get(p.id) || {}).archived);
    }
    res.json(result);
  } catch (err) {
    console.error('[api] /api/team/tasks failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// --- WEB tab: manually-logged mentions (requireTeamAuth, project-scoped) ---
function requireProjectParam(req, res) {
  const project = ((req.query && req.query.project) || (req.body && req.body.project) || '').toString().trim();
  if (!project) {
    res.status(400).json({ error: 'missing_project', message: 'Выберите проект.' });
    return null;
  }
  return project;
}

app.get('/api/team/mentions', teamAuth.requireTeamAuth, async (req, res) => {
  const project = requireProjectParam(req, res);
  if (!project) return;
  try {
    const list = await mentions.listMentions(config.mattermostBoardId, project);
    res.json({ mentions: list });
  } catch (err) {
    console.error('[api] /api/team/mentions GET failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.post('/api/team/mentions', teamAuth.requireTeamAuth, async (req, res) => {
  const project = requireProjectParam(req, res);
  if (!project) return;
  try {
    const user = (req.teamSession && req.teamSession.user) || {};
    const createdBy = user.username || user.email || '';
    const m = await mentions.createMention(config.mattermostBoardId, project, req.body || {}, createdBy);
    res.json({ mention: m });
  } catch (err) {
    console.error('[api] /api/team/mentions POST failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.put('/api/team/mentions/:id', teamAuth.requireTeamAuth, async (req, res) => {
  const project = requireProjectParam(req, res);
  if (!project) return;
  try {
    const m = await mentions.updateMention(req.params.id, config.mattermostBoardId, project, req.body || {});
    if (!m) return res.status(404).json({ error: 'not_found', message: 'Упоминание не найдено.' });
    res.json({ mention: m });
  } catch (err) {
    console.error('[api] /api/team/mentions PUT failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.delete('/api/team/mentions/:id', teamAuth.requireTeamAuth, async (req, res) => {
  const project = requireProjectParam(req, res);
  if (!project) return;
  try {
    const ok = await mentions.deleteMention(req.params.id, config.mattermostBoardId, project);
    if (!ok) return res.status(404).json({ error: 'not_found', message: 'Упоминание не найдено.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /api/team/mentions DELETE failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- Статистика tab: monthly rollup of mentions ---
app.get('/api/team/mentions/stats', teamAuth.requireTeamAuth, async (req, res) => {
  const project = requireProjectParam(req, res);
  if (!project) return;
  try {
    const stats = await mentions.monthlyStats(config.mattermostBoardId, project);
    res.json({ stats });
  } catch (err) {
    console.error('[api] /api/team/mentions/stats failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- Client cabinet (anonymous link mechanics, same as SMM) ---
app.get('/api/links/:token', async (req, res) => {
  const resolved = await projectSettings.resolveToken(req.params.token);
  if (!resolved) {
    return res.status(404).json({
      error: 'link_not_found',
      message: 'Ссылка недействительна или была отозвана. Обратитесь к вашему менеджеру за новой ссылкой.',
    });
  }
  try {
    const { board } = await loadBoard(resolved.boardId);
    const label = projectLabelFor(board, resolved.projectId);
    res.json({ boardId: resolved.boardId, projectId: resolved.projectId, name: label });
  } catch (err) {
    console.error('[api] /api/links/:token failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

function projectLabelFor(board, projectId) {
  const { optionLabelById, findPropertyDef } = require('./taskMapper');
  const prop = findPropertyDef(board, config.projectPropertyName);
  return prop ? optionLabelById(prop, projectId) || '' : '';
}

app.get('/api/tasks', async (req, res) => {
  const project = req.query.project || '';
  if (!project) {
    return res.status(400).json({ error: 'missing_project', message: 'Не указан проект.' });
  }
  try {
    const result = await loadTeamTasks({ project, onlyFacts: true });
    if (!result.meta.projectFilterMatched) {
      return res.status(404).json({ error: 'project_not_found', message: 'Такой проект не найден на борде.' });
    }
    res.json(result);
  } catch (err) {
    console.error('[api] /api/tasks failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

// --- Admin: client link generator + summary (requireAdminAuth) ---
app.get('/api/projects', teamAuth.requireAdminAuth, async (req, res) => {
  try {
    const { board, cards } = await loadBoard(config.mattermostBoardId);
    const projects = projectOptions(board);
    const statusOptionsList = statusOptions(board);
    const settingsMap = await settingsMapSafe();
    const data = await Promise.all(
      projects.map(async (p) => {
        const token = await projectSettings.getToken(config.mattermostBoardId, p.id);
        const facts = buildTasks(board, cards, { project: p.id, onlyFacts: true }).tasks;
        const published = facts.filter((t) => String(t.status.label || '').trim().toLowerCase() === 'опубликован');
        const reachSum = facts.reduce((acc, t) => acc + (t.uvm || 0), 0);
        const s = settingsMap.get(p.id) || {};
        return {
          projectId: p.id,
          label: p.label,
          token,
          link: `/l/${token}`,
          factsCount: facts.length,
          publishedCount: published.length,
          reachSum,
          lastPublishedDate: null,
          archived: !!s.archived,
        };
      })
    );
    res.json({ projects: data, statuses: statusOptionsList });
  } catch (err) {
    console.error('[api] /api/projects failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

app.post('/api/projects/:projectId/regenerate-link', teamAuth.requireAdminAuth, async (req, res) => {
  try {
    const token = await projectSettings.regenerateToken(config.mattermostBoardId, req.params.projectId);
    invalidate();
    res.json({ token, link: `/l/${token}` });
  } catch (err) {
    console.error('[api] regenerate-link failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- Admin: project "card" (archive flag, client identity, socials) ---
app.get('/api/admin/projects/:projectId/settings', teamAuth.requireAdminAuth, async (req, res) => {
  try {
    const settings = await projectSettings.getSettings(config.mattermostBoardId, req.params.projectId);
    res.json({ settings });
  } catch (err) {
    console.error('[api] admin settings GET failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.put('/api/admin/projects/:projectId/settings', teamAuth.requireAdminAuth, async (req, res) => {
  try {
    const settings = await projectSettings.saveSettings(config.mattermostBoardId, req.params.projectId, req.body || {});
    res.json({ settings });
  } catch (err) {
    console.error('[api] admin settings PUT failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- Ingest: search results from an external system (n8n) ---
// POST /api/cron/mentions  with header  X-Cron-Secret: <CRON_SECRET>
// The external system does the searching; the app only persists the findings
// into `mentions` in the exact shape the WEB tab renders. Idempotent: rows
// with the same (project, url) are skipped on re-run.
// Body: { items: [ { projectId?, url, source?, title?, publishedAt?,
//                    sentiment?, urgent?, comment?, sourceType? } ] }
// `projectId` may also be given at top level and inherited by all items.
app.post('/api/cron/mentions', async (req, res) => {
  const secret = config.cronSecret;
  if (!secret || req.get('X-Cron-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Cron-Secret.' });
  }
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return res.status(400).json({ error: 'empty_items', message: 'Body must contain non-empty "items" array.' });
  }
  if (items.length > 500) {
    return res.status(400).json({ error: 'too_many_items', message: 'Max 500 items per request.' });
  }
  const provider = {
    name: String(body.providerName || body.provider || '').trim().slice(0, 200) || 'n8n',
    projectId: body.projectId != null ? String(body.projectId) : undefined,
  };
  try {
    const result = await mentions.importMentions(config.mattermostBoardId, provider, items);
    res.json({ ok: true, inserted: result.inserted, skipped: result.skipped, dropped: result.dropped });
  } catch (err) {
    console.error('[api] /api/cron/mentions failed:', err.message);
    res.status(502).json({ error: 'import_failed', message: err.message });
  }
});

// --- Cron: nightly news search (called by n8n, not by the browser) ---
// POST /api/cron/search-news  with header  X-Cron-Secret: <CRON_SECRET>
// Runs every active search scenario (project + keywords + sources) for the
// last N days and stores matches in `mentions` (source_type='auto_search').
// The app itself only reads and displays; all searching is delegated to n8n.
app.post('/api/cron/search-news', async (req, res) => {
  const secret = config.cronSecret;
  if (!secret || req.get('X-Cron-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Cron-Secret.' });
  }
  const days = parseInt(req.body && req.body.days, 10) || 7;
  if (days < 1 || days > 30) {
    return res.status(400).json({ error: 'bad_days', message: 'days must be between 1 and 30.' });
  }
  try {
    const active = await scenarios.listActiveScenarios(config.mattermostBoardId);
    const summary = await newsSearcher.runScenarios(config.mattermostBoardId, active, { days, createdBy: 'n8n-cron' });
    const totalInserted = summary.reduce((a, s) => a + (s.inserted || 0), 0);
    res.json({ ok: true, days, scenarios: active.length, inserted: totalInserted, summary });
  } catch (err) {
    console.error('[api] /api/cron/search-news failed:', err.message);
    res.status(502).json({ error: 'search_failed', message: err.message });
  }
});

// --- Team cabinet: search scenarios (the "filters" n8n runs) ---
app.get('/api/team/search-scenarios', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const list = await scenarios.listScenarios(config.mattermostBoardId);
    res.json({ scenarios: list });
  } catch (err) {
    console.error('[api] /api/team/search-scenarios GET failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.post('/api/team/search-scenarios', teamAuth.requireTeamAuth, async (req, res) => {
  const projectId = String((req.body && req.body.projectId) || '').trim();
  if (!projectId) return res.status(400).json({ error: 'missing_project', message: 'Выберите проект.' });
  try {
    const user = (req.teamSession && req.teamSession.user) || {};
    const createdBy = user.username || user.email || '';
    const s = await scenarios.createScenario(config.mattermostBoardId, projectId, req.body || {}, createdBy);
    res.json({ scenario: s });
  } catch (err) {
    console.error('[api] /api/team/search-scenarios POST failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.put('/api/team/search-scenarios/:id', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const s = await scenarios.updateScenario(req.params.id, config.mattermostBoardId, req.body || {});
    if (!s) return res.status(404).json({ error: 'not_found', message: 'Сценарий не найден.' });
    res.json({ scenario: s });
  } catch (err) {
    console.error('[api] /api/team/search-scenarios PUT failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

app.delete('/api/team/search-scenarios/:id', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const ok = await scenarios.deleteScenario(req.params.id, config.mattermostBoardId);
    if (!ok) return res.status(404).json({ error: 'not_found', message: 'Сценарий не найден.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] /api/team/search-scenarios DELETE failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- Static frontend (same layout as SMM) ---
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(
  express.static(frontendDir, {
    setHeaders: (res, filePath) => {
      if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  })
);

app.get('/l/:token', (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));
app.get(config.adminPath, teamAuth.requireAdminAuth, (req, res) => res.sendFile(path.join(frontendDir, 'admin.html')));
app.get(config.teamCabinetPath, (req, res) => res.sendFile(path.join(frontendDir, 'team.html')));
app.get('/', (req, res) => res.redirect(config.teamCabinetPath));

async function waitForDb(maxAttempts = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.initSchema();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      console.warn(`[startup] database not ready yet (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

(async () => {
  try {
    await waitForDb();
    await teamAuth.restoreSessions();
  } catch (err) {
    console.error('[startup] database init failed — client links/sessions will not work:', err.message);
  }
  app.listen(config.port, () => {
    console.log(`PR-мониторинг слушает на :${config.port}`);
    if (!config.mattermostUrl) {
      console.warn('[startup] MATTERMOST_URL not set — API calls will fail until configured.');
    }
    if (!config.databaseUrl) {
      console.warn('[startup] DATABASE_URL not set — client links will not work until Postgres is configured.');
    }
  });
})();
