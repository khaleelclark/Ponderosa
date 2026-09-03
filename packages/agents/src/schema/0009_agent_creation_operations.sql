CREATE TABLE IF NOT EXISTS agent_creation_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'managed', 'import')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'canonical_committed', 'completed', 'rolling_back', 'rolled_back')),
  communication_event_id TEXT,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, actor_scope, kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_creation_operation_members (
  operation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (operation_id, agent_id),
  UNIQUE (operation_id, position),
  FOREIGN KEY (operation_id) REFERENCES agent_creation_operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_creation_operations_pending
  ON agent_creation_operations(status, updated_at);
