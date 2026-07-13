ALTER TABLE agents ADD COLUMN organizational_parent_agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agents_organizational_parent ON agents (organizational_parent_agent_id);
