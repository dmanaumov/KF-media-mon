// Team access control — two independent global privileges per team member
// (see db.js#team_permissions) plus a per-project allow-list
// (team_project_access). Design notes (2026-09-09, Дмитрий):
//
// - "Настройки проектов" (canManageProjects) and "Настройка прав"
//   (canManageAcl) are deliberately two separate checkboxes — someone can
//   edit client cards/links without being able to touch who-sees-what, and
//   vice versa.
// - Project access is opt-in restriction: a user with ZERO rows in
//   team_project_access keeps seeing every non-archived project, exactly
//   like before this feature existed. The moment an admin gives them their
//   first row, they switch to allow-list mode (only the listed projects).
//   This means turning ACL on can never silently empty someone's cabinet.
// - Env-configured admins (ADMIN_EMAILS/ADMIN_LOGINS) remain permanent
//   "super admins": both privileges, and never restricted by project
//   access. That keeps a working break-glass path if the DB-based grants
//   are ever misconfigured.
const db = require('./db');
const config = require('./config');

function isSuperAdmin(user) {
  const email = user && user.email ? String(user.email).toLowerCase().trim() : '';
  const username = user && user.username ? String(user.username).toLowerCase().trim() : '';
  return (email && config.adminEmails.includes(email)) || (username && config.adminLogins.includes(username));
}

async function getPermissions(boardId, userId) {
  if (!userId) return { canManageProjects: false, canManageAcl: false };
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT can_manage_projects, can_manage_acl FROM team_permissions WHERE board_id = $1 AND user_id = $2',
    [boardId, userId]
  );
  if (!rows.length) return { canManageProjects: false, canManageAcl: false };
  return { canManageProjects: !!rows[0].can_manage_projects, canManageAcl: !!rows[0].can_manage_acl };
}

async function listPermissions(boardId) {
  const pool = db.requirePool();
  const { rows } = await pool.query('SELECT * FROM team_permissions WHERE board_id = $1', [boardId]);
  const map = new Map();
  rows.forEach((r) => map.set(r.user_id, { canManageProjects: !!r.can_manage_projects, canManageAcl: !!r.can_manage_acl }));
  return map;
}

async function setPermissions(boardId, userId, { canManageProjects, canManageAcl }) {
  const pool = db.requirePool();
  await pool.query(
    `INSERT INTO team_permissions (board_id, user_id, can_manage_projects, can_manage_acl, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (board_id, user_id) DO UPDATE SET
       can_manage_projects = EXCLUDED.can_manage_projects,
       can_manage_acl = EXCLUDED.can_manage_acl,
       updated_at = now()`,
    [boardId, userId, !!canManageProjects, !!canManageAcl]
  );
}

async function canManageProjects(boardId, user) {
  if (isSuperAdmin(user)) return true;
  if (!user || !user.id) return false;
  try {
    return (await getPermissions(boardId, user.id)).canManageProjects;
  } catch (e) {
    return false;
  }
}

async function canManageAcl(boardId, user) {
  if (isSuperAdmin(user)) return true;
  if (!user || !user.id) return false;
  try {
    return (await getPermissions(boardId, user.id)).canManageAcl;
  } catch (e) {
    return false;
  }
}

// null = unrestricted (no rows yet — sees everything); otherwise the exact
// set of project ids this user is allowed to see.
async function getProjectAccess(boardId, userId) {
  if (!userId) return null;
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT project_id FROM team_project_access WHERE board_id = $1 AND user_id = $2',
    [boardId, userId]
  );
  if (!rows.length) return null;
  return new Set(rows.map((r) => r.project_id));
}

// All users who have at least one restriction row, board-wide — for
// rendering the ACL matrix (users with no row are drawn as "все проекты").
async function listAllAccess(boardId) {
  const pool = db.requirePool();
  const { rows } = await pool.query(
    'SELECT user_id, project_id FROM team_project_access WHERE board_id = $1',
    [boardId]
  );
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.user_id)) map.set(r.user_id, new Set());
    map.get(r.user_id).add(r.project_id);
  });
  return map;
}

// Replaces the user's whole access list. NOTE: since "restricted" is stored
// purely as "has at least one row", clearing the list back down to empty is
// indistinguishable from never having restricted them — it puts them back
// to unrestricted ("sees everything"), not "sees nothing". There is no way
// to grant literally zero projects through this table; that's a deliberate
// simplification (lock someone out entirely via their Mattermost account,
// not this list) so "opt-in restriction" stays true in both directions.
async function setProjectAccess(boardId, userId, projectIds) {
  const pool = db.requirePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM team_project_access WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
    const ids = [...new Set((projectIds || []).filter(Boolean).map(String))];
    for (const projectId of ids) {
      await client.query(
        `INSERT INTO team_project_access (board_id, user_id, project_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [boardId, userId, projectId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function filterProjects(boardId, user, allProjects) {
  if (isSuperAdmin(user) || !user || !user.id) return allProjects;
  const access = await getProjectAccess(boardId, user.id);
  if (!access) return allProjects; // unrestricted — today's behaviour
  return allProjects.filter((p) => access.has(p.id));
}

async function isProjectAccessible(boardId, user, projectId) {
  if (!projectId) return true; // "all projects" view — callers filter the list themselves
  if (isSuperAdmin(user) || !user || !user.id) return true;
  const access = await getProjectAccess(boardId, user.id);
  if (!access) return true;
  return access.has(projectId);
}

module.exports = {
  isSuperAdmin,
  getPermissions,
  listPermissions,
  setPermissions,
  canManageProjects,
  canManageAcl,
  getProjectAccess,
  listAllAccess,
  setProjectAccess,
  filterProjects,
  isProjectAccessible,
};
