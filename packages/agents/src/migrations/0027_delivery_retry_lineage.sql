-- Delivery retries are an append-only structural chain. The predecessor key
-- admits at most one successor, while (root, attempt_number) supplies stable
-- ordering independent of caller idempotency keys and wall-clock timestamps.

CREATE TABLE activation_delivery_retry_lineage (
  predecessor_activation_id TEXT PRIMARY KEY
    REFERENCES agent_activations(id) ON DELETE RESTRICT,
  successor_activation_id TEXT NOT NULL UNIQUE
    REFERENCES agent_activations(id) ON DELETE RESTRICT,
  root_activation_id TEXT NOT NULL
    REFERENCES agent_activations(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  created_at TEXT NOT NULL,
  UNIQUE (root_activation_id, attempt_number)
);

CREATE INDEX activation_delivery_retry_lineage_successor
  ON activation_delivery_retry_lineage(successor_activation_id);
