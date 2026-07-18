ALTER TABLE agents ADD COLUMN allow_automatic_descendant_deletion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN allow_automatic_descendant_reorganization INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agent_deletion_tombstones (
  agent_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  tombstone_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
