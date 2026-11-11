-- Every group Chat is held before any importer or workspace creation effects.
CREATE TABLE coordination_destination_group_chats (
 admission_id TEXT NOT NULL REFERENCES coordination_destination_admissions(id) ON DELETE RESTRICT,
 source_chat_id TEXT NOT NULL,
 source_execution_id TEXT NOT NULL REFERENCES branch_executions(id) ON DELETE RESTRICT,
 conversation_id TEXT NOT NULL UNIQUE,
 stage_json TEXT,
 PRIMARY KEY(admission_id,source_chat_id)
);
CREATE TRIGGER coordination_destination_group_chat_immutable BEFORE UPDATE ON coordination_destination_group_chats
 WHEN OLD.admission_id!=NEW.admission_id OR OLD.source_chat_id!=NEW.source_chat_id OR OLD.source_execution_id!=NEW.source_execution_id OR OLD.conversation_id!=NEW.conversation_id
 OR OLD.stage_json IS NOT NULL AND OLD.stage_json IS NOT NEW.stage_json
 BEGIN SELECT RAISE(ABORT,'Destination group map is immutable'); END;
