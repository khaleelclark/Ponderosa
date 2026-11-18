-- Durable, non-text evidence of memory exposed to an exact provider Run.
CREATE TABLE memory_exposure_runs (
 run_id TEXT PRIMARY KEY REFERENCES scheduler_runs(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 fencing_token INTEGER NOT NULL,
 authorization_hash TEXT NOT NULL,
 attempted INTEGER NOT NULL DEFAULT 0,
 pending INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0,
 unverified INTEGER NOT NULL DEFAULT 0,
 mutation_epoch INTEGER NOT NULL DEFAULT 0,
 checked_epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE memory_exposure_sources (
 run_id TEXT NOT NULL REFERENCES memory_exposure_runs(run_id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 source_id TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 PRIMARY KEY (run_id, scope, source_id)
);
