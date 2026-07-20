-- A provider Run may remain active long enough to finish host cleanup after it
-- has handed off every inbound correlated Request. Keep that cleanup authority
-- separate from authority to create additional Ponderosa side effects.
ALTER TABLE scheduler_runs ADD COLUMN side_effects_fenced_at TEXT;
