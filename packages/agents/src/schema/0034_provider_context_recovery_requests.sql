-- Coordination-owned refusal/hold only. No state can authorize native input,
-- drain, context replacement or acceptance without a separately implemented primitive.
CREATE TABLE provider_context_recovery_requests (
 id TEXT PRIMARY KEY,
 agent_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 source_run_id TEXT NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL,
 provider_session_id TEXT NOT NULL,
 tool_contract_hash TEXT NOT NULL,
 source_fence INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('unsupported_fenced','dismissed')),
 created_at TEXT NOT NULL,
 dismissed_at TEXT,
 UNIQUE(agent_id,idempotency_key)
);
CREATE UNIQUE INDEX provider_context_recovery_active ON provider_context_recovery_requests(agent_id)
 WHERE state='unsupported_fenced';
