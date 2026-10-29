-- Keep access changes atomic with their policy revision. Existing policies have
-- no reconstructed history: the first new change records their actual before state.
CREATE TABLE capability_policy_history (
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, revision)
);
