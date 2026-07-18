CREATE TABLE runtime_artifacts (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('communication', 'request_update')),
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('long_text', 'document')),
  title TEXT NOT NULL,
  media_type TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  origin_agent_id TEXT,
  execution_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id, role)
);

CREATE INDEX runtime_artifacts_project
  ON runtime_artifacts(project_id, created_at, id);
