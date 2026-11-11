ALTER TABLE imported_history_messages ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'history';
ALTER TABLE imported_history_messages ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imported_history_messages ADD COLUMN source_created_at TEXT;
ALTER TABLE imported_history_messages ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE imported_history_messages ADD COLUMN total_code_points INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imported_history_messages ADD COLUMN total_utf8_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imported_history_messages ADD COLUMN code_point_byte_offsets TEXT NOT NULL DEFAULT '[0]';

CREATE INDEX idx_imported_history_sequence ON imported_history_messages(agent_id, sequence);
CREATE TABLE imported_history_indexes (
  agent_id TEXT PRIMARY KEY,
  archive_version TEXT NOT NULL,
  integrity_key TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  expected_messages INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('preparing', 'ready', 'unavailable'))
);
CREATE VIRTUAL TABLE imported_history_fts USING fts5(text, tokenize='unicode61');
CREATE TRIGGER imported_history_fts_delete AFTER DELETE ON imported_history_messages
BEGIN
  DELETE FROM imported_history_fts WHERE rowid = old.rowid;
END;
