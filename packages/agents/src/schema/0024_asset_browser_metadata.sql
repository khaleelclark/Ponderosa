-- Fresh current metadata shares the coordination database and transaction.
CREATE TABLE IF NOT EXISTS asset_reservations (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0), created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_reservation_agent ON asset_reservations(project_id, agent_id);
CREATE TABLE IF NOT EXISTS asset_committed (
  asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0)
);
CREATE INDEX IF NOT EXISTS asset_committed_agent ON asset_committed(project_id, agent_id);
CREATE TABLE IF NOT EXISTS asset_settlements (reservation_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_deletions (
  asset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL DEFAULT 0, audit_event_id TEXT, completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS asset_rate_events (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_rate_agent ON asset_rate_events(project_id, agent_id, created_at);
CREATE TABLE IF NOT EXISTS asset_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, agent_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE TABLE IF NOT EXISTS runtime_attachment_associations (
  communication_id TEXT NOT NULL, asset_id TEXT NOT NULL, project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (communication_id, asset_id)
);
CREATE INDEX IF NOT EXISTS runtime_attachment_associations_owner
  ON runtime_attachment_associations(project_id, agent_id, asset_id);
CREATE TABLE IF NOT EXISTS runtime_artifact_authority (
  id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
  title TEXT NOT NULL, media_type TEXT NOT NULL, blob_path TEXT NOT NULL,
  blob_hash TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  origin_agent_id TEXT, execution_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_artifact_authority_owner_role
  ON runtime_artifact_authority(project_id, id, role);
CREATE TABLE IF NOT EXISTS generated_artifact_authority (
  id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  origin_agent_id TEXT NOT NULL, execution_id TEXT, kind TEXT NOT NULL CHECK(kind = 'generated_file'),
  artifact_path TEXT NOT NULL, source_path TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL,
  media_type TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  blob_hash TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS generated_artifact_authority_owner
  ON generated_artifact_authority(project_id, origin_agent_id, id);
CREATE TABLE IF NOT EXISTS generated_artifact_import_receipts (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, artifact_id TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, tool_call_id),
  UNIQUE (project_id, artifact_id),
  FOREIGN KEY (project_id, artifact_id)
  REFERENCES generated_artifact_authority(project_id, id)
);

CREATE TABLE draft_attachment_cleanups (
  draft_id TEXT NOT NULL, owner_id TEXT NOT NULL, asset_id TEXT NOT NULL,
  eligible_at INTEGER NOT NULL,
  PRIMARY KEY (draft_id, owner_id, asset_id)
);
CREATE INDEX draft_attachment_cleanup_due
  ON draft_attachment_cleanups(eligible_at);

CREATE TABLE draft_asset_reservations (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE,
  draft_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size > 0), created_at INTEGER NOT NULL
);
CREATE INDEX draft_asset_reservation_surface
  ON draft_asset_reservations(draft_id);
CREATE TABLE draft_asset_committed (
  asset_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0)
);
CREATE INDEX draft_asset_committed_surface
  ON draft_asset_committed(draft_id);
CREATE TABLE draft_asset_settlements (
  reservation_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL,
  draft_id TEXT NOT NULL, owner_id TEXT NOT NULL
);
CREATE TABLE draft_asset_rate_events (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX draft_asset_rate_surface
  ON draft_asset_rate_events(draft_id, created_at);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  namespace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS browser_profiles_project
  ON browser_profiles(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS browser_agent_preferences (
  agent_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  namespace_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('disposable','trusted')),
  profile_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK((mode='disposable' AND profile_id IS NULL) OR (mode='trusted' AND profile_id IS NOT NULL)),
  FOREIGN KEY(profile_id) REFERENCES browser_profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS browser_agent_preferences_project
  ON browser_agent_preferences(project_id, agent_id);
CREATE TABLE IF NOT EXISTS browser_chat_profiles (
  project_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS saved_browser (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  promoted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_browser_access (
  profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, project_id, agent_id)
);
CREATE INDEX IF NOT EXISTS saved_browser_access_agent
  ON saved_browser_access(agent_id, project_id);
CREATE TABLE IF NOT EXISTS saved_browser_access_fences (
  profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(profile_id, project_id, agent_id)
);
CREATE TABLE IF NOT EXISTS saved_browser_approval_intents (
  decision_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','applied','revoked'))
);

CREATE TABLE IF NOT EXISTS launcher_browser_sessions (
  token_digest TEXT PRIMARY KEY,
  credential_binding TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS launcher_browser_sessions_expiry
  ON launcher_browser_sessions(expires_at_ms);
