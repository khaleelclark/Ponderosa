-- Chat metadata is canonical; these columns are its ownership projection.
ALTER TABLE conversations ADD COLUMN branch_id TEXT;
ALTER TABLE conversations ADD COLUMN branch_execution_id TEXT;
CREATE INDEX conversation_branch_owner ON conversations(branch_id,branch_execution_id);
ALTER TABLE branches ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
ALTER TABLE branches ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0,1));
ALTER TABLE branches ADD COLUMN configuration_json TEXT NOT NULL DEFAULT '{"parameters":{},"limits":{"maxCallDepth":100,"maxLoopIterations":100,"maxTraversals":100}}';
ALTER TABLE branches ADD COLUMN configuration_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_executions ADD COLUMN configuration_json TEXT NOT NULL DEFAULT '{"parameters":{},"limits":{"maxCallDepth":100,"maxLoopIterations":100,"maxTraversals":100}}';
ALTER TABLE branch_executions ADD COLUMN parent_execution_id TEXT REFERENCES branch_executions(id);
ALTER TABLE branch_executions ADD COLUMN parent_attempt_id TEXT REFERENCES branch_attempts(id);
ALTER TABLE branch_executions ADD COLUMN call_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_executions ADD COLUMN depth_ceiling INTEGER NOT NULL DEFAULT 100;
ALTER TABLE branch_executions ADD COLUMN traversals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_executions ADD COLUMN budget_exhausted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_attempts ADD COLUMN runtime_outcome_json TEXT;
ALTER TABLE branch_paths ADD COLUMN traversals INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX branch_call_attempt ON branch_executions(parent_attempt_id);
CREATE INDEX branch_execution_parent ON branch_executions(parent_execution_id);
CREATE TABLE branch_loop_counts (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 path_id TEXT NOT NULL REFERENCES branch_paths(id), edge_id TEXT NOT NULL, iterations INTEGER NOT NULL,
 PRIMARY KEY(execution_id,path_id,edge_id)
);
CREATE TABLE branch_dependencies (
 branch_id TEXT NOT NULL REFERENCES branches(id), target_branch_id TEXT NOT NULL REFERENCES branches(id),
 ref TEXT NOT NULL, PRIMARY KEY(branch_id,ref)
);
-- Reconciliation bindings are local runtime identities, not exported UUIDs.
CREATE TABLE branch_installation_resources (
 branch_id TEXT NOT NULL REFERENCES branches(id), package_id TEXT NOT NULL,
 chat_ref TEXT NOT NULL, agent_ref TEXT NOT NULL DEFAULT '', local_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','staging','retiring','deleted')),
 PRIMARY KEY(branch_id,package_id,chat_ref,agent_ref)
);
CREATE TABLE branch_resource_references (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), chat_id TEXT NOT NULL,
 PRIMARY KEY(execution_id,chat_id)
);
-- Every revisit of a fork has a fresh invocation identity.
ALTER TABLE branch_forks RENAME TO branch_forks_previous;
CREATE TABLE branch_forks (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 parent_path_id TEXT NOT NULL, fork_id TEXT NOT NULL, join_id TEXT NOT NULL,
 state TEXT NOT NULL, selected_paths_json TEXT, result_json TEXT
);
INSERT INTO branch_forks SELECT * FROM branch_forks_previous;
DROP TABLE branch_forks_previous;

ALTER TABLE branch_resources ADD COLUMN chat_id TEXT;
ALTER TABLE branch_resources ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE TABLE branch_ephemeral_contexts (
 step_execution_id TEXT NOT NULL REFERENCES branch_step_executions(id), generation INTEGER NOT NULL,
 chat_id TEXT NOT NULL, agent_ids_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(step_execution_id,generation)
);
ALTER TABLE branches ADD COLUMN package_id TEXT;
CREATE TABLE branch_installation_plans (
 id TEXT PRIMARY KEY, branch_id TEXT, expected_version_id TEXT, expected_configuration_revision INTEGER,
 package_json TEXT NOT NULL, bindings_json TEXT NOT NULL, preview_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'preview', error TEXT, created_at TEXT NOT NULL
);

ALTER TABLE conversation_deletion_receipts ADD COLUMN branch_id TEXT;

ALTER TABLE branch_paths ADD COLUMN handling_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_executions ADD COLUMN recovery_traversals INTEGER NOT NULL DEFAULT 0;
CREATE TABLE branch_retirement_errors(resource_id TEXT PRIMARY KEY,error TEXT NOT NULL,updated_at TEXT NOT NULL);

ALTER TABLE branch_gates ADD COLUMN prompt_text TEXT NOT NULL DEFAULT '';

ALTER TABLE branch_resources ADD COLUMN retry_draining INTEGER NOT NULL DEFAULT 0 CHECK(retry_draining IN (0,1));
CREATE TRIGGER branch_retry_descendant_fence BEFORE INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id) AND EXISTS(SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id WHERE m.agent_id=NEW.manager_agent_id AND r.retry_draining=1)
BEGIN SELECT RAISE(ABORT,'Branch resource is draining for a fresh retry'); END;

CREATE TABLE branch_retirement_references(resource_id TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES branch_executions(id),PRIMARY KEY(resource_id,execution_id));

ALTER TABLE branch_executions ADD COLUMN loop_iterations INTEGER NOT NULL DEFAULT 0;

ALTER TABLE branch_installation_plans ADD COLUMN expected_resources_hash TEXT;
