-- Derived telemetry lookup only. No new communication or runtime authority.
CREATE INDEX IF NOT EXISTS idx_events_public_progress
  ON events (agent_id, json_extract(payload_json, '$.executionId'), json_extract(payload_json, '$.progressInjectionId'), seq DESC)
  WHERE type = 'text' AND json_extract(payload_json, '$.presentation') = 'progress';
CREATE INDEX IF NOT EXISTS idx_runtime_communications_public_reply
  ON runtime_communications (project_id, json_extract(sender_json, '$.agentId'),
    json_extract(sender_json, '$.executionId'), intent,
    json_extract(payload_json, '$.communication.conversationId'), created_at DESC);
