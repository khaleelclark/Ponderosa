ALTER TABLE trigger_definitions ADD COLUMN run_budget_limit INTEGER CHECK (run_budget_limit IS NULL OR run_budget_limit > 0);
ALTER TABLE trigger_definitions ADD COLUMN run_budget_period TEXT CHECK (run_budget_period IS NULL OR run_budget_period IN ('day', 'week', 'month', 'lifetime'));
ALTER TABLE trigger_definitions ADD COLUMN run_budget_used INTEGER NOT NULL DEFAULT 0 CHECK (run_budget_used >= 0);
ALTER TABLE trigger_definitions ADD COLUMN run_budget_allowance INTEGER NOT NULL DEFAULT 0 CHECK (run_budget_allowance >= 0);
ALTER TABLE trigger_definitions ADD COLUMN run_budget_period_started_at TEXT;

CREATE INDEX trigger_definitions_budget
  ON trigger_definitions(run_budget_period, run_budget_period_started_at)
  WHERE run_budget_limit IS NOT NULL;
