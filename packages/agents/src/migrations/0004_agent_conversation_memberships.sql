-- Additive projection for zero-to-many agent/conversation membership.
-- Existing agents are backfilled by AgentStore from canonical agent.json metadata.
CREATE TABLE IF NOT EXISTS agent_conversation_memberships (
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_memberships_master
  ON agent_conversation_memberships (conversation_id, position, agent_id);
