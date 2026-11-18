-- Preserve all native restoration rows and update origins while allowing an
-- explicitly retained installation source. Never synthesize local snapshots.
CREATE TEMP TABLE retained_cut_old_receipts AS SELECT * FROM coordination_cut_restorations;
CREATE TEMP TABLE retained_cut_old_origins AS SELECT * FROM coordination_restored_update_origins;
DROP TABLE coordination_restored_update_origins;
DROP TABLE coordination_cut_restorations;
-- Immutable provenance only: never an old Run, reply route, lease or grant.
CREATE TABLE coordination_cut_restorations (
 id TEXT PRIMARY KEY,
 branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE CASCADE,
 checkpoint_id INTEGER REFERENCES branch_unit_snapshots(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL DEFAULT 'native' CHECK(source_kind IN ('native','retained_foreign')),
 retained_source_id TEXT REFERENCES coordination_destination_retained_sources(id) ON DELETE RESTRICT,
 cut_hash TEXT NOT NULL,
 command_key TEXT NOT NULL,
 command_hash TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(source_execution_id,command_key),
 CHECK((source_kind='native' AND checkpoint_id IS NOT NULL AND retained_source_id IS NULL) OR (source_kind='retained_foreign' AND checkpoint_id IS NULL AND retained_source_id IS NOT NULL)),
 FOREIGN KEY(retained_source_id,branch_id,source_execution_id) REFERENCES coordination_destination_retained_sources(id,branch_id,local_execution_id)
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

INSERT INTO coordination_cut_restorations(id,branch_id,source_execution_id,checkpoint_id,cut_hash,command_key,command_hash,receipt_json,created_at)
 SELECT id,branch_id,source_execution_id,checkpoint_id,cut_hash,command_key,command_hash,receipt_json,created_at FROM retained_cut_old_receipts;
INSERT INTO coordination_restored_update_origins SELECT * FROM retained_cut_old_origins;
DROP TABLE retained_cut_old_origins;
DROP TABLE retained_cut_old_receipts;
