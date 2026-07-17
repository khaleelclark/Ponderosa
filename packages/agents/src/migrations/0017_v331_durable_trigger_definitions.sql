-- Trigger definitions are authoritative Communication V3 state. Projects,
-- conversations, and agents are rebuildable projections that are deleted and
-- replayed at startup, so foreign-key cascades to those tables would erase
-- every Trigger during a normal daemon restart. Explicit lifecycle handlers
-- remain responsible for deleting definitions owned by deleted entities.
DROP INDEX IF EXISTS trigger_definitions_agent;
DROP INDEX IF EXISTS trigger_definitions_due;
DROP INDEX IF EXISTS trigger_definitions_budget;

ALTER TABLE trigger_definitions RENAME TO trigger_definitions_v33;

CREATE TABLE trigger_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule', 'webhook', 'filesystem')),
  source_config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_fire_at TEXT,
  last_fired_at TEXT,
  secret_ciphertext TEXT,
  secret_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_budget_limit INTEGER CHECK (run_budget_limit IS NULL OR run_budget_limit > 0),
  run_budget_period TEXT CHECK (run_budget_period IS NULL OR run_budget_period IN ('day', 'week', 'month', 'lifetime')),
  run_budget_used INTEGER NOT NULL DEFAULT 0 CHECK (run_budget_used >= 0),
  run_budget_allowance INTEGER NOT NULL DEFAULT 0 CHECK (run_budget_allowance >= 0),
  run_budget_period_started_at TEXT
);

INSERT INTO trigger_definitions (
  id, project_id, conversation_id, agent_id, name, instructions,
  source_kind, source_config_json, enabled, next_fire_at, last_fired_at,
  secret_ciphertext, secret_fingerprint, created_at, updated_at,
  run_budget_limit, run_budget_period, run_budget_used, run_budget_allowance,
  run_budget_period_started_at
)
SELECT
  id, project_id, conversation_id, agent_id, name, instructions,
  source_kind, source_config_json, enabled, next_fire_at, last_fired_at,
  secret_ciphertext, secret_fingerprint, created_at, updated_at,
  run_budget_limit, run_budget_period, run_budget_used, run_budget_allowance,
  run_budget_period_started_at
FROM trigger_definitions_v33;

DROP TABLE trigger_definitions_v33;

CREATE INDEX trigger_definitions_agent
  ON trigger_definitions(agent_id, conversation_id, created_at);

CREATE INDEX trigger_definitions_due
  ON trigger_definitions(enabled, source_kind, next_fire_at, id)
  WHERE enabled = 1 AND source_kind = 'schedule' AND next_fire_at IS NOT NULL;

CREATE INDEX trigger_definitions_budget
  ON trigger_definitions(run_budget_period, run_budget_period_started_at)
  WHERE run_budget_limit IS NOT NULL;
