ALTER TABLE activation_outbox ADD COLUMN available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

-- Do not infer that historical dead letters are transient. JSON-valid payloads
-- may still be structurally or semantically invalid. They require exact-row
-- operator repair before requeueing, while new transient failures back off.

CREATE TABLE IF NOT EXISTS activation_outbox_repair_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL,
  activation_id TEXT NOT NULL,
  previous_payload_json TEXT NOT NULL,
  replacement_payload_json TEXT NOT NULL,
  previous_error TEXT NOT NULL,
  reason TEXT NOT NULL,
  repaired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS activation_outbox_available
  ON activation_outbox (available_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
