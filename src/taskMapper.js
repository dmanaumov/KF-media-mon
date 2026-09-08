const config = require('./config');

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function normLabel(s) {
  return (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ');
}

function findPropertyDef(board, name) {
  const props = (board && board.cardProperties) || [];
  const needle = normLabel(name);
  return props.find((p) => normLabel(p.name) === needle) || null;
}

function optionLabelById(propDef, optionId) {
  if (!propDef || !optionId) return null;
  const opt = (propDef.options || []).find((o) => o.id === optionId);
  return opt ? opt.value : null;
}

function optionIdByLabel(propDef, label) {
  if (!propDef) return null;
  const needle = normLabel(label);
  const opt = (propDef.options || []).find((o) => normLabel(o.value) === needle);
  return opt ? opt.id : null;
}

function resolveProjectOptionId(projectProp, filterValue) {
  if (!projectProp || !filterValue) return null;
  const needle = String(filterValue).trim().toLowerCase();
  const opt = (projectProp.options || []).find(
    (o) => o.id === filterValue || String(o.value).trim().toLowerCase() === needle
  );
  return opt ? opt.id : null;
}

// Focalboard date-property values appear as {"from":<epoch-ms>}, a bare
// epoch-ms string, or plain "YYYY-MM-DD". Try all three, else null.
function parsePropertyDate(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.from) return new Date(obj.from).toISOString().slice(0, 10);
  } catch (e) {
    // not JSON
  }
  if (/^\d{12,13}$/.test(raw)) return new Date(parseInt(raw, 10)).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

// "19.4К" / "414.7K" / plain number / "1 200" -> integer (or null)
function parseUvm(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null;
  const s = String(raw).trim().replace(',', '.');
  const m = s.match(/^([\d.]+)\s*([КкKk]?)(М?[Mm]?)$/);
  if (!m) {
    const n = Number(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= 1_000;
  if (m[3]) n *= 1_000_000;
  return Math.round(n);
}

function displayReach(reach) {
  if (!reach) return '';
  if (reach >= 1_000_000) return `${(reach / 1_000_000).toFixed(reach % 1_000_000 === 0 ? 0 : 1)}M`;
  if (reach >= 1_000) return `${(reach / 1_000).toFixed(reach % 1_000 === 0 ? 0 : 1)}K`;
  return String(reach);
}

function projectOptions(board) {
  const prop = findPropertyDef(board, config.projectPropertyName);
  return (prop && prop.options || []).map((o) => ({ id: o.id, label: o.value }));
}

function statusOptions(board) {
  const prop = findPropertyDef(board, config.statusPropertyName);
  return (prop && prop.options || []).map((o) => ({ id: o.id, label: o.value }));
}

// board: getBoard -> single board object with cardProperties.
// cards: listCards -> card[] with properties keyed by property id.
// opts.project: option id or label to narrow to one client (REQUIRED for the
//   client cabinet — the board holds every client's cards). When present and
//   not resolving, returns no tasks rather than everything (never leak).
// opts.onlyFacts: restrict to cards that actually have a publication link.
// Returns { tasks, meta } where tasks is sorted by deadline desc, then createAt.
function buildTasks(board, cards, opts = {}) {
  const projectProp = findPropertyDef(board, config.projectPropertyName);
  const statusProp = findPropertyDef(board, config.statusPropertyName);
  const deadlineProp = findPropertyDef(board, config.datePropertyName);
  const smiProp = findPropertyDef(board, config.smiPropertyName);
  const urlProp = findPropertyDef(board, config.urlPropertyName);
  const uvmProp = findPropertyDef(board, config.uvmPropertyName);
  const typeProp = findPropertyDef(board, config.typePropertyName);
  const priorityProp = findPropertyDef(board, config.priorityPropertyName);

  const projectOptionId = projectProp ? resolveProjectOptionId(projectProp, opts.project) : null;
  const projectFilterMatched = !projectProp || !!projectOptionId;

  let visibleCards = (cards || []).filter((c) => !c.deleteAt);
  if (opts.project) {
    visibleCards = projectOptionId
      ? visibleCards.filter((c) => (c.properties || {})[projectProp.id] === projectOptionId)
      : [];
  }

  const tasks = visibleCards.map((card) => {
    const properties = card.properties || {};

    const projectId = projectProp ? properties[projectProp.id] || null : null;
    const statusId = statusProp ? properties[statusProp.id] || null : null;
    const rawDeadline = deadlineProp ? properties[deadlineProp.id] : null;
    const rawUrl = urlProp ? properties[urlProp.id] : null;
    const rawSmi = smiProp ? properties[smiProp.id] : null;
    const rawUvm = uvmProp ? properties[uvmProp.id] : null;
    const rawType = typeProp ? properties[typeProp.id] : null;
    const rawPriority = priorityProp ? properties[priorityProp.id] : null;

    const deadline = parsePropertyDate(rawDeadline);
    const pubUrl = rawUrl ? String(rawUrl).trim() : '';
    const reach = parseUvm(rawUvm);

    return {
      id: card.id,
      title: card.title || '(без названия)',
      project: {
        id: projectId,
        label: optionLabelById(projectProp, projectId),
      },
      status: {
        id: statusId,
        label: optionLabelById(statusProp, statusId),
      },
      smi: rawSmi ? String(rawSmi).trim() : '',
      type: typeProp && rawType ? optionLabelById(typeProp, rawType) : null,
      priority: priorityProp && rawPriority ? optionLabelById(priorityProp, rawPriority) : null,
      deadline,
      deadlineLabel: deadline ? deadlineLabel(deadline) : '',
      pubUrl,
      isFact: !!pubUrl,
      uvm: reach,
      uvmLabel: displayReach(reach),
      createAt: card.createAt || 0,
    };
  });

  let visibleTasks = tasks;
  if (opts.onlyFacts) visibleTasks = visibleTasks.filter((t) => t.isFact);
  if (opts.statusFilter) {
    const needle = normLabel(opts.statusFilter);
    visibleTasks = visibleTasks.filter((t) => normLabel(t.status.label) === needle);
  }

  visibleTasks.sort((a, b) => {
    if (a.deadline !== b.deadline) return (b.deadline || '').localeCompare(a.deadline || '');
    return b.createAt - a.createAt;
  });

  return {
    tasks: visibleTasks,
    meta: {
      projectPropertyFound: !!projectProp,
      statusPropertyFound: !!statusProp,
      datePropertyFound: !!deadlineProp,
      urlPropertyFound: !!urlProp,
      projectFilterMatched,
      projects: projectOptions(board),
      statuses: statusOptions(board),
    },
  };
}

function deadlineLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]}`;
}

module.exports = {
  buildTasks,
  findPropertyDef,
  optionIdByLabel,
  optionLabelById,
  projectOptions,
  statusOptions,
  parseUvm,
  displayReach,
};