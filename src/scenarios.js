// Search scenarios ("filters") the team configures from the cabinet.
// Stored per board+project; executed externally by n8n via the cron endpoint.
// The app persists results into `mentions` (source_type='auto') for display.

const db = require('./db');

function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function rowToScenario(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name || '',
    keywords: toArray(row.keywords),
    sources: toArray(row.sources),
    negativeKeywords: toArray(row.negative_keywords),
    positiveKeywords: toArray(row.positive_keywords),
    query: row.query || '',
    feedUrl: row.feed_url || '',
    archived: !!row.archived,
    createdBy: row.created_by || '',
    updatedAt: row.updated_at,
  };
}

async function listScenarios(boardId, { includeArchived = false } = {}) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT * FROM search_scenarios
     WHERE board_id = $1${includeArchived ? '' : ' AND archived = false'}
     ORDER BY updated_at DESC`,
    [boardId]
  );
  return rows.map(rowToScenario);
}

async function getScenario(id, boardId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT * FROM search_scenarios WHERE id = $1 AND board_id = $2',
    [id, boardId]
  );
  return rows[0] ? rowToScenario(rows[0]) : null;
}

async function createScenario(boardId, projectId, data, createdBy) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO search_scenarios (board_id, project_id, name, keywords, sources, negative_keywords, positive_keywords, query, feed_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      boardId,
      projectId,
      String(data.name || '').trim().slice(0, 300),
      toArray(data.keywords).slice(0, 50).map((s) => s.slice(0, 200)),
      toArray(data.sources).slice(0, 50).map((s) => s.slice(0, 500)),
      toArray(data.negativeKeywords).slice(0, 50).map((s) => s.slice(0, 200)),
      toArray(data.positiveKeywords).slice(0, 50).map((s) => s.slice(0, 200)),
      String(data.query || '').trim().slice(0, 1000),
      String(data.feedUrl || '').trim().slice(0, 1000),
      String(createdBy || '').slice(0, 200),
    ]
  );
  return rowToScenario(rows[0]);
}

async function updateScenario(id, boardId, data) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `UPDATE search_scenarios SET
       project_id = $10,
       name = $3,
       keywords = $4::text[],
       sources = $5::text[],
       negative_keywords = $6::text[],
       positive_keywords = $7::text[],
       query = $8,
       feed_url = $11,
       archived = $9,
       updated_at = now()
     WHERE id = $1 AND board_id = $2
     RETURNING *`,
    [
      id,
      boardId,
      String(data.name || '').trim().slice(0, 300),
      toArray(data.keywords).slice(0, 50).map((s) => s.slice(0, 200)),
      toArray(data.sources).slice(0, 50).map((s) => s.slice(0, 500)),
      toArray(data.negativeKeywords).slice(0, 50).map((s) => s.slice(0, 200)),
      toArray(data.positiveKeywords).slice(0, 50).map((s) => s.slice(0, 200)),
      String(data.query || '').trim().slice(0, 1000),
      !!data.archived,
      String(data.projectId || '').slice(0, 100),
      String(data.feedUrl || '').trim().slice(0, 1000),
    ]
  );
  return rows[0] ? rowToScenario(rows[0]) : null;
}

async function deleteScenario(id, boardId) {
  const pool = db.requirePool();
  const { rowCount } = await pool.query(
    'DELETE FROM search_scenarios WHERE id = $1 AND board_id = $2',
    [id, boardId]
  );
  return rowCount > 0;
}

// All non-archived scenarios for a board, enriched with the project label.
async function listActiveScenarios(boardId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT * FROM search_scenarios WHERE board_id = $1 AND archived = false ORDER BY project_id, updated_at DESC',
    [boardId]
  );
  return rows.map(rowToScenario);
}

module.exports = {
  listScenarios,
  getScenario,
  createScenario,
  updateScenario,
  deleteScenario,
  listActiveScenarios,
};
