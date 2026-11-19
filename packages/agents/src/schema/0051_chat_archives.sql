-- Chat metadata is rebuilt from files on startup. The archive and dispatch
-- hold are lifecycle authority and survive projection rebuilds.
CREATE TABLE chat_archives (
  conversation_id TEXT PRIMARY KEY,
  archived_at TEXT
);
