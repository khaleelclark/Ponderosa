-- INITIAL-only checkpoints. No historical audit row is promoted into executable state.
CREATE TABLE branch_initial_checkpoints (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 execution_id TEXT NOT NULL UNIQUE REFERENCES branch_executions(id),
 snapshot_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE branch_initial_rewinds (
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 checkpoint_id INTEGER NOT NULL REFERENCES branch_initial_checkpoints(id),
 checkpoint_hash TEXT NOT NULL,
 command_key TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 execution_id TEXT NOT NULL UNIQUE REFERENCES branch_executions(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(source_execution_id,command_key)
);
CREATE TRIGGER branch_initial_checkpoint_immutable BEFORE UPDATE ON branch_initial_checkpoints
 BEGIN SELECT RAISE(ABORT,'Initial checkpoints are immutable'); END;
CREATE TRIGGER branch_initial_rewind_immutable BEFORE UPDATE ON branch_initial_rewinds
 BEGIN SELECT RAISE(ABORT,'Initial rewind lineage is immutable'); END;
