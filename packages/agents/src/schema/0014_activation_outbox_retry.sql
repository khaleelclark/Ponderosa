ALTER TABLE activation_outbox ADD COLUMN available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

-- Older builds dead-lettered otherwise valid signals after eight rapid tries.
-- Restore them to bounded retry; malformed payloads remain repair obligations.
UPDATE activation_outbox
SET dead_lettered_at = NULL,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    claimed_by = NULL,
    claimed_at = NULL
WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL
  AND last_error <> 'invalid activation-outbox payload'
  AND json_valid(payload_json) = 1;

CREATE INDEX IF NOT EXISTS activation_outbox_available
  ON activation_outbox (available_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
