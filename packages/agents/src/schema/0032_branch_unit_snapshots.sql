-- Saved identities exist only after the separate post-primary saver INSERT.
CREATE TABLE branch_unit_snapshots (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL,
 content_hash TEXT NOT NULL
);
CREATE INDEX branch_unit_snapshot_owner ON branch_unit_snapshots(execution_id,id);
CREATE TRIGGER branch_unit_snapshot_immutable BEFORE UPDATE ON branch_unit_snapshots
 BEGIN SELECT RAISE(ABORT,'Branch unit snapshots are immutable'); END;
