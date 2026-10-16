-- Explicit post-baseline extension for disposable pre-release databases that
-- already carry the 0000 marker. Fresh databases contain the same tables.
CREATE TABLE IF NOT EXISTS communication_v4_next_run_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  publisher_kind TEXT NOT NULL CHECK (publisher_kind IN ('agent', 'operator')),
  publisher_agent_id TEXT,
  publisher_user_id TEXT,
  publisher_label TEXT NOT NULL,
  source_run_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  recipient_agent_ids_json TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (publisher_kind = 'agent' AND publisher_agent_id IS NOT NULL
      AND publisher_user_id IS NULL AND source_run_id IS NOT NULL)
    OR
    (publisher_kind = 'operator' AND publisher_agent_id IS NULL
      AND publisher_user_id IS NOT NULL AND source_run_id IS NULL)
  ),
  UNIQUE (publisher_agent_id, source_run_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS communication_v4_next_run_recipients (
  delivery_id TEXT NOT NULL REFERENCES communication_v4_next_run_deliveries(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  recipient_label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'expired', 'unavailable')),
  delivered_run_id TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  expired_at TEXT,
  unavailable_at TEXT,
  unavailable_reason TEXT,
  PRIMARY KEY (delivery_id, agent_id)
);

CREATE INDEX IF NOT EXISTS communication_v4_next_run_deliveries_scope_newest
  ON communication_v4_next_run_deliveries(project_id, conversation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS communication_v4_next_run_deliveries_operator_idempotency
  ON communication_v4_next_run_deliveries(publisher_user_id, conversation_id, idempotency_key)
  WHERE publisher_kind = 'operator';
CREATE INDEX IF NOT EXISTS communication_v4_next_run_recipients_pending
  ON communication_v4_next_run_recipients(agent_id, state, created_at, delivery_id);
