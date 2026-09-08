const fetch = require('node-fetch');
const db = require('./db');

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search?q={query}&hl=ru&gl=RU&ceid=RU:ru';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// Simple RSS XML item parser — extracts <item> blocks from RSS feed.
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const tag = (name) => {
      const r = new RegExp(`<${name}[^>]*><\\!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
      const match = block.match(r);
      return match ? (match[1] || match[2] || '').trim() : '';
    };
    const pubDateRaw = tag('pubDate');
    items.push({
      title: tag('title'),
      link: tag('link'),
      pubDate: pubDateRaw ? new Date(pubDateRaw) : null,
      pubDateStr: pubDateRaw,
      source: tag('source'),
      description: tag('description'),
    });
  }
  return items;
}

// Classify sentiment based on keyword lists.
// negativeKeywords and positiveKeywords are arrays of lowercase strings.
// Returns 'negative', 'positive', or 'neutral'.
function classifySentiment(text, negativeKeywords, positiveKeywords) {
  const lower = text.toLowerCase();
  let negScore = 0;
  let posScore = 0;
  for (const kw of negativeKeywords) {
    if (lower.includes(kw.toLowerCase())) negScore++;
  }
  for (const kw of positiveKeywords) {
    if (lower.includes(kw.toLowerCase())) posScore++;
  }
  if (negScore > posScore) return 'negative';
  if (posScore > negScore) return 'positive';
  return 'neutral';
}

// Check if the text is relevant to the scenario: any keyword or source match.
function isRelevant(title, description, keywords, sources) {
  const text = (title + ' ' + description).toLowerCase();
  const terms = [...keywords, ...sources].filter(Boolean);
  for (const term of terms) {
    if (text.includes(String(term).toLowerCase())) return true;
  }
  return false;
}

async function searchGoogleNews(query, { days = 7 } = {}) {
  const url = GOOGLE_NEWS_RSS.replace('{query}', encodeURIComponent(query));
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PR-Monitor/1.0)' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Google News RSS returned ${res.status}`);
  const xml = await res.text();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return parseRssItems(xml).filter((item) => item.pubDate && item.pubDate >= cutoff);
}

// Fetch a custom RSS/API URL as-is (no query interpolation).
async function searchFeed(feedUrl, { days = 7 } = {}) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PR-Monitor/1.0)' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  const xml = await res.text();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return parseRssItems(xml).filter((item) => item.pubDate && item.pubDate >= cutoff);
}

// Execute a single search scenario: build the query from its client/keywords
// and sources, fetch the feed (Google News by default, or a custom RSS/API URL
// from scenario.feedUrl), then filter the results by an optional scenario.regex
// (applied to title+description) and classify sentiment/relevance.
async function searchScenario(scenario, { days = 7 } = {}) {
  const keywords = toArray(scenario.keywords);
  const sources = toArray(scenario.sources);
  const parts = [...keywords, ...sources].filter(Boolean);
  const feedUrl = String(scenario.feedUrl || '').trim();
  const regexRaw = String(scenario.regex || '').trim();

  if (!feedUrl && !parts.length) {
    return { results: [], skipped: true, reason: 'no-keywords' };
  }

  let regex = null;
  if (regexRaw) {
    try {
      regex = new RegExp(regexRaw, 'i');
    } catch (err) {
      throw new Error(`invalid regex: ${regexRaw}`);
    }
  }

  const raw = feedUrl
    ? await searchFeed(feedUrl, { days })
    : await searchGoogleNews(parts.join(' OR ') || parts[0], { days });

  const negativeKw = toArray(scenario.negativeKeywords);
  const positiveKw = toArray(scenario.positiveKeywords);

  const results = raw.map((item) => {
    const text = (item.title + ' ' + item.description);
    return {
      title: item.title,
      url: item.link,
      source: item.source,
      publishedAt: item.pubDate ? item.pubDate.toISOString().slice(0, 10) : '',
      snippet: item.description,
      sentiment: classifySentiment(text, negativeKw, positiveKw),
      relevant: regex ? regex.test(text) : isRelevant(item.title, item.description, keywords, sources),
    };
  });

  return { results: results.filter((r) => r.relevant), skipped: false };
}

// Insert new results into mentions table (skip duplicates by URL).
async function persistResults(boardId, projectId, results, createdBy = 'auto_search') {
  const pool = db.requirePool();
  let inserted = 0;
  for (const r of results) {
    if (!r.url) continue;
    try {
      await pool.query(
        `INSERT INTO mentions (board_id, project_id, url, source, title, published_at, sentiment, comment, created_by, source_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'auto_search')
         ON CONFLICT (board_id, project_id, url) DO NOTHING`,
        [
          boardId,
          projectId,
          r.url.slice(0, 1000),
          (r.source || '').slice(0, 300),
          (r.title || '').slice(0, 500),
          r.publishedAt || null,
          r.sentiment || 'neutral',
          (r.snippet || '').slice(0, 4000),
          createdBy,
        ]
      );
      inserted++;
    } catch (err) {
      console.warn('[news] insert failed:', err.message);
    }
  }
  return inserted;
}

// Run every active scenario for a board. Used by the n8n cron endpoint.
// scenarios is the list from scenarios.listActiveScenarios(boardId).
async function runScenarios(boardId, scenarios, { days = 7, createdBy = 'cron' } = {}) {
  const summary = [];
  for (const scenario of scenarios) {
    try {
      const { results, skipped, reason } = await searchScenario(scenario, { days });
      if (skipped) {
        summary.push({ scenarioId: scenario.id, projectId: scenario.projectId, found: 0, inserted: 0, skipped: true, reason });
        continue;
      }
      const inserted = await persistResults(boardId, scenario.projectId, results, createdBy);
      summary.push({ scenarioId: scenario.id, projectId: scenario.projectId, found: results.length, inserted, skipped: false });
    } catch (err) {
      console.error(`[news] search failed for scenario ${scenario.id}:`, err.message);
      summary.push({ scenarioId: scenario.id, projectId: scenario.projectId, found: 0, inserted: 0, error: err.message });
    }
  }
  return summary;
}

module.exports = { searchScenario, persistResults, runScenarios, parseRssItems, classifySentiment, isRelevant };
