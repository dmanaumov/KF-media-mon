const { Pool } = require('pg');
const config = require('./config');

const pool = config.databaseUrl ? new Pool({ connectionString: config.databaseUrl }) : null;

function requirePool() {
  if (!pool) {
    throw new Error('DATABASE_URL is not set — see .env.example. Client links and sessions require Postgres.');
  }
  return pool;
}

async function initSchema() {
  if (!pool) {
    console.warn('[db] DATABASE_URL not set — client links and team sessions will not work until it is configured.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_settings (
      board_id text NOT NULL,
      project_id text NOT NULL,
      link_token text NOT NULL,
      link_token_updated_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, project_id)
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS project_settings_link_token_idx
      ON project_settings (link_token);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_sessions (
      id text PRIMARY KEY,
      mm_token text NOT NULL,
      user_data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    );
  `);
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'team_sessions' AND column_name = 'user') THEN
        ALTER TABLE team_sessions RENAME COLUMN "user" TO user_data;
      END IF;
    END $$;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS team_sessions_expires_idx ON team_sessions (expires_at);`);
}

module.exports = { pool, requirePool, initSchema };