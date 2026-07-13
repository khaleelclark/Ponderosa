-- Attribute a conversation message to the agent (thread) that posted it, so the
-- conversation can render agent report-backs (finished/stuck) as a group chat.

ALTER TABLE conversation_messages ADD COLUMN author_thread_id TEXT;
