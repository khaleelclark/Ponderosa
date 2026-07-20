-- Rebuildable, bounded provider-session continuation handoffs. Canonical Agent
-- events remain authoritative; this table makes fresh-session lookup O(1).

CREATE TABLE continuation_handoffs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  consumed_by_execution_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_continuation_handoff_source_run
  ON continuation_handoffs (agent_id, source_execution_id);

CREATE INDEX idx_continuation_handoff_pending
  ON continuation_handoffs (agent_id, consumed_at, created_at DESC);
