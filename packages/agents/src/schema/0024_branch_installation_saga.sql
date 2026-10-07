-- Canonical Chat and Agent mutations live outside SQLite. Keep their before-images
-- until publication succeeds or compensation and staging cleanup are observed.
ALTER TABLE branch_installation_plans ADD COLUMN journal_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE branch_installation_plans ADD COLUMN owned_resources_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX branch_installation_cancellation ON branch_installation_plans(state,updated_at);
