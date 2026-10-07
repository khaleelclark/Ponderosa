-- Workflow authority lives beside coordination, never in rebuilt chat projections.
CREATE TABLE IF NOT EXISTS branches (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL,
 active_version_id TEXT NOT NULL, binding_revision_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branch_versions (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES branches(id),
 definition_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branch_bindings (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES branches(id),
 bindings_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branch_deployments (
 chat_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL,
 result_json TEXT NOT NULL, PRIMARY KEY(chat_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS branch_executions (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES branches(id),
 version_id TEXT NOT NULL REFERENCES branch_versions(id),
 binding_revision_id TEXT NOT NULL REFERENCES branch_bindings(id),
 occurrence_key TEXT NOT NULL, input_text TEXT NOT NULL, input_hash TEXT NOT NULL,
 provenance_json TEXT NOT NULL, state TEXT NOT NULL, wait_reason TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 output_text TEXT, merged_into TEXT REFERENCES branch_executions(id),
 revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(branch_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS branch_execution_queue ON branch_executions(state, created_at);
CREATE TABLE IF NOT EXISTS branch_step_executions (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 step_id TEXT NOT NULL, path_id TEXT NOT NULL, invocation INTEGER NOT NULL,
 state TEXT NOT NULL, input_text TEXT NOT NULL, result_json TEXT,
 UNIQUE(execution_id, path_id, step_id, invocation)
);
CREATE TABLE IF NOT EXISTS branch_attempts (
 id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL REFERENCES branch_step_executions(id),
 number INTEGER NOT NULL, state TEXT NOT NULL, request_id TEXT UNIQUE,
 fence INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until TEXT,
 process_identity_json TEXT, input_hash TEXT NOT NULL, result_json TEXT, error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(step_execution_id, number)
);
CREATE INDEX IF NOT EXISTS branch_attempt_work ON branch_attempts(state, lease_until);
-- Path instances and gate revisions prevent future forks/retries from aliasing.
CREATE TABLE IF NOT EXISTS branch_paths (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 parent_path_id TEXT REFERENCES branch_paths(id), fork_invocation_id TEXT,
 edge_id TEXT, state TEXT NOT NULL, UNIQUE(fork_invocation_id, edge_id)
);
CREATE TABLE IF NOT EXISTS branch_join_arrivals (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), fork_invocation_id TEXT NOT NULL,
 join_id TEXT NOT NULL, path_id TEXT NOT NULL REFERENCES branch_paths(id), outcome TEXT NOT NULL,
 PRIMARY KEY(execution_id, fork_invocation_id, join_id, path_id)
);
CREATE TABLE IF NOT EXISTS branch_gates (
 id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL UNIQUE REFERENCES branch_step_executions(id),
 state TEXT NOT NULL, proposal_text TEXT NOT NULL, choices_json TEXT,
 revision INTEGER NOT NULL DEFAULT 0, resolution_key TEXT UNIQUE, response_json TEXT
);
CREATE TABLE IF NOT EXISTS branch_checkpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 transition_key TEXT NOT NULL, kind TEXT NOT NULL, evidence_json TEXT NOT NULL,
 created_at TEXT NOT NULL, audit_published INTEGER NOT NULL DEFAULT 0, UNIQUE(execution_id, transition_key)
);
