-- Exact creation intent for a new durable Chat's two external memory collections.
-- Existing Chats receive no intent and are never assumed to be new.
CREATE TABLE local_memory_scope_provisioning (
 chat_id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 data_generation TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 storage_binding TEXT NOT NULL,
 intent_id TEXT NOT NULL UNIQUE,
 memory_state TEXT NOT NULL CHECK(memory_state IN ('planned','submitted','confirmed')),
 log_state TEXT NOT NULL CHECK(log_state IN ('planned','submitted','confirmed')),
 memory_collection_id TEXT,
 log_collection_id TEXT,
 created_at TEXT NOT NULL,
 CHECK((memory_state='confirmed' AND memory_collection_id IS NOT NULL) OR (memory_state!='confirmed' AND memory_collection_id IS NULL)),
 CHECK((log_state='confirmed' AND log_collection_id IS NOT NULL) OR (log_state!='confirmed' AND log_collection_id IS NULL))
);

-- A canonical witness prevents a missing established policy from being
-- mistaken for a fresh installation on a later restart.
CREATE TABLE local_memory_host_binding (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 data_generation TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('never_configured','bound')),
 principal_id TEXT,
 storage_binding TEXT,
 policy_custody TEXT,
 CHECK((state='never_configured' AND principal_id IS NULL AND storage_binding IS NULL AND policy_custody IS NULL)
    OR (state='bound' AND principal_id IS NOT NULL AND storage_binding IS NOT NULL AND policy_custody IS NOT NULL))
);
