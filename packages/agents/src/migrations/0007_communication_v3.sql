-- Communication V3 authoritative coordination and scheduler state.

CREATE TABLE coordination_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  requester_agent_id TEXT,
  recipient_agent_id TEXT NOT NULL,
  communication_event_id TEXT,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'open', 'in_progress', 'waiting_dependency', 'awaiting_answer',
    'completed', 'blocked', 'failed', 'cancelled', 'superseded',
    'recipient_unavailable', 'outcome_unknown', 'expired'
  )),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lifetime_kind TEXT NOT NULL CHECK (lifetime_kind IN ('deadline', 'indefinite')),
  deadline_at TEXT,
  open_question_update_id TEXT,
  superseded_by_request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (lifetime_kind = 'deadline' AND deadline_at IS NOT NULL) OR
    (lifetime_kind = 'indefinite' AND deadline_at IS NULL)
  )
);

CREATE TABLE coordination_request_updates (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'user', 'system', 'supervisor')),
  actor_id TEXT,
  in_reply_to_update_id TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  resulting_state TEXT NOT NULL,
  resulting_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE coordination_joins (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('all', 'any', 'quorum')),
  quorum INTEGER NOT NULL CHECK (quorum > 0),
  satisfying_outcomes_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'satisfied', 'impossible', 'expired', 'cancelled')),
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE TABLE coordination_join_members (
  join_id TEXT NOT NULL REFERENCES coordination_joins(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (join_id, request_id),
  UNIQUE (join_id, position)
);

CREATE TABLE agent_activations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'attached', 'consumed', 'retry_pending', 'failed',
    'outcome_unknown', 'cancelled'
  )),
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE (project_id, agent_id, dedupe_key)
);

CREATE TABLE activation_sources (
  activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (activation_id, source_kind, source_id)
);

CREATE TABLE scheduler_agent_fences (
  agent_id TEXT PRIMARY KEY,
  next_fencing_token INTEGER NOT NULL CHECK (next_fencing_token > 0)
);

CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'leased', 'running', 'completed', 'failed', 'cancelled', 'outcome_unknown'
  )),
  lease_owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  prompt_injection_state TEXT NOT NULL CHECK (prompt_injection_state IN ('not_injected', 'injecting', 'injected')),
  provider_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  terminal_at TEXT,
  UNIQUE (agent_id, fencing_token)
);

CREATE UNIQUE INDEX scheduler_one_active_run_per_agent
  ON scheduler_runs(agent_id)
  WHERE status IN ('leased', 'running');

CREATE TABLE scheduler_run_activations (
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE RESTRICT,
  attached_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (run_id, activation_id)
);

CREATE TABLE coordination_idempotency (
  project_id TEXT NOT NULL,
  actor_scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, actor_scope, operation, idempotency_key)
);

CREATE TABLE activation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX coordination_requests_recipient_state
  ON coordination_requests(recipient_agent_id, state, updated_at);
CREATE INDEX coordination_requests_deadline
  ON coordination_requests(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX coordination_joins_owner_state
  ON coordination_joins(owner_agent_id, state, updated_at);
CREATE INDEX coordination_joins_deadline
  ON coordination_joins(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX coordination_join_members_request
  ON coordination_join_members(request_id, join_id);
CREATE INDEX agent_activations_runnable
  ON agent_activations(state, available_at, priority DESC, created_at);
CREATE INDEX activation_outbox_pending
  ON activation_outbox(processed_at, claimed_at, id);
