-- Immutable provenance only: never an old Run, reply route, lease or grant.
CREATE TABLE coordination_cut_restorations (
 id TEXT PRIMARY KEY,
 branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE CASCADE,
 checkpoint_id INTEGER NOT NULL REFERENCES branch_unit_snapshots(id) ON DELETE CASCADE,
 cut_hash TEXT NOT NULL,
 command_key TEXT NOT NULL,
 command_hash TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(source_execution_id,command_key)
);
CREATE TABLE coordination_restored_update_origins (
 update_id TEXT PRIMARY KEY REFERENCES coordination_request_updates(id) ON DELETE CASCADE,
 restoration_id TEXT NOT NULL REFERENCES coordination_cut_restorations(id) ON DELETE CASCADE,
 source_request_id TEXT NOT NULL,
 source_update_id TEXT NOT NULL,
 source_kind TEXT NOT NULL,
 source_payload_hash TEXT NOT NULL,
 source_resulting_version INTEGER NOT NULL,
 source_actor_json TEXT NOT NULL
);
CREATE TRIGGER coordination_cut_restorations_immutable BEFORE UPDATE ON coordination_cut_restorations
 BEGIN SELECT RAISE(ABORT,'Coordination restoration receipts are immutable'); END;
CREATE TRIGGER coordination_restored_origins_immutable BEFORE UPDATE ON coordination_restored_update_origins
 BEGIN SELECT RAISE(ABORT,'Coordination restoration provenance is immutable'); END;
