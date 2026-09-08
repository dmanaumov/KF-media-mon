// Manually-logged web mentions for the "WEB" tab (team cabinet).
// Backed by Postgres (see db.js#initSchema -> `mentions` table).
// Stand-in for the phase-2 search pipeline: staff log reprints/comments by
// hand (url, source, date, sentiment, urgent flag, comment); the same shape
// will later be filled in automatically.

const db = require('./db');

const SENTIMENTS = ['positive', 'neutral', 'negative'];
const EVENT_TYPES = ['article', 'news'];

function normSentiment(s) {
  return SENTIMENTS.includes(s) ? s : 'neutral';
}

function normEventType(s) {
  return EVENT_TYPES.includes(s) ? s : 'news';
}

function rowToMention(r) {
  return {
    id: r.id,
    url: r.url || '',
    source: r.source || '',
    publishedAt: r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '',
    sentiment: r.sentiment || 'neutral',
    urgent: !!r.urgent,
    eventType: normEventType(r.event_type),
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
    `INSERT INTO mentions (board_id, project_id, url, source, published_at, sentiment, urgent, comment, event_type, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      boardId,
      projectId,
      String(data.url || '').trim().slice(0, 1000),
      String(data.source || '').trim().slice(0, 300),
      data.publishedAt || null,
      normSentiment(data.sentiment),
      !!data.urgent,
      String(data.comment || '').trim().slice(0, 4000),
      normEventType(data.eventType),
      String(createdBy || '').slice(0, 200),
    ]
  );
  return rowToMention(rows[0]);
}

async function updateMention(id, boardId, projectId, data) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    `UPDATE mentions SET
       url = $4, source = $5, published_at = $6, sentiment = $7, urgent = $8, comment = $9, event_type = $10, updated_at = now()
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
      normEventType(data.eventType),
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

// Ingest a batch of search results from an external system (n8n). Each item
// is validated/normalized before insert; rows whose (board_id, project_id,
// url) already exist are skipped, so re-runs of the same feed are idempotent.
// Returns { inserted, skipped, dropped } — dropped entries carry a reason for
// anything the endpoint could not store.
async function importMentions(boardId, provider, items) {
  const pool = db.requirePool();
  const createdBy = String((provider && provider.name) || 'external');

  let inserted = 0;
  let skipped = 0;
  const dropped = [];

  for (let i = 0; i < (items || []).length; i++) {
    const raw = items[i] || {};
    const projectId = String(raw.projectId != null && raw.projectId !== '' ? raw.projectId : (provider || {}).projectId || '').trim();
    const url = String(raw.url || '').trim().slice(0, 1000);
    if (!projectId) {
      dropped.push({ index: i, reason: 'missing_projectId' });
      continue;
    }
    if (!url) {
      dropped.push({ index: i, reason: 'missing_url' });
      continue;
    }
    try {
      const params = [
        boardId,
        projectId,
        url,
        String(raw.source || '').trim().slice(0, 300),
        String(raw.title || raw.comment || '').trim().slice(0, 500),
        raw.publishedAt || raw.published_at || null,
        normSentiment(raw.sentiment),
        !!raw.urgent,
        String(raw.comment || raw.snippet || '').trim().slice(0, 4000),
        createdBy,
        String(raw.sourceType || 'auto').slice(0, 50),
        normEventType(raw.eventType || raw.event_type),
      ];
      const res = await pool.query(
        `INSERT INTO mentions (board_id, project_id, url, source, title, published_at, sentiment, urgent, comment, created_by, source_type, event_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (board_id, project_id, url) DO NOTHING
         RETURNING id`,
        params
      );
      if (res.rowCount > 0) inserted++;
      else skipped++;
    } catch (err) {
      console.warn('[mentions] import row failed:', err.message);
      dropped.push({ index: i, reason: 'db_error', message: err.message });
    }
  }

  return { inserted, skipped, dropped };
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

module.exports = { listMentions, createMention, updateMention, deleteMention, importMentions, monthlyStats, SENTIMENTS, EVENT_TYPES };
