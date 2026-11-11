-- Durable staging is authority; process flags and importer callbacks are not.
CREATE TABLE coordination_destination_admissions (
 id TEXT PRIMARY KEY,
 branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE RESTRICT,
 checkpoint_id INTEGER NOT NULL REFERENCES branch_unit_snapshots(id) ON DELETE RESTRICT,
 command_key TEXT NOT NULL,
 reservation_hash TEXT NOT NULL,
 reservation_json TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 project_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('reserved','staged','admitted')),
 stage_json TEXT,
 receipt_json TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(branch_id,command_key)
);
CREATE TABLE coordination_destination_members (
 admission_id TEXT NOT NULL REFERENCES coordination_destination_admissions(id),
 source_agent_id TEXT NOT NULL,
 agent_id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(admission_id,source_agent_id)
);
CREATE TRIGGER coordination_destination_identity_immutable BEFORE UPDATE ON coordination_destination_admissions
 WHEN OLD.id!=NEW.id OR OLD.reservation_json!=NEW.reservation_json OR OLD.reservation_hash!=NEW.reservation_hash
 OR OLD.snapshot_json!=NEW.snapshot_json OR OLD.project_id!=NEW.project_id OR OLD.conversation_id!=NEW.conversation_id
 OR OLD.source_execution_id!=NEW.source_execution_id OR OLD.checkpoint_id!=NEW.checkpoint_id
 OR OLD.branch_id!=NEW.branch_id OR OLD.command_key!=NEW.command_key
 OR OLD.stage_json IS NOT NULL AND OLD.stage_json IS NOT NEW.stage_json
 OR OLD.receipt_json IS NOT NULL AND OLD.receipt_json IS NOT NEW.receipt_json
 OR OLD.state='admitted' AND OLD.state!=NEW.state
 BEGIN SELECT RAISE(ABORT,'Destination admission identity is immutable'); END;
CREATE TRIGGER coordination_destination_member_immutable BEFORE UPDATE ON coordination_destination_members
 BEGIN SELECT RAISE(ABORT,'Destination participant map is immutable'); END;
