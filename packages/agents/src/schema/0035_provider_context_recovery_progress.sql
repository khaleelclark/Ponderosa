-- Recovery holds remain active throughout native mutation and source-work reconciliation.
ALTER TABLE provider_context_recovery_requests ADD COLUMN progress_json TEXT;
