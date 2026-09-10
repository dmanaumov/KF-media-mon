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
    projectId: r.project_id || '',
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

  const details = [];
  for (const raw of items || []) {
    if (!raw) { details.push({ error: 'empty item' }); continue; }
    const name = String(raw.scenarioName || '').trim().slice(0, 300);
    if (!name) { details.push({ error: 'scenarioName is required' }); continue; }

    const scenarioId = raw.scenarioId != null ? Number(raw.scenarioId) || null : null;
    let projectId = raw.projectId != null ? String(raw.projectId).trim().slice(0, 100) : '';
    if (!projectId && scenarioId) {
      const sc = await pool.query(
        'SELECT project_id FROM search_scenarios WHERE id = $1 AND board_id = $2',
        [scenarioId, boardId]
      );
      if (sc.rows[0]) projectId = String(sc.rows[0].project_id || '').slice(0, 100);
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO search_logs (board_id, scenario_id, scenario_name, status, note, severity, project_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          boardId,
          scenarioId,
          name,
          String(raw.status || '').trim().slice(0, 50) || 'ok',
          String(raw.note || '').trim().slice(0, 1000),
          normSeverity(raw.severity),
          projectId,
          createdBy,
        ]
      );
      if (rows.length) details.push({ id: rows[0].id });
    } catch (err) {
      details.push({ scenarioName: name, error: String((err && err.message) || err) });
    }
  }
  const inserted = details.filter((d) => d.id != null).length;
  const failed = details.length - inserted;
  return { inserted, failed, details };
}

async function listLogs(boardId, { limit = 100, severity = '', project = '' } = {}) {
  const pool = db.requirePool();
  const clauses = ['board_id = $1'];
  const params = [boardId];
  if (severity && SEVERITIES.includes(severity)) {
    params.push(severity);
    clauses.push(`severity = $${params.length}`);
  }
  if (project) {
    params.push(project);
    clauses.push(`project_id = $${params.length}`);
  }
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  const { rows } = await pool.query(
    `SELECT * FROM search_logs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(rowToLog);
}

module.exports = { insertLogs, listLogs, SEVERITIES };