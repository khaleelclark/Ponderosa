-- Add project-level conversations and optional thread grouping.

CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  title          TEXT NOT NULL,
  default_engine TEXT,
  default_model  TEXT,
  default_effort TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role           TEXT NOT NULL,
  text           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_master ON conversation_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_threads_conversation ON threads (conversation_id);
