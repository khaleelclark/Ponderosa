CREATE TABLE branch_actions (
 attempt_id TEXT PRIMARY KEY REFERENCES branch_attempts(id),
 state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
 notification_id TEXT
);
