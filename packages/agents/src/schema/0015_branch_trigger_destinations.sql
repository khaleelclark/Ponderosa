-- Reuse existing Trigger authority with one exclusive destination. No synthetic Agents.

CREATE TABLE trigger_definitions_branch_destination (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT,
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
  run_budget_period_started_at TEXT,
  CHECK ((agent_id IS NOT NULL AND branch_id IS NULL) OR (agent_id IS NULL AND branch_id IS NOT NULL))
);

INSERT INTO trigger_definitions_branch_destination(id,project_id,conversation_id,agent_id,name,instructions,source_kind,source_config_json,enabled,next_fire_at,last_fired_at,secret_ciphertext,secret_fingerprint,created_at,updated_at,run_budget_limit,run_budget_period,run_budget_used,run_budget_allowance,run_budget_period_started_at) SELECT id,project_id,conversation_id,agent_id,name,instructions,source_kind,source_config_json,enabled,next_fire_at,last_fired_at,secret_ciphertext,secret_fingerprint,created_at,updated_at,run_budget_limit,run_budget_period,run_budget_used,run_budget_allowance,run_budget_period_started_at FROM trigger_definitions;

DROP TABLE trigger_definitions;

ALTER TABLE trigger_definitions_branch_destination RENAME TO trigger_definitions;

CREATE INDEX trigger_definitions_agent
  ON trigger_definitions(agent_id, conversation_id, created_at);

CREATE INDEX idx_trigger_definitions_project_directory
  ON trigger_definitions(project_id, updated_at DESC, name, id);

CREATE INDEX idx_trigger_definitions_agent_directory
  ON trigger_definitions(agent_id, updated_at DESC, name, id);

CREATE INDEX trigger_definitions_budget
  ON trigger_definitions(run_budget_period, run_budget_period_started_at)
  WHERE run_budget_limit IS NOT NULL;

CREATE INDEX trigger_definitions_due
  ON trigger_definitions(enabled, source_kind, next_fire_at, id)
  WHERE enabled = 1 AND source_kind = 'schedule' AND next_fire_at IS NOT NULL;

CREATE TABLE trigger_occurrences_branch_destination (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT,
  branch_execution_id TEXT REFERENCES branch_executions(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  trigger_snapshot_json TEXT NOT NULL DEFAULT '{}',
  payload_media_type TEXT NOT NULL DEFAULT 'application/json',
  input_hash TEXT NOT NULL,
  activation_config_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'activated', 'cancelled', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  activation_id TEXT REFERENCES agent_activations(id) ON DELETE SET NULL,
  last_error TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  dead_lettered_at TEXT, budget_charge_id TEXT, budget_charged_at TEXT,
  UNIQUE (trigger_id, occurrence_key)
);

INSERT INTO trigger_occurrences_branch_destination(id,trigger_id,occurrence_key,project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,input_hash,activation_config_json,state,attempts,available_at,activation_id,last_error,occurred_at,created_at,updated_at,cancelled_at,dead_lettered_at,budget_charge_id,budget_charged_at) SELECT id,trigger_id,occurrence_key,project_id,agent_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,payload_media_type,input_hash,activation_config_json,state,attempts,available_at,activation_id,last_error,occurred_at,created_at,updated_at,cancelled_at,dead_lettered_at,budget_charge_id,budget_charged_at FROM trigger_occurrences;

DROP TABLE trigger_occurrences;

ALTER TABLE trigger_occurrences_branch_destination RENAME TO trigger_occurrences;

CREATE INDEX idx_trigger_occurrences_scope_created
  ON trigger_occurrences (project_id, scope_key, created_at DESC, id DESC);

CREATE INDEX idx_trigger_occurrences_scope_updated
  ON trigger_occurrences (project_id, scope_key, updated_at DESC, id DESC);

CREATE INDEX trigger_occurrences_agent
  ON trigger_occurrences(agent_id, state, occurred_at DESC);

CREATE INDEX trigger_occurrences_budget_charge
  ON trigger_occurrences(trigger_id, budget_charge_id, activation_id)
  WHERE budget_charge_id IS NOT NULL;

CREATE INDEX trigger_occurrences_dead_letter
  ON trigger_occurrences(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX trigger_occurrences_attention
  ON trigger_occurrences(updated_at DESC, id DESC)
  WHERE state = 'dead_lettered';

CREATE INDEX trigger_occurrences_due
  ON trigger_occurrences(state, available_at, id)
  WHERE state = 'pending';

CREATE INDEX trigger_occurrences_trigger
  ON trigger_occurrences(trigger_id, occurred_at DESC, id);

CREATE TABLE trigger_filesystem_bursts_branch_destination (
  trigger_id TEXT PRIMARY KEY,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  changes_json TEXT NOT NULL,
  dropped_path_event_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_path_event_count >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO trigger_filesystem_bursts_branch_destination(trigger_id,occurrence_key,project_id,agent_id,started_at,last_at,event_count,changes_json,dropped_path_event_count,updated_at) SELECT trigger_id,occurrence_key,project_id,agent_id,started_at,last_at,event_count,changes_json,dropped_path_event_count,updated_at FROM trigger_filesystem_bursts;

DROP TABLE trigger_filesystem_bursts;

ALTER TABLE trigger_filesystem_bursts_branch_destination RENAME TO trigger_filesystem_bursts;

CREATE INDEX trigger_filesystem_bursts_project
  ON trigger_filesystem_bursts(project_id, updated_at, trigger_id);

CREATE UNIQUE INDEX trigger_branch_enabled ON trigger_definitions(branch_id) WHERE branch_id IS NOT NULL AND enabled = 1;

ALTER TABLE branches ADD COLUMN trigger_id TEXT;

-- Restore collection notifications dropped with the rebuilt source table.
CREATE TRIGGER IF NOT EXISTS trg_triggers_collection_insert AFTER INSERT ON trigger_definitions BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('triggers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || NEW.agent_id, 1 WHERE NEW.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_triggers_collection_update AFTER UPDATE ON trigger_definitions BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('triggers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || OLD.agent_id, 1 WHERE OLD.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || NEW.agent_id, 1 WHERE NEW.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_triggers_collection_delete AFTER DELETE ON trigger_definitions BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('triggers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || OLD.agent_id, 1 WHERE OLD.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
