-- Ponderosa projection schema (SPEC §7). Idempotent init migration.
-- SQLite projections are rebuildable from the on-disk event logs.

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  host_path    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  conversation_id    TEXT,
  title             TEXT NOT NULL,
  active_engine     TEXT NOT NULL,
  active_session_id TEXT,
  state_branch      TEXT,
  state_commit      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  archived          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  engine     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL,
  task_id    TEXT,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  summary    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages (agent_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks (agent_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_agent ON artifacts (agent_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events (agent_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
