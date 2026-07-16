-- Durable recovery for provider steering whose acknowledgement is uncertain.
-- Existing outcome_unknown injections deliberately receive no row and remain
-- historical, operator-visible undelivered records.

CREATE TABLE scheduler_steering_recoveries (
  injection_id TEXT PRIMARY KEY REFERENCES scheduler_prompt_injections(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('grace_period', 'wait_for_run', 'recovery_queued')),
  recover_at TEXT NOT NULL,
  decision_idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scheduler_steering_recovery_activations (
  injection_id TEXT NOT NULL REFERENCES scheduler_steering_recoveries(injection_id) ON DELETE CASCADE,
  source_activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE RESTRICT,
  recovery_activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE RESTRICT,
  PRIMARY KEY (injection_id, source_activation_id),
  UNIQUE (recovery_activation_id)
);

CREATE INDEX scheduler_steering_recoveries_due
  ON scheduler_steering_recoveries(state, recover_at)
  WHERE state = 'grace_period';

CREATE INDEX activation_sources_communication_lookup
  ON activation_sources(source_kind, source_id, activation_id);

CREATE INDEX runtime_communications_authored_event
  ON runtime_communications(json_extract(payload_json, '$.communication.eventId'))
  WHERE json_valid(payload_json);
