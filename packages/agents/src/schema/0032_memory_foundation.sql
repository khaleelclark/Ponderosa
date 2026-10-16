-- Canonical memory foundation. No runtime grants or public API enabled.
CREATE TABLE memory_scope_generations (
  scope TEXT NOT NULL CHECK(scope IN ('project','global')),
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  PRIMARY KEY(scope,owner_id)
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('project','global')),
  owner_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision > 0),
  generation INTEGER NOT NULL CHECK(generation > 0),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','forgotten')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  forgotten_at TEXT
);
CREATE INDEX memories_owner ON memories(scope,owner_id,lifecycle);
CREATE TABLE memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  author_json TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('user_statement','agent_inference')),
  sources_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  prior_revision INTEGER,
  PRIMARY KEY(memory_id,revision)
);
-- Receipts never retain text, sources or author metadata.
CREATE TABLE memory_commands (
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(scope,owner_id,actor_id,command_key)
);
CREATE TABLE memory_tombstones (
  memory_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  deleted_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('forgotten','project_deleted'))
);
-- Transactional invalidation intent, not a semantic worker/job framework.
-- Consumers must use immutable memory:revision:generation IDs and hydrate live.
CREATE TABLE memory_index_intents (
  memory_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','remove')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(memory_id,generation)
);
CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED,revision UNINDEXED,text);
