-- Host reconciliation commits survive Branch/Chat deletion. No source-object foreign keys.
CREATE TABLE host_lifecycle_commits (
 kind TEXT NOT NULL,
 identity TEXT NOT NULL,
 input_json TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 receipt_sha256 TEXT NOT NULL,
 PRIMARY KEY(kind,identity)
);
CREATE TRIGGER host_lifecycle_commit_immutable_update BEFORE UPDATE ON host_lifecycle_commits
 BEGIN SELECT RAISE(ABORT,'Lifecycle commit is immutable'); END;
CREATE TRIGGER host_lifecycle_commit_immutable_delete BEFORE DELETE ON host_lifecycle_commits
 BEGIN SELECT RAISE(ABORT,'Lifecycle commit is immutable'); END;
