-- Keep agent collaboration out of the manager-facing master-chat transcript.
ALTER TABLE master_chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS idx_master_chat_messages_channel
  ON master_chat_messages (master_chat_id, channel, created_at);
