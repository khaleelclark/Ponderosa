-- Disposable SQLite projections for the canonical Ponderosa V1 logs.

CREATE TABLE projects (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, host_path TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT
);

CREATE TABLE agent_presets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, guidance TEXT NOT NULL, engine TEXT NOT NULL,
  model TEXT, effort TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  default_engine TEXT, default_model TEXT, default_effort TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT,
  title TEXT NOT NULL, active_engine TEXT NOT NULL, active_session_id TEXT,
  state_branch TEXT, state_commit TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  manager_agent_id TEXT, spawned_by_agent_id TEXT, spawned_by_execution_id TEXT,
  spawn_prompt TEXT, spawn_idempotency_key TEXT, preset_snapshot_json TEXT
);

CREATE TABLE agent_conversation_memberships (
  agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, communication_event_id TEXT, agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL, reply_to_json TEXT, attachments_json TEXT
);

CREATE TABLE runs (
  id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT NOT NULL, engine TEXT NOT NULL,
  communication_event_id TEXT, started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY (agent_id, id)
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, execution_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, execution_id TEXT,
  kind TEXT NOT NULL, path TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE INDEX idx_agents_project ON agents (project_id);
CREATE INDEX idx_agents_conversation ON agents (conversation_id);
CREATE INDEX idx_agents_manager ON agents (manager_agent_id);
CREATE UNIQUE INDEX idx_agents_agent_spawn_idempotency
  ON agents (spawned_by_agent_id, spawned_by_execution_id, spawn_idempotency_key)
  WHERE spawned_by_agent_id IS NOT NULL
    AND spawned_by_execution_id IS NOT NULL
    AND spawn_idempotency_key IS NOT NULL;
CREATE INDEX idx_conversations_project ON conversations (project_id);
CREATE INDEX idx_agent_memberships_conversation
  ON agent_conversation_memberships (conversation_id, position, agent_id);
CREATE INDEX idx_messages_agent ON messages (agent_id, seq);
CREATE UNIQUE INDEX agent_message_communication_projection
  ON messages (agent_id, communication_event_id)
  WHERE communication_event_id IS NOT NULL;
CREATE INDEX idx_runs_agent ON runs (agent_id, started_at);
CREATE INDEX idx_work_items_agent ON work_items (agent_id, updated_at);
CREATE INDEX idx_artifacts_agent ON artifacts (agent_id);
CREATE INDEX idx_events_agent_seq ON events (agent_id, seq);
CREATE INDEX idx_events_type ON events (type);
