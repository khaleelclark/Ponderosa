ALTER TABLE projects ADD COLUMN default_engine TEXT NOT NULL DEFAULT 'codex';
ALTER TABLE projects ADD COLUMN last_conversation_id TEXT;
