-- Exact durable import submission identity.
CREATE TABLE IF NOT EXISTS agent_import_submission_intents (
 project_id TEXT NOT NULL, request_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, product_scope TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL, request_fingerprint TEXT,
 operation_id TEXT NOT NULL UNIQUE, staged_name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','queued','retired')),
 PRIMARY KEY(project_id, request_id)
);
