-- Durable Trigger admission, retry-budget identity, and filesystem quiet-window
-- state. Trigger-owned rows intentionally avoid projection foreign keys because
-- definitions survive ordinary projection rebuilds.
ALTER TABLE trigger_occurrences ADD COLUMN budget_charge_id TEXT;
ALTER TABLE trigger_occurrences ADD COLUMN budget_charged_at TEXT;

CREATE INDEX trigger_occurrences_budget_charge
  ON trigger_occurrences(trigger_id, budget_charge_id, activation_id)
  WHERE budget_charge_id IS NOT NULL;

CREATE TABLE trigger_filesystem_bursts (
  trigger_id TEXT PRIMARY KEY,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  changes_json TEXT NOT NULL,
  dropped_path_event_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_path_event_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX trigger_filesystem_bursts_project
  ON trigger_filesystem_bursts(project_id, updated_at, trigger_id);
