import {activeChatResourceOwner} from "./branch-resource-owner.js";
import type {AgentStore} from '@ponderosa/agents';

/** Read-only correlation with the existing committed human creation ledger.
 * Neither a matching title nor an allocated-but-uncommitted Agent is evidence. */
export function creationMessageKeys(store:Pick<AgentStore,"sqlite"|"getCommunicationEvent">,projectId:string,eventIds:readonly string[]):Map<string,string> {
  const ids=[...new Set(eventIds.filter(id=>id.startsWith('agent-opening:')))];
  const result=new Map<string,string>();
  if(!ids.length)return result;
  const rows=store.sqlite.prepare(`SELECT communication_event_id eventId,idempotency_key requestKey,result_json result,conversation_id conversationId,product_scope productScope
    FROM agent_creation_operations WHERE project_id=? AND actor_scope='user:local-operator' AND kind='human'
    AND status IN ('canonical_committed','completed') AND communication_event_id IN (${ids.map(()=>'?').join(',')})`).all(projectId,...ids) as Array<{eventId:string;requestKey:string;result:string|null;conversationId:string|null;productScope:string|null}>;
  const counts=new Map<string,number>();for(const row of rows)counts.set(row.eventId,(counts.get(row.eventId)??0)+1);
  for(const row of rows){
    if(counts.get(row.eventId)!==1||!row.result)continue;
    let agent: {id?:string;projectId?:string;conversationId?:string};try{agent=JSON.parse(row.result);if(!agent||typeof agent!=="object"||Array.isArray(agent))continue;}catch{continue;}
    if([agent.id,agent.projectId,agent.conversationId].some(value=>typeof value!=="string"||!value))continue;
    const communication=store.getCommunicationEvent(projectId,row.eventId);
    if((row.conversationId===null)!==(row.productScope===null))continue;
    const owner=agent.conversationId?activeChatResourceOwner(store,"conversation",agent.conversationId):undefined;
    // Human creation currently leaves ledger owner columns null. The committed
    // result AND authored opening must agree on the exact canonical Chat;
    // any explicit ledger owner/product must additionally agree. No replay
    // authority changes or heuristic matching are needed for this read hint.
    if(!owner||owner.projectId!==projectId||row.conversationId!==null&&row.conversationId!==agent.conversationId||row.productScope!==null&&row.productScope!==(owner.branchId?"branches":"dev"))continue;
    if(communication?.sender.kind==='user'&&communication.sender.userId==='local-operator'&&agent.projectId===projectId&&agent.id&&row.eventId===`agent-opening:${agent.id}`&&agent.conversationId===communication.conversationId)result.set(row.eventId,row.requestKey);
  }
  return result;
}
