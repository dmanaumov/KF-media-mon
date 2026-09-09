const express = require('express');
const compression = require('compression');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./openapi.json');
const config = require('./config');
const mm = require('./mattermostClient');
const db = require('./db');
const teamAuth = require('./teamAuth');
const projectSettings = require('./projectSettings');
const mentions = require('./mentions');
const { buildTasks, buildTaskDetail, projectOptions, statusOptions, assigneeOptions, findPropertyDef } = require('./taskMapper');
const scenarios = require('./scenarios');
const searchLogs = require('./searchLogs');

const app = express();
app.use(compression());
// Raised from the default 100kb: attachment uploads on a task card arrive as
// base64 JSON (POST /api/team/tasks/:id/attachments), which runs ~33% larger
// than the raw file — capped at 8MB raw in that route, so ~11MB encoded.
app.use(express.json({ limit: '12mb' }));

// --- Board loading with lazy TTL cache (matches SMM: in-memory only) ---
const boardCache = new Map(); // boardId -> { expires, board, cards }
let teamMembersCache = { expires: 0, members: [] };

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

// Team members change rarely — cache for a few minutes regardless of the
// (much shorter) board TTL, so opening the assignee picker doesn't always
// cost a round trip to Mattermost's core API.
async function loadTeamMembers({ fresh = false } = {}) {
  if (!fresh && teamMembersCache.expires > Date.now()) return teamMembersCache.members;
  try {
    const members = await mm.listTeamMembers(config.teamId);
    teamMembersCache = { members, expires: Date.now() + 5 * 60 * 1000 };
    return members;
  } catch (err) {
    console.error('[api] loadTeamMembers failed:', err.message);
    return teamMembersCache.members; // stale-but-something beats a broken picker
  }
}

async function loadTeamTasks(opts = {}) {
  const [{ board, cards }, members] = await Promise.all([
    loadBoard(config.mattermostBoardId, { fresh: !!opts.fresh }),
    loadTeamMembers(),
  ]);
  return buildTasks(board, cards, { ...opts, members });
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

// --- Task card: full detail + edit (writes go straight to the Mattermost
// board — this is the same card the whole team already works from, not a
// local copy). Property writes always re-fetch the card fresh and merge
// onto its CURRENT full properties object before patching: Focalboard's
// PATCH replaces the whole `properties` field wholesale, so patching from a
// stale or partial object would silently wipe sibling fields (status,
// project, etc.) that nobody meant to touch. ---
async function findCardFresh(cardId) {
  const { board, cards } = await loadBoard(config.mattermostBoardId, { fresh: true });
  const card = cards.find((c) => c.id === cardId && !c.deleteAt);
  return { board, card };
}

app.get('/api/team/tasks/:id', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const { board, card } = await findCardFresh(req.params.id);
    if (!card) return res.status(404).json({ error: 'not_found', message: 'Задача не найдена.' });
    const [blocks, members] = await Promise.all([
      mm.listBlocks(config.mattermostBoardId),
      loadTeamMembers(),
    ]);
    const detail = buildTaskDetail(board, card, blocks, members);
    res.json({
      task: detail,
      meta: {
        statuses: statusOptions(board),
        projects: projectOptions(board),
        assignee: assigneeOptions(board, members),
      },
    });
  } catch (err) {
    console.error('[api] GET /api/team/tasks/:id failed:', err.message);
    res.status(502).json({ error: 'mattermost_unavailable', message: err.message });
  }
});

app.patch('/api/team/tasks/:id', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const { board, card } = await findCardFresh(req.params.id);
    if (!card) return res.status(404).json({ error: 'not_found', message: 'Задача не найдена.' });
    const body = req.body || {};

    const projectProp = findPropertyDef(board, config.projectPropertyName);
    const statusProp = findPropertyDef(board, config.statusPropertyName);
    const deadlineProp = findPropertyDef(board, config.datePropertyName);
    const smiProp = findPropertyDef(board, config.smiPropertyName);
    const urlProp = findPropertyDef(board, config.urlPropertyName);
    const uvmProp = findPropertyDef(board, config.uvmPropertyName);
    const assigneeProp = findPropertyDef(board, config.assigneePropertyName);

    const newProps = { ...(card.properties || {}) };
    if (projectProp && body.projectId !== undefined) newProps[projectProp.id] = body.projectId || '';
    if (statusProp && body.statusId !== undefined) newProps[statusProp.id] = body.statusId || '';
    if (smiProp && body.smi !== undefined) newProps[smiProp.id] = String(body.smi || '');
    if (urlProp && body.url !== undefined) newProps[urlProp.id] = String(body.url || '');
    if (uvmProp && body.uvm !== undefined) newProps[uvmProp.id] = body.uvm === null || body.uvm === '' ? '' : String(body.uvm);
    if (assigneeProp && body.assigneeId !== undefined) newProps[assigneeProp.id] = body.assigneeId || '';
    if (deadlineProp && body.deadline !== undefined) {
      newProps[deadlineProp.id] = body.deadline ? JSON.stringify({ from: Date.parse(`${body.deadline}T00:00:00Z`) }) : '';
    }

    const patch = { updatedFields: { properties: newProps } };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title) patch.title = title;
    await mm.patchBlock(config.mattermostBoardId, card.id, patch);

    if (body.text !== undefined) {
      const blocks = await mm.listBlocks(config.mattermostBoardId);
      const existing = blocks.find((b) => b.parentId === card.id && b.type === 'text' && !b.deleteAt);
      const text = String(body.text || '');
      if (existing) {
        await mm.patchBlock(config.mattermostBoardId, existing.id, { title: text });
      } else if (text.trim()) {
        await mm.insertBlocks(config.mattermostBoardId, [{
          id: '', boardId: config.mattermostBoardId, parentId: card.id, type: 'text',
          title: text, fields: {}, createAt: Date.now(), updateAt: Date.now(), deleteAt: 0,
        }]);
      }
    }

    invalidate();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] PATCH /api/team/tasks/:id failed:', err.message);
    res.status(502).json({ error: 'mattermost_write_failed', message: err.message });
  }
});

app.post('/api/team/tasks/:id/comments', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'empty_comment', message: 'Пустой комментарий.' });
    const { card } = await findCardFresh(req.params.id);
    if (!card) return res.status(404).json({ error: 'not_found', message: 'Задача не найдена.' });
    await mm.insertBlocks(config.mattermostBoardId, [{
      id: '', boardId: config.mattermostBoardId, parentId: card.id, type: 'comment',
      title: text, fields: {}, createAt: Date.now(), updateAt: Date.now(), deleteAt: 0,
    }]);
    invalidate();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] POST /api/team/tasks/:id/comments failed:', err.message);
    res.status(502).json({ error: 'mattermost_write_failed', message: err.message });
  }
});

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
app.post('/api/team/tasks/:id/attachments', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const { filename, mimeType, dataBase64 } = req.body || {};
    if (!filename || !dataBase64) return res.status(400).json({ error: 'missing_file', message: 'Файл не передан.' });
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: 'file_too_large', message: 'Файл больше 8 МБ.' });
    }
    const { card } = await findCardFresh(req.params.id);
    if (!card) return res.status(404).json({ error: 'not_found', message: 'Задача не найдена.' });
    const fileId = await mm.uploadFile(config.teamId, config.mattermostBoardId, buffer, filename, mimeType);
    const isImage = /^image\//.test(mimeType || '');
    await mm.insertBlocks(config.mattermostBoardId, [{
      id: '', boardId: config.mattermostBoardId, parentId: card.id,
      type: isImage ? 'image' : 'attachment',
      title: filename,
      fields: { fileId },
      createAt: Date.now(), updateAt: Date.now(), deleteAt: 0,
    }]);
    invalidate();
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] POST /api/team/tasks/:id/attachments failed:', err.message);
    res.status(502).json({ error: 'mattermost_write_failed', message: err.message });
  }
});

app.get('/api/team/tasks/:id/attachments/:fileId', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const mmRes = await mm.getFile(config.teamId, config.mattermostBoardId, req.params.fileId);
    res.setHeader('Content-Type', mmRes.headers.get('content-type') || 'application/octet-stream');
    mmRes.body.pipe(res);
  } catch (err) {
    console.error('[api] GET /api/team/tasks/:id/attachments/:fileId failed:', err.message);
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
// POST /api/cron/mentions  with header  X-Automation-Api-Key: <AUTOMATION_API_KEY>
// The external system does the searching; the app only persists the findings
// into `mentions` in the exact shape the WEB tab renders. Idempotent: rows
// with the same (project, url) are skipped on re-run.
// Body: { items: [ { projectId?, url, source?, title?, publishedAt?,
//                    sentiment?, urgent?, comment?, sourceType? } ] }
// `projectId` may also be given at top level and inherited by all items.
app.post('/api/cron/mentions', async (req, res) => {
  const secret = config.automationApiKey;
  if (!secret || req.get('X-Automation-Api-Key') !== secret) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Automation-Api-Key.' });
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

// --- Cron: active search scenarios for the external automation (n8n) ---
// GET /api/cron/scenarios  with header  X-Automation-Api-Key: <AUTOMATION_API_KEY>
// Returns only non-archived scenarios — the "current filters" the automation
// should run. The automation then does the searching and pushes findings to
// POST /api/cron/mentions.
app.get('/api/cron/scenarios', async (req, res) => {
  const secret = config.automationApiKey;
  if (!secret || req.get('X-Automation-Api-Key') !== secret) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Automation-Api-Key.' });
  }
  try {
    const list = await scenarios.listActiveScenarios(config.mattermostBoardId);
    res.json({
      boardId: config.mattermostBoardId,
      scenarios: list.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        name: s.name,
        keywords: s.keywords,
        sources: s.sources,
        negativeKeywords: s.negativeKeywords,
        positiveKeywords: s.positiveKeywords,
        regex: s.regex,
        feedUrl: s.feedUrl,
      })),
    });
  } catch (err) {
    console.error('[api] /api/cron/scenarios failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- Ingest: run reports from the external automation (n8n) ---
// POST /api/cron/search-logs  with header  X-Automation-Api-Key
// The automation reports that it ran a scenario: what came out of it and any
// notes. Body: { providerName?, items: [ { scenarioId?, scenarioName, status?,
// note?, severity? } ] }; severity ∈ info | debug | important.
app.post('/api/cron/search-logs', async (req, res) => {
  const secret = config.automationApiKey;
  if (!secret || req.get('X-Automation-Api-Key') !== secret) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Automation-Api-Key.' });
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
  };
  try {
    const result = await searchLogs.insertLogs(config.mattermostBoardId, provider, items);
    res.json({ ok: true, inserted: result.inserted });
  } catch (err) {
    console.error('[api] /api/cron/search-logs failed:', err.message);
    res.status(502).json({ error: 'insert_failed', message: err.message });
  }
});

// --- Team cabinet: search scenarios (the "filters" n8n runs) ---
app.get('/api/team/search-scenarios', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const list = await scenarios.listScenarios(config.mattermostBoardId, { includeArchived: true });
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

// --- Team cabinet: search automation logs ---
// GET /api/team/search-logs?limit=100&severity=info|debug|important
app.get('/api/team/search-logs', teamAuth.requireTeamAuth, async (req, res) => {
  try {
    const logs = await searchLogs.listLogs(config.mattermostBoardId, {
      limit: req.query.limit,
      severity: String(req.query.severity || ''),
      project: String(req.query.project || ''),
    });
    res.json({ logs });
  } catch (err) {
    console.error('[api] /api/team/search-logs GET failed:', err.message);
    res.status(502).json({ error: 'db_error', message: err.message });
  }
});

// --- OpenAPI / Swagger ---
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: 'PR-мониторинг API',
  swaggerOptions: {
    defaultModelsExpandDepth: -1, // show models collapsed, but expandable
    defaultModelExpandDepth: 10,  // keep model fields expanded inside the docs
    persistAuthorization: true,
    displayRequestDuration: true,
  },
}));
app.get('/api/docs.json', (req, res) => res.json(swaggerDocument));

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
