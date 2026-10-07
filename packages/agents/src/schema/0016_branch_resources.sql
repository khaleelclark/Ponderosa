CREATE TABLE branch_resources (
 step_execution_id TEXT PRIMARY KEY REFERENCES branch_step_executions(id),
 execution_id TEXT NOT NULL REFERENCES branch_executions(id), template_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','active','archived')),
 requested_count INTEGER NOT NULL CHECK(requested_count > 0),
 root_agent_id TEXT, creation_key TEXT NOT NULL UNIQUE, error TEXT
);
CREATE TABLE branch_resource_members (
 agent_id TEXT PRIMARY KEY, step_execution_id TEXT NOT NULL REFERENCES branch_resources(step_execution_id),
 origin TEXT NOT NULL CHECK(origin IN ('template','descendant'))
);
CREATE INDEX branch_resources_execution ON branch_resources(execution_id,state);
-- Managed descendants inherit the exact durable resource owner and its budget.
CREATE TRIGGER branch_child_budget BEFORE INSERT ON agents
WHEN EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id = NEW.manager_agent_id)
BEGIN
 SELECT CASE WHEN EXISTS(
   SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id
   JOIN branch_executions e ON e.id=r.execution_id JOIN branch_versions v ON v.id=e.version_id
   WHERE m.agent_id=NEW.manager_agent_id AND (r.state != 'active' OR e.cancel_requested=1 OR
     (SELECT COALESCE(SUM(requested_count),0) FROM branch_resources WHERE execution_id=e.id) +
     (SELECT COUNT(*) FROM branch_resource_members cm JOIN branch_resources cr ON cr.step_execution_id=cm.step_execution_id WHERE cr.execution_id=e.id AND cm.origin='descendant')
     >= COALESCE(json_extract(v.definition_json,'$.policy.maxEphemeralAgents'),100))
 ) THEN RAISE(ABORT,'Branch managed Agent resource budget or lifecycle fence') END;
END;
CREATE TRIGGER branch_child_ownership AFTER INSERT ON agents
WHEN EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id)
BEGIN
 INSERT INTO branch_resource_members(agent_id,step_execution_id,origin)
 SELECT NEW.id,step_execution_id,'descendant' FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id;
END;
-- A reporting-line edit must not silently transfer ephemeral ownership.
CREATE TRIGGER branch_resource_reporting_owner BEFORE UPDATE OF manager_agent_id ON agents
WHEN NEW.manager_agent_id IS NOT OLD.manager_agent_id
AND NOT (NEW.manager_agent_id IS NULL AND (NEW.archived=1 OR NEW.deleted_at IS NOT NULL OR EXISTS(
 SELECT 1 FROM agents parent WHERE parent.id=OLD.manager_agent_id AND (parent.archived=1 OR parent.deleted_at IS NOT NULL)))) AND (
 EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id) OR
 EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id))
BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM branch_resource_members child JOIN branch_resource_members parent ON parent.step_execution_id=child.step_execution_id
 WHERE child.agent_id=NEW.id AND parent.agent_id=NEW.manager_agent_id)
 THEN RAISE(ABORT,'Branch resource ownership cannot be changed through reporting lines') END;
END;
