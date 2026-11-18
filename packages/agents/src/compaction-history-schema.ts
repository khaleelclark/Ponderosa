import type Database from "better-sqlite3";

export function ensureHistoryIndex(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS compaction_history_messages (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      canonical_ordinal INTEGER NOT NULL,
      conversation_id TEXT,
      created_at TEXT NOT NULL,
      revision_event_id TEXT,
      edited_at TEXT,
      content_sha256 TEXT NOT NULL,
      text TEXT NOT NULL,
      communication_intent TEXT NOT NULL DEFAULT '',
      context_policy TEXT NOT NULL DEFAULT '',
      sender_kind TEXT NOT NULL DEFAULT '',
      sender_agent_id TEXT,
      PRIMARY KEY (project_id, communication_event_id)
    );
  `);
  const columns = new Set((sqlite.pragma("table_info(compaction_history_messages)") as Array<{ name: string }>)
    .map((column) => column.name));
  for (const [name, declaration] of [
    ["communication_intent", "TEXT NOT NULL DEFAULT ''"],
    ["context_policy", "TEXT NOT NULL DEFAULT ''"],
    ["sender_kind", "TEXT NOT NULL DEFAULT ''"],
    ["sender_agent_id", "TEXT"],
  ] as const) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE compaction_history_messages ADD COLUMN ${name} ${declaration}`);
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_compaction_history_messages_boundary
      ON compaction_history_messages (project_id, canonical_ordinal);
    CREATE INDEX IF NOT EXISTS idx_compaction_history_messages_conversation_ordinal
      ON compaction_history_messages (project_id, conversation_id, canonical_ordinal);
    CREATE TABLE IF NOT EXISTS compaction_history_agent_participants (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, communication_event_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS compaction_history_relation_candidates (
      project_id TEXT NOT NULL,
      communication_event_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      canonical_ordinal INTEGER NOT NULL,
      authority_agent_id TEXT NOT NULL,
      PRIMARY KEY (project_id, communication_event_id, authority_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_history_relation_candidates_lookup
      ON compaction_history_relation_candidates (
        project_id, conversation_id, authority_agent_id, canonical_ordinal DESC
      );
    CREATE VIRTUAL TABLE IF NOT EXISTS compaction_history_fts USING fts5(
      project_id UNINDEXED,
      communication_event_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    );
  `);
}
