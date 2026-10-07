-- Durable retry/cancellation bookkeeping keeps package work fair and recoverable.
ALTER TABLE branch_installation_plans ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE branch_installation_plans ADD COLUMN next_attempt_at TEXT;
ALTER TABLE branch_installation_plans ADD COLUMN updated_at TEXT;
UPDATE branch_installation_plans SET updated_at=created_at WHERE updated_at IS NULL;
CREATE INDEX branch_installation_retry_eligibility ON branch_installation_plans(state,next_attempt_at,created_at);
