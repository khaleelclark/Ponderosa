-- Rebuildable byte-addressable projection of canonical tool_result events.
-- Keeping the immutable payload separate lets exact-output pages read only the
-- requested byte range instead of parsing and hashing the full event per page.
CREATE TABLE IF NOT EXISTS tool_output_projection (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  output BLOB NOT NULL,
  total_utf8_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
