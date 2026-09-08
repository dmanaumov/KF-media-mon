const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const COOKIE_NAME = 'team_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const sessions = new Map();

function newSessionId() {
  return crypto.randomBytes(24).toString('base64url');
}

async function createSession(mmToken, user) {
  const id = newSessionId();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, { mmToken, user, expiresAt });
  if (db.pool) {
    try {
      await db.pool.query(
        `INSERT INTO team_sessions (id, mm_token, user_data, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
         ON CONFLICT (id) DO NOTHING`,
        [id, mmToken, JSON.stringify(user), expiresAt]
      );
    } catch (err) {
      console.error('[teamAuth] failed to persist session:', err.message);
    }
  }
  return id;
}

function getSession(id) {
  if (!id) return null;
  const entry = sessions.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    sessions.delete(id);
    if (db.pool) db.pool.query('DELETE FROM team_sessions WHERE id = $1', [id]).catch(() => {});
    return null;
  }
  return entry;
}

function destroySession(id) {
  if (!id) return;
  sessions.delete(id);
  if (db.pool) db.pool.query('DELETE FROM team_sessions WHERE id = $1', [id]).catch(() => {});
}

async function restoreSessions() {
  if (!db.pool) return;
  try {
    const { rows } = await db.pool.query(
      'SELECT id, mm_token, user_data, expires_at FROM team_sessions WHERE expires_at > now()'
    );
    rows.forEach((r) => {
      sessions.set(r.id, { mmToken: r.mm_token, user: r.user_data, expiresAt: new Date(r.expires_at).getTime() });
    });
    await db.pool.query('DELETE FROM team_sessions WHERE expires_at <= now()');
    console.log(`[teamAuth] restored ${rows.length} team session(s) from Postgres.`);
  } catch (err) {
    console.error('[teamAuth] failed to restore sessions:', err.message);
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res, id) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sessionIdFromRequest(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

function requireTeamAuth(req, res, next) {
  const session = getSession(sessionIdFromRequest(req));
  if (!session) {
    return res.status(401).json({ error: 'not_logged_in' });
  }
  req.teamSession = session;
  next();
}

function roleFor(user) {
  const email = user && user.email ? String(user.email).toLowerCase().trim() : '';
  const username = user && user.username ? String(user.username).toLowerCase().trim() : '';
  const admin = (email && config.adminEmails.includes(email)) || (username && config.adminLogins.includes(username));
  return { admin };
}

function requireAdminAuth(req, res, next) {
  const session = getSession(sessionIdFromRequest(req));
  const role = session && session.user ? roleFor(session.user) : null;
  if (role && role.admin) {
    req.adminUser = session.user;
    return next();
  }
  return res.status(401).json({ error: 'not_allowed', message: 'Доступ только администраторам.' });
}

module.exports = {
  createSession,
  getSession,
  destroySession,
  restoreSessions,
  setSessionCookie,
  clearSessionCookie,
  sessionIdFromRequest,
  requireTeamAuth,
  requireAdminAuth,
  roleFor,
};