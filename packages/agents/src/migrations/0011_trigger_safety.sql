-- Durable trigger intake. Trigger occurrences may create Activations, but the
-- scheduler remains the only component allowed to create Runs.
CREATE TABLE trigger_occurrences (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  activation_config_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'activated', 'debounced', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  activation_id TEXT REFERENCES agent_activations(id) ON DELETE SET NULL,
  last_error TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dead_lettered_at TEXT,
  UNIQUE (trigger_id, occurrence_key)
);

CREATE INDEX trigger_occurrences_due
  ON trigger_occurrences(state, available_at, id)
  WHERE state = 'pending';

CREATE INDEX trigger_occurrences_debounce
  ON trigger_occurrences(trigger_id, agent_id, scope_key, occurred_at DESC);

CREATE INDEX trigger_occurrences_dead_letter
  ON trigger_occurrences(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
