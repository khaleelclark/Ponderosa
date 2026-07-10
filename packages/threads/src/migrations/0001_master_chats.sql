-- Add project-level master chats and optional thread grouping.

CREATE TABLE IF NOT EXISTS master_chats (
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

CREATE TABLE IF NOT EXISTS master_chat_messages (
  id             TEXT PRIMARY KEY,
  master_chat_id TEXT NOT NULL,
  role           TEXT NOT NULL,
  text           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_master_chats_project ON master_chats (project_id);
CREATE INDEX IF NOT EXISTS idx_master_chat_messages_master ON master_chat_messages (master_chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_threads_master_chat ON threads (master_chat_id);
