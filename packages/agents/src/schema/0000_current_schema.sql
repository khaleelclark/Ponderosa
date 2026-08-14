-- Ponderosa launch baseline. New databases are created directly at the current schema.

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
, dead_lettered_at TEXT);
CREATE TABLE activation_sources (
  activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (activation_id, source_kind, source_id)
);
CREATE TABLE activity_projection (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  execution_id TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  output_preview_utf8_bytes INTEGER,
  output_total_utf8_bytes INTEGER,
  output_sha256 TEXT,
  PRIMARY KEY (agent_id, seq),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE agent_activations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority >= 0),
  dispatch_policy TEXT NOT NULL CHECK (dispatch_policy IN ('steer_or_run', 'next_run')),
  prompt_class TEXT NOT NULL CHECK (prompt_class IN ('human', 'blocker', 'coordination', 'ordinary')),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'attached', 'consumed', 'retry_pending', 'failed',
    'outcome_unknown', 'cancelled'
  )),
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT, scope_key TEXT NOT NULL DEFAULT '', delivery_failures INTEGER NOT NULL DEFAULT 0 CHECK (delivery_failures >= 0), last_delivery_error TEXT, terminal_outcome TEXT CHECK (terminal_outcome IN (
    'recipient_unavailable', 'permanent_failure', 'retry_exhausted'
  )), terminal_at TEXT,
  UNIQUE (project_id, agent_id, dedupe_key)
);
CREATE TABLE required_reply_obligations (
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
CREATE INDEX idx_required_reply_obligations_state
  ON required_reply_obligations (state, updated_at, run_id);
CREATE TABLE context_rollovers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'requested', 'handoff_committed', 'session_retiring',
    'continuation_ready', 'completed', 'failed', 'outcome_unknown'
  )),
  old_provider_session_id TEXT NOT NULL,
  provider_session_generation TEXT NOT NULL,
  detected_occupancy INTEGER NOT NULL CHECK (detected_occupancy >= 0),
  aggregate_tokens INTEGER,
  threshold INTEGER NOT NULL CHECK (threshold > 0),
  context_window INTEGER,
  low_water_mark INTEGER NOT NULL CHECK (low_water_mark >= 0),
  low_water_confirmation_required INTEGER NOT NULL DEFAULT 1 CHECK (low_water_confirmation_required = 1),
  trigger_kind TEXT NOT NULL DEFAULT 'automatic' CHECK (trigger_kind IN ('automatic','human')),
  compaction_cutoff_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (compaction_cutoff_ordinal >= 0),
  compaction_cutoff_event_id TEXT,
  recent_tail_event_ids_json TEXT NOT NULL DEFAULT '[]',
  recent_tail_hashes_json TEXT NOT NULL DEFAULT '[]',
  source_run_id TEXT NOT NULL,
  source_activation_ids_json TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  conversation_id TEXT,
  reply_authority_json TEXT,
  handoff_event_id TEXT,
  continuation_activation_id TEXT,
  replacement_session_id TEXT,
  replacement_run_id TEXT,
  replacement_prompt_hash TEXT,
  replacement_system_prompt_hash TEXT,
  replacement_manifest_hash TEXT,
  replacement_attempt INTEGER NOT NULL DEFAULT 0 CHECK (replacement_attempt >= 0),
  visible_response_committed INTEGER NOT NULL DEFAULT 0,
  handoff_committed_at TEXT,
  session_retiring_at TEXT,
  continuation_ready_at TEXT,
  replacement_session_at TEXT,
  replacement_input_committed_at TEXT,
  replacement_verified_at TEXT,
  visible_response_committed_at TEXT,
  completion_reason TEXT CHECK (completion_reason IN (
    'replacement_verified', 'native_compaction', 'no_continuation_required'
  )),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (state IN ('failed','outcome_unknown') OR
    (compaction_cutoff_ordinal > 0 AND compaction_cutoff_event_id IS NOT NULL))
);
CREATE TABLE compaction_history_messages (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  canonical_ordinal INTEGER NOT NULL,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  revision_event_id TEXT,
  edited_at TEXT,
  content_sha256 TEXT NOT NULL,
  text TEXT NOT NULL,
  communication_intent TEXT NOT NULL DEFAULT '',
  context_policy TEXT NOT NULL DEFAULT '',
  sender_kind TEXT NOT NULL DEFAULT '',
  sender_agent_id TEXT,
  PRIMARY KEY (project_id, communication_event_id)
);
CREATE INDEX idx_compaction_history_messages_boundary
  ON compaction_history_messages (project_id, canonical_ordinal);
CREATE INDEX idx_compaction_history_messages_conversation_ordinal
  ON compaction_history_messages (project_id, conversation_id, canonical_ordinal);
CREATE TABLE compaction_history_agent_participants (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (project_id, communication_event_id, agent_id)
);
CREATE TABLE compaction_history_relation_candidates (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  canonical_ordinal INTEGER NOT NULL,
  authority_agent_id TEXT NOT NULL,
  PRIMARY KEY (project_id, communication_event_id, authority_agent_id)
);
CREATE INDEX idx_compaction_history_relation_candidates_lookup
  ON compaction_history_relation_candidates (
    project_id, conversation_id, authority_agent_id, canonical_ordinal DESC
  );
CREATE VIRTUAL TABLE compaction_history_fts USING fts5(
  project_id UNINDEXED,
  communication_event_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);
CREATE TABLE agent_conversation_memberships (
  agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
);
CREATE TABLE agent_deletion_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  preview_hash TEXT NOT NULL UNIQUE,
  root_agent_ids_json TEXT NOT NULL,
  deleted_agent_ids_json TEXT NOT NULL,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  server_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE agent_deletion_tombstones (
  agent_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  tombstone_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE agent_event_head_projection (
  agent_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE agent_health_projection (
  agent_id TEXT PRIMARY KEY,
  source_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  status_timestamp TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE agent_management_approvals (
  decision_id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  consumed_at TEXT
);
CREATE TABLE agent_presets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, guidance TEXT NOT NULL, engine TEXT NOT NULL,
  model TEXT, effort TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT,
  title TEXT NOT NULL, active_engine TEXT NOT NULL, active_session_id TEXT,
  state_branch TEXT, state_commit TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  manager_agent_id TEXT, spawned_by_agent_id TEXT, spawned_by_execution_id TEXT,
  spawn_prompt TEXT, spawn_idempotency_key TEXT, preset_snapshot_json TEXT
, model TEXT, effort TEXT, active_session_contract_hash TEXT, active_session_artifact_ids_json TEXT NOT NULL DEFAULT '[]', allow_automatic_descendant_deletion INTEGER NOT NULL DEFAULT 0, allow_automatic_descendant_reorganization INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
CREATE TABLE all_chat_feed_projection (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  row_key TEXT NOT NULL,
  order_key TEXT NOT NULL,
  PRIMARY KEY (project_id, communication_event_id)
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, execution_id TEXT,
  kind TEXT NOT NULL, path TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL
, source_path TEXT, media_type TEXT, visibility TEXT, pinned INTEGER, size INTEGER);
CREATE TABLE changed_file_execution_projection (
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, path, execution_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE changed_file_projection (
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  last_changed_at TEXT NOT NULL,
  execution_ids_json TEXT NOT NULL,
  diff TEXT, execution_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, path),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE chat_search_messages (
  row_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL CHECK (chat_kind IN ('conversation', 'collaboration', 'agent')),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  author_agent_id TEXT,
  timestamp TEXT NOT NULL,
  order_key TEXT NOT NULL,
  text TEXT NOT NULL
, conversation_id TEXT, communication_intent TEXT, sender_kind TEXT, sender_agent_id TEXT, context_policy TEXT);
CREATE TABLE continuation_handoffs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  consumed_by_execution_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  default_engine TEXT, default_model TEXT, default_effort TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
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
CREATE TABLE coordination_join_members (
  join_id TEXT NOT NULL REFERENCES coordination_joins(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (join_id, request_id),
  UNIQUE (join_id, position)
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
, conversation_id TEXT, definition_hash TEXT, continuation_request_ids_json TEXT NOT NULL DEFAULT '[]', wake_policy TEXT NOT NULL DEFAULT 'final_only'
  CHECK (wake_policy IN ('each_result', 'final_only')));
CREATE TABLE coordination_question_suspensions (
  question_update_id TEXT NOT NULL REFERENCES coordination_request_updates(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE CASCADE,
  owner_agent_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('decision', 'join')),
  dependency_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  PRIMARY KEY (question_update_id, dependency_kind, dependency_id)
);
CREATE TABLE coordination_request_late_results (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('completed', 'blocked', 'failed')),
  actor_agent_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
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
  terminal_at TEXT, conversation_id TEXT, reply_authority_json TEXT,
  CHECK (
    (lifetime_kind = 'deadline' AND deadline_at IS NOT NULL) OR
    (lifetime_kind = 'indefinite' AND deadline_at IS NULL)
  )
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE imported_history_messages (
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, message_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE managed_artifact_projection (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  visibility TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  artifact_json TEXT NOT NULL, owner_kind TEXT NOT NULL DEFAULT 'project', owner_id TEXT NOT NULL DEFAULT '', audience_json TEXT NOT NULL DEFAULT '{"kind":"organization"}', sender_agent_id TEXT,
  PRIMARY KEY (project_id, artifact_id)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, communication_event_id TEXT, agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL, reply_to_json TEXT, attachments_json TEXT
);
CREATE TABLE project_deletion_pending (
  project_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_error TEXT
, tombstone_name TEXT);
CREATE TABLE project_deletion_receipts (
  project_id TEXT PRIMARY KEY NOT NULL,
  tombstone_name TEXT NOT NULL,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, host_path TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT
, default_engine TEXT NOT NULL DEFAULT 'codex', last_conversation_id TEXT, default_model TEXT, default_effort TEXT);
CREATE TABLE communication_v4_next_run_deliveries (
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
CREATE TABLE communication_v4_next_run_recipients (
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
CREATE TABLE provider_inputs (
  execution_id TEXT PRIMARY KEY,
  scheduler_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider_prompt TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  provider_system_prompt TEXT NOT NULL DEFAULT '',
  system_prompt_hash TEXT NOT NULL DEFAULT '',
  source_manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE provider_operation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('interrupt')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, dead_lettered_at TEXT);
CREATE TABLE provider_process_authority (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  project_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  pid INTEGER NOT NULL CHECK (pid > 0),
  pgid INTEGER NOT NULL CHECK (pgid > 0),
  birth_marker TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (worker_id, pid, birth_marker)
);
CREATE INDEX idx_provider_process_authority_worker
  ON provider_process_authority (worker_id, created_at, id);
CREATE INDEX idx_provider_process_authority_run
  ON provider_process_authority (run_id, created_at, id);
CREATE INDEX idx_provider_process_authority_project_agent
  ON provider_process_authority (project_id, agent_id, created_at, id);
CREATE TABLE collection_generations (
  name TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE runs (
  id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT NOT NULL, engine TEXT NOT NULL,
  communication_event_id TEXT, started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, completed_at TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER, model TEXT, effort TEXT, cache_write_input_tokens INTEGER, provider_request_usage_json TEXT, wake_cause TEXT,
  PRIMARY KEY (agent_id, id)
);
CREATE TABLE runtime_artifacts (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('communication', 'request_update')),
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('long_text', 'document')),
  title TEXT NOT NULL,
  media_type TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  origin_agent_id TEXT,
  execution_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id, role)
);
CREATE TABLE runtime_communications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sender_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  actionable INTEGER NOT NULL CHECK (actionable IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TABLE scheduler_agent_fences (
  agent_id TEXT PRIMARY KEY,
  next_fencing_token INTEGER NOT NULL CHECK (next_fencing_token > 0)
);
CREATE TABLE scheduler_cancellation_receipts (
  agent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  fencing_token INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, idempotency_key)
);
CREATE TABLE scheduler_prompt_injections (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'steer')),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'submitted', 'acknowledged', 'outcome_unknown', 'cancelled'
  )),
  prompt_hash TEXT NOT NULL,
  activation_ids_json TEXT NOT NULL,
  provider_turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  acknowledged_at TEXT,
  terminal_at TEXT,
  UNIQUE (run_id, sequence)
);
CREATE TABLE scheduler_run_activations (
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  activation_id TEXT NOT NULL REFERENCES agent_activations(id) ON DELETE RESTRICT,
  attached_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (run_id, activation_id)
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
  heartbeat_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  terminal_at TEXT, scope_key TEXT NOT NULL DEFAULT '', context_disposition TEXT NOT NULL DEFAULT 'fresh_task', side_effects_fenced_at TEXT, provider_failure_json TEXT,
  UNIQUE (agent_id, fencing_token)
);
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
CREATE TABLE tool_output_projection (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  output BLOB NOT NULL,
  total_utf8_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE TABLE trigger_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('schedule', 'webhook', 'filesystem')),
  source_config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_fire_at TEXT,
  last_fired_at TEXT,
  secret_ciphertext TEXT,
  secret_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_budget_limit INTEGER CHECK (run_budget_limit IS NULL OR run_budget_limit > 0),
  run_budget_period TEXT CHECK (run_budget_period IS NULL OR run_budget_period IN ('day', 'week', 'month', 'lifetime')),
  run_budget_used INTEGER NOT NULL DEFAULT 0 CHECK (run_budget_used >= 0),
  run_budget_allowance INTEGER NOT NULL DEFAULT 0 CHECK (run_budget_allowance >= 0),
  run_budget_period_started_at TEXT
);
CREATE TABLE trigger_filesystem_bursts (
  trigger_id TEXT PRIMARY KEY,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  changes_json TEXT NOT NULL,
  dropped_path_event_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_path_event_count >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE trigger_occurrences (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  trigger_snapshot_json TEXT NOT NULL DEFAULT '{}',
  payload_media_type TEXT NOT NULL DEFAULT 'application/json',
  input_hash TEXT NOT NULL,
  activation_config_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'activated', 'cancelled', 'dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  activation_id TEXT REFERENCES agent_activations(id) ON DELETE SET NULL,
  last_error TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  dead_lettered_at TEXT, budget_charge_id TEXT, budget_charged_at TEXT,
  UNIQUE (trigger_id, occurrence_key)
);
CREATE TABLE work_items (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, execution_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX activation_delivery_retry_lineage_successor
  ON activation_delivery_retry_lineage(successor_activation_id);
CREATE INDEX activation_outbox_dead_letter
  ON activation_outbox(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
CREATE INDEX activation_outbox_pending
  ON activation_outbox(processed_at, claimed_at, id);
CREATE INDEX activation_sources_communication_lookup
  ON activation_sources(source_kind, source_id, activation_id);
CREATE INDEX agent_activations_agent_scope_runnable
  ON agent_activations(agent_id, scope_key, state, available_at, priority DESC, created_at);
CREATE INDEX agent_activations_runnable
  ON agent_activations(state, available_at, priority DESC, created_at);
CREATE INDEX agent_activations_terminal_delivery
  ON agent_activations(terminal_outcome, terminal_at DESC)
  WHERE terminal_outcome IS NOT NULL;
CREATE INDEX agent_activations_communication_attention
  ON agent_activations(updated_at DESC, id DESC)
  WHERE state IN ('failed', 'outcome_unknown')
    AND kind IN ('human_message', 'urgent_message', 'ordinary_message');
CREATE UNIQUE INDEX agent_message_communication_projection
  ON messages (agent_id, communication_event_id)
  WHERE communication_event_id IS NOT NULL;
CREATE INDEX coordination_join_members_request
  ON coordination_join_members(request_id, join_id);
CREATE INDEX coordination_joins_deadline
  ON coordination_joins(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX coordination_joins_owner_state
  ON coordination_joins(owner_agent_id, state, updated_at);
CREATE INDEX coordination_joins_attention
  ON coordination_joins(updated_at DESC, id DESC)
  WHERE state IN ('impossible', 'expired');
CREATE UNIQUE INDEX coordination_one_open_join_per_definition
  ON coordination_joins(project_id, owner_agent_id, definition_hash)
  WHERE state = 'open' AND definition_hash IS NOT NULL;
CREATE INDEX coordination_question_suspensions_dependency
  ON coordination_question_suspensions(dependency_kind, dependency_id, state);
CREATE INDEX coordination_question_suspensions_request
  ON coordination_question_suspensions(request_id, state);
CREATE INDEX coordination_requests_deadline
  ON coordination_requests(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX coordination_requests_recipient_state
  ON coordination_requests(recipient_agent_id, state, updated_at);
CREATE INDEX coordination_requests_attention
  ON coordination_requests(updated_at DESC, id DESC)
  WHERE state IN ('blocked', 'failed', 'outcome_unknown', 'expired', 'recipient_unavailable');
CREATE INDEX communication_v4_next_run_deliveries_scope_newest
  ON communication_v4_next_run_deliveries(project_id, conversation_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX communication_v4_next_run_deliveries_operator_idempotency
  ON communication_v4_next_run_deliveries(publisher_user_id, conversation_id, idempotency_key)
  WHERE publisher_kind = 'operator';
CREATE INDEX communication_v4_next_run_recipients_pending
  ON communication_v4_next_run_recipients(agent_id, state, created_at, delivery_id);
CREATE INDEX idx_activity_projection_execution
  ON activity_projection (agent_id, execution_id, event_type, seq);
CREATE INDEX idx_activity_projection_newest
  ON activity_projection (agent_id, seq DESC);
CREATE INDEX idx_agent_activations_scope_created
  ON agent_activations (project_id, scope_key, created_at DESC, id DESC);
CREATE INDEX idx_agent_activations_scope_updated
  ON agent_activations (project_id, scope_key, updated_at DESC, id DESC);
CREATE INDEX idx_agent_authored_broadcast_context_newest
  ON chat_search_messages (
    chat_kind, chat_id, conversation_id, communication_intent, sender_agent_id,
    timestamp DESC, message_id DESC
  );
CREATE INDEX idx_agent_context_newest
  ON chat_search_messages (
    chat_kind, chat_id, conversation_id, communication_intent,
    timestamp DESC, message_id DESC
  );
CREATE INDEX idx_agent_memberships_conversation
  ON agent_conversation_memberships (conversation_id, position, agent_id);
CREATE UNIQUE INDEX idx_agents_agent_spawn_idempotency
  ON agents (spawned_by_agent_id, spawned_by_execution_id, spawn_idempotency_key)
  WHERE spawned_by_agent_id IS NOT NULL
    AND spawned_by_execution_id IS NOT NULL
    AND spawn_idempotency_key IS NOT NULL;
CREATE INDEX idx_agents_conversation ON agents (conversation_id);
CREATE INDEX idx_agents_manager ON agents (manager_agent_id);
CREATE INDEX idx_agents_project ON agents (project_id);
CREATE INDEX idx_agents_project_directory
  ON agents (project_id, deleted_at, archived, updated_at DESC, title, id);
CREATE INDEX idx_all_chat_feed_keyset
  ON all_chat_feed_projection (order_key DESC, row_key DESC);
CREATE INDEX idx_artifact_source_projection
  ON artifacts (agent_id, kind, source_path, created_at DESC, id DESC);
CREATE INDEX idx_artifacts_agent ON artifacts (agent_id);
CREATE INDEX idx_artifacts_agent_created_id
  ON artifacts (agent_id, created_at DESC, id DESC);
CREATE INDEX idx_changed_file_execution_detail
  ON changed_file_execution_projection (agent_id, path, last_seq DESC, execution_id DESC);
CREATE INDEX idx_changed_file_projection_newest
  ON changed_file_projection (agent_id, last_seq DESC, path DESC);
CREATE INDEX idx_chat_context_newest
  ON chat_search_messages (
    chat_kind, chat_id, context_policy, timestamp DESC, message_id DESC
  );
CREATE INDEX idx_chat_search_chat_newest
  ON chat_search_messages (chat_kind, chat_id, order_key DESC, row_key DESC);
CREATE INDEX idx_chat_search_event
  ON chat_search_messages (project_id, communication_event_id, chat_kind);
CREATE INDEX idx_chat_search_feed_choice
  ON chat_search_messages
    (project_id, communication_event_id, chat_kind, chat_id, row_key);
CREATE INDEX idx_chat_search_newest
  ON chat_search_messages (timestamp DESC, chat_kind DESC, row_key DESC);
CREATE INDEX idx_continuation_handoff_pending
  ON continuation_handoffs (agent_id, consumed_at, created_at DESC);
CREATE UNIQUE INDEX idx_continuation_handoff_source_run
  ON continuation_handoffs (agent_id, source_execution_id);
CREATE INDEX idx_context_rollovers_agent_state
  ON context_rollovers (agent_id, state, updated_at DESC);
CREATE UNIQUE INDEX idx_context_rollovers_generation_owner
  ON context_rollovers (agent_id, provider_session_generation)
  WHERE state IN (
    'requested', 'handoff_committed', 'session_retiring',
    'continuation_ready', 'completed'
  );
CREATE UNIQUE INDEX idx_context_rollovers_continuation_activation
  ON context_rollovers (continuation_activation_id)
  WHERE continuation_activation_id IS NOT NULL;
CREATE INDEX idx_projects_directory
  ON projects (last_used_at DESC, created_at DESC, label, id);
CREATE INDEX idx_conversations_global_recent
  ON conversations (updated_at DESC, id);
CREATE INDEX idx_conversations_project ON conversations (project_id);
CREATE INDEX idx_conversations_project_directory
  ON conversations (project_id, updated_at DESC, title, id);
CREATE INDEX idx_coordination_joins_conversation_created
  ON coordination_joins (project_id, conversation_id, created_at DESC, id DESC);
CREATE INDEX idx_coordination_joins_conversation_updated
  ON coordination_joins (project_id, conversation_id, updated_at DESC, id DESC);
CREATE INDEX idx_coordination_request_late_results_request
  ON coordination_request_late_results (request_id, created_at, id);
CREATE INDEX idx_coordination_request_updates_request_created
  ON coordination_request_updates (request_id, created_at, id);
CREATE INDEX idx_coordination_requests_conversation_created
  ON coordination_requests (project_id, conversation_id, created_at DESC, id DESC);
CREATE INDEX idx_coordination_requests_conversation_updated
  ON coordination_requests (project_id, conversation_id, updated_at DESC, id DESC);
CREATE INDEX idx_coordination_requests_communication
  ON coordination_requests (project_id, communication_event_id, created_at, id);
CREATE INDEX idx_events_agent_seq ON events (agent_id, seq);
CREATE INDEX idx_events_agent_type_seq
  ON events (agent_id, type, seq DESC);
CREATE INDEX idx_events_type ON events (type);
CREATE INDEX idx_imported_history_newest
  ON imported_history_messages (agent_id, created_at DESC, message_id DESC);
CREATE INDEX idx_managed_artifact_projection_audience
  ON managed_artifact_projection (project_id, owner_kind, owner_id, artifact_id);
CREATE INDEX idx_managed_artifact_projection_context
  ON managed_artifact_projection (project_id, pinned, visibility, created_at DESC, artifact_id DESC);
CREATE INDEX idx_managed_artifact_projection_newest
  ON managed_artifact_projection (project_id, created_at DESC, artifact_id DESC);
CREATE INDEX idx_messages_agent ON messages (agent_id, seq);
CREATE INDEX idx_runs_agent ON runs (agent_id, started_at);
CREATE INDEX idx_runs_agent_started_id
  ON runs (agent_id, started_at DESC, id DESC);
CREATE INDEX idx_scheduler_runs_scope_created
  ON scheduler_runs (project_id, scope_key, created_at DESC, id DESC);
CREATE INDEX idx_scheduler_runs_scope_updated
  ON scheduler_runs (project_id, scope_key, updated_at DESC, id DESC);
CREATE INDEX idx_trigger_occurrences_scope_created
  ON trigger_occurrences (project_id, scope_key, created_at DESC, id DESC);
CREATE INDEX idx_trigger_occurrences_scope_updated
  ON trigger_occurrences (project_id, scope_key, updated_at DESC, id DESC);
CREATE INDEX idx_work_items_agent ON work_items (agent_id, updated_at);
CREATE INDEX idx_work_items_agent_created_id
  ON work_items (agent_id, created_at DESC, id DESC);
CREATE INDEX provider_inputs_agent ON provider_inputs(agent_id, created_at);
CREATE INDEX provider_inputs_scheduler_run ON provider_inputs(scheduler_run_id);
CREATE INDEX provider_operation_outbox_dead_letter
  ON provider_operation_outbox(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
CREATE INDEX provider_operation_outbox_runnable
  ON provider_operation_outbox(state, available_at, claimed_at, id);
CREATE INDEX runtime_artifacts_project
  ON runtime_artifacts(project_id, created_at, id);
CREATE INDEX idx_runtime_artifacts_owner
  ON runtime_artifacts(owner_kind, owner_id, created_at, id);
CREATE INDEX runtime_communications_authored_event
  ON runtime_communications(json_extract(payload_json, '$.communication.eventId'))
  WHERE json_valid(payload_json);
CREATE INDEX runtime_communications_project_created
  ON runtime_communications(project_id, created_at, id);
CREATE UNIQUE INDEX scheduler_one_active_run_per_agent
  ON scheduler_runs(agent_id)
  WHERE status IN ('leased', 'running');
CREATE INDEX scheduler_prompt_injections_recovery
  ON scheduler_prompt_injections(state, updated_at, run_id);
CREATE INDEX scheduler_runs_agent_scope
  ON scheduler_runs(agent_id, scope_key, created_at);
CREATE INDEX scheduler_steering_recoveries_due
  ON scheduler_steering_recoveries(state, recover_at)
  WHERE state = 'grace_period';
CREATE INDEX trigger_definitions_agent
  ON trigger_definitions(agent_id, conversation_id, created_at);
CREATE INDEX idx_trigger_definitions_project_directory
  ON trigger_definitions(project_id, updated_at DESC, name, id);
CREATE INDEX idx_trigger_definitions_agent_directory
  ON trigger_definitions(agent_id, updated_at DESC, name, id);
CREATE INDEX trigger_definitions_budget
  ON trigger_definitions(run_budget_period, run_budget_period_started_at)
  WHERE run_budget_limit IS NOT NULL;
CREATE INDEX trigger_definitions_due
  ON trigger_definitions(enabled, source_kind, next_fire_at, id)
  WHERE enabled = 1 AND source_kind = 'schedule' AND next_fire_at IS NOT NULL;
CREATE INDEX trigger_filesystem_bursts_project
  ON trigger_filesystem_bursts(project_id, updated_at, trigger_id);
CREATE INDEX trigger_occurrences_agent
  ON trigger_occurrences(agent_id, state, occurred_at DESC);
CREATE INDEX trigger_occurrences_budget_charge
  ON trigger_occurrences(trigger_id, budget_charge_id, activation_id)
  WHERE budget_charge_id IS NOT NULL;
CREATE INDEX trigger_occurrences_dead_letter
  ON trigger_occurrences(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;
CREATE INDEX trigger_occurrences_attention
  ON trigger_occurrences(updated_at DESC, id DESC)
  WHERE state = 'dead_lettered';
CREATE INDEX trigger_occurrences_due
  ON trigger_occurrences(state, available_at, id)
  WHERE state = 'pending';
CREATE INDEX trigger_occurrences_trigger
  ON trigger_occurrences(trigger_id, occurred_at DESC, id);
