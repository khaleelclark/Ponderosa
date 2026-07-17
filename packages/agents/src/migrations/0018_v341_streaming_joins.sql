ALTER TABLE coordination_joins
  ADD COLUMN wake_policy TEXT NOT NULL DEFAULT 'final_only'
  CHECK (wake_policy IN ('each_result', 'final_only'));
