-- Stable newest-first keyset reads for independently paged Agent telemetry.
CREATE INDEX IF NOT EXISTS idx_runs_agent_started_id
  ON runs (agent_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_work_items_agent_created_id
  ON work_items (agent_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_artifacts_agent_created_id
  ON artifacts (agent_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_events_agent_type_seq
  ON events (agent_id, type, seq DESC);

CREATE INDEX IF NOT EXISTS idx_coordination_requests_conversation_updated
  ON coordination_requests (project_id, conversation_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_coordination_joins_conversation_updated
  ON coordination_joins (project_id, conversation_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_activations_scope_updated
  ON agent_activations (project_id, scope_key, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scheduler_runs_scope_updated
  ON scheduler_runs (project_id, scope_key, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_trigger_occurrences_scope_updated
  ON trigger_occurrences (project_id, scope_key, updated_at DESC, id DESC);
