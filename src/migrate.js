const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');
  await pool.query(sql);
  console.log('Миграция выполнена.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
