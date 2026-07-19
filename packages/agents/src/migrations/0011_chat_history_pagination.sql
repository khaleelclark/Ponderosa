-- This table is a disposable projection. Recreate it with the canonical order
-- key and Team Chat surface needed for stable, bounded timeline reads.
DROP TABLE chat_search_messages;

CREATE TABLE chat_search_messages (
  row_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('conversation', 'collaboration', 'agent')),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  author_agent_id TEXT,
  timestamp TEXT NOT NULL,
  order_key TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE INDEX idx_chat_search_newest
  ON chat_search_messages (timestamp DESC, chat_kind DESC, row_key DESC);
CREATE INDEX idx_chat_search_event
  ON chat_search_messages (project_id, communication_event_id, chat_kind);
CREATE INDEX idx_chat_search_chat_newest
  ON chat_search_messages (chat_kind, chat_id, order_key DESC, row_key DESC);
