-- Project deletion crosses fallible browser/provider cleanup. Persist the
-- quarantine before cleanup begins so a daemon restart cannot restore intake
-- or runtime authority for a Project whose deletion has not committed.

CREATE TABLE project_deletion_pending (
  project_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_error TEXT
);
