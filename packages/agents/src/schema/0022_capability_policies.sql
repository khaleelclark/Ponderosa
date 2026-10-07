-- Capability policies are runtime authority. They narrow available Engine
-- capabilities and are deliberately independent of Branch definition JSON.
CREATE TABLE IF NOT EXISTS capability_policies (
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','product','branch','chat','agent','run')),
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  restricted_capability_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope_kind, scope_id)
);

CREATE TRIGGER IF NOT EXISTS capability_policy_branch_cleanup
AFTER DELETE ON branches
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'branch' AND scope_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS capability_policy_chat_cleanup
AFTER DELETE ON conversations
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'chat' AND scope_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS capability_policy_agent_cleanup
AFTER DELETE ON agents
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'agent' AND scope_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS capability_policy_run_cleanup
AFTER DELETE ON runs
BEGIN
  DELETE FROM capability_policies WHERE scope_kind = 'run' AND scope_id = OLD.id;
END;
