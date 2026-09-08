const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const config = require('./config');

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function agentFor(url) {
  return url.startsWith('https:') ? keepAliveHttpsAgent : keepAliveHttpAgent;
}

function usingSessionLogin() {
  return !!(config.mattermostLoginId && config.mattermostPassword);
}

function assertConfigured() {
  if (!config.mattermostUrl) throw new Error('MATTERMOST_URL is not configured');
  if (config.mattermostLoginId && !config.mattermostPassword) {
    throw new Error('MATTERMOST_LOGIN_ID set but MATTERMOST_PASSWORD is missing — set both, or use MATTERMOST_TOKEN');
  }
  if (!usingSessionLogin() && !config.mattermostToken) {
    throw new Error('Neither MATTERMOST_TOKEN nor MATTERMOST_LOGIN_ID/MATTERMOST_PASSWORD are configured');
  }
}

function boardsUrl(path) {
  return `${config.mattermostUrl}${config.boardsApiPrefix}${path}`;
}

function fetchWithTimeout(url, opts = {}, ms = config.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { agent: agentFor(url), ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let session = { token: null };

function extractAuthTokenFromCookies(res) {
  const rawCookies = (res.headers.raw && res.headers.raw()['set-cookie']) || [];
  for (const cookie of rawCookies) {
    const match = /(?:^|;\s*)MMAUTHTOKEN=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function login() {
  const res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: config.mattermostLoginId, password: config.mattermostPassword }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[mattermost] login() failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const token = res.headers.get('token') || extractAuthTokenFromCookies(res);
  if (!token) {
    throw new Error('[mattermost] login() succeeded (200) but no session token found in headers/cookies');
  }
  session = { token };
  return token;
}

async function loginAs(loginId, password) {
  const res = await fetchWithTimeout(`${config.mattermostUrl}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: loginId, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(text).message || message;
    } catch (e) {
      // keep fallback
    }
    throw new Error(message);
  }
  const token = res.headers.get('token') || extractAuthTokenFromCookies(res);
  if (!token) {
    throw new Error('Mattermost вернул успешный логин, но не выдал сессионный токен.');
  }
  let user = null;
  try {
    user = JSON.parse(text);
  } catch (e) {
    // fall through
  }
  if (!user || !user.id) {
    throw new Error('Mattermost вернул успешный логин, но тело ответа не похоже на профиль пользователя.');
  }
  return { token, user };
}

async function getBearerToken({ forceRelogin = false } = {}) {
  if (!usingSessionLogin()) return config.mattermostToken;
  if (forceRelogin || !session.token) await login();
  return session.token;
}

async function authHeaders(extra, opts) {
  const token = await getBearerToken(opts);
  return {
    Authorization: `Bearer ${token}`,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function asJsonOrThrow(res, context) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[mattermost] ${context} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (config.debug) console.log(`[mattermost:debug] ${context} →`, JSON.stringify(parsed).slice(0, 2000));
    return parsed;
  } catch (e) {
    throw new Error(`[mattermost] ${context}: non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function mmFetch(url, { headers: extraHeaders, ...opts } = {}, context) {
  assertConfigured();
  let headers = await authHeaders(extraHeaders);
  let res = await fetchWithTimeout(url, { ...opts, headers });
  if (res.status === 401 && usingSessionLogin()) {
    headers = await authHeaders(extraHeaders, { forceRelogin: true });
    res = await fetchWithTimeout(url, { ...opts, headers });
  }
  const isGet = !opts.method || opts.method.toUpperCase() === 'GET';
  const RETRY_DELAYS_MS = [400, 1200];
  for (let i = 0; isGet && res.status >= 500 && i < RETRY_DELAYS_MS.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
    res = await fetchWithTimeout(url, { ...opts, headers });
  }
  return res;
}

async function listTeamBoards(teamId) {
  const res = await mmFetch(boardsUrl(`/teams/${teamId}/boards`), {}, `listTeamBoards(${teamId})`);
  const data = await asJsonOrThrow(res, `listTeamBoards(${teamId})`);
  return Array.isArray(data) ? data : (data && data.boards) || [];
}

async function getBoard(boardId, teamId) {
  if (!teamId) throw new Error('MATTERMOST_TEAM_ID is not configured');
  try {
    const res = await mmFetch(boardsUrl(`/boards/${boardId}`), {}, `getBoard(${boardId})`);
    const board = await asJsonOrThrow(res, `getBoard(${boardId})`);
    if (board && !board.title) throw new Error(`Board ${boardId} returned malformed body`);
    return board;
  } catch (err) {
    if (!String(err.message).includes('HTTP 404')) throw err;
  }
  const boards = await listTeamBoards(teamId);
  const board = boards.find((b) => b.id === boardId);
  if (!board) throw new Error(`Board ${boardId} not found in team ${teamId} (checked ${boards.length} boards)`);
  return board;
}

async function fetchCardsPage(boardId, page, perPage) {
  const res = await mmFetch(
    boardsUrl(`/boards/${boardId}/cards?page=${page}&per_page=${perPage}`),
    {},
    `listCards(${boardId},page=${page})`
  );
  const data = await asJsonOrThrow(res, `listCards(${boardId},page=${page})`);
  const batch = Array.isArray(data) ? data : (data && data.cards) || [];
  return { batch, reachedEnd: batch.length < perPage, skipped: 0 };
}

async function listCards(boardId) {
  const perPage = 200;
  const maxPages = 50;
  const BATCH_SIZE = 5;
  let all = [];
  let reachedEnd = false;
  for (let batchStart = 0; batchStart < maxPages && !reachedEnd; batchStart += BATCH_SIZE) {
    const pages = [];
    for (let p = batchStart; p < Math.min(batchStart + BATCH_SIZE, maxPages); p++) pages.push(p);
    const results = await Promise.all(pages.map((p) => fetchCardsPage(boardId, p, perPage)));
    for (const r of results) {
      all = all.concat(r.batch);
      if (r.reachedEnd) {
        reachedEnd = true;
        break;
      }
    }
  }
  return all;
}

async function listBlocks(boardId) {
  const res = await mmFetch(boardsUrl(`/boards/${boardId}/blocks`), {}, `listBlocks(${boardId})`);
  const data = await asJsonOrThrow(res, `listBlocks(${boardId})`);
  return Array.isArray(data) ? data : (data && data.blocks) || [];
}

async function getUserIdByUsername(username) {
  if (!username) return null;
  try {
    const headers = await authHeaders();
    delete headers['Content-Type'];
    const res = await fetchWithTimeout(
      `${config.mattermostUrl}/api/v4/users/username/${encodeURIComponent(username)}`,
      { headers }
    );
    if (!res.ok) return null;
    const user = await res.json();
    return user.id || null;
  } catch (err) {
    if (config.debug) console.warn(`[mattermost] getUserIdByUsername(${username}) failed:`, err.message);
    return null;
  }
}

module.exports = {
  listTeamBoards,
  getBoard,
  listCards,
  listBlocks,
  loginAs,
  getUserIdByUsername,
};