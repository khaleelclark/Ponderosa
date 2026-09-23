import Database from "better-sqlite3";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface Finding {
  code: string;
  count: number;
  examples: Record<string, unknown>[];
}

export const unresolvedArtifactOwnershipSql = `
  SELECT m.artifact_id AS artifactId,m.project_id AS legacyProjectId FROM managed_artifact_projection m
  LEFT JOIN agents a ON a.id=CASE WHEN json_valid(m.artifact_json)
    THEN COALESCE(json_extract(m.artifact_json,'$.legacyRecovery.custodianAgentId'),json_extract(m.artifact_json,'$.originAgentId')) END
  LEFT JOIN conversations c ON c.id=a.conversation_id
  WHERE (c.id IS NULL OR c.project_id<>m.project_id OR a.project_id<>m.project_id)
  AND NOT (m.owner_kind='communication' AND (
    SELECT COUNT(DISTINCT s.conversation_id) FROM chat_search_messages s
    JOIN conversations owner ON owner.id=s.conversation_id AND owner.project_id=m.project_id
    WHERE s.project_id=m.project_id AND s.communication_event_id=m.owner_id
  )=1)`;

/** Read-only ownership preflight. This never opens AgentStore: its startup
 * reconciliation can write data. Passing this check is not migration approval;
 * canonical journals, file access, and runtime recovery need separate checks. */
export function auditChatOwnership(databasePath: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => {
      const findings: Finding[] = [];
      const check = (code: string, sql: string) => {
        const { count } = db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get() as { count: number };
        if (count) findings.push({ code, count, examples: db.prepare(`${sql} LIMIT 20`).all() as Record<string, unknown>[] });
      };
      check("chat_without_project_metadata", `
        SELECT c.id AS chatId FROM conversations c LEFT JOIN projects p ON p.id=c.project_id WHERE p.id IS NULL`);
      check("live_agent_without_valid_chat", `
        SELECT a.id AS agentId FROM agents a LEFT JOIN conversations c ON c.id=a.conversation_id
        WHERE a.deleted_at IS NULL AND (c.id IS NULL OR c.project_id<>a.project_id)`);
      check("cross_chat_hierarchy", `
        SELECT a.id AS agentId,a.manager_agent_id AS managerId FROM agents a JOIN agents m ON m.id=a.manager_agent_id
        WHERE a.deleted_at IS NULL AND (m.deleted_at IS NOT NULL OR a.conversation_id IS NULL
          OR m.conversation_id IS NULL OR a.conversation_id<>m.conversation_id OR a.project_id<>m.project_id)`);
      check("cross_chat_request", `
        SELECT r.id AS requestId FROM coordination_requests r
        JOIN agents a ON a.id=r.requester_agent_id JOIN agents b ON b.id=r.recipient_agent_id
        WHERE a.conversation_id IS NOT NULL AND b.conversation_id IS NOT NULL AND a.conversation_id<>b.conversation_id`);
      check("artifact_without_resolvable_chat", unresolvedArtifactOwnershipSql);
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return {
        version: 1,
        scope: "sqlite-ownership-preflight-only",
        migrationImplemented: false,
        canonicalJournalVerificationRequired: true,
        findings,
        counts: {
          projects: count("projects"), chats: count("conversations"), agents: count("agents"),
          artifacts: count("managed_artifact_projection"), requests: count("coordination_requests"),
          presets: count("agent_presets"),
        },
      };
    })();
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node chat-ownership-audit.js /path/to/ponderosa.db");
  const result = auditChatOwnership(process.argv[2]!);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.findings.length) process.exitCode = 2;
}
