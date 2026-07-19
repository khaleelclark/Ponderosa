-- Rebuildable, work-bounded read projections for provider context and ordinary
-- Agent audit/list surfaces. Canonical JSONL remains authoritative.

ALTER TABLE chat_search_messages ADD COLUMN conversation_id TEXT;
ALTER TABLE chat_search_messages ADD COLUMN communication_intent TEXT;
ALTER TABLE chat_search_messages ADD COLUMN sender_kind TEXT;
ALTER TABLE chat_search_messages ADD COLUMN sender_agent_id TEXT;
ALTER TABLE chat_search_messages ADD COLUMN context_policy TEXT;

ALTER TABLE artifacts ADD COLUMN source_path TEXT;
ALTER TABLE artifacts ADD COLUMN media_type TEXT;
ALTER TABLE artifacts ADD COLUMN visibility TEXT;
ALTER TABLE artifacts ADD COLUMN pinned INTEGER;
ALTER TABLE artifacts ADD COLUMN size INTEGER;

CREATE INDEX idx_artifact_source_projection
  ON artifacts (agent_id, kind, source_path, created_at DESC, id DESC);

CREATE INDEX idx_chat_context_newest
  ON chat_search_messages (
    chat_kind, chat_id, context_policy, timestamp DESC, message_id DESC
  );

CREATE INDEX idx_agent_context_newest
  ON chat_search_messages (
    chat_kind, chat_id, conversation_id, communication_intent,
    timestamp DESC, message_id DESC
  );

CREATE INDEX idx_agent_authored_broadcast_context_newest
  ON chat_search_messages (
    chat_kind, chat_id, conversation_id, communication_intent, sender_agent_id,
    timestamp DESC, message_id DESC
  );

CREATE TABLE imported_history_messages (
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, message_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_imported_history_newest
  ON imported_history_messages (agent_id, created_at DESC, message_id DESC);

CREATE TABLE activity_projection (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  execution_id TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  output_preview_utf8_bytes INTEGER,
  output_total_utf8_bytes INTEGER,
  output_sha256 TEXT,
  PRIMARY KEY (agent_id, seq),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_activity_projection_newest
  ON activity_projection (agent_id, seq DESC);

CREATE INDEX idx_activity_projection_execution
  ON activity_projection (agent_id, execution_id, event_type, seq);

CREATE TABLE changed_file_projection (
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  last_changed_at TEXT NOT NULL,
  execution_ids_json TEXT NOT NULL,
  diff TEXT,
  PRIMARY KEY (agent_id, path),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_changed_file_projection_newest
  ON changed_file_projection (agent_id, last_seq DESC, path DESC);

CREATE TABLE managed_artifact_projection (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  visibility TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  artifact_json TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id)
);

CREATE INDEX idx_managed_artifact_projection_newest
  ON managed_artifact_projection (project_id, created_at DESC, artifact_id DESC);

CREATE INDEX idx_managed_artifact_projection_context
  ON managed_artifact_projection (project_id, pinned, visibility, created_at DESC, artifact_id DESC);
