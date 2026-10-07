-- Final Step results are immutable evidence. A later operator retry creates a new invocation.
CREATE TABLE branch_sealed_results (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 path_id TEXT NOT NULL REFERENCES branch_paths(id),
 step_execution_id TEXT NOT NULL UNIQUE REFERENCES branch_step_executions(id),
 terminal_attempt_id TEXT NOT NULL REFERENCES branch_attempts(id),
 result_json TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX branch_sealed_execution ON branch_sealed_results(execution_id);
ALTER TABLE branch_paths ADD COLUMN last_result_id TEXT;

-- Map uses the existing fork/path/join lifecycle. These rows only seal its dynamic items.
CREATE TABLE branch_map_invocations (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 map_id TEXT NOT NULL, parent_path_id TEXT NOT NULL REFERENCES branch_paths(id),
 join_id TEXT NOT NULL, source_result_id TEXT, item_count INTEGER NOT NULL,
 items_hash TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX branch_map_execution ON branch_map_invocations(execution_id);
CREATE TABLE branch_map_items (
 id TEXT PRIMARY KEY, map_invocation_id TEXT NOT NULL REFERENCES branch_map_invocations(id),
 item_index INTEGER NOT NULL, path_id TEXT NOT NULL UNIQUE REFERENCES branch_paths(id),
 input_text TEXT NOT NULL, input_hash TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0,
 UNIQUE(map_invocation_id,item_index)
);
CREATE INDEX branch_map_item_order ON branch_map_items(map_invocation_id,item_index);

-- Large Joined text remains an explicit execution-owned result reference.
CREATE TABLE branch_result_bundles (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 fork_invocation_id TEXT NOT NULL, content_text TEXT NOT NULL,
 content_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX branch_result_bundle_execution ON branch_result_bundles(execution_id);
