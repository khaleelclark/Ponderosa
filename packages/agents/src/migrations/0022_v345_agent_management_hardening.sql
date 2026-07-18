CREATE TABLE agent_deletion_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  preview_hash TEXT NOT NULL UNIQUE,
  root_agent_ids_json TEXT NOT NULL,
  deleted_agent_ids_json TEXT NOT NULL,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  server_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE agent_management_approvals (
  decision_id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  consumed_at TEXT
);
