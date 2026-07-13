ALTER TABLE threads ADD COLUMN spawned_by_agent_id TEXT;
ALTER TABLE threads ADD COLUMN spawned_by_execution_id TEXT;
ALTER TABLE threads ADD COLUMN spawn_prompt TEXT;
ALTER TABLE threads ADD COLUMN spawn_idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_agent_spawn_idempotency
  ON threads (spawned_by_agent_id, spawned_by_execution_id, spawn_idempotency_key)
  WHERE spawned_by_agent_id IS NOT NULL
    AND spawned_by_execution_id IS NOT NULL
    AND spawn_idempotency_key IS NOT NULL;
