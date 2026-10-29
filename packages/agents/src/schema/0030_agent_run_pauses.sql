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
