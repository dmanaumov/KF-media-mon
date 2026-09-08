const crypto = require('crypto');
const db = require('./db');

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

async function ensureRow(boardId, projectId) {
  const pool = db.requirePool();
  const existing = await pool.query(
    'SELECT link_token FROM project_settings WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  if (existing.rows.length) return existing.rows[0].link_token;
  const token = newToken();
  await pool.query(
    `INSERT INTO project_settings (board_id, project_id, link_token)
     VALUES ($1, $2, $3)
     ON CONFLICT (board_id, project_id) DO NOTHING`,
    [boardId, projectId, token]
  );
  const row = await pool.query(
    'SELECT link_token FROM project_settings WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  return row.rows[0].link_token;
}

async function getToken(boardId, projectId) {
  return ensureRow(boardId, projectId);
}

async function regenerateToken(boardId, projectId) {
  const pool = db.requirePool();
  const token = newToken();
  await pool.query(
    `INSERT INTO project_settings (board_id, project_id, link_token, link_token_updated_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (board_id, project_id)
     DO UPDATE SET link_token = EXCLUDED.link_token, link_token_updated_at = now(), updated_at = now()`,
    [boardId, projectId, token]
  );
  return token;
}

async function resolveToken(token) {
  if (!token) return null;
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT board_id, project_id FROM project_settings WHERE link_token = $1',
    [token]
  );
  if (!rows.length) return null;
  return { boardId: rows[0].board_id, projectId: rows[0].project_id };
}

async function getTokenUpdatedAt(boardId, projectId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT link_token, link_token_updated_at FROM project_settings WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  return rows[0] || null;
}

module.exports = {
  getToken,
  regenerateToken,
  resolveToken,
  getTokenUpdatedAt,
};