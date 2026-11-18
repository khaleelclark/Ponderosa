/** A resource capture may contain several complete organizations, never partial edges. */
export function assertCheckpointMembership(
  chatId:string,
  selectedIds:readonly string[],
  actual:readonly {id:string;conversationId:string;managerAgentId?:string|null}[],
):void {
  const selected=new Set(selectedIds),byId=new Map(actual.map(agent=>[agent.id,agent]));
  if(!selected.size||selected.size!==selectedIds.length)throw new Error('Checkpoint source membership must be nonempty and unique');
  for(const id of selected){
    const agent=byId.get(id);
    if(!agent||agent.conversationId!==chatId)throw new Error('Checkpoint source member missing or moved');
    if(agent.managerAgentId&&!selected.has(agent.managerAgentId))throw new Error('Checkpoint membership omits an external manager');
  }
  for(const agent of actual){
    if(agent.managerAgentId&&selected.has(agent.managerAgentId)&&!selected.has(agent.id))throw new Error('Checkpoint membership omits a live descendant');
  }
}
