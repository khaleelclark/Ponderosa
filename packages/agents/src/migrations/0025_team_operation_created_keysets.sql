-- Team operational history is immutable by creation identity. State updates
-- must never move an unseen row behind a previously issued history cursor.
CREATE INDEX IF NOT EXISTS idx_coordination_requests_conversation_created
  ON coordination_requests (project_id, conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coordination_joins_conversation_created
  ON coordination_joins (project_id, conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_activations_scope_created
  ON agent_activations (project_id, scope_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_scope_created
  ON scheduler_runs (project_id, scope_key, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_trigger_occurrences_scope_created
  ON trigger_occurrences (project_id, scope_key, created_at DESC, id DESC);
