export type ProductScope='dev'|'branches';

/** SQL aliases are internal constants, never request values. Ownership is
 * canonical Chat lineage; namespaces and folder membership grant no access. */
export function activeChatOwnerSql(chat:string):string {
  return `NOT EXISTS(SELECT 1 FROM coordination_destination_admissions staged_chat WHERE staged_chat.conversation_id=${chat}.id AND staged_chat.state!='admitted')
    AND NOT EXISTS(SELECT 1 FROM coordination_destination_group_chats staged_group JOIN coordination_destination_admissions staged_owner ON staged_owner.id=staged_group.admission_id WHERE staged_group.conversation_id=${chat}.id AND staged_owner.state!='admitted')
    AND NOT EXISTS(SELECT 1 FROM coordination_destination_retirements retired_chat WHERE retired_chat.conversation_id=${chat}.id)
    AND NOT EXISTS(SELECT 1 FROM conversation_deletion_receipts removed_chat WHERE removed_chat.conversation_id=${chat}.id)
    AND NOT EXISTS(SELECT 1 FROM project_deletion_pending deleting_project WHERE deleting_project.project_id=${chat}.project_id)
    AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive_chat WHERE inactive_chat.local_id=${chat}.id AND inactive_chat.state!='active')
    AND (${chat}.branch_id IS NULL OR EXISTS(SELECT 1 FROM branches owner_branch WHERE owner_branch.id=${chat}.branch_id AND owner_branch.deleting=0))`;
}
export function chatProductSql(chat:string,product:ProductScope):string {
  return `${chat}.branch_id IS ${product==='branches'?'NOT ':''}NULL`;
}
export function activeChatProductSql(chat:string,product:ProductScope):string {
  return `(${chatProductSql(chat,product)}) AND (${activeChatOwnerSql(chat)})`;
}
export function activeAgentOwnerSql(agent:string):string {
  return `${agent}.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM coordination_destination_admissions staged_identity WHERE staged_identity.state!='admitted' AND (staged_identity.conversation_id=${agent}.conversation_id OR EXISTS(SELECT 1 FROM coordination_destination_members staged_member WHERE staged_member.admission_id=staged_identity.id AND staged_member.agent_id=${agent}.id)))
    AND NOT EXISTS(SELECT 1 FROM coordination_destination_group_chats staged_group JOIN coordination_destination_admissions staged_owner ON staged_owner.id=staged_group.admission_id WHERE staged_group.conversation_id=${agent}.conversation_id AND staged_owner.state!='admitted')
    AND NOT EXISTS(SELECT 1 FROM coordination_destination_retirements retired_identity WHERE retired_identity.conversation_id=${agent}.conversation_id OR EXISTS(SELECT 1 FROM json_each(retired_identity.members_json) retired_member WHERE json_extract(retired_member.value,'$.agent_id')=${agent}.id))
    AND NOT EXISTS(SELECT 1 FROM agent_deletion_pending deleting_agent WHERE deleting_agent.agent_id=${agent}.id)
    AND NOT EXISTS(SELECT 1 FROM agent_creation_operation_members member JOIN agent_creation_operations operation ON operation.id=member.operation_id
      WHERE member.agent_id=${agent}.id AND operation.status IN ('preparing','canonical_committed','rolling_back'))
    AND NOT EXISTS(SELECT 1 FROM branch_installation_resources inactive_agent WHERE inactive_agent.local_id=${agent}.id AND inactive_agent.state!='active')`;
}
export function activeAgentProductSql(agent:string,product:ProductScope):string {
  return `(${activeAgentOwnerSql(agent)}) AND EXISTS(SELECT 1 FROM conversations product_owner
    WHERE product_owner.id=${agent}.conversation_id AND product_owner.project_id=${agent}.project_id AND ${activeChatProductSql('product_owner',product)})`;
}
export function projectProductSql(project:string,product:ProductScope):string {
  const owned=`EXISTS(SELECT 1 FROM conversations product_chat WHERE product_chat.project_id=${project} AND ${activeChatProductSql('product_chat',product)})`;
  const removed=`EXISTS(SELECT 1 FROM conversation_deletion_receipts removed_chat WHERE removed_chat.project_id=${project} AND removed_chat.canonical_deletion_completed=1 AND ${chatProductSql('removed_chat',product)})`;
  const history=`EXISTS(SELECT 1 FROM conversations product_chat WHERE product_chat.project_id=${project}) OR EXISTS(SELECT 1 FROM conversation_deletion_receipts removed_chat WHERE removed_chat.project_id=${project})`;
  return product==='branches'?`((${owned}) OR (${removed}))`:`((${owned}) OR (${removed}) OR NOT (${history}))`;
}
