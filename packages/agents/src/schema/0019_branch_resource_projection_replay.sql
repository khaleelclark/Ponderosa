-- Existing members retain canonical SQLite ownership during metadata projection rebuild.
DROP TRIGGER branch_child_budget;
DROP TRIGGER branch_child_ownership;
DROP TRIGGER branch_child_path_fence;
CREATE TRIGGER branch_child_budget BEFORE INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id)
AND EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id = NEW.manager_agent_id)
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
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id)
AND EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id)
BEGIN
 INSERT INTO branch_resource_members(agent_id,step_execution_id,origin)
 SELECT NEW.id,step_execution_id,'descendant' FROM branch_resource_members WHERE agent_id=NEW.manager_agent_id;
END;
CREATE TRIGGER branch_child_path_fence BEFORE INSERT ON agents
WHEN NOT EXISTS(SELECT 1 FROM branch_resource_members WHERE agent_id=NEW.id) AND EXISTS(SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id
 JOIN branch_step_executions s ON s.id=r.step_execution_id JOIN branch_paths p ON p.id=s.path_id
 WHERE m.agent_id=NEW.manager_agent_id AND (r.state='archived' OR p.state='canceled'))
BEGIN SELECT RAISE(ABORT,'Branch resource path no longer accepts descendants'); END;
