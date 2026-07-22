CREATE TABLE coordination_request_late_results (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('completed', 'blocked', 'failed')),
  actor_agent_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_coordination_request_late_results_request
  ON coordination_request_late_results (request_id, created_at, id);
