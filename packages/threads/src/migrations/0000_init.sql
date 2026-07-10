-- Ponderosa projection schema (SPEC §7). Idempotent init migration.
-- SQLite projections are rebuildable from the on-disk event logs.

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  host_path    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
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
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  engine     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  task_id    TEXT,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  summary    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON threads (project_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks (thread_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts (thread_id);
CREATE INDEX IF NOT EXISTS idx_events_thread_seq ON events (thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
