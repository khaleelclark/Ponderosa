import {activeAgentOwnerSql,activeChatOwnerSql} from './product-scope-sql.js';

/** Product visibility follows canonical current or retained deletion ownership.
 * This predicate narrows an existing artifact audience; it never grants access. */
export function artifactAgentProductSql(agent:string,product:'dev'|'branches'):string {
  const scope=product==='branches'?'IS NOT NULL':'IS NULL';
  return `(EXISTS(SELECT 1 FROM conversations artifact_chat WHERE artifact_chat.id=${agent}.conversation_id
    AND artifact_chat.project_id=${agent}.project_id AND artifact_chat.branch_id ${scope}
    AND ${activeAgentOwnerSql(agent)} AND ${activeChatOwnerSql('artifact_chat')})
    OR (${agent}.deleted_at IS NOT NULL AND ${agent}.conversation_id IS NULL AND EXISTS(SELECT 1 FROM agent_deletion_tombstones tombstone
      LEFT JOIN conversations artifact_chat ON artifact_chat.id=tombstone.conversation_id AND artifact_chat.project_id=tombstone.project_id
      LEFT JOIN conversation_deletion_receipts removed ON removed.conversation_id=tombstone.conversation_id AND removed.project_id=tombstone.project_id
      WHERE tombstone.agent_id=${agent}.id AND tombstone.project_id=${agent}.project_id
        AND (artifact_chat.id IS NOT NULL OR removed.conversation_id IS NOT NULL)
        AND CASE WHEN artifact_chat.id IS NOT NULL THEN artifact_chat.branch_id ELSE removed.branch_id END ${scope})))`;
}

/** Both producer and user-document provenance are already canonical SQLite
 * authorities. Filter them before pagination without replaying authored logs. */
export function managedArtifactProductSql(artifact:string,product:'dev'|'branches'):string {
  const scope=product==='branches'?'IS NOT NULL':'IS NULL';
  return `(EXISTS(SELECT 1 FROM agents artifact_agent
      WHERE artifact_agent.id=COALESCE(${artifact}.sender_agent_id,json_extract(${artifact}.artifact_json,'$.originAgentId'))
        AND artifact_agent.project_id=${artifact}.project_id AND ${artifactAgentProductSql('artifact_agent',product)})
    OR (${artifact}.owner_kind='communication' AND ${artifact}.sender_agent_id IS NULL AND EXISTS(
      SELECT 1 FROM runtime_communications publication JOIN runtime_artifacts content
        ON content.owner_kind='communication' AND content.owner_id=publication.id AND content.project_id=publication.project_id
      LEFT JOIN conversations publication_chat ON publication_chat.id=COALESCE(json_extract(publication.payload_json,'$.communication.conversationId'),json_extract(publication.payload_json,'$.conversationId'))
        AND publication_chat.project_id=publication.project_id
      LEFT JOIN conversation_deletion_receipts removed ON removed.conversation_id=COALESCE(json_extract(publication.payload_json,'$.communication.conversationId'),json_extract(publication.payload_json,'$.conversationId'))
        AND removed.project_id=publication.project_id AND removed.canonical_deletion_completed=1
      WHERE publication.id=${artifact}.owner_id AND publication.project_id=${artifact}.project_id AND content.id=${artifact}.artifact_id
        AND content.origin_agent_id IS NULL AND content.execution_id IS NULL
        AND json_extract(publication.sender_json,'$.kind')='user' AND json_extract(publication.sender_json,'$.userId')='local-operator'
        AND (publication_chat.id IS NOT NULL OR removed.conversation_id IS NOT NULL)
        AND CASE WHEN publication_chat.id IS NOT NULL THEN publication_chat.branch_id ELSE removed.branch_id END ${scope}
        AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive WHERE inactive.local_id=publication_chat.id AND inactive.state!='active')
    )))`;
}
