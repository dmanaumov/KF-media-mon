// Yandex Search API (AI Studio / Yandex Cloud) — runs web searches against
// the Yandex index. One API key + folder ID for all clients (Docker env).
// Returns the standard XML search results page as Base64 in `rawData`, which
// we decode and parse into mention-shaped items.

const config = require('./config');
const log = require('./logger');

const SEARCH_API_URL = 'https://searchapi.api.cloud.yandex.net/v2/web/search';
const SEARCH_TYPE = 'SEARCH_TYPE_RU';

function isConfigured() {
  return !!(config.yandexSearchApiKey && config.yandexSearchFolderId);
}

// Run a query and return the decoded XML document.
async function search(queryText, { page = 0, timeoutMs = 30000 } = {}) {
  if (!isConfigured()) {
    const err = new Error('Yandex Search API не настроен: задайте YANDEX_SEARCH_API_KEY и YANDEX_SEARCH_FOLDER_ID');
    err.code = 'YANDEX_NOT_CONFIGURED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
const res = await fetch(SEARCH_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${config.yandexSearchApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: { searchType: SEARCH_TYPE, queryText, page: Number(page) || 0 },
          folderId: config.yandexSearchFolderId,
          responseFormat: 'FORMAT_XML',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 YaBrowser/25.2.0.0 Safari/537.36',
        }),
        signal: controller.signal,
      });
      log.debug('yandex', `search "${queryText}" page=${page} → HTTP ${res.status}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Yandex Search API ${res.status}: ${text.slice(0, 300)}`);
      err.code = 'YANDEX_HTTP_' + res.status;
      throw err;
    }
    const data = await res.json();
    const raw = data && data.rawData ? data.rawData : '';
    if (!raw) {
      const err = new Error('Yandex Search API: пустой ответ без rawData');
      err.code = 'YANDEX_EMPTY';
      throw err;
    }
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('Yandex Search API: таймаут');
      e.code = 'YANDEX_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(parseInt(n, 10)) || m)
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)) || m);
}

// Parse the Yandex XML results page: pull out every <doc> (url, title, first
// passage, modtime when present).
function parseXmlResults(xml) {
  if (!xml) return [];
  const out = [];
  const docRe = /<doc>([\s\S]*?)<\/doc>/gi;
  let m;
  while ((m = docRe.exec(xml)) !== null) {
    const body = m[1];
    const urlM = /<url>([\s\S]*?)<\/url>/i.exec(body);
    const url = urlM ? decodeXmlEntities(urlM[1]).trim() : '';
    if (!url) continue;
    const titleM = /<title>([\s\S]*?)<\/title>/i.exec(body);
    const passM = /<passages>[\s\S]*?<passage>([\s\S]*?)<\/passage>/i.exec(body) ||
      /<passage>([\s\S]*?)<\/passage>/i.exec(body);
    const modM = /<modtime[^>]*>([\d\s]*?)<\/modtime>/i.exec(body);
    const modtime = modM ? parseInt(modM[1].trim(), 10) : NaN;
    out.push({
      url,
      title: decodeXmlEntities(titleM ? titleM[1] : '').trim(),
      snippet: decodeXmlEntities(passM ? passM[1] : '').trim()
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      modtime: Number.isFinite(modtime) && modtime > 0 ? new Date(modtime * 1000) : null,
    });
  }
  return out;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

module.exports = { search, parseXmlResults, hostOf, isConfigured };