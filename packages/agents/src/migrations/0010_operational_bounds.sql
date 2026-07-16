ALTER TABLE provider_operation_outbox ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE activation_outbox ADD COLUMN dead_lettered_at TEXT;

CREATE INDEX provider_operation_outbox_dead_letter
  ON provider_operation_outbox(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX activation_outbox_dead_letter
  ON activation_outbox(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
