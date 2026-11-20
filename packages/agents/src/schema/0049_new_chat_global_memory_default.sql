ALTER TABLE local_memory_scope_provisioning
  ADD COLUMN default_read_global INTEGER NOT NULL DEFAULT 0 CHECK(default_read_global IN (0, 1));
