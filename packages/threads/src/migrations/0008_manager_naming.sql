ALTER TABLE threads RENAME COLUMN organizational_parent_agent_id TO manager_agent_id;
DROP INDEX IF EXISTS idx_threads_organizational_parent;
CREATE INDEX IF NOT EXISTS idx_threads_manager ON threads (manager_agent_id);
