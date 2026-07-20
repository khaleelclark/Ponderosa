-- Rebuildable hot-path indexes. Canonical JSONL ledgers remain authoritative;
-- startup rebuilds every row below before the daemon serves reads.

CREATE TABLE agent_event_head_projection (
  agent_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE agent_health_projection (
  agent_id TEXT PRIMARY KEY,
  source_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_timestamp TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE all_chat_feed_projection (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  order_key TEXT NOT NULL,
  PRIMARY KEY (project_id, communication_event_id)
);

CREATE INDEX idx_all_chat_feed_keyset
  ON all_chat_feed_projection (order_key DESC, row_key DESC);

CREATE INDEX idx_chat_search_feed_choice
  ON chat_search_messages
    (project_id, communication_event_id, chat_kind, chat_id, row_key);

ALTER TABLE changed_file_projection ADD COLUMN execution_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE changed_file_execution_projection (
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, path, execution_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_changed_file_execution_detail
  ON changed_file_execution_projection (agent_id, path, last_seq DESC, execution_id DESC);
