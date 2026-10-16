CREATE TABLE IF NOT EXISTS required_reply_obligations (
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  source_activation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  reply_authority_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'satisfied', 'recovery_pending', 'failed',
    'cancelled', 'retried', 'superseded'
  )),
  satisfied_communication_id TEXT,
  recovery_activation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  PRIMARY KEY (run_id, source_activation_id)
);

CREATE INDEX IF NOT EXISTS idx_required_reply_obligations_state
  ON required_reply_obligations (state, updated_at, run_id);

-- Upgrade recovery is intentionally bounded and fails closed instead of
-- silently dropping an in-flight human reply when the bound is exceeded.
CREATE TEMP TABLE _required_reply_backfill_guard (
  candidate_count INTEGER NOT NULL CHECK (candidate_count <= 10000)
);
INSERT INTO _required_reply_backfill_guard (candidate_count)
SELECT COUNT(*)
FROM scheduler_runs run
JOIN scheduler_run_activations attached ON attached.run_id = run.id
JOIN agent_activations activation ON activation.id = attached.activation_id
WHERE run.status IN ('leased', 'running')
  AND (
    (
      activation.kind IN (
        'human_message', 'required_reply_recovery', 'coordination_outcome',
        'coordination_join_satisfied', 'coordination_join_impossible',
        'context_rollover_handoff'
      )
      AND json_type(activation.payload_json, '$.replyAuthority') = 'object'
      AND json_extract(activation.payload_json, '$.replyAuthority.intent') IN (
        'broadcast', 'direct_to_user', 'collaboration'
      )
    )
    OR (
      activation.kind = 'human_message'
      AND json_extract(activation.payload_json, '$.communication.sender.kind') = 'user'
      AND json_extract(activation.payload_json, '$.communication.intent') IN (
        'broadcast', 'user_dm'
      )
    )
  );

INSERT OR IGNORE INTO required_reply_obligations (
  run_id, source_activation_id, project_id, agent_id, scope_key,
  reply_authority_json, attempt_count, state, created_at, updated_at
)
SELECT
  run.id,
  activation.id,
  run.project_id,
  run.agent_id,
  run.scope_key,
  CASE
    WHEN json_type(activation.payload_json, '$.replyAuthority') = 'object'
      THEN json_extract(activation.payload_json, '$.replyAuthority')
    WHEN json_extract(activation.payload_json, '$.communication.intent') = 'broadcast'
      THEN '{"intent":"broadcast"}'
    ELSE '{"intent":"direct_to_user"}'
  END,
  MAX(0, COALESCE(
    json_extract(activation.payload_json, '$.requiredReplyRecovery.attempt'),
    0
  )),
  'pending',
  activation.created_at,
  run.updated_at
FROM scheduler_runs run
JOIN scheduler_run_activations attached ON attached.run_id = run.id
JOIN agent_activations activation ON activation.id = attached.activation_id
WHERE run.status IN ('leased', 'running')
  AND (
    (
      activation.kind IN (
        'human_message', 'required_reply_recovery', 'coordination_outcome',
        'coordination_join_satisfied', 'coordination_join_impossible',
        'context_rollover_handoff'
      )
      AND json_type(activation.payload_json, '$.replyAuthority') = 'object'
      AND json_extract(activation.payload_json, '$.replyAuthority.intent') IN (
        'broadcast', 'direct_to_user', 'collaboration'
      )
    )
    OR (
      activation.kind = 'human_message'
      AND json_extract(activation.payload_json, '$.communication.sender.kind') = 'user'
      AND json_extract(activation.payload_json, '$.communication.intent') IN (
        'broadcast', 'user_dm'
      )
    )
  )
ORDER BY run.created_at, run.id, activation.id
LIMIT 10000;

DROP TABLE _required_reply_backfill_guard;
