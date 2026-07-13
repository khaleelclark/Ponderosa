ALTER TABLE conversation_messages ADD COLUMN communication_event_id TEXT;
ALTER TABLE messages ADD COLUMN communication_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_communication_projection
  ON conversation_messages(communication_event_id)
  WHERE communication_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_message_communication_projection
  ON messages(agent_id, communication_event_id)
  WHERE communication_event_id IS NOT NULL;
