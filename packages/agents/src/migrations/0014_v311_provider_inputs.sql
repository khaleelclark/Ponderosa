CREATE TABLE provider_inputs (
  execution_id TEXT PRIMARY KEY,
  scheduler_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider_prompt TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX provider_inputs_scheduler_run ON provider_inputs(scheduler_run_id);
CREATE INDEX provider_inputs_agent ON provider_inputs(agent_id, created_at);
