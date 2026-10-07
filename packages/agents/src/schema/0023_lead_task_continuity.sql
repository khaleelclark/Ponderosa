-- Additive only: historical tasks/answers are not revived or completed.
ALTER TABLE coordination_requests ADD COLUMN origin_run_id TEXT REFERENCES scheduler_runs(id) ON DELETE SET NULL;
ALTER TABLE coordination_joins ADD COLUMN origin_run_id TEXT REFERENCES scheduler_runs(id) ON DELETE SET NULL;
ALTER TABLE required_reply_obligations ADD COLUMN delivery_phase TEXT NOT NULL DEFAULT 'initial'
  CHECK (delivery_phase IN ('initial', 'final'));
ALTER TABLE required_reply_obligations ADD COLUMN interim_communication_id TEXT;
ALTER TABLE required_reply_obligations ADD COLUMN blocking_decision_id TEXT;
ALTER TABLE context_rollovers ADD COLUMN continuity_waiting INTEGER NOT NULL DEFAULT 0
  CHECK (continuity_waiting IN (0, 1));
CREATE INDEX idx_requests_task_origin ON coordination_requests(origin_run_id, state);
CREATE INDEX idx_joins_task_origin ON coordination_joins(origin_run_id, state);
CREATE INDEX idx_reply_task_decision ON required_reply_obligations(blocking_decision_id);
CREATE INDEX idx_reply_task_root ON required_reply_obligations(source_activation_id, project_id, agent_id, scope_key, run_id);
CREATE INDEX idx_rollover_retained_continuity ON context_rollovers(agent_id, scope_key) WHERE continuity_waiting = 1;
