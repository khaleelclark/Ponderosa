-- Directory status counts active work only for the bounded Branch page.
CREATE INDEX IF NOT EXISTS branch_execution_branch_state
  ON branch_executions(branch_id, state);
