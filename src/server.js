require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const { pool } = require('./db');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  cookieSession({
    name: 'prm_session',
    keys: [process.env.SESSION_SECRET || 'dev-secret'],
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.STAFF_AUTH_USER && password === process.env.STAFF_AUTH_PASSWORD) {
    req.session.authed = true;
    return res.redirect('/');
  }
  return res.render('login', { error: 'Неверный логин или пароль' });
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// --- Дашборд фактов ---
app.get('/', requireAuth, async (req, res) => {
  const clientFilter = req.query.client || '';
  const statusFilter = req.query.status || '';

  const clientsRes = await pool.query('SELECT id, name FROM clients ORDER BY name');

  const params = [];
  const where = [];
  if (clientFilter) {
    params.push(clientFilter);
    where.push(`c.name = $${params.length}`);
  }
  if (statusFilter) {
    params.push(statusFilter);
    where.push(`f.status = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const factsRes = await pool.query(
    `SELECT f.id, f.title, f.status, f.publish_date, f.url, f.reach_estimate, f.reach_source,
            c.name AS client_name, p.display_name AS platform_name, p.tier AS platform_tier,
            (SELECT count(*) FROM publications pub WHERE pub.fact_id = f.id AND pub.confirmed) AS reprints_found
     FROM facts f
     LEFT JOIN clients c ON c.id = f.client_id
     LEFT JOIN platforms p ON p.id = f.platform_id
     ${whereSql}
     ORDER BY f.publish_date DESC NULLS LAST, f.id DESC`,
    params
  );

  const statusesRes = await pool.query(
    'SELECT DISTINCT status FROM facts WHERE status IS NOT NULL ORDER BY status'
  );

  res.render('dashboard', {
    clients: clientsRes.rows,
    facts: factsRes.rows,
    statuses: statusesRes.rows.map((r) => r.status),
    clientFilter,
    statusFilter,
  });
});

// --- Сводка по клиентам ---
app.get('/clients', requireAuth, async (req, res) => {
  const summaryRes = await pool.query(
    `SELECT c.name,
            count(f.id) AS facts_count,
            count(f.id) FILTER (WHERE f.status = 'Опубликован') AS published_count,
            count(f.reach_estimate) AS reach_known_count,
            coalesce(sum(f.reach_estimate), 0) AS reach_sum
     FROM clients c
     LEFT JOIN facts f ON f.client_id = c.id
     GROUP BY c.name
     ORDER BY facts_count DESC`
  );
  res.render('clients', { rows: summaryRes.rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PR-мониторинг слушает на :${PORT}`));
