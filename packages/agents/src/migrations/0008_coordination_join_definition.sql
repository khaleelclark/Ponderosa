ALTER TABLE coordination_joins ADD COLUMN definition_hash TEXT;

CREATE UNIQUE INDEX coordination_one_open_join_per_definition
  ON coordination_joins(project_id, owner_agent_id, definition_hash)
  WHERE state = 'open' AND definition_hash IS NOT NULL;
