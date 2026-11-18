-- Durable action provenance and report deduplication; neither table grants access.
CREATE TABLE workspace_agent_actions (
 id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
 operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
 result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(source_agent_id, operation, idempotency_key)
) WITHOUT ROWID;
CREATE TABLE assistant_report_sources (
 speaker_agent_id TEXT NOT NULL, source_key TEXT NOT NULL, communication_id TEXT NOT NULL,
 reported_at TEXT NOT NULL, PRIMARY KEY(speaker_agent_id,source_key)
) WITHOUT ROWID;
CREATE INDEX assistant_report_interval ON assistant_report_sources(speaker_agent_id,reported_at);
CREATE TABLE assistant_report_scan (
 speaker_agent_id TEXT PRIMARY KEY, after_sequence INTEGER NOT NULL
) WITHOUT ROWID;

-- Durable observation order; authoritative outcomes remain in their canonical tables.
-- An insertion sequence cannot miss equal-time outcomes or clock corrections.
CREATE TABLE assistant_status_sources (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL, source_id TEXT NOT NULL, source_version INTEGER,
 project_id TEXT NOT NULL, chat_id TEXT, agent_id TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE TRIGGER assistant_status_communication AFTER INSERT ON runtime_communications
 WHEN json_extract(NEW.payload_json,'$.taskDelivery')='final' AND json_extract(NEW.sender_json,'$.kind')='agent'
 BEGIN INSERT OR IGNORE INTO assistant_status_sources(source_key,kind,source_id,project_id,chat_id,agent_id,observed_at)
 VALUES('communication:'||NEW.id,'communication',NEW.id,NEW.project_id,json_extract(NEW.payload_json,'$.communication.conversationId'),json_extract(NEW.sender_json,'$.agentId'),NEW.created_at); END;
CREATE TRIGGER assistant_status_request AFTER UPDATE OF state,version ON coordination_requests
 WHEN NEW.state IN ('completed','blocked','failed','outcome_unknown','recipient_unavailable')
 BEGIN INSERT OR IGNORE INTO assistant_status_sources(source_key,kind,source_id,source_version,project_id,chat_id,agent_id,observed_at)
 VALUES('request:'||NEW.id||':'||NEW.version,'request',NEW.id,NEW.version,NEW.project_id,NEW.conversation_id,NEW.recipient_agent_id,NEW.updated_at); END;
CREATE TRIGGER assistant_status_run AFTER UPDATE OF status ON runs WHEN NEW.status='failed'
 BEGIN INSERT OR IGNORE INTO assistant_status_sources(source_key,kind,source_id,project_id,chat_id,agent_id,observed_at)
 SELECT 'run:'||NEW.agent_id||':'||NEW.id,'run',NEW.id,a.project_id,a.conversation_id,a.id,COALESCE(NEW.completed_at,NEW.updated_at) FROM agents a WHERE a.id=NEW.agent_id; END;
