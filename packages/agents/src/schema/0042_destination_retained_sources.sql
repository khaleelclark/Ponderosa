-- Current-format bootstrap only. Populated destination stores require a separately
-- reviewed lossless offline converter; never relax online state admission.
CREATE TEMP TABLE destination_retained_empty_bootstrap (
 empty INTEGER NOT NULL CHECK(empty=1)
);
INSERT INTO destination_retained_empty_bootstrap SELECT
 NOT EXISTS(SELECT 1 FROM coordination_destination_admissions)
 AND NOT EXISTS(SELECT 1 FROM coordination_destination_members)
 AND NOT EXISTS(SELECT 1 FROM coordination_destination_group_chats)
 AND NOT EXISTS(SELECT 1 FROM coordination_destination_retirements);
DROP TABLE destination_retained_empty_bootstrap;

CREATE TABLE coordination_destination_retained_sources (
 id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
 branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
 local_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE RESTRICT,
 installation_plan_id TEXT NOT NULL REFERENCES branch_installation_plans(id) ON DELETE RESTRICT,
 installation_execution_id TEXT NOT NULL,
 installation_command_key TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
 original_execution_id TEXT NOT NULL,
 original_checkpoint_key TEXT NOT NULL,
 original_checkpoint_sha256 TEXT NOT NULL CHECK(length(original_checkpoint_sha256)=64 AND original_checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'),
 original_snapshot_json TEXT NOT NULL,
 proof_json TEXT NOT NULL,
 proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64 AND proof_sha256 NOT GLOB '*[^0-9a-f]*'),
 FOREIGN KEY(installation_execution_id,installation_command_key)
  REFERENCES branch_commands(execution_id,command_key) ON DELETE RESTRICT,
 UNIQUE(id,branch_id,local_execution_id)
);
CREATE TABLE coordination_destination_retained_owners (
 source_id TEXT NOT NULL REFERENCES coordination_destination_retained_sources(id) ON DELETE RESTRICT,
 original_execution_id TEXT NOT NULL,
 local_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE RESTRICT,
 owner_json TEXT NOT NULL,
 owner_sha256 TEXT NOT NULL CHECK(length(owner_sha256)=64 AND owner_sha256 NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(source_id,original_execution_id),
 UNIQUE(source_id,local_execution_id)
);
CREATE TRIGGER coordination_destination_retained_source_immutable
 BEFORE UPDATE ON coordination_destination_retained_sources
 BEGIN SELECT RAISE(ABORT,'Retained source association is immutable'); END;
CREATE TRIGGER coordination_destination_retained_owner_immutable
 BEFORE UPDATE ON coordination_destination_retained_owners
 BEGIN SELECT RAISE(ABORT,'Retained owner association is immutable'); END;

-- Drop children before their empty parent; foreign_keys remains enabled.
DROP TABLE coordination_destination_group_chats;
DROP TABLE coordination_destination_members;
DROP TABLE coordination_destination_admissions;

-- Durable staging is authority; process flags and importer callbacks are not.
CREATE TABLE coordination_destination_admissions (
 id TEXT PRIMARY KEY,
 branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE RESTRICT,
 checkpoint_id INTEGER REFERENCES branch_unit_snapshots(id) ON DELETE RESTRICT,
 source_kind TEXT NOT NULL DEFAULT 'native' CHECK(source_kind IN ('native','retained_foreign')),
 retained_source_id TEXT REFERENCES coordination_destination_retained_sources(id) ON DELETE RESTRICT,
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
 UNIQUE(branch_id,command_key),
 CHECK((source_kind='native' AND checkpoint_id IS NOT NULL AND retained_source_id IS NULL)
  OR (source_kind='retained_foreign' AND checkpoint_id IS NULL AND retained_source_id IS NOT NULL)),
 FOREIGN KEY(retained_source_id,branch_id,source_execution_id)
  REFERENCES coordination_destination_retained_sources(id,branch_id,local_execution_id) ON DELETE RESTRICT
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
 OR OLD.source_execution_id!=NEW.source_execution_id OR OLD.checkpoint_id IS NOT NEW.checkpoint_id
 OR OLD.source_kind IS NOT NEW.source_kind OR OLD.retained_source_id IS NOT NEW.retained_source_id
 OR OLD.branch_id!=NEW.branch_id OR OLD.command_key!=NEW.command_key
 OR OLD.stage_json IS NOT NULL AND OLD.stage_json IS NOT NEW.stage_json
 OR OLD.receipt_json IS NOT NULL AND OLD.receipt_json IS NOT NEW.receipt_json
 OR OLD.state='admitted' AND OLD.state!=NEW.state
 BEGIN SELECT RAISE(ABORT,'Destination admission identity is immutable'); END;
CREATE TRIGGER coordination_destination_member_immutable BEFORE UPDATE ON coordination_destination_members
 BEGIN SELECT RAISE(ABORT,'Destination participant map is immutable'); END;

-- Every group Chat is held before any importer or workspace creation effects.
CREATE TABLE coordination_destination_group_chats (
 admission_id TEXT NOT NULL REFERENCES coordination_destination_admissions(id) ON DELETE RESTRICT,
 source_chat_id TEXT NOT NULL,
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE RESTRICT,
 conversation_id TEXT NOT NULL UNIQUE,
 retained_source_id TEXT,
 stage_json TEXT,
 FOREIGN KEY(retained_source_id,source_execution_id)
  REFERENCES coordination_destination_retained_owners(source_id,local_execution_id) ON DELETE RESTRICT,
 PRIMARY KEY(admission_id,source_chat_id)
);
CREATE TRIGGER coordination_destination_group_chat_immutable BEFORE UPDATE ON coordination_destination_group_chats
 WHEN OLD.admission_id!=NEW.admission_id OR OLD.source_chat_id!=NEW.source_chat_id OR OLD.source_execution_id!=NEW.source_execution_id OR OLD.conversation_id!=NEW.conversation_id
 OR OLD.retained_source_id IS NOT NEW.retained_source_id
 OR OLD.stage_json IS NOT NULL AND OLD.stage_json IS NOT NEW.stage_json
 BEGIN SELECT RAISE(ABORT,'Destination group map is immutable'); END;

CREATE TRIGGER coordination_destination_group_retained_source BEFORE INSERT ON coordination_destination_group_chats
 WHEN NEW.retained_source_id IS NOT (SELECT retained_source_id FROM coordination_destination_admissions WHERE id=NEW.admission_id)
 BEGIN SELECT RAISE(ABORT,'Destination group retained source differs'); END;
CREATE TRIGGER coordination_destination_retained_owner_insert BEFORE INSERT ON coordination_destination_retained_owners
 WHEN EXISTS(SELECT 1 FROM coordination_destination_admissions WHERE retained_source_id=NEW.source_id)
 BEGIN SELECT RAISE(ABORT,'Admitted retained owner set is fixed'); END;
CREATE TRIGGER coordination_destination_retained_owner_delete BEFORE DELETE ON coordination_destination_retained_owners
 WHEN EXISTS(SELECT 1 FROM coordination_destination_admissions WHERE retained_source_id=OLD.source_id)
 BEGIN SELECT RAISE(ABORT,'Admitted retained owner set is fixed'); END;
CREATE TRIGGER coordination_destination_retained_source_delete BEFORE DELETE ON coordination_destination_retained_sources
 WHEN EXISTS(SELECT 1 FROM coordination_destination_admissions WHERE retained_source_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Admitted retained source is pinned'); END;

-- Manifest and per-owner command facts are rechecked by the host verifier;
-- pin their live bytes against ordinary command maintenance in the meantime.
CREATE TRIGGER coordination_destination_retained_command_update BEFORE UPDATE ON branch_commands
 WHEN EXISTS(SELECT 1 FROM coordination_destination_retained_sources s
  WHERE s.installation_execution_id=OLD.execution_id AND s.installation_command_key=OLD.command_key)
 OR OLD.command_key='portable-runtime-data' AND EXISTS(
  SELECT 1 FROM coordination_destination_retained_owners o WHERE o.local_execution_id=OLD.execution_id)
 BEGIN SELECT RAISE(ABORT,'Retained source command evidence is pinned'); END;
CREATE TRIGGER coordination_destination_retained_command_delete BEFORE DELETE ON branch_commands
 WHEN EXISTS(SELECT 1 FROM coordination_destination_retained_sources s
  WHERE s.installation_execution_id=OLD.execution_id AND s.installation_command_key=OLD.command_key)
 OR OLD.command_key='portable-runtime-data' AND EXISTS(
  SELECT 1 FROM coordination_destination_retained_owners o WHERE o.local_execution_id=OLD.execution_id)
 BEGIN SELECT RAISE(ABORT,'Retained source command evidence is pinned'); END;
