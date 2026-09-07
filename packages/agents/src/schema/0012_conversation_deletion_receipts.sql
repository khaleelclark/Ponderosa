CREATE TABLE IF NOT EXISTS conversation_deletion_receipts (
  conversation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  server_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversation_deletion_receipts_pending
  ON conversation_deletion_receipts(storage_cleanup_completed, server_cleanup_completed, created_at);
