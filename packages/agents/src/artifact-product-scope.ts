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
