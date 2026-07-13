-- Additive projection for zero-to-many agent/conversation membership.
-- Existing threads are backfilled by ThreadStore from canonical thread.json metadata.
CREATE TABLE IF NOT EXISTS thread_conversation_memberships (
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (thread_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_memberships_master
  ON thread_conversation_memberships (conversation_id, position, thread_id);
