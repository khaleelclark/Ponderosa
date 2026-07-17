ALTER TABLE coordination_joins
  ADD COLUMN wake_policy TEXT NOT NULL DEFAULT 'final_only'
  CHECK (wake_policy IN ('each_result', 'final_only'));

ALTER TABLE coordination_requests
  ADD COLUMN reply_authority_json TEXT;
