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

// --- Project "card": archive flag, client identity, speaker profile, socials ---

function rowToSettings(row) {
  if (!row) {
    return {
      archived: false,
      clientNameRu: '',
      clientNameEn: '',
      ceoName: '',
      website: '',
      socialLinks: [],
      speakerProfile: '',
      otherInfo: '',
    };
  }
  let socialLinks = [];
  try {
    socialLinks = Array.isArray(row.social_links) ? row.social_links : JSON.parse(row.social_links || '[]');
  } catch (e) {
    socialLinks = [];
  }
  return {
    archived: !!row.archived,
    clientNameRu: row.client_name_ru || '',
    clientNameEn: row.client_name_en || '',
    ceoName: row.ceo_name || '',
    website: row.website || '',
    socialLinks,
    speakerProfile: row.speaker_profile || '',
    otherInfo: row.other_info || '',
  };
}

async function getSettings(boardId, projectId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT * FROM project_settings WHERE board_id = $1 AND project_id = $2',
    [boardId, projectId]
  );
  return rowToSettings(rows[0]);
}

// boardId -> Map<projectId, settings>. Used to filter archived projects out
// of team-facing endpoints without one query per project.
async function listSettingsMap(boardId) {
  const pool = db.requirePool();
  const { rows } = await pool.query('SELECT * FROM project_settings WHERE board_id = $1', [boardId]);
  const map = new Map();
  rows.forEach((r) => map.set(r.project_id, rowToSettings(r)));
  return map;
}

async function saveSettings(boardId, projectId, data) {
  await ensureRow(boardId, projectId);
  const pool = db.requirePool();
  const socialLinks = Array.isArray(data.socialLinks)
    ? data.socialLinks
        .filter((l) => l && (l.platform || l.url))
        .map((l) => ({
          platform: String(l.platform || '').trim().slice(0, 60),
          url: String(l.url || '').trim().slice(0, 500),
        }))
    : [];
  await pool.query(
    `UPDATE project_settings SET
       archived = $3,
       client_name_ru = $4,
       client_name_en = $5,
       ceo_name = $6,
       website = $7,
       social_links = $8::jsonb,
       speaker_profile = $9,
       other_info = $10,
       updated_at = now()
     WHERE board_id = $1 AND project_id = $2`,
    [
      boardId,
      projectId,
      !!data.archived,
      String(data.clientNameRu || '').slice(0, 300),
      String(data.clientNameEn || '').slice(0, 300),
      String(data.ceoName || '').slice(0, 300),
      String(data.website || '').slice(0, 500),
      JSON.stringify(socialLinks),
      String(data.speakerProfile || '').slice(0, 4000),
      String(data.otherInfo || '').slice(0, 4000),
    ]
  );
  return getSettings(boardId, projectId);
}

module.exports = {
  getToken,
  regenerateToken,
  resolveToken,
  getTokenUpdatedAt,
  getSettings,
  listSettingsMap,
  saveSettings,
};
