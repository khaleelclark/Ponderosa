-- Existing ordinary Agents receive no profile. Existing Pinecones start active.
ALTER TABLE pinecone_profiles ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'active' CHECK(admission_state IN ('active','paused'));
ALTER TABLE pinecone_profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE pinecone_profiles ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE pinecone_profiles SET updated_at=created_at WHERE updated_at='';
CREATE INDEX IF NOT EXISTS pinecone_profiles_admission ON pinecone_profiles(agent_id,admission_state);
CREATE TABLE IF NOT EXISTS pinecone_admission_receipts (
  agent_id TEXT NOT NULL REFERENCES pinecone_profiles(agent_id) DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) DEFERRABLE INITIALLY DEFERRED,
  operation_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(agent_id,operation_key)
);
CREATE INDEX IF NOT EXISTS pinecone_admission_receipts_project ON pinecone_admission_receipts(project_id);
CREATE INDEX IF NOT EXISTS pinecone_admission_receipts_chat ON pinecone_admission_receipts(conversation_id);
