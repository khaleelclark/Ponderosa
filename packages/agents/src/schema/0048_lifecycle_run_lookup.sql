-- Run-scoped exit proof reads the append-only lifecycle journal by exact Run.
-- Without this, every Stop/Skip settlement pass scanned all retained receipts.
CREATE INDEX host_lifecycle_commits_run ON host_lifecycle_commits(kind, json_extract(receipt_json, '$.runId'));
