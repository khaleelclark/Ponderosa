CREATE TABLE IF NOT EXISTS provider_process_authority (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  project_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  pid INTEGER NOT NULL CHECK (pid > 0),
  pgid INTEGER NOT NULL CHECK (pgid > 0),
  birth_marker TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (worker_id, pid, birth_marker)
);
CREATE INDEX IF NOT EXISTS idx_provider_process_authority_worker
  ON provider_process_authority (worker_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_provider_process_authority_run
  ON provider_process_authority (run_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_provider_process_authority_project_agent
  ON provider_process_authority (project_id, agent_id, created_at, id);
