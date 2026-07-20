-- Bind the durable Project-deletion quarantine to the exact filesystem rename.
-- Startup can then distinguish an uncommitted rename (restore and retry) from
-- a committed tombstone whose journal row was atomically purged.

ALTER TABLE project_deletion_pending ADD COLUMN tombstone_name TEXT;
