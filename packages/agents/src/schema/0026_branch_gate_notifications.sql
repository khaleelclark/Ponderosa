CREATE TABLE IF NOT EXISTS branch_gate_notifications (
 gate_id TEXT NOT NULL REFERENCES branch_gates(id),
 gate_revision INTEGER NOT NULL,
 execution_id TEXT NOT NULL REFERENCES branch_executions(id),
 state TEXT NOT NULL CHECK(state IN ('pending','open','closing_unpublished','closing','resolved')),
 prompt_text TEXT NOT NULL,
 purpose TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(gate_id,gate_revision)
);
CREATE INDEX IF NOT EXISTS branch_gate_notifications_pending_idx ON branch_gate_notifications(state,created_at,gate_id,gate_revision);
