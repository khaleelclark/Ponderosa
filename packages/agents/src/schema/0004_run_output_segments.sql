CREATE TABLE IF NOT EXISTS run_output_segments (
  agent_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('text', 'reasoning')),
  execution_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  text_preview TEXT NOT NULL DEFAULT '',
  preview_utf8_bytes INTEGER NOT NULL DEFAULT 0,
  raw_utf8_bytes INTEGER NOT NULL DEFAULT 0,
  canonical_utf8_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, first_seq),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_output_segments_agent_newest
  ON run_output_segments (agent_id, first_seq DESC);
CREATE INDEX IF NOT EXISTS idx_run_output_segments_execution_response
  ON run_output_segments (agent_id, execution_id, event_type, first_seq DESC);

CREATE TABLE IF NOT EXISTS run_output_heads (
  agent_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  execution_id TEXT,
  segment_first_seq INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- AgentStore's canonical startup rebuild fills both projections from the
-- append-only event logs before any read surface becomes available.
