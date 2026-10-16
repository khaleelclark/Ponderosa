CREATE TABLE IF NOT EXISTS agent_management_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'completed')),
  operation_progress_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(operation_progress_json)),
  refs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(refs_json)),
  changed_agent_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_agent_ids_json)),
  approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  approval_decision_id TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (owner_agent_id, run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_management_plans_project
  ON agent_management_plans(project_id, created_at);
