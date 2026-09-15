require('dotenv').config();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function enabled(level) {
  return current <= LEVELS[level];
}

function log(level, tag, ...args) {
  if (!enabled(level)) return;
  const prefix = tag ? `[${tag}]` : '';
  if (level === 'warn') console.warn(prefix, ...args);
  else if (level === 'error') console.error(prefix, ...args);
  else console.log(prefix, ...args);
}

module.exports = {
  debug: (tag, ...args) => log('debug', tag, ...args),
  info: (tag, ...args) => log('info', tag, ...args),
  warn: (tag, ...args) => log('warn', tag, ...args),
  error: (tag, ...args) => log('error', tag, ...args),
  enabled,
};