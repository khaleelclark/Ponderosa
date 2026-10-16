-- Installation identity is opaque, not an account/credential or proxy identity.
CREATE TABLE memory_installation_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  principal_id TEXT NOT NULL UNIQUE
);
-- Explicit operator-only recall grants; product is an authority restriction,
-- not a third memory scope. Revocation retains a generation for future sessions.
CREATE TABLE memory_global_grants (
  project_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('dev','branches')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id,product)
);
CREATE TABLE memory_promotions (
  memory_id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  source_text_hash TEXT NOT NULL
);
