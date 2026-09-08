// Manually-logged web mentions for the "WEB" tab (team cabinet).
// Backed by Postgres (see db.js#initSchema -> `mentions` table).
// Stand-in for the phase-2 search pipeline: staff log reprints/comments by
// hand (url, source, date, sentiment, urgent flag, comment); the same shape
// will later be filled in automatically.

const db = require('./db');

const SENTIMENTS = ['positive', 'neutral', 'negative'];

function normSentiment(s) {
  return SENTIMENTS.includes(s) ? s : 'neutral';
}

function rowToMention(r) {
  return {
    id: r.id,
    url: r.url || '',
    source: r.source || '',
    publishedAt: r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '',
    sentiment: r.sentiment || 'neutral',
    urgent: !!r.urgent,
    comment: r.comment || '',
    createdBy: r.created_by || '',
    createdAt: r.created_at,
  };
}

async function listMentions(boardId, projectId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT * FROM mentions WHERE board_id = $1 AND project_id = $2
     ORDER BY published_at DESC NULLS LAST, created_at DESC`,
    [boardId, projectId]
  );
  return rows.map(rowToMention);
}

async function createMention(boardId, projectId, data, createdBy) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `INSERT INTO mentions (board_id, project_id, url, source, published_at, sentiment, urgent, comment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      boardId,
      projectId,
      String(data.url || '').trim().slice(0, 1000),
      String(data.source || '').trim().slice(0, 300),
      data.publishedAt || null,
      normSentiment(data.sentiment),
      !!data.urgent,
      String(data.comment || '').trim().slice(0, 4000),
      String(createdBy || '').slice(0, 200),
    ]
  );
  return rowToMention(rows[0]);
}

async function updateMention(id, boardId, projectId, data) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `UPDATE mentions SET
       url = $4, source = $5, published_at = $6, sentiment = $7, urgent = $8, comment = $9, updated_at = now()
     WHERE id = $1 AND board_id = $2 AND project_id = $3
     RETURNING *`,
    [
      id,
      boardId,
      projectId,
      String(data.url || '').trim().slice(0, 1000),
      String(data.source || '').trim().slice(0, 300),
      data.publishedAt || null,
      normSentiment(data.sentiment),
      !!data.urgent,
      String(data.comment || '').trim().slice(0, 4000),
    ]
  );
  return rows[0] ? rowToMention(rows[0]) : null;
}

async function deleteMention(id, boardId, projectId) {
  const pool = db.requirePool();
  const { rowCount } = await pool.query(
    'DELETE FROM mentions WHERE id = $1 AND board_id = $2 AND project_id = $3',
    [id, boardId, projectId]
  );
  return rowCount > 0;
}

// Monthly rollup for the "Статистика" tab. mediaIndex is a simple net-sentiment
// score (positive count minus negative count) per month — transparent and
// cheap to compute from manually-tagged mentions; can be swapped for a
// weighted/reach-based formula once the search pipeline supplies volume.
async function monthlyStats(boardId, projectId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `SELECT
       to_char(COALESCE(published_at, created_at::date), 'YYYY-MM') AS month,
       count(*) FILTER (WHERE sentiment = 'positive') AS positive,
       count(*) FILTER (WHERE sentiment = 'neutral') AS neutral,
       count(*) FILTER (WHERE sentiment = 'negative') AS negative,
       count(*) AS total
     FROM mentions
     WHERE board_id = $1 AND project_id = $2
     GROUP BY 1
     ORDER BY 1`,
    [boardId, projectId]
  );
  return rows.map((r) => {
    const positive = parseInt(r.positive, 10) || 0;
    const neutral = parseInt(r.neutral, 10) || 0;
    const negative = parseInt(r.negative, 10) || 0;
    const total = parseInt(r.total, 10) || 0;
    return { month: r.month, positive, neutral, negative, total, mediaIndex: positive - negative };
  });
}

module.exports = { listMentions, createMention, updateMention, deleteMention, monthlyStats, SENTIMENTS };
