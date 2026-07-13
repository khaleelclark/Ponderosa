CREATE TABLE agent_presets (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
 guidance TEXT NOT NULL, engine TEXT NOT NULL, model TEXT, effort TEXT, enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE agents ADD COLUMN preset_snapshot_json TEXT;
