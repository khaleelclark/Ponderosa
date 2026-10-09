import type Database from "better-sqlite3";
import type { ArtifactDto, CommunicationEvent } from "@ponderosa/core";
import { isDeepStrictEqual } from "node:util";

/** Local-user authorship is not Agent custody. Resolve only exact canonical
 * document publications; never infer a Chat from a recipient or a namespace.
 * The byte reader still validates the retained blob against this metadata. */
export function userCommunicationArtifactOwners(
  client: Database.Database,
  events: readonly CommunicationEvent[],
  projectId: string,
): Map<string, { conversationId: string; product: 'dev' | 'branches' }> {
  const owners = new Map<string, { conversationId: string; product: 'dev' | 'branches' }>();
  for (const event of events) {
    const document = event.document;
    if (event.projectId !== projectId || event.sender.kind !== 'user' ||
        event.sender.userId !== 'local-operator' || !event.conversationId || !document ||
        document.authorUserId !== event.sender.userId || document.authorAgentId !== undefined || document.executionId !== undefined ||
        document.id !== document.artifactId || document.mediaType !== 'text/markdown' || !document.title.trim() ||
        events.filter(item => item.eventId === event.eventId || item.document?.id === document.id).length !== 1)
      continue;
    const row = client.prepare(`SELECT artifact_json, owner_kind, owner_id, audience_json, sender_agent_id
      FROM managed_artifact_projection WHERE project_id=? AND artifact_id=?`).get(projectId, document.id) as {
        artifact_json: string; owner_kind: string; owner_id: string; audience_json: string; sender_agent_id: string | null;
      } | undefined;
    if (!row || row.owner_kind !== 'communication' || row.owner_id !== event.eventId || row.sender_agent_id !== null) continue;
    try {
      const artifact = JSON.parse(row.artifact_json) as ArtifactDto;
      if (!isDeepStrictEqual(JSON.parse(row.audience_json), event.audience) ||
          artifact.id !== document.id || artifact.projectId !== projectId || artifact.kind !== 'document' ||
          artifact.agentId !== event.sender.userId || artifact.originAgentId !== event.sender.userId ||
          artifact.executionId !== undefined || artifact.legacyRecovery !== undefined || artifact.path !== `communication/${document.id}.md` ||
          artifact.summary !== document.title || artifact.mediaType !== document.mediaType ||
          artifact.size !== document.byteLength || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? '')) continue;
      const runtimeRows = client.prepare(`SELECT r.*, c.payload_json, c.sender_json, c.intent, c.audience_json
        FROM runtime_artifacts r JOIN runtime_communications c ON c.id=r.owner_id AND c.project_id=r.project_id
        WHERE r.id=? AND r.project_id=? AND r.owner_kind='communication'`).all(document.id, projectId) as Array<{
          title: string; media_type: string; byte_length: number; blob_path: string; blob_hash: string;
          origin_agent_id: string | null; execution_id: string | null; payload_json: string;
          sender_json: string; intent: string; audience_json: string;
        }>;
      if (runtimeRows.length !== 1) continue;
      const runtime = runtimeRows[0]!;
      const payload = JSON.parse(runtime.payload_json);
      const original = payload.communication ?? payload;
      if (runtime.origin_agent_id !== null || runtime.execution_id !== null ||
          runtime.blob_path !== document.id || runtime.blob_hash !== artifact.sha256 ||
          runtime.title !== document.title || runtime.media_type !== document.mediaType || runtime.byte_length !== document.byteLength ||
          !isDeepStrictEqual(JSON.parse(runtime.sender_json), event.sender) || runtime.intent !== event.intent ||
          !isDeepStrictEqual(JSON.parse(runtime.audience_json), event.audience) ||
          ['eventId','projectId','conversationId','sender','intent','audience','document','text','createdAt'].some(key =>
            !isDeepStrictEqual(original[key], event[key as keyof CommunicationEvent]))) continue;
      const chat = client.prepare(`SELECT branch_id FROM conversations WHERE id=? AND project_id=?
        AND EXISTS(SELECT 1 FROM projects WHERE id=conversations.project_id)
        AND NOT EXISTS(SELECT 1 FROM conversation_deletion_receipts removed WHERE removed.conversation_id=conversations.id)
        AND NOT EXISTS(SELECT 1 FROM project_deletion_pending WHERE project_id=?)
        AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive WHERE inactive.local_id=conversations.id AND inactive.state!='active')`)
        .get(event.conversationId, projectId, projectId) as { branch_id: string | null } | undefined;
      const historical = !chat && client.prepare(`SELECT branch_id FROM conversation_deletion_receipts
        WHERE conversation_id=? AND project_id=? AND canonical_deletion_completed=1
          AND NOT EXISTS(SELECT 1 FROM conversations WHERE id=?)
          AND EXISTS(SELECT 1 FROM projects WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM project_deletion_pending WHERE project_id=?)`)
        .get(event.conversationId, projectId, event.conversationId, projectId, projectId) as { branch_id: string | null } | undefined;
      const custody = chat || historical;
      if (custody) owners.set(document.id, { conversationId: event.conversationId, product: custody.branch_id === null ? 'dev' : 'branches' });
    } catch { /* Missing or malformed canonical provenance never grants custody. */ }
  }
  return owners;
}

/** Validated canonical IDs enter SQL before its cursor/search/limit, so a
 * foreign product cannot consume a page. Existing Agent/historical SQL stays. */
export function managedArtifactProductSql(alias: string, product: 'dev' | 'branches', userIds: readonly string[], userDocumentIds: readonly string[]): string {
  const ids = JSON.stringify(userIds).replace(/'/gu, "''");
  const documents = JSON.stringify(userDocumentIds).replace(/'/gu, "''");
  return `(EXISTS(SELECT 1 FROM agents owner_agent
    WHERE ${alias}.artifact_id NOT IN (SELECT value FROM json_each('${documents}'))
      AND owner_agent.id=COALESCE(json_extract(${alias}.artifact_json,'$.legacyRecovery.custodianAgentId'),json_extract(${alias}.artifact_json,'$.originAgentId'))
      AND owner_agent.project_id=${alias}.project_id AND ${artifactAgentProductSql('owner_agent', product)})
    OR ${alias}.artifact_id IN (SELECT value FROM json_each('${ids}')))`;
}

/** Historical artifact ownership follows the custodian's Chat at creation/deletion,
 * not the Agent's current live Chat pointer. Canonical deletion clears that pointer. */
export function artifactAgentProductSql(agentAlias: string, product: 'dev' | 'branches'): string {
  const scope = product === 'branches' ? 'IS NOT NULL' : 'IS NULL';
  const chatEvidence = `(
    EXISTS(SELECT 1 FROM agent_deletion_tombstones tombstone
      JOIN conversations chat ON chat.id=tombstone.conversation_id AND chat.project_id=tombstone.project_id
      WHERE tombstone.agent_id=${agentAlias}.id AND tombstone.project_id=${agentAlias}.project_id)
    OR EXISTS(SELECT 1 FROM agent_deletion_tombstones tombstone
      JOIN conversation_deletion_receipts removed_chat ON removed_chat.conversation_id=tombstone.conversation_id AND removed_chat.project_id=tombstone.project_id
      WHERE tombstone.agent_id=${agentAlias}.id AND tombstone.project_id=${agentAlias}.project_id)
  )`;
  return `(
    EXISTS(SELECT 1 FROM conversations chat WHERE chat.id=${agentAlias}.conversation_id
      AND chat.project_id=${agentAlias}.project_id AND chat.branch_id ${scope}
      AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive
        WHERE inactive.local_id IN (${agentAlias}.id,chat.id) AND inactive.state!='active'))
    OR (${agentAlias}.conversation_id IS NULL AND
      CASE WHEN ${chatEvidence} THEN
        EXISTS(SELECT 1 FROM agent_deletion_tombstones tombstone
          LEFT JOIN conversations chat ON chat.id=tombstone.conversation_id AND chat.project_id=tombstone.project_id
          LEFT JOIN conversation_deletion_receipts removed_chat ON removed_chat.conversation_id=tombstone.conversation_id AND removed_chat.project_id=tombstone.project_id
          WHERE tombstone.agent_id=${agentAlias}.id AND tombstone.project_id=${agentAlias}.project_id
            AND (chat.id IS NOT NULL OR removed_chat.conversation_id IS NOT NULL)
            AND CASE WHEN chat.id IS NOT NULL THEN chat.branch_id ELSE removed_chat.branch_id END ${scope})
      ELSE EXISTS(SELECT 1 FROM agent_deletion_receipts receipt, json_each(receipt.deleted_agent_ids_json) deleted
        WHERE receipt.project_id=${agentAlias}.project_id AND deleted.value=${agentAlias}.id
          AND receipt.product_scope='${product}') END)
  )`;
}
