import {activeAgentOwnerSql,activeChatOwnerSql,type AgentStore} from '@ponderosa/agents';

/** Current canonical Chat ownership, including creation/deletion and inactive
 * installation fences shared by the product's bounded collection queries. */
export function activeChatResourceOwner(store:Pick<AgentStore,'sqlite'>,kind:'conversation'|'chat'|'agent',id:string):{branchId:string|null;executionId:string|null;projectId:string}|undefined {
  const row=kind==='agent'
    ?store.sqlite.prepare(`SELECT c.branch_id,c.branch_execution_id,c.project_id FROM agents a
      JOIN conversations c ON c.id=a.conversation_id AND c.project_id=a.project_id
      WHERE a.id=? AND ${activeAgentOwnerSql('a')} AND ${activeChatOwnerSql('c')}`).get(id)
    :store.sqlite.prepare(`SELECT c.branch_id,c.branch_execution_id,c.project_id FROM conversations c WHERE c.id=? AND ${activeChatOwnerSql('c')}`).get(id);
  if(!row)return undefined;
  const owner=row as {branch_id:string|null;branch_execution_id:string|null;project_id:string};
  return {branchId:owner.branch_id,executionId:owner.branch_execution_id,projectId:owner.project_id};
}
