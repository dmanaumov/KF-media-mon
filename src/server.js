const express = require('express');
const compression = require('compression');
const path = require('path');
const config = require('./config');
const mm = require('./mattermostClient');
const db = require('./db');
const teamAuth = require('./teamAuth');
const projectSettings = require('./projectSettings');
const { buildTasks, projectOptions, statusOptions } = require('./taskMapper');

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
    res.json({ projects: projectOptions(board) });
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
    res.json(result);
  } catch (err) {
    console.error('[api] /api/team/tasks failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
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
    const data = await Promise.all(
      projects.map(async (p) => {
        const token = await projectSettings.getToken(config.mattermostBoardId, p.id);
        const facts = buildTasks(board, cards, { project: p.id, onlyFacts: true }).tasks;
        const published = facts.filter((t) => String(t.status.label || '').trim().toLowerCase() === 'опубликован');
        const reachSum = facts.reduce((acc, t) => acc + (t.uvm || 0), 0);
        return {
          projectId: p.id,
          label: p.label,
          token,
          link: `/l/${token}`,
          factsCount: facts.length,
          publishedCount: published.length,
          reachSum,
          lastPublishedDate: null,
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