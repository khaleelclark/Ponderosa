ALTER TABLE agent_creation_operations
  ADD COLUMN artifact_identities_json TEXT NOT NULL DEFAULT '[]';
