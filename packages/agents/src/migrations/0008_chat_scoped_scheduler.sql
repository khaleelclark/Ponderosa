-- Make Team Chat membership an authoritative Communication V3 boundary.

ALTER TABLE coordination_requests ADD COLUMN conversation_id TEXT;
ALTER TABLE coordination_joins ADD COLUMN conversation_id TEXT;
ALTER TABLE agent_activations ADD COLUMN scope_key TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_runs ADD COLUMN scope_key TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_runs ADD COLUMN context_disposition TEXT NOT NULL DEFAULT 'fresh_task';

CREATE INDEX agent_activations_agent_scope_runnable
  ON agent_activations(agent_id, scope_key, state, available_at, priority DESC, created_at);
CREATE INDEX scheduler_runs_agent_scope
  ON scheduler_runs(agent_id, scope_key, created_at);
