// Search automation logs — each run of a search scenario that the external
// system (n8n) reports. The team cabinet reads them in the "Логи поиска"
// popup to see whether a filter actually ran (and what came out of it).

const db = require('./db');

const SEVERITIES = ['info', 'debug', 'important'];

function normSeverity(s) {
  return SEVERITIES.includes(s) ? s : 'info';
}

function rowToLog(r) {
  return {
    id: r.id,
    scenarioId: r.scenario_id != null ? r.scenario_id : null,
    scenarioName: r.scenario_name || '',
    status: r.status || 'ok',
    note: r.note || '',
    severity: normSeverity(r.severity),
    createdBy: r.created_by || '',
    createdAt: r.created_at,
  };
}

// Ingest a batch of run reports. `provider` mirrors the mentions provider
// (name shown as createdBy). Items:
//   { scenarioId?, scenarioName?, status?, note?, severity? }
async function insertLogs(boardId, provider, items) {
  const pool = db.requirePool();
  const createdBy = String((provider && provider.name) || 'external');

  let inserted = 0;
  for (const raw of items || []) {
    if (!raw) continue;
    const name = String(raw.scenarioName || '').trim().slice(0, 300);
    if (!name) continue;
    const { rows } = await pool.query(
      `INSERT INTO search_logs (board_id, scenario_id, scenario_name, status, note, severity, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        boardId,
        raw.scenarioId != null ? Number(raw.scenarioId) || null : null,
        name,
        String(raw.status || '').trim().slice(0, 50) || 'ok',
        String(raw.note || '').trim().slice(0, 1000),
        normSeverity(raw.severity),
        createdBy,
      ]
    );
    if (rows.length) inserted++;
  }
  return { inserted };
}

async function listLogs(boardId, { limit = 100, severity = '' } = {}) {
  const pool = db.requirePool();
  const params = [boardId];
  let where = 'board_id = $1';
  if (severity && SEVERITIES.includes(severity)) {
    params.push(severity);
    where += ` AND severity = $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const { rows } = await pool.query(
    `SELECT * FROM search_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(rowToLog);
}

module.exports = { insertLogs, listLogs, SEVERITIES };