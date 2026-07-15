ALTER TABLE coordination_joins
  ADD COLUMN continuation_request_ids_json TEXT NOT NULL DEFAULT '[]';
