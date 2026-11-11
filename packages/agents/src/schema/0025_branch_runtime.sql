-- Current Branch workflow schema, assembled from the qualified Branch runtime.
-- This extension does not restore Agent/Chat archive or main-product Automations.
ALTER TABLE conversations ADD COLUMN branch_id TEXT;
ALTER TABLE conversations ADD COLUMN branch_execution_id TEXT;
ALTER TABLE conversation_deletion_receipts ADD COLUMN branch_id TEXT;
ALTER TABLE agent_creation_operations ADD COLUMN conversation_id TEXT;
ALTER TABLE agent_creation_operations ADD COLUMN product_scope TEXT CHECK(product_scope IS NULL OR product_scope IN ('dev','branches'));
ALTER TABLE project_deletion_receipts ADD COLUMN product_scope TEXT NOT NULL DEFAULT 'unknown' CHECK(product_scope IN ('dev','branches','mixed','unknown'));
ALTER TABLE agent_deletion_receipts ADD COLUMN product_scope TEXT NOT NULL DEFAULT 'unknown' CHECK(product_scope IN ('dev','branches','mixed','unknown'));

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
 state TEXT NOT NULL CHECK(state IN ('reserved','active','retired')),
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

CREATE TABLE "trigger_definitions" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  agent_id TEXT,
  branch_id TEXT NOT NULL REFERENCES branches(id),
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
  CHECK (agent_id IS NULL AND branch_id IS NOT NULL)
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

CREATE INDEX agent_creation_operation_destination ON agent_creation_operations(conversation_id,product_scope);

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

CREATE INDEX conversation_branch_owner ON conversations(branch_id,branch_execution_id);

CREATE INDEX idx_trigger_definitions_agent_directory
  ON trigger_definitions(agent_id, updated_at DESC, name, id);

CREATE INDEX idx_trigger_definitions_project_directory
  ON trigger_definitions(project_id, updated_at DESC, name, id);

CREATE INDEX idx_trigger_occurrences_scope_created
  ON trigger_occurrences (project_id, scope_key, created_at DESC, id DESC);

CREATE INDEX idx_trigger_occurrences_scope_updated
  ON trigger_occurrences (project_id, scope_key, updated_at DESC, id DESC);

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
 WHERE m.agent_id=NEW.manager_agent_id AND (r.state='retired' OR p.state='canceled'))
BEGIN SELECT RAISE(ABORT,'Branch resource path no longer accepts descendants'); END;

CREATE TRIGGER branch_resource_reporting_owner BEFORE UPDATE OF manager_agent_id ON agents
WHEN NEW.manager_agent_id IS NOT OLD.manager_agent_id
AND NOT (NEW.manager_agent_id IS NULL AND (NEW.deleted_at IS NOT NULL OR EXISTS(
 SELECT 1 FROM agents parent WHERE parent.id=OLD.manager_agent_id AND (parent.deleted_at IS NOT NULL)))) AND (
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

CREATE TRIGGER capability_policy_branch_cleanup
AFTER DELETE ON branches
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'branch' AND scope_id = OLD.id;
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

-- Restriction lineage is authority, not private Agent history. Retain only its
-- immutable ID edge when canonical deletion clears the private Agent fields.
CREATE TABLE capability_retired_spawners (
 agent_id TEXT PRIMARY KEY,
 spawned_by_agent_id TEXT NOT NULL
);

-- Restriction records remain authoritative for surviving descendants after
-- canonical Agent deletion; they cannot create work.
CREATE TRIGGER branch_agent_private_state_cleanup AFTER UPDATE OF deleted_at ON agents
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
 INSERT INTO capability_retired_spawners(agent_id,spawned_by_agent_id)
 SELECT OLD.id,OLD.spawned_by_agent_id WHERE OLD.spawned_by_agent_id IS NOT NULL;
END;

-- Publication and retirement affect scoped collections without rewriting their
-- resource rows. Bump once within the owning transaction, never from a UI view.
CREATE TRIGGER branch_resource_visibility_insert AFTER INSERT ON branch_installation_resources BEGIN
 INSERT INTO collection_generations(name,generation) VALUES('resource_visibility',1)
 ON CONFLICT(name) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER branch_resource_visibility_update AFTER UPDATE OF state ON branch_installation_resources
WHEN OLD.state != NEW.state BEGIN
 INSERT INTO collection_generations(name,generation) VALUES('resource_visibility',1)
 ON CONFLICT(name) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER branch_resource_visibility_delete AFTER DELETE ON branch_installation_resources BEGIN
 INSERT INTO collection_generations(name,generation) VALUES('resource_visibility',1)
 ON CONFLICT(name) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER branch_owner_visibility_update AFTER UPDATE OF deleting ON branches
WHEN OLD.deleting != NEW.deleting BEGIN
 INSERT INTO collection_generations(name,generation) VALUES('resource_visibility',1)
 ON CONFLICT(name) DO UPDATE SET generation=generation+1;
END;
CREATE TRIGGER branch_owner_visibility_delete AFTER DELETE ON branches BEGIN
 INSERT INTO collection_generations(name,generation) VALUES('resource_visibility',1)
 ON CONFLICT(name) DO UPDATE SET generation=generation+1;
END;
