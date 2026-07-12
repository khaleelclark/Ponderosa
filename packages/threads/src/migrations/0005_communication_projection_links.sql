ALTER TABLE master_chat_messages ADD COLUMN communication_event_id TEXT;
ALTER TABLE messages ADD COLUMN communication_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS master_chat_message_communication_projection
  ON master_chat_messages(communication_event_id)
  WHERE communication_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS thread_message_communication_projection
  ON messages(thread_id, communication_event_id)
  WHERE communication_event_id IS NOT NULL;
