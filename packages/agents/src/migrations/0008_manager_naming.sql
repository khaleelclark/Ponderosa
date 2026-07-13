ALTER TABLE agents RENAME COLUMN organizational_parent_agent_id TO manager_agent_id;
DROP INDEX IF EXISTS idx_agents_organizational_parent;
CREATE INDEX IF NOT EXISTS idx_agents_manager ON agents (manager_agent_id);
