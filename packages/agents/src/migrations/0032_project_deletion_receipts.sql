-- An irreversible Project purge must remain observable after its canonical
-- Project row and pre-commit quarantine journal have been removed. Keep the
-- exact filesystem tombstone and retryable cleanup state in a durable receipt.

CREATE TABLE project_deletion_receipts (
  project_id TEXT PRIMARY KEY NOT NULL,
  tombstone_name TEXT NOT NULL,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
