-- Exact native task stop attempts: uncertain mutations are never replayed.
CREATE TABLE IF NOT EXISTS native_task_stops (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  command_key TEXT NOT NULL, run_id TEXT NOT NULL, source_fence INTEGER NOT NULL CHECK(source_fence > 0),
  session_id TEXT NOT NULL, task_key TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('acknowledged','terminated','not_found','unknown')),
  created_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY(agent_id, command_key), UNIQUE(agent_id, run_id, source_fence, session_id, task_key)
);
