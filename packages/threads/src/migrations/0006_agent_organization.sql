ALTER TABLE threads ADD COLUMN organizational_parent_agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_threads_organizational_parent ON threads (organizational_parent_agent_id);
