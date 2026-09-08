-- PR-мониторинг: базовая схема (v1, соответствует claude/pr-monitoring-architecture.md)

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS platforms (
  id SERIAL PRIMARY KEY,
  domain TEXT UNIQUE, -- нормализованный домен, может быть NULL для площадок без сайта (только бренд)
  display_name TEXT NOT NULL,
  tier CHAR(1), -- A / B / C, см. §3 архитектуры — ручная эвристика на бесплатных источниках
  reach_estimate BIGINT,
  reach_source TEXT, -- 'uvm_manual' | 'similarweb_free' | 'mediakit' | 'heuristic'
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id),
  mm_card_id TEXT UNIQUE, -- id карточки в Mattermost — ключ для будущей живой синхронизации
  title TEXT NOT NULL,
  source_media_raw TEXT, -- как есть в поле "СМИ/ресурс" борда
  platform_id INTEGER REFERENCES platforms(id),
  status TEXT, -- статус карточки борда на момент импорта
  publish_date DATE,
  url TEXT,
  reach_estimate BIGINT, -- из UVM, если заполнено вручную
  reach_source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Найденные перепечатки — таблица уже готова под фазу 2 (поисковый пайплайн), сейчас пустая
CREATE TABLE IF NOT EXISTS publications (
  id SERIAL PRIMARY KEY,
  fact_id INTEGER REFERENCES facts(id) ON DELETE CASCADE,
  platform_id INTEGER REFERENCES platforms(id),
  found_url TEXT,
  similarity_score REAL,
  confirmed BOOLEAN DEFAULT false,
  reach_estimate BIGINT,
  reach_source TEXT,
  found_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facts_client ON facts(client_id);
CREATE INDEX IF NOT EXISTS idx_facts_platform ON facts(platform_id);
CREATE INDEX IF NOT EXISTS idx_publications_fact ON publications(fact_id);
