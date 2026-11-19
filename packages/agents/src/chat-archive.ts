import type Database from 'better-sqlite3';

/** Pending and committed archives both prevent dispatch. Retained work holds
 * survive restore separately so newly authored work can still be admitted. */
export function chatArchiveScopeSql(agent: string, scope: string): string {
  return `(EXISTS (SELECT 1 FROM chat_archives archive WHERE archive.conversation_id =
      (SELECT conversation_id FROM agents WHERE id=${agent}))
    OR EXISTS (SELECT 1 FROM chat_archives archive
      WHERE archive.conversation_id=CASE WHEN ${scope} LIKE 'conversation:%' THEN substr(${scope},14) END))`;
}

export function chatArchiveBlocksChat(db: Database.Database, chatId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM chat_archives WHERE conversation_id=?").get(chatId));
}

export function chatArchiveBlocksAgent(db: Database.Database, agentId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 WHERE ${chatArchiveScopeSql('?', "''")}`).get(agentId));
}

export function chatArchiveActivationSql(activation: string): string {
  return `(${chatArchiveScopeSql(`${activation}.agent_id`, `${activation}.scope_key`)} OR EXISTS (
    SELECT 1 FROM activation_sources hold WHERE hold.activation_id=${activation}.id
      AND hold.source_kind='chat_archive_hold'))`;
}
