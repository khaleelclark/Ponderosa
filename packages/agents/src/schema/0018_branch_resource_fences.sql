CREATE TRIGGER branch_child_path_fence BEFORE INSERT ON agents
WHEN EXISTS(SELECT 1 FROM branch_resource_members m JOIN branch_resources r ON r.step_execution_id=m.step_execution_id
 JOIN branch_step_executions s ON s.id=r.step_execution_id JOIN branch_paths p ON p.id=s.path_id
 WHERE m.agent_id=NEW.manager_agent_id AND (r.state='archived' OR p.state='canceled'))
BEGIN SELECT RAISE(ABORT,'Branch resource path no longer accepts descendants'); END;
