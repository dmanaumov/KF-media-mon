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

  // Project "card" fields (archive flag, client identity, speaker profile,
  // socials) — used by the admin settings panel and, later, by the search
  // pipeline (phase 2, see pr-monitoring-architecture.md).
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS client_name_ru text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS client_name_en text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS ceo_name text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '[]'::jsonb;`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS speaker_profile text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS other_info text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS search_keywords text[] NOT NULL DEFAULT '{}';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS negative_keywords text[] NOT NULL DEFAULT '{}';`);
  await pool.query(`ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS positive_keywords text[] NOT NULL DEFAULT '{}';`);

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

  // Manually-logged web mentions ("WEB" tab) — bridges the gap until the
  // search pipeline (phase 2) is live: staff log reprints/comments by hand,
  // tagging sentiment/urgency; the same table will receive rows from the
  // automated search later.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mentions (
      id bigserial PRIMARY KEY,
      board_id text NOT NULL,
      project_id text NOT NULL,
      url text NOT NULL DEFAULT '',
      source text NOT NULL DEFAULT '',
      published_at date,
      sentiment text NOT NULL DEFAULT 'neutral',
      urgent boolean NOT NULL DEFAULT false,
      comment text NOT NULL DEFAULT '',
      created_by text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_project_idx ON mentions (board_id, project_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS mentions_published_idx ON mentions (published_at);`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual';`);
  await pool.query(`ALTER TABLE mentions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS mentions_url_unique ON mentions (board_id, project_id, url) WHERE url != '';`);

  // Search scenarios — the "filters" a user configures from the team cabinet
  // (project + keywords + sources/links). These are executed externally by
  // n8n via POST /api/cron/search-news; the app only stores and displays
  // the results that that run persists into `mentions` (source_type='auto').
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_scenarios (
      id bigserial PRIMARY KEY,
      board_id text NOT NULL,
      project_id text NOT NULL,
      name text NOT NULL DEFAULT '',
      keywords text[] NOT NULL DEFAULT '{}',
      sources text[] NOT NULL DEFAULT '{}',
      negative_keywords text[] NOT NULL DEFAULT '{}',
      positive_keywords text[] NOT NULL DEFAULT '{}',
      archived boolean NOT NULL DEFAULT false,
      created_by text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE search_scenarios ADD COLUMN IF NOT EXISTS query text NOT NULL DEFAULT '';`);
  await pool.query(`ALTER TABLE search_scenarios ADD COLUMN IF NOT EXISTS feed_url text NOT NULL DEFAULT '';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS search_scenarios_board_idx ON search_scenarios (board_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS search_scenarios_project_idx ON search_scenarios (board_id, project_id);`);
}

module.exports = { pool, requirePool, initSchema };
