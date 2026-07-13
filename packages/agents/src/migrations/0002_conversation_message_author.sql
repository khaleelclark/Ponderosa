-- Attribute a conversation message to the agent (agent) that posted it, so the
-- conversation can render agent report-backs (finished/stuck) as a group chat.

ALTER TABLE conversation_messages ADD COLUMN author_agent_id TEXT;
