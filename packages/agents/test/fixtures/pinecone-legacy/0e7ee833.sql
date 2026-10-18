-- Fresh schema captured from 0e7ee833d5f633e0d681c36c7880191cc7e30b94; contains no user database or records.

CREATE TABLE _schema_version (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);

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
, dead_lettered_at TEXT, available_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');

CREATE TABLE activation_outbox_repair_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL,
  activation_id TEXT NOT NULL,
  previous_payload_json TEXT NOT NULL,
  replacement_payload_json TEXT NOT NULL,
  previous_error TEXT NOT NULL,
  reason TEXT NOT NULL,
  repaired_at TEXT NOT NULL
);

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
  )), terminal_at TEXT, provider_failure_category TEXT CHECK (
  provider_failure_category IS NULL OR provider_failure_category IN (
    'authentication', 'rate_limit', 'capacity', 'context_length',
    'invalid_request', 'unavailable', 'unknown'
  )
), steering_wait_reason TEXT
  CHECK (steering_wait_reason IN ('provider_not_ready', 'provider_unsupported', 'preparation_retry')),
  UNIQUE (project_id, agent_id, dedupe_key)
);

CREATE TABLE agent_conversation_memberships (
  agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
);

CREATE TABLE agent_creation_operation_members (
  operation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (operation_id, agent_id),
  UNIQUE (operation_id, position),
  FOREIGN KEY (operation_id) REFERENCES agent_creation_operations(id) ON DELETE CASCADE
);

CREATE TABLE agent_creation_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'managed', 'import')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'canonical_committed', 'completed', 'rolling_back', 'rolled_back')),
  communication_event_id TEXT,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, artifact_identities_json TEXT NOT NULL DEFAULT '[]', conversation_id TEXT, product_scope TEXT CHECK(product_scope IS NULL OR product_scope IN ('dev','branches')),
  UNIQUE (project_id, actor_scope, kind, idempotency_key)
);

CREATE TABLE agent_deletion_pending (
  agent_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  tombstone_name TEXT NOT NULL,
  ownership_token TEXT NOT NULL,
  created_at TEXT NOT NULL
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
, product_scope TEXT NOT NULL DEFAULT 'unknown'
  CHECK(product_scope IN ('dev','branches','mixed','unknown')));

CREATE TABLE agent_deletion_tombstones (
  agent_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  tombstone_name TEXT NOT NULL,
  ownership_token TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_event_head_projection (
  agent_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE agent_handle_reservations (
  project_id TEXT NOT NULL,
  normalized_handle TEXT NOT NULL,
  handle TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (project_id, normalized_handle)
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

CREATE TABLE agent_management_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'completed')),
  operation_progress_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(operation_progress_json)),
  refs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(refs_json)),
  changed_agent_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_agent_ids_json)),
  approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  approval_decision_id TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (owner_agent_id, run_id, idempotency_key)
);

CREATE TABLE agent_presets (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, guidance TEXT NOT NULL, engine TEXT NOT NULL,
  model TEXT, effort TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT,
  title TEXT NOT NULL, handle TEXT NOT NULL, active_engine TEXT NOT NULL, active_session_id TEXT,
  state_branch TEXT, state_commit TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  manager_agent_id TEXT, spawned_by_agent_id TEXT, spawned_by_execution_id TEXT,
  spawn_prompt TEXT, spawn_idempotency_key TEXT, preset_snapshot_json TEXT
, model TEXT, effort TEXT, active_session_contract_hash TEXT, active_session_artifact_ids_json TEXT NOT NULL DEFAULT '[]', allow_automatic_descendant_deletion INTEGER NOT NULL DEFAULT 0, allow_automatic_descendant_reorganization INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, creation_idempotency_key TEXT, working_copy_json TEXT NOT NULL, speed TEXT);

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

CREATE TABLE branch_actions (
 attempt_id TEXT PRIMARY KEY REFERENCES branch_attempts(id),
 state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
 notification_id TEXT
);

CREATE TABLE branch_attempts (
 id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL REFERENCES branch_step_executions(id),
 number INTEGER NOT NULL, state TEXT NOT NULL, request_id TEXT UNIQUE,
 fence INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until TEXT,
 process_identity_json TEXT, input_hash TEXT NOT NULL, result_json TEXT, error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, available_at TEXT, purpose TEXT NOT NULL DEFAULT 'step', recovery_of_request_id TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, runtime_outcome_json TEXT,
 UNIQUE(step_execution_id, number)
);

CREATE TABLE branch_bindings (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES branches(id),
 bindings_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE branch_checkpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 transition_key TEXT NOT NULL, kind TEXT NOT NULL, evidence_json TEXT NOT NULL,
 created_at TEXT NOT NULL, audit_published INTEGER NOT NULL DEFAULT 0, UNIQUE(execution_id, transition_key)
);

CREATE TABLE branch_commands (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), command_key TEXT NOT NULL,
 input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(execution_id,command_key)
);

CREATE TABLE branch_dependencies (
 branch_id TEXT NOT NULL REFERENCES branches(id), target_branch_id TEXT NOT NULL REFERENCES branches(id),
 ref TEXT NOT NULL, PRIMARY KEY(branch_id,ref)
);

CREATE TABLE branch_deployments (
 chat_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL,
 result_json TEXT NOT NULL, PRIMARY KEY(chat_id, idempotency_key)
);

CREATE TABLE branch_ephemeral_contexts (
 step_execution_id TEXT NOT NULL REFERENCES branch_step_executions(id), generation INTEGER NOT NULL,
 chat_id TEXT NOT NULL, agent_ids_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(step_execution_id,generation)
);

CREATE TABLE branch_execution_budget_commands (
 branch_id TEXT NOT NULL REFERENCES branches(id), command_key TEXT NOT NULL,
 input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(branch_id,command_key)
);

CREATE TABLE branch_execution_budget_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id TEXT NOT NULL REFERENCES branches(id),
 kind TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
 audit_published INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE branch_execution_budgets (
 branch_id TEXT PRIMARY KEY REFERENCES branches(id), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 limit_count INTEGER CHECK(limit_count BETWEEN 1 AND 1000000000),
 period TEXT CHECK(period IN ('day','week','month','lifetime')),
 used INTEGER NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 1000000000),
 allowance INTEGER NOT NULL DEFAULT 0 CHECK(allowance BETWEEN 0 AND 1000000000),
 period_id TEXT, period_started_at TEXT, updated_at TEXT NOT NULL,
 CHECK((limit_count IS NULL AND period IS NULL AND period_id IS NULL AND period_started_at IS NULL) OR
       (limit_count IS NOT NULL AND period IS NOT NULL AND period_id IS NOT NULL AND period_started_at IS NOT NULL)),
 CHECK(COALESCE(limit_count,0)+allowance<=1000000000)
);

CREATE TABLE branch_executions (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES branches(id),
 version_id TEXT NOT NULL REFERENCES branch_versions(id),
 binding_revision_id TEXT NOT NULL REFERENCES branch_bindings(id),
 occurrence_key TEXT NOT NULL, input_text TEXT NOT NULL, input_hash TEXT NOT NULL,
 provenance_json TEXT NOT NULL, state TEXT NOT NULL, wait_reason TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 output_text TEXT, merged_into TEXT REFERENCES branch_executions(id),
 revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, requested_outcome TEXT NOT NULL DEFAULT 'canceled', configuration_json TEXT NOT NULL DEFAULT '{"parameters":{},"limits":{"maxCallDepth":100,"maxLoopIterations":100,"maxTraversals":100}}', parent_execution_id TEXT REFERENCES branch_executions(id), parent_attempt_id TEXT REFERENCES branch_attempts(id), call_depth INTEGER NOT NULL DEFAULT 0, depth_ceiling INTEGER NOT NULL DEFAULT 100, traversals INTEGER NOT NULL DEFAULT 0, budget_exhausted INTEGER NOT NULL DEFAULT 0, recovery_traversals INTEGER NOT NULL DEFAULT 0, loop_iterations INTEGER NOT NULL DEFAULT 0, admission_source TEXT NOT NULL DEFAULT 'automatic' CHECK(admission_source IN ('manual','automatic','call')), admitted_at TEXT, admission_json TEXT, budget_wait INTEGER NOT NULL DEFAULT 0 CHECK(budget_wait IN (0,1)),
 UNIQUE(branch_id, occurrence_key)
);

CREATE TABLE branch_forks (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 parent_path_id TEXT NOT NULL, fork_id TEXT NOT NULL, join_id TEXT NOT NULL,
 state TEXT NOT NULL, selected_paths_json TEXT, result_json TEXT
);

CREATE TABLE branch_gate_notifications (
 gate_id TEXT NOT NULL REFERENCES branch_gates(id),
 gate_revision INTEGER NOT NULL,
 execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 state TEXT NOT NULL CHECK(state IN ('pending','open','closing_unpublished','closing','resolved')),
 prompt_text TEXT NOT NULL,
 purpose TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(gate_id,gate_revision)
);

CREATE TABLE branch_gates (
 id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL UNIQUE REFERENCES branch_step_executions(id),
 state TEXT NOT NULL, proposal_text TEXT NOT NULL, choices_json TEXT,
 revision INTEGER NOT NULL DEFAULT 0, resolution_key TEXT UNIQUE, response_json TEXT
, purpose TEXT NOT NULL DEFAULT 'approval', attempt_id TEXT, prompt_text TEXT NOT NULL DEFAULT '');

CREATE TABLE branch_installation_plans (
 id TEXT PRIMARY KEY, branch_id TEXT, expected_version_id TEXT, expected_configuration_revision INTEGER,
 package_json TEXT NOT NULL, bindings_json TEXT NOT NULL, preview_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'preview', error TEXT, created_at TEXT NOT NULL
, expected_resources_hash TEXT, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), next_attempt_at TEXT, updated_at TEXT, journal_json TEXT NOT NULL DEFAULT '{}', owned_resources_json TEXT NOT NULL DEFAULT '[]');

CREATE TABLE branch_installation_resources (
 branch_id TEXT NOT NULL REFERENCES branches(id), package_id TEXT NOT NULL,
 chat_ref TEXT NOT NULL, agent_ref TEXT NOT NULL DEFAULT '', local_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','staging','retiring','deleted')), staging_plan_id TEXT, creation_operation_id TEXT,
 PRIMARY KEY(branch_id,package_id,chat_ref,agent_ref)
);

CREATE TABLE branch_join_arrivals (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), fork_invocation_id TEXT NOT NULL,
 join_id TEXT NOT NULL, path_id TEXT NOT NULL REFERENCES branch_paths(id), outcome TEXT NOT NULL, output_text TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(execution_id, fork_invocation_id, join_id, path_id)
);

CREATE TABLE branch_loop_counts (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 path_id TEXT NOT NULL REFERENCES branch_paths(id), edge_id TEXT NOT NULL, iterations INTEGER NOT NULL,
 PRIMARY KEY(execution_id,path_id,edge_id)
);

CREATE TABLE branch_map_invocations (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 map_id TEXT NOT NULL, parent_path_id TEXT NOT NULL REFERENCES branch_paths(id),
 join_id TEXT NOT NULL, source_result_id TEXT, item_count INTEGER NOT NULL,
 items_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE branch_map_items (
 id TEXT PRIMARY KEY, map_invocation_id TEXT NOT NULL REFERENCES branch_map_invocations(id),
 item_index INTEGER NOT NULL, path_id TEXT NOT NULL UNIQUE REFERENCES branch_paths(id),
 input_text TEXT NOT NULL, input_hash TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0,
 UNIQUE(map_invocation_id,item_index)
);

CREATE TABLE branch_paths (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 parent_path_id TEXT REFERENCES branch_paths(id), fork_invocation_id TEXT,
 edge_id TEXT, state TEXT NOT NULL, node_id TEXT, step_execution_id TEXT, input_text TEXT NOT NULL DEFAULT '', result_json TEXT, traversals INTEGER NOT NULL DEFAULT 0, handling_limit INTEGER NOT NULL DEFAULT 0, last_result_id TEXT, UNIQUE(fork_invocation_id, edge_id)
);

CREATE TABLE branch_resource_members (
 agent_id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL REFERENCES branch_resources(step_execution_id),
 origin TEXT NOT NULL CHECK(origin IN ('template','descendant'))
);

CREATE TABLE branch_resource_references (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), chat_id TEXT NOT NULL,
 PRIMARY KEY(execution_id,chat_id)
);

CREATE TABLE branch_resources (
 step_execution_id TEXT PRIMARY KEY REFERENCES branch_step_executions(id),
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), template_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','active','archived')),
 requested_count INTEGER NOT NULL CHECK(requested_count > 0),
 root_agent_id TEXT, creation_key TEXT NOT NULL UNIQUE, error TEXT
, chat_id TEXT, generation INTEGER NOT NULL DEFAULT 0, retry_draining INTEGER NOT NULL DEFAULT 0 CHECK(retry_draining IN (0,1)));

CREATE TABLE branch_result_bundles (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 fork_invocation_id TEXT NOT NULL, content_text TEXT NOT NULL,
 content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE branch_retirement_errors(resource_id TEXT PRIMARY KEY,error TEXT NOT NULL,updated_at TEXT NOT NULL);

CREATE TABLE branch_retirement_references(resource_id TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES branch_executions(id),PRIMARY KEY(resource_id,execution_id));

CREATE TABLE branch_sealed_results (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 path_id TEXT NOT NULL REFERENCES branch_paths(id),
 step_execution_id TEXT NOT NULL UNIQUE REFERENCES branch_step_executions(id),
 terminal_attempt_id TEXT NOT NULL REFERENCES branch_attempts(id),
 result_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE branch_step_executions (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 step_id TEXT NOT NULL, path_id TEXT NOT NULL, invocation INTEGER NOT NULL,
 state TEXT NOT NULL, input_text TEXT NOT NULL, result_json TEXT,
 UNIQUE(execution_id, path_id, step_id, invocation)
);

CREATE TABLE branch_versions (
 id TEXT PRIMARY KEY, branch_id TEXT NOT NULL REFERENCES branches(id),
 definition_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE branches (
 id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL,
 active_version_id TEXT NOT NULL, binding_revision_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, trigger_id TEXT, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0,1)), configuration_json TEXT NOT NULL DEFAULT '{"parameters":{},"limits":{"maxCallDepth":100,"maxLoopIterations":100,"maxTraversals":100}}', configuration_revision INTEGER NOT NULL DEFAULT 0, package_id TEXT);

CREATE TABLE capability_policies (
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','product','branch','chat','agent','run')),
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  restricted_capability_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope_kind, scope_id)
);

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

CREATE TABLE collection_generations (
  name TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);

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

CREATE TABLE compaction_history_agent_participants (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (project_id, communication_event_id, agent_id)
);

CREATE VIRTUAL TABLE compaction_history_fts USING fts5(
  project_id UNINDEXED,
  communication_event_id UNINDEXED,
  text,
  tokenize = 'unicode61'
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

CREATE TABLE compaction_history_relation_candidates (
  project_id TEXT NOT NULL,
  communication_event_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  canonical_ordinal INTEGER NOT NULL,
  authority_agent_id TEXT NOT NULL,
  PRIMARY KEY (project_id, communication_event_id, authority_agent_id)
);

CREATE TABLE "context_rollovers" (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'requested', 'handoff_committed', 'session_retiring',
          'continuation_ready', 'completed', 'failed', 'outcome_unknown'
        )),
        old_provider_session_id TEXT NOT NULL,
        provider_session_generation TEXT NOT NULL,
        detected_occupancy INTEGER CHECK (detected_occupancy >= 0),
        aggregate_tokens INTEGER,
        threshold INTEGER NOT NULL CHECK (threshold > 0),
        context_window INTEGER,
        low_water_mark INTEGER NOT NULL CHECK (low_water_mark >= 0),
        low_water_confirmation_required INTEGER NOT NULL DEFAULT 1 CHECK (low_water_confirmation_required = 1),
        trigger_kind TEXT NOT NULL DEFAULT 'automatic' CHECK (trigger_kind IN ('automatic','human')),
        compaction_cutoff_ordinal INTEGER NOT NULL CHECK (compaction_cutoff_ordinal >= 0),
        compaction_cutoff_event_id TEXT,
        recent_tail_event_ids_json TEXT NOT NULL,
        recent_tail_hashes_json TEXT NOT NULL,
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
          'replacement_verified', 'native_compaction', 'no_continuation_required', 'headroom_restored'
        )),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT, failure_provenance TEXT NOT NULL DEFAULT 'internal'
          CHECK (failure_provenance IN ('provider','internal')), cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number > 0), failure_signal TEXT CHECK (
  failure_signal IS NULL OR failure_signal IN ('seed_overflow', 'replacement_cancelled')
), continuity_waiting INTEGER NOT NULL DEFAULT 0
  CHECK (continuity_waiting IN (0, 1)),
        CHECK (state IN ('failed','outcome_unknown') OR
          (compaction_cutoff_ordinal > 0 AND compaction_cutoff_event_id IS NOT NULL))
      );

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

CREATE TABLE conversation_deletion_receipts (
  conversation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tombstone_name TEXT,
  ownership_token TEXT,
  removal_started INTEGER NOT NULL DEFAULT 0,
  canonical_deletion_completed INTEGER NOT NULL DEFAULT 0,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  server_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
, branch_id TEXT);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  default_engine TEXT, default_model TEXT, default_effort TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
, default_speed TEXT, branch_id TEXT, branch_execution_id TEXT);

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
  CHECK (wake_policy IN ('each_result', 'final_only')), origin_run_id TEXT REFERENCES scheduler_runs(id) ON DELETE SET NULL);

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
, provider_failure_category TEXT
          CHECK (provider_failure_category IS NULL OR provider_failure_category IN (
            'authentication', 'rate_limit', 'capacity', 'context_length',
            'invalid_request', 'unavailable', 'unknown'
          )));

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
  terminal_at TEXT, conversation_id TEXT, reply_authority_json TEXT, origin_run_id TEXT REFERENCES scheduler_runs(id) ON DELETE SET NULL,
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

CREATE TABLE pinecone_profiles (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) DEFERRABLE INITIALLY DEFERRED,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) DEFERRABLE INITIALLY DEFERRED,
  guidance_version INTEGER NOT NULL CHECK(guidance_version = 1),
  created_at TEXT NOT NULL
);

CREATE TABLE project_deletion_pending (
  project_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_error TEXT
, tombstone_name TEXT, ownership_token TEXT, draft_surfaces_json TEXT);

CREATE TABLE project_deletion_receipts (
  project_id TEXT PRIMARY KEY NOT NULL,
  tombstone_name TEXT NOT NULL,
  ownership_token TEXT,
  removal_started INTEGER NOT NULL DEFAULT 0,
  storage_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  draft_surfaces_json TEXT NOT NULL DEFAULT '[]',
  draft_cleanup_completed INTEGER NOT NULL DEFAULT 1,
  asset_authority_cleanup_completed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
, product_scope TEXT NOT NULL DEFAULT 'dev' CHECK(product_scope IN ('dev','branches')));

CREATE TABLE projects (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, host_path TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT
, default_engine TEXT NOT NULL DEFAULT 'codex', last_conversation_id TEXT, default_model TEXT, default_effort TEXT);

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
  created_at TEXT NOT NULL, scope_json TEXT,
  UNIQUE (worker_id, pid, birth_marker)
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
  terminal_at TEXT, delivery_phase TEXT NOT NULL DEFAULT 'initial'
  CHECK (delivery_phase IN ('initial', 'final')), interim_communication_id TEXT, blocking_decision_id TEXT,
  PRIMARY KEY (run_id, source_activation_id)
);

CREATE TABLE run_output_heads (
  agent_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  execution_id TEXT,
  segment_first_seq INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE run_output_segments (
  agent_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('text', 'reasoning')),
  execution_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  text_preview TEXT NOT NULL DEFAULT '',
  preview_utf8_bytes INTEGER NOT NULL DEFAULT 0,
  raw_utf8_bytes INTEGER NOT NULL DEFAULT 0,
  canonical_utf8_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, first_seq),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
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

CREATE TABLE runtime_communication_activation_intake (
  communication_id TEXT NOT NULL
    REFERENCES runtime_communications(id) ON DELETE CASCADE,
  recipient_index INTEGER NOT NULL CHECK (recipient_index >= 0),
  agent_id TEXT NOT NULL,
  activation_id TEXT NOT NULL
    REFERENCES agent_activations(id) ON DELETE CASCADE,
  PRIMARY KEY (communication_id, recipient_index)
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
  terminal_at TEXT, exact_prompt TEXT, source_manifest_json TEXT,
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

CREATE TABLE system_incident_runs (
  incident_id TEXT NOT NULL REFERENCES system_incidents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE RESTRICT,
  PRIMARY KEY (incident_id, run_id),
  UNIQUE (run_id)
);

CREATE TABLE system_incidents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('startup_orphaned_run_recovery')),
  observed_at TEXT NOT NULL
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

CREATE TABLE "trigger_definitions" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT,
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
  run_budget_period_started_at TEXT,
  CHECK ((agent_id IS NOT NULL AND branch_id IS NULL) OR (agent_id IS NULL AND branch_id IS NOT NULL))
);

CREATE TABLE "trigger_filesystem_bursts" (
  trigger_id TEXT PRIMARY KEY,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  changes_json TEXT NOT NULL,
  dropped_path_event_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_path_event_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE "trigger_occurrences" (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT,
  branch_execution_id TEXT REFERENCES branch_executions(id) ON DELETE SET NULL,
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

CREATE INDEX activation_outbox_available
  ON activation_outbox (available_at, id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX activation_outbox_dead_letter
  ON activation_outbox(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX activation_outbox_pending
  ON activation_outbox(processed_at, claimed_at, id);

CREATE INDEX activation_sources_communication_lookup
  ON activation_sources(source_kind, source_id, activation_id);

CREATE INDEX agent_activations_agent_scope_runnable
  ON agent_activations(agent_id, scope_key, state, available_at, priority DESC, created_at);

CREATE INDEX agent_activations_communication_attention
  ON agent_activations(updated_at DESC, id DESC)
  WHERE state IN ('failed', 'outcome_unknown')
    AND kind IN ('human_message', 'urgent_message', 'ordinary_message');

CREATE INDEX agent_activations_runnable
  ON agent_activations(state, available_at, priority DESC, created_at);

CREATE INDEX agent_activations_terminal_delivery
  ON agent_activations(terminal_outcome, terminal_at DESC)
  WHERE terminal_outcome IS NOT NULL;

CREATE INDEX agent_creation_operation_destination ON agent_creation_operations(conversation_id,product_scope);

CREATE UNIQUE INDEX agent_message_communication_projection
  ON messages (agent_id, communication_event_id)
  WHERE communication_event_id IS NOT NULL;

CREATE INDEX branch_attempt_work ON branch_attempts(state, lease_until);

CREATE UNIQUE INDEX branch_call_attempt ON branch_executions(parent_attempt_id);

CREATE INDEX branch_execution_branch_state
  ON branch_executions(branch_id, state);

CREATE INDEX branch_execution_parent ON branch_executions(parent_execution_id);

CREATE INDEX branch_execution_queue ON branch_executions(state, created_at);

CREATE INDEX branch_gate_notifications_pending_idx ON branch_gate_notifications(state,created_at,gate_id,gate_revision);

CREATE INDEX branch_installation_cancellation ON branch_installation_plans(state,updated_at);

CREATE INDEX branch_installation_retry_eligibility ON branch_installation_plans(state,next_attempt_at,created_at);

CREATE INDEX branch_installation_staging_owner ON branch_installation_resources(staging_plan_id,state);

CREATE INDEX branch_map_execution ON branch_map_invocations(execution_id);

CREATE INDEX branch_map_item_order ON branch_map_items(map_invocation_id,item_index);

CREATE INDEX branch_resources_execution ON branch_resources(execution_id,state);

CREATE INDEX branch_result_bundle_execution ON branch_result_bundles(execution_id);

CREATE INDEX branch_sealed_execution ON branch_sealed_results(execution_id);

CREATE UNIQUE INDEX communication_v4_next_run_deliveries_operator_idempotency
  ON communication_v4_next_run_deliveries(publisher_user_id, conversation_id, idempotency_key)
  WHERE publisher_kind = 'operator';

CREATE INDEX communication_v4_next_run_deliveries_scope_newest
  ON communication_v4_next_run_deliveries(project_id, conversation_id, created_at DESC, id DESC);

CREATE INDEX communication_v4_next_run_recipients_pending
  ON communication_v4_next_run_recipients(agent_id, state, created_at, delivery_id);

CREATE INDEX conversation_branch_owner ON conversations(branch_id,branch_execution_id);

CREATE INDEX coordination_join_members_request
  ON coordination_join_members(request_id, join_id);

CREATE INDEX coordination_joins_attention
  ON coordination_joins(updated_at DESC, id DESC)
  WHERE state IN ('impossible', 'expired');

CREATE INDEX coordination_joins_deadline
  ON coordination_joins(deadline_at) WHERE deadline_at IS NOT NULL;

CREATE INDEX coordination_joins_owner_state
  ON coordination_joins(owner_agent_id, state, updated_at);

CREATE UNIQUE INDEX coordination_one_open_join_per_definition
  ON coordination_joins(project_id, owner_agent_id, definition_hash)
  WHERE state = 'open' AND definition_hash IS NOT NULL;

CREATE INDEX coordination_question_suspensions_dependency
  ON coordination_question_suspensions(dependency_kind, dependency_id, state);

CREATE INDEX coordination_question_suspensions_request
  ON coordination_question_suspensions(request_id, state);

CREATE INDEX coordination_requests_attention
  ON coordination_requests(updated_at DESC, id DESC)
  WHERE state IN ('blocked', 'failed', 'outcome_unknown', 'expired', 'recipient_unavailable');

CREATE INDEX coordination_requests_deadline
  ON coordination_requests(deadline_at) WHERE deadline_at IS NOT NULL;

CREATE INDEX coordination_requests_recipient_state
  ON coordination_requests(recipient_agent_id, state, updated_at);

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

CREATE INDEX idx_agent_creation_operations_pending
  ON agent_creation_operations(status, updated_at);

CREATE INDEX idx_agent_management_plans_project
  ON agent_management_plans(project_id, created_at);

CREATE INDEX idx_agent_memberships_conversation
  ON agent_conversation_memberships (conversation_id, position, agent_id);

CREATE UNIQUE INDEX idx_agents_agent_spawn_idempotency
  ON agents (spawned_by_agent_id, spawned_by_execution_id, spawn_idempotency_key)
  WHERE spawned_by_agent_id IS NOT NULL
    AND spawned_by_execution_id IS NOT NULL
    AND spawn_idempotency_key IS NOT NULL;

CREATE INDEX idx_agents_conversation ON agents (conversation_id);

CREATE UNIQUE INDEX idx_agents_creation_idempotency
  ON agents (project_id, creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;

CREATE INDEX idx_agents_manager ON agents (manager_agent_id);

CREATE INDEX idx_agents_project ON agents (project_id);

CREATE INDEX idx_agents_project_directory
  ON agents (project_id, deleted_at, archived, updated_at DESC, title, id);

CREATE UNIQUE INDEX idx_agents_project_handle ON agents (project_id, lower(handle));

CREATE INDEX idx_agents_project_organization
  ON agents (
    project_id, manager_agent_id, deleted_at, archived,
    title COLLATE NOCASE, id
  );

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

CREATE INDEX idx_compaction_history_messages_boundary
  ON compaction_history_messages (project_id, canonical_ordinal);

CREATE INDEX idx_compaction_history_messages_conversation_ordinal
  ON compaction_history_messages (project_id, conversation_id, canonical_ordinal);

CREATE INDEX idx_compaction_history_relation_candidates_lookup
  ON compaction_history_relation_candidates (
    project_id, conversation_id, authority_agent_id, canonical_ordinal DESC
  );

CREATE INDEX idx_context_rollovers_agent_state
        ON context_rollovers (agent_id, state, updated_at DESC);

CREATE UNIQUE INDEX idx_context_rollovers_continuation_activation
        ON context_rollovers (continuation_activation_id)
        WHERE continuation_activation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_context_rollovers_generation_cycle
        ON context_rollovers (agent_id, provider_session_generation, cycle_number);

CREATE INDEX idx_continuation_handoff_pending
  ON continuation_handoffs (agent_id, consumed_at, created_at DESC);

CREATE UNIQUE INDEX idx_continuation_handoff_source_run
  ON continuation_handoffs (agent_id, source_execution_id);

CREATE INDEX idx_conversation_deletion_receipts_pending
        ON conversation_deletion_receipts(
          canonical_deletion_completed,
          storage_cleanup_completed,
          server_cleanup_completed,
          created_at
        );

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

CREATE INDEX idx_coordination_requests_communication
  ON coordination_requests (project_id, communication_event_id, created_at, id);

CREATE INDEX idx_coordination_requests_conversation_created
  ON coordination_requests (project_id, conversation_id, created_at DESC, id DESC);

CREATE INDEX idx_coordination_requests_conversation_updated
  ON coordination_requests (project_id, conversation_id, updated_at DESC, id DESC);

CREATE INDEX idx_events_agent_seq ON events (agent_id, seq);

CREATE INDEX idx_events_agent_type_seq
  ON events (agent_id, type, seq DESC);

CREATE INDEX idx_events_public_progress
  ON events (agent_id, json_extract(payload_json, '$.executionId'), json_extract(payload_json, '$.progressInjectionId'), seq DESC)
  WHERE type = 'text' AND json_extract(payload_json, '$.presentation') = 'progress';

CREATE INDEX idx_events_type ON events (type);

CREATE INDEX idx_imported_history_newest
  ON imported_history_messages (agent_id, created_at DESC, message_id DESC);

CREATE INDEX idx_joins_task_origin ON coordination_joins(origin_run_id, state);

CREATE INDEX idx_managed_artifact_projection_audience
  ON managed_artifact_projection (project_id, owner_kind, owner_id, artifact_id);

CREATE INDEX idx_managed_artifact_projection_context
  ON managed_artifact_projection (project_id, pinned, visibility, created_at DESC, artifact_id DESC);

CREATE INDEX idx_managed_artifact_projection_newest
  ON managed_artifact_projection (project_id, created_at DESC, artifact_id DESC);

CREATE INDEX idx_messages_agent ON messages (agent_id, seq);

CREATE INDEX idx_projects_directory
  ON projects (last_used_at DESC, created_at DESC, label, id);

CREATE INDEX idx_provider_process_authority_project_agent
  ON provider_process_authority (project_id, agent_id, created_at, id);

CREATE INDEX idx_provider_process_authority_run
  ON provider_process_authority (run_id, created_at, id);

CREATE INDEX idx_provider_process_authority_worker
  ON provider_process_authority (worker_id, created_at, id);

CREATE INDEX idx_reply_recovery_activation ON required_reply_obligations(recovery_activation_id)
  WHERE recovery_activation_id IS NOT NULL;

CREATE INDEX idx_reply_task_decision ON required_reply_obligations(blocking_decision_id);

CREATE INDEX idx_reply_task_root ON required_reply_obligations(source_activation_id, project_id, agent_id, scope_key, run_id);

CREATE INDEX idx_requests_task_origin ON coordination_requests(origin_run_id, state);

CREATE INDEX idx_required_reply_obligations_state
  ON required_reply_obligations (state, updated_at, run_id);

CREATE INDEX idx_rollover_retained_continuity ON context_rollovers(agent_id, scope_key) WHERE continuity_waiting = 1;

CREATE INDEX idx_run_output_segments_agent_newest
  ON run_output_segments (agent_id, first_seq DESC);

CREATE INDEX idx_run_output_segments_execution_response
  ON run_output_segments (agent_id, execution_id, event_type, first_seq DESC);

CREATE INDEX idx_runs_agent ON runs (agent_id, started_at);

CREATE INDEX idx_runs_agent_started_id
  ON runs (agent_id, started_at DESC, id DESC);

CREATE INDEX idx_runtime_artifacts_owner
  ON runtime_artifacts(owner_kind, owner_id, created_at, id);

CREATE INDEX idx_runtime_communications_public_reply
  ON runtime_communications (project_id, json_extract(sender_json, '$.agentId'),
    json_extract(sender_json, '$.executionId'), intent,
    json_extract(payload_json, '$.communication.conversationId'), created_at DESC);

CREATE INDEX idx_scheduler_runs_scope_created
  ON scheduler_runs (project_id, scope_key, created_at DESC, id DESC);

CREATE INDEX idx_scheduler_runs_scope_updated
  ON scheduler_runs (project_id, scope_key, updated_at DESC, id DESC);

CREATE INDEX idx_trigger_definitions_agent_directory
  ON trigger_definitions(agent_id, updated_at DESC, name, id);

CREATE INDEX idx_trigger_definitions_project_directory
  ON trigger_definitions(project_id, updated_at DESC, name, id);

CREATE INDEX idx_trigger_occurrences_scope_created
  ON trigger_occurrences (project_id, scope_key, created_at DESC, id DESC);

CREATE INDEX idx_trigger_occurrences_scope_updated
  ON trigger_occurrences (project_id, scope_key, updated_at DESC, id DESC);

CREATE INDEX idx_work_items_agent ON work_items (agent_id, updated_at);

CREATE INDEX idx_work_items_agent_created_id
  ON work_items (agent_id, created_at DESC, id DESC);

CREATE INDEX pinecone_profiles_project ON pinecone_profiles(project_id);

CREATE INDEX provider_inputs_agent ON provider_inputs(agent_id, created_at);

CREATE INDEX provider_inputs_scheduler_run ON provider_inputs(scheduler_run_id);

CREATE INDEX provider_operation_outbox_dead_letter
  ON provider_operation_outbox(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX provider_operation_outbox_runnable
  ON provider_operation_outbox(state, available_at, claimed_at, id);

CREATE INDEX runtime_artifacts_project
  ON runtime_artifacts(project_id, created_at, id);

CREATE INDEX runtime_communication_activation_intake_activation
  ON runtime_communication_activation_intake (activation_id);

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

CREATE UNIQUE INDEX trigger_branch_enabled ON trigger_definitions(branch_id) WHERE branch_id IS NOT NULL AND enabled = 1;

CREATE INDEX trigger_definitions_agent
  ON trigger_definitions(agent_id, conversation_id, created_at);

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

CREATE INDEX trigger_occurrences_attention
  ON trigger_occurrences(updated_at DESC, id DESC)
  WHERE state = 'dead_lettered';

CREATE INDEX trigger_occurrences_budget_charge
  ON trigger_occurrences(trigger_id, budget_charge_id, activation_id)
  WHERE budget_charge_id IS NOT NULL;

CREATE INDEX trigger_occurrences_dead_letter
  ON trigger_occurrences(dead_lettered_at, id)
  WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX trigger_occurrences_due
  ON trigger_occurrences(state, available_at, id)
  WHERE state = 'pending';

CREATE INDEX trigger_occurrences_trigger
  ON trigger_occurrences(trigger_id, occurred_at DESC, id);

CREATE TRIGGER branch_child_budget BEFORE INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id)
AND EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id = NEW.manager_agent_id)
BEGIN
 SELECT CASE WHEN EXISTS(
   SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id
   JOIN branch_executions e ON e.id=r.execution_id JOIN branch_versions v ON v.id=e.version_id
   WHERE m.agent_id=NEW.manager_agent_id AND (r.state != 'active' OR e.cancel_requested=1 OR
     (SELECT COALESCE(SUM(requested_count),0) FROM branch_resources WHERE execution_id=e.id) +
     (SELECT COUNT(*) FROM branch_resource_members cm JOIN branch_resources cr ON cr.step_execution_id=cm.step_execution_id WHERE cr.execution_id=e.id AND cm.origin='descendant')
     >= COALESCE(json_extract(v.definition_json,'$.policy.maxEphemeralAgents'),100))
 ) THEN RAISE(ABORT,'Branch managed Agent resource budget or lifecycle fence') END;
END;

CREATE TRIGGER branch_child_ownership AFTER INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id)
AND EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id)
BEGIN
 INSERT INTO branch_resource_members(agent_id,step_execution_id,origin)
 SELECT NEW.id,step_execution_id,'descendant' FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id;
END;

CREATE TRIGGER branch_child_path_fence BEFORE INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id) AND EXISTS(SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id
 JOIN branch_step_executions s ON s.id=r.step_execution_id JOIN branch_paths p ON p.id=s.path_id
 WHERE m.agent_id=NEW.manager_agent_id AND (r.state='archived' OR p.state='canceled'))
BEGIN SELECT RAISE(ABORT,'Branch resource path no longer accepts descendants'); END;

CREATE TRIGGER branch_resource_reporting_owner BEFORE UPDATE OF manager_agent_id ON agents
WHEN NEW.manager_agent_id IS NOT OLD.manager_agent_id
AND NOT (NEW.manager_agent_id IS NULL AND (NEW.archived=1 OR NEW.deleted_at IS NOT NULL OR EXISTS(
 SELECT 1 FROM agents parent WHERE parent.id=OLD.manager_agent_id AND (parent.archived=1 OR parent.deleted_at IS NOT NULL)))) AND (
 EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id) OR
 EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id))
BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM branch_resource_members child JOIN branch_resource_members parent ON parent.step_execution_id=child.step_execution_id
 WHERE child.agent_id=NEW.id AND parent.agent_id=NEW.manager_agent_id)
 THEN RAISE(ABORT,'Branch resource ownership cannot be changed through reporting lines') END;
END;

CREATE TRIGGER branch_retry_descendant_fence BEFORE INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id) AND EXISTS(SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id WHERE m.agent_id=NEW.manager_agent_id AND r.retry_draining=1)
BEGIN SELECT RAISE(ABORT,'Branch resource is draining for a fresh retry'); END;

CREATE TRIGGER capability_policy_agent_cleanup
AFTER DELETE ON agents
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'agent' AND scope_id = OLD.id;
END;

CREATE TRIGGER capability_policy_branch_cleanup
AFTER DELETE ON branches
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'branch' AND scope_id = OLD.id;
END;

CREATE TRIGGER capability_policy_chat_cleanup
AFTER DELETE ON conversations
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'chat' AND scope_id = OLD.id;
END;

CREATE TRIGGER capability_policy_run_cleanup
AFTER DELETE ON runs
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'run' AND scope_id = OLD.id;
END;

CREATE TRIGGER trg_agents_collection_delete AFTER DELETE ON agents BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('agents', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_agents_collection_insert AFTER INSERT ON agents BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('agents', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_agents_collection_update AFTER UPDATE ON agents BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('agents', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_context_rollovers_collection_delete AFTER DELETE ON context_rollovers BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('context_rollovers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_context_rollovers_collection_insert AFTER INSERT ON context_rollovers BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('context_rollovers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_context_rollovers_collection_update AFTER UPDATE ON context_rollovers BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('context_rollovers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_conversations_collection_delete AFTER DELETE ON conversations BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('conversations', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_conversations_collection_insert AFTER INSERT ON conversations BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('conversations', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_conversations_collection_update AFTER UPDATE ON conversations BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('conversations', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_memberships_collection_delete AFTER DELETE ON agent_conversation_memberships BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('memberships', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || OLD.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_memberships_collection_insert AFTER INSERT ON agent_conversation_memberships BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('memberships', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || NEW.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_memberships_collection_update AFTER UPDATE ON agent_conversation_memberships BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('memberships', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || OLD.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || NEW.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_projects_collection_delete AFTER DELETE ON projects BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('projects', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('projects:id:' || OLD.id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_projects_collection_insert AFTER INSERT ON projects BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('projects', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('projects:id:' || NEW.id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_projects_collection_update AFTER UPDATE ON projects BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('projects', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('projects:id:' || NEW.id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_scheduler_runs_collection_delete AFTER DELETE ON scheduler_runs BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('scheduler_runs', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_scheduler_runs_collection_insert AFTER INSERT ON scheduler_runs BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('scheduler_runs', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_scheduler_runs_collection_update AFTER UPDATE ON scheduler_runs BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('scheduler_runs', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_triggers_collection_delete AFTER DELETE ON trigger_definitions BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('triggers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || OLD.agent_id, 1 WHERE OLD.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_triggers_collection_insert AFTER INSERT ON trigger_definitions BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('triggers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || NEW.agent_id, 1 WHERE NEW.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER trg_triggers_collection_update AFTER UPDATE ON trigger_definitions BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('triggers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('triggers:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || OLD.agent_id, 1 WHERE OLD.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) SELECT 'triggers:agent:' || NEW.agent_id, 1 WHERE NEW.agent_id IS NOT NULL
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0000_current_schema.sql','2026-10-18T06:05:04.864Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0005_context_rollover_atomicity.ts','2026-10-18T06:05:04.866Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0012_context_rollover_failure_provenance.ts','2026-10-18T06:05:04.870Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0020_context_rollover_cycles.ts','2026-10-18T06:05:04.871Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0001_communication_v4_next_run_deliveries.sql','2026-10-18T06:05:04.871Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0002_provider_process_authority.sql','2026-10-18T06:05:04.871Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0003_collection_generations.sql','2026-10-18T06:05:04.872Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0004_run_output_segments.sql','2026-10-18T06:05:04.872Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0005_required_reply_obligations.sql','2026-10-18T06:05:04.873Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0006_delivery_idempotency.sql','2026-10-18T06:05:04.873Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0007_structured_provider_failure_state.sql','2026-10-18T06:05:04.875Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0008_public_activation_provider_failures.sql','2026-10-18T06:05:04.875Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0009_agent_creation_operations.sql','2026-10-18T06:05:04.875Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0010_agent_creation_artifact_identities.sql','2026-10-18T06:05:04.876Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0011_agent_management_plans.sql','2026-10-18T06:05:04.877Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0012_conversation_deletion_receipts.sql','2026-10-18T06:05:04.877Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0013_runtime_speed_defaults.sql','2026-10-18T06:05:04.880Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0014_activation_outbox_retry.sql','2026-10-18T06:05:04.881Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0015_system_incident_correlation.sql','2026-10-18T06:05:04.881Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0016_public_progress.sql','2026-10-18T06:05:04.882Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0017_exact_prompt_injections.sql','2026-10-18T06:05:04.884Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0018_steering_wait_reason.sql','2026-10-18T06:05:04.885Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0022_provider_scope_authority.sql','2026-10-18T06:05:04.886Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0013_branches.sql','2026-10-18T06:05:04.887Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0014_branch_workflows.sql','2026-10-18T06:05:04.898Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0015_branch_trigger_destinations.sql','2026-10-18T06:05:04.909Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0016_branch_resources.sql','2026-10-18T06:05:04.910Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0017_branch_actions.sql','2026-10-18T06:05:04.910Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0018_branch_resource_fences.sql','2026-10-18T06:05:04.911Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0019_branch_resource_projection_replay.sql','2026-10-18T06:05:04.911Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0020_branch_product.sql','2026-10-18T06:05:04.943Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0021_branch_execution_directory_status.sql','2026-10-18T06:05:04.943Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0022_capability_policies.sql','2026-10-18T06:05:04.943Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0023_branch_installation_lifecycle.sql','2026-10-18T06:05:04.947Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0024_branch_installation_saga.sql','2026-10-18T06:05:04.950Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0025_branch_installation_receipts.sql','2026-10-18T06:05:04.952Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0026_branch_gate_notifications.sql','2026-10-18T06:05:04.953Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0027_agent_creation_product_scope.sql','2026-10-18T06:05:04.955Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0028_deletion_product_scope.sql','2026-10-18T06:05:04.958Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0029_branch_map_results.sql','2026-10-18T06:05:04.960Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0030_historical_artifact_product_scope.sql','2026-10-18T06:05:04.960Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0031_branch_execution_budgets.sql','2026-10-18T06:05:04.966Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0037_pinecone_profiles.sql','2026-10-18T06:05:04.966Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0023_lead_task_continuity.sql','2026-10-18T06:05:04.974Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0021_context_rollover_observations.ts','2026-10-18T06:05:04.979Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0013_working_copy_authority.ts','2026-10-18T06:05:04.979Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0014_project_deletion_ownership.ts','2026-10-18T06:05:04.979Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0015_deletion_recovery_phases.ts','2026-10-18T06:05:04.980Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0016_conversation_deletion_precommit.ts','2026-10-18T06:05:04.980Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0017_project_deletion_draft_cleanup.ts','2026-10-18T06:05:04.980Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0018_project_deletion_asset_authority_cleanup.ts','2026-10-18T06:05:04.981Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0019_conversation_deletion_ownership.ts','2026-10-18T06:05:04.981Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0009_public_provider_request_updates.ts','2026-10-18T06:05:04.983Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0010_provider_activation_execution_payloads.ts','2026-10-18T06:05:04.983Z');

INSERT INTO "_schema_version" ("name","applied_at") VALUES ('0011_nested_provider_activation_execution_payloads.ts','2026-10-18T06:05:04.983Z');
