CREATE TABLE agent_run_pauses (
 id TEXT PRIMARY KEY,
 agent_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('paused','resume_requested','resumed','stopped')),
 pause_key TEXT NOT NULL,
 resume_key TEXT,
 provider_input_json TEXT NOT NULL,
 injection_snapshot_json TEXT NOT NULL,
 paused_at TEXT NOT NULL,
 resumed_at TEXT,
 UNIQUE(agent_id,pause_key)
);
CREATE UNIQUE INDEX agent_run_pause_active ON agent_run_pauses(agent_id) WHERE state IN ('paused','resume_requested');

ALTER TABLE agent_run_pauses ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_run_pauses ADD COLUMN phase TEXT NOT NULL DEFAULT 'source';
ALTER TABLE agent_run_pauses ADD COLUMN rollover_id TEXT;
ALTER TABLE agent_run_pauses ADD COLUMN recovery_activation_id TEXT;
ALTER TABLE agent_run_pauses ADD COLUMN last_error TEXT;
CREATE TABLE agent_pause_recoveries (
 pause_id TEXT NOT NULL REFERENCES agent_run_pauses(id) ON DELETE CASCADE,
 resume_key TEXT NOT NULL,
 activation_id TEXT NOT NULL UNIQUE,
 run_id TEXT UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','outcome_unknown','stopped')),
 error TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(pause_id,resume_key)
);
