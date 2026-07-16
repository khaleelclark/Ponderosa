-- V3.2 user-authored Trigger definitions. Definitions are owned by one Agent
-- in one Project chat; occurrence rows intentionally retain a definition
-- snapshot after the definition or Agent is deleted.
CREATE TABLE trigger_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
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
  updated_at TEXT NOT NULL
);

CREATE INDEX trigger_definitions_agent
  ON trigger_definitions(agent_id, conversation_id, created_at);

CREATE INDEX trigger_definitions_due
  ON trigger_definitions(enabled, source_kind, next_fire_at, id)
  WHERE enabled = 1 AND source_kind = 'schedule' AND next_fire_at IS NOT NULL;

ALTER TABLE trigger_occurrences RENAME TO trigger_occurrences_v31;

CREATE TABLE trigger_occurrences (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
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
  dead_lettered_at TEXT,
  UNIQUE (trigger_id, occurrence_key)
);

INSERT INTO trigger_occurrences (
  id, trigger_id, occurrence_key, project_id, agent_id, scope_key,
  payload_json, provenance_json, input_hash, activation_config_json,
  state, attempts, available_at, activation_id, last_error, occurred_at,
  created_at, updated_at, cancelled_at, dead_lettered_at
)
SELECT
  id, trigger_id, occurrence_key, project_id, agent_id, scope_key,
  payload_json, provenance_json, input_hash, activation_config_json,
  CASE WHEN state IN ('pending', 'debounced') THEN 'cancelled' ELSE state END,
  attempts, available_at, activation_id, last_error, occurred_at,
  created_at, updated_at,
  CASE WHEN state IN ('pending', 'debounced') THEN updated_at ELSE NULL END,
  dead_lettered_at
FROM trigger_occurrences_v31;

DROP TABLE trigger_occurrences_v31;

-- V3.1 contained no user-owned Trigger definitions. Any legacy Activation that
-- has not begun therefore has no authorized V3.2 owner/instructions and must
-- fail closed instead of executing an empty snapshot after upgrade.
UPDATE agent_activations
SET state = 'cancelled', terminal_outcome = NULL, terminal_at = updated_at,
    last_delivery_error = 'legacy Trigger intake cancelled at V3.2 cutover'
WHERE state IN ('pending', 'retry_pending') AND id IN (
  SELECT activation_id FROM trigger_occurrences WHERE activation_id IS NOT NULL
);

UPDATE trigger_occurrences
SET state = 'cancelled', cancelled_at = updated_at,
    last_error = 'legacy Trigger intake cancelled at V3.2 cutover'
WHERE state = 'activated' AND activation_id IN (
  SELECT id FROM agent_activations WHERE state = 'cancelled'
);

CREATE INDEX trigger_occurrences_due
  ON trigger_occurrences(state, available_at, id)
  WHERE state = 'pending';

CREATE INDEX trigger_occurrences_trigger
  ON trigger_occurrences(trigger_id, occurred_at DESC, id);

CREATE INDEX trigger_occurrences_agent
  ON trigger_occurrences(agent_id, state, occurred_at DESC);

CREATE INDEX trigger_occurrences_dead_letter
  ON trigger_occurrences(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
