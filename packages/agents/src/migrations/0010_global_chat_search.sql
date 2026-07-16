-- Disposable, bounded global Chat search projection. Canonical communication
-- events and placement ledgers rebuild these rows on startup.
CREATE TABLE chat_search_messages (
  row_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('conversation', 'agent')),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  author_agent_id TEXT,
  timestamp TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE INDEX idx_chat_search_newest
  ON chat_search_messages (timestamp DESC, chat_kind DESC, row_key DESC);
CREATE INDEX idx_chat_search_event
  ON chat_search_messages (project_id, communication_event_id, chat_kind);
CREATE INDEX idx_chat_search_chat_newest
  ON chat_search_messages (chat_kind, chat_id, timestamp DESC);
CREATE INDEX idx_conversations_global_recent
  ON conversations (updated_at DESC, id);
