CREATE TABLE IF NOT EXISTS collection_generations (
  name TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);

CREATE TRIGGER IF NOT EXISTS trg_projects_collection_insert AFTER INSERT ON projects BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('projects', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('projects:id:' || NEW.id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_projects_collection_update AFTER UPDATE ON projects BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('projects', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('projects:id:' || NEW.id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_projects_collection_delete AFTER DELETE ON projects BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('projects', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('projects:id:' || OLD.id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_conversations_collection_insert AFTER INSERT ON conversations BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('conversations', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_conversations_collection_update AFTER UPDATE ON conversations BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('conversations', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_conversations_collection_delete AFTER DELETE ON conversations BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('conversations', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('conversations:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_agents_collection_insert AFTER INSERT ON agents BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('agents', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_agents_collection_update AFTER UPDATE ON agents BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('agents', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || NEW.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_agents_collection_delete AFTER DELETE ON agents BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('agents', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('agents:project:' || OLD.project_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_memberships_collection_insert AFTER INSERT ON agent_conversation_memberships BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('memberships', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || NEW.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_memberships_collection_update AFTER UPDATE ON agent_conversation_memberships BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('memberships', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || OLD.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || NEW.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_memberships_collection_delete AFTER DELETE ON agent_conversation_memberships BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('memberships', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
  INSERT INTO collection_generations (name, generation) VALUES ('memberships:conversation:' || OLD.conversation_id, 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_scheduler_runs_collection_insert AFTER INSERT ON scheduler_runs BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('scheduler_runs', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_scheduler_runs_collection_update AFTER UPDATE ON scheduler_runs BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('scheduler_runs', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_scheduler_runs_collection_delete AFTER DELETE ON scheduler_runs BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('scheduler_runs', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_context_rollovers_collection_insert AFTER INSERT ON context_rollovers BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('context_rollovers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_context_rollovers_collection_update AFTER UPDATE ON context_rollovers BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('context_rollovers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER IF NOT EXISTS trg_context_rollovers_collection_delete AFTER DELETE ON context_rollovers BEGIN
  INSERT INTO collection_generations (name, generation) VALUES ('context_rollovers', 1)
  ON CONFLICT(name) DO UPDATE SET generation = generation + 1;
END;
