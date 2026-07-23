CREATE TABLE coordination_question_suspensions (
  question_update_id TEXT NOT NULL REFERENCES coordination_request_updates(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES coordination_requests(id) ON DELETE CASCADE,
  owner_agent_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN ('decision', 'join')),
  dependency_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  PRIMARY KEY (question_update_id, dependency_kind, dependency_id)
);

CREATE INDEX coordination_question_suspensions_dependency
  ON coordination_question_suspensions(dependency_kind, dependency_id, state);

CREATE INDEX coordination_question_suspensions_request
  ON coordination_question_suspensions(request_id, state);
