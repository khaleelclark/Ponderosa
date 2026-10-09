-- One persistent coordinator per live Dev Chat, including an archived Agent.
-- Delete the Agent through canonical deletion before replacing its identity.
CREATE TABLE IF NOT EXISTS pinecone_profiles (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) DEFERRABLE INITIALLY DEFERRED,
  guidance_version INTEGER NOT NULL CHECK(guidance_version = 1),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pinecone_profiles_project ON pinecone_profiles(project_id);
