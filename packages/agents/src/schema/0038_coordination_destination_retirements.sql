-- Tombstones retain dispatch/idempotency barriers even after proven-safe pin release.
CREATE TABLE coordination_destination_retirements (
 admission_id TEXT PRIMARY KEY,
 branch_id TEXT NOT NULL, command_key TEXT NOT NULL,
 conversation_id TEXT NOT NULL UNIQUE,
 input_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
 evidence_json TEXT NOT NULL, members_json TEXT NOT NULL,
 UNIQUE(branch_id,command_key)
);
CREATE TRIGGER coordination_destination_retirement_immutable_update
 BEFORE UPDATE ON coordination_destination_retirements
 BEGIN SELECT RAISE(ABORT,'Destination retirement is immutable'); END;
CREATE TRIGGER coordination_destination_retirement_immutable_delete
 BEFORE DELETE ON coordination_destination_retirements
 BEGIN SELECT RAISE(ABORT,'Destination retirement is immutable'); END;
