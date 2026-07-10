-- Attribute a master-chat message to the agent (thread) that posted it, so the
-- master chat can render agent report-backs (finished/stuck) as a group chat.

ALTER TABLE master_chat_messages ADD COLUMN author_thread_id TEXT;
