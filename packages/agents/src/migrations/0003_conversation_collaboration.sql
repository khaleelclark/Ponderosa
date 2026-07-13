-- Keep agent collaboration out of the manager-facing conversation transcript.
ALTER TABLE conversation_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS idx_conversation_messages_channel
  ON conversation_messages (conversation_id, channel, created_at);
