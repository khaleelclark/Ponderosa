ALTER TABLE agents ADD COLUMN active_session_contract_hash TEXT;
ALTER TABLE agents ADD COLUMN active_session_artifact_ids_json TEXT NOT NULL DEFAULT '[]';
