// Media sources / sites library. A project ("клиент") has a core of ~20 media
// outlets; sources are managed in the team cabinet and referenced from search
// scenarios later. Every row belongs to a board (Mattermost) and optionally to
// a project (empty = shared pool usable by all projects).

const db = require('./db');

const TYPES = ['smi', 'portal', 'aggregator', 'telegram', 'other'];
const LANGS = ['ru', 'en', 'other'];
const STATUSES = ['active', 'paused'];

function normType(t) {
  return TYPES.includes(t) ? t : 'smi';
}

function normLang(l) {
  return LANGS.includes(l) ? l : 'ru';
}

function normStatus(s) {
  return STATUSES.includes(s) ? s : 'active';
}

function parseUrl(u) {
  return String(u || '').trim().slice(0, 500);
}

function rowToSource(r) {
  return {
    id: r.id,
    projectId: r.project_id || '',
    name: r.name || '',
    url: r.url || '',
    type: normType(r.type),
    lang: normLang(r.lang),
    region: r.region || '',
    status: normStatus(r.status),
    createdBy: r.created_by || '',
    createdAt: r.created_at,
  };
}

async function listSources(boardId, { project = '', q = '', status = '', type = '', lang = '' } = {}) {
  const pool = db.requirePool();
  const clauses = ['board_id = $1'];
  const params = [boardId];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (project) {
    clauses.push(`(project_id = ${push(project)} OR project_id = '')`);
  }
  if (status && STATUSES.includes(status)) clauses.push(`status = ${push(status)}`);
  if (type && TYPES.includes(type)) clauses.push(`type = ${push(type)}`);
  if (lang && LANGS.includes(lang)) clauses.push(`lang = ${push(lang)}`);
  if (q) {
    clauses.push(`(name ILIKE ${push('%' + q + '%')} OR url ILIKE ${push('%' + q + '%')})`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM sources WHERE ${clauses.join(' AND ')} ORDER BY name ASC`,
    params
  );
  return rows.map(rowToSource);
}

async function createSource(boardId, { projectId, name, url, type, lang, region, status }, createdBy = '') {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO sources (board_id, project_id, name, url, type, lang, region, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      boardId,
      String(projectId || '').trim().slice(0, 100),
      String(name || '').trim().slice(0, 200),
      parseUrl(url),
      normType(type),
      normLang(lang),
      String(region || '').trim().slice(0, 100),
      normStatus(status),
      String(createdBy || '').trim().slice(0, 200),
    ]
  );
  return rowToSource(rows[0]);
}

async function updateSource(boardId, id, patch = {}) {
  const pool = db.requirePool();
  const fields = [];
  const params = [boardId, id];
  const push = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const setters = [];
  if (patch.projectId !== undefined) setters.push(`project_id = ${push(String(patch.projectId || '').trim().slice(0, 100))}`);
  if (patch.name !== undefined) setters.push(`name = ${push(String(patch.name || '').trim().slice(0, 200))}`);
  if (patch.url !== undefined) setters.push(`url = ${push(parseUrl(patch.url))}`);
  if (patch.type !== undefined) setters.push(`type = ${push(normType(patch.type))}`);
  if (patch.lang !== undefined) setters.push(`lang = ${push(normLang(patch.lang))}`);
  if (patch.region !== undefined) setters.push(`region = ${push(String(patch.region || '').trim().slice(0, 100))}`);
  if (patch.status !== undefined) setters.push(`status = ${push(normStatus(patch.status))}`);
  if (!setters.length) return null;
  setters.push(`updated_at = now()`);
  const { rows } = await pool.query(
    `UPDATE sources SET ${setters.join(', ')} WHERE board_id = $1 AND id = $2 RETURNING *`,
    params
  );
  return rows.length ? rowToSource(rows[0]) : null;
}

async function deleteSource(boardId, id) {
  const pool = db.requirePool();
  const { rowCount } = await pool.query('DELETE FROM sources WHERE board_id = $1 AND id = $2', [boardId, id]);
  return rowCount > 0;
}

module.exports = { listSources, createSource, updateSource, deleteSource, TYPES, LANGS, STATUSES };