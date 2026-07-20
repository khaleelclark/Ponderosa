ALTER TABLE managed_artifact_projection ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'project';
ALTER TABLE managed_artifact_projection ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
ALTER TABLE managed_artifact_projection ADD COLUMN audience_json TEXT NOT NULL DEFAULT '{"kind":"organization"}';
ALTER TABLE managed_artifact_projection ADD COLUMN sender_agent_id TEXT;

CREATE INDEX idx_managed_artifact_projection_audience
  ON managed_artifact_projection (project_id, owner_kind, owner_id, artifact_id);
