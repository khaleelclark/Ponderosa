-- Durable graph cursors belong to path instances, never UI projections.
ALTER TABLE branch_paths ADD COLUMN node_id TEXT;
ALTER TABLE branch_paths ADD COLUMN step_execution_id TEXT;
ALTER TABLE branch_paths ADD COLUMN input_text TEXT NOT NULL DEFAULT '';
ALTER TABLE branch_paths ADD COLUMN result_json TEXT;
ALTER TABLE branch_attempts ADD COLUMN available_at TEXT;
ALTER TABLE branch_attempts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'step';
ALTER TABLE branch_attempts ADD COLUMN recovery_of_request_id TEXT;
ALTER TABLE branch_attempts ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branch_gates ADD COLUMN purpose TEXT NOT NULL DEFAULT 'approval';
ALTER TABLE branch_gates ADD COLUMN attempt_id TEXT;
ALTER TABLE branch_join_arrivals ADD COLUMN output_text TEXT NOT NULL DEFAULT '';
ALTER TABLE branch_executions ADD COLUMN requested_outcome TEXT NOT NULL DEFAULT 'canceled';
CREATE TABLE branch_forks (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 parent_path_id TEXT NOT NULL REFERENCES branch_paths(id), fork_id TEXT NOT NULL, join_id TEXT NOT NULL,
 state TEXT NOT NULL, selected_paths_json TEXT, result_json TEXT,
 UNIQUE(execution_id,parent_path_id,fork_id)
);
CREATE TABLE branch_commands (
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), command_key TEXT NOT NULL,
 input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(execution_id,command_key)
);
-- Upgrade live Phase 1 paths from their latest invocation; completed paths stay terminal.
UPDATE branch_paths SET node_id = (
 SELECT s.step_id FROM branch_step_executions s WHERE s.path_id=branch_paths.id ORDER BY s.rowid DESC LIMIT 1
), input_text = COALESCE((
 SELECT s.input_text FROM branch_step_executions s WHERE s.path_id=branch_paths.id ORDER BY s.rowid DESC LIMIT 1
),'');

UPDATE branch_paths SET step_execution_id = (SELECT s.id FROM branch_step_executions s WHERE s.path_id=branch_paths.id ORDER BY s.rowid DESC LIMIT 1);
