-- Current invocation metadata shares the canonical execution owner. Historical
-- invocation identities remain in immutable saved snapshot bytes.
ALTER TABLE branch_executions ADD COLUMN checkpoint_invocation_json TEXT
 CHECK(checkpoint_invocation_json IS NULL OR json_valid(checkpoint_invocation_json));
