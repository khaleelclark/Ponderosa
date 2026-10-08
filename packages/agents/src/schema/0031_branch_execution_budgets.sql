-- Local policy, counters, command receipts and admission all share Engine SQLite authority.
CREATE TABLE branch_execution_budgets (
 branch_id TEXT PRIMARY KEY REFERENCES branches(id), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 limit_count INTEGER CHECK(limit_count BETWEEN 1 AND 1000000000),
 period TEXT CHECK(period IN ('day','week','month','lifetime')),
 used INTEGER NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 1000000000),
 allowance INTEGER NOT NULL DEFAULT 0 CHECK(allowance BETWEEN 0 AND 1000000000),
 period_id TEXT, period_started_at TEXT, updated_at TEXT NOT NULL,
 CHECK((limit_count IS NULL AND period IS NULL AND period_id IS NULL AND period_started_at IS NULL) OR
       (limit_count IS NOT NULL AND period IS NOT NULL AND period_id IS NOT NULL AND period_started_at IS NOT NULL)),
 CHECK(COALESCE(limit_count,0)+allowance<=1000000000)
);
CREATE TABLE branch_execution_budget_commands (
 branch_id TEXT NOT NULL REFERENCES branches(id), command_key TEXT NOT NULL,
 input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(branch_id,command_key)
);
CREATE TABLE branch_execution_budget_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id TEXT NOT NULL REFERENCES branches(id),
 kind TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
 audit_published INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE branch_executions ADD COLUMN admission_source TEXT NOT NULL DEFAULT 'automatic' CHECK(admission_source IN ('manual','automatic','call'));
ALTER TABLE branch_executions ADD COLUMN admitted_at TEXT;
ALTER TABLE branch_executions ADD COLUMN admission_json TEXT;
ALTER TABLE branch_executions ADD COLUMN budget_wait INTEGER NOT NULL DEFAULT 0 CHECK(budget_wait IN (0,1));
-- Backfill from canonical relational intake receipts, never payload/provenance/key text.
-- Before this migration the only intake paths were direct manual, bound trigger, or exact child Call.
UPDATE branch_executions SET admission_source=CASE
 WHEN parent_attempt_id IS NOT NULL THEN 'call'
 WHEN EXISTS(SELECT 1 FROM trigger_occurrences o WHERE o.branch_execution_id=branch_executions.id) THEN 'automatic'
 ELSE 'manual' END;
-- Historical receipts grandfather started work.
UPDATE branch_executions SET admitted_at=created_at,admission_json='{"kind":"grandfathered"}'
 WHERE state IN ('running','waiting','completed','failed') OR EXISTS(SELECT 1 FROM branch_paths p WHERE p.execution_id=branch_executions.id);
