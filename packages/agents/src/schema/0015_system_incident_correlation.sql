-- Only directly observed recovery events receive an incident. This table does
-- not infer an OOM, provider outage, or a cause for historical unknown Runs.
CREATE TABLE IF NOT EXISTS system_incidents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('startup_orphaned_run_recovery')),
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS system_incident_runs (
  incident_id TEXT NOT NULL REFERENCES system_incidents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE RESTRICT,
  PRIMARY KEY (incident_id, run_id),
  UNIQUE (run_id)
);
