-- Additive projection for zero-to-many agent/master-chat membership.
-- Existing threads are backfilled by ThreadStore from canonical thread.json metadata.
CREATE TABLE IF NOT EXISTS thread_master_chat_memberships (
  thread_id TEXT NOT NULL,
  master_chat_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (thread_id, master_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_memberships_master
  ON thread_master_chat_memberships (master_chat_id, position, thread_id);
