import {hostUpdateFact,verifyHostProvenance} from './branch-host-provenance.js';
import type {BranchDefinition} from '@ponderosa/core';
import type {Selected} from './branch-script-continuation.js';
import {verifyBranchHostCut,type BranchHostCut} from './branch-host-cut.js';
import {validateHistoricalRequest} from './coordination-v3-cut-restoration-authority.js';
import {branchText} from './branch-definition.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';

/** Evidence-only opt-in for the dedicated issued-resource codec, never ordinary rewind. */
export function issuedResourceFrontierSupported(selected:Selected,definition:BranchDefinition,cut?:BranchHostCut,group=false,ownerTree=false,generationOne=false):boolean {
 try{
  if(group){
   const resources=selected.resources!,count=resources.length,chats=new Set(resources.map(r=>r.chat_id));
   if(count<2||count>32||!cut||!verifyBranchHostCut(cut,selected.execution![0]!.id)||!cut.coverage.complete
    ||chats.size!==count||chats.has(null)||chats.has(undefined)||new Set(resources.map(r=>r.step_execution_id)).size!==count
    ||cut.resources.length!==count||cut.resources.some(x=>!resources.some(r=>stableJson(r)===stableJson(x.row)))
    ||cut.requests.some(x=>!chats.has(x.row.conversation_id))||cut.joins.some(x=>!chats.has(x.row.conversation_id)))return false;
   const agentIds=cut.resourceMembers.map(x=>x.row.agent_id),steps=new Set(resources.map(r=>r.step_execution_id));
   if(new Set(agentIds).size!==agentIds.length||cut.resourceMembers.some(x=>!steps.has(x.row.step_execution_id))
    ||cut.resourceContexts.some(x=>!steps.has(x.row.step_execution_id)))return false;
   return selected.resources!.every(resource=>{
    const attempts=selected.attempts!.filter(a=>a.step_execution_id===resource.step_execution_id);
    const local={...cut,resources:cut.resources.filter(x=>x.row.step_execution_id===resource.step_execution_id),resourceMembers:cut.resourceMembers.filter(x=>x.row.step_execution_id===resource.step_execution_id),resourceContexts:cut.resourceContexts.filter(x=>x.row.step_execution_id===resource.step_execution_id),requests:cut.requests.filter(x=>x.row.conversation_id===resource.chat_id),joins:cut.joins.filter(x=>x.row.conversation_id===resource.chat_id)};
    const step=selected.steps!.find(s=>s.id===resource.step_execution_id);
    return issuedResourceFrontierSupported({...selected,resources:[resource],attempts},{...definition,steps:definition.steps.filter(s=>s.kind!=='agent'||s.id===step?.step_id)},local);
   });
  }
  const e=selected.execution?.[0],r=selected.resources?.[0],s=selected.steps?.find(s=>s.id===r?.step_execution_id),node=definition.steps.find(n=>n.id===s?.step_id);
  if(!e||!r||!s||!cut||!verifyBranchHostCut(cut,e.id)||!cut.coverage.complete||cut.bindingPin.requiredSecretRefs.length
   ||selected.resources?.length!==1||cut.resources.length!==1||stableJson(cut.resources[0]!.row)!==stableJson(r)
   ||!ownerTree&&(e.parent_execution_id||e.parent_attempt_id||e.call_depth)||node?.kind!=='agent'||node.target.kind!=='ephemeral_organization'
   ||definition.steps.filter(n=>n.kind==='agent').length!==1||!ownerTree&&definition.steps.some(n=>n.kind==='branch_call')
   ||r.execution_id!==e.id||r.template_ref!==node.target.templateRef||!['active','draining'].includes(r.state)||r.retry_draining||r.error
   ||!Number.isSafeInteger(r.generation)||r.generation!==(generationOne?1:0)||r.creation_key!==(generationOne?`branch-resource:${s.id}:1`:`branch-resource:${s.id}`)
   ||!['waiting','completed'].includes(s.state)||!r.chat_id||!r.root_agent_id
   ||r.requested_count!==definition.templates?.[r.template_ref]?.agents.length||r.requested_count>(definition.policy.maxEphemeralAgents??100))return false;
  const chat=JSON.parse(r.chat_operation_json),operation=JSON.parse(r.import_operation_json),ids=operation.result?.agentIds;
  if(chat.schema!=='branch-resource-operation.v1'||chat.phase!=='chat'||chat.state!=='completed'||chat.releaseRequired!==true||chat.generation!==r.generation||chat.result?.chatId!==r.chat_id
   ||operation.schema!=='branch-resource-operation.v1'||operation.phase!=='import'||operation.state!=='completed'||!operation.creationOperationId
   ||operation.result?.rootAgentId!==r.root_agent_id||!Array.isArray(ids)||ids.length!==r.requested_count||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id)||!ids.includes(r.root_agent_id))return false;
  if(stableJson(cut.resourceMembers.map(x=>x.row.agent_id).sort())!==stableJson([...ids].sort())
   ||cut.resourceMembers.some(x=>x.row.step_execution_id!==s.id||x.row.origin!=='template')||cut.resourceContexts.length!==1)return false;
  const context=cut.resourceContexts[0]!.row;
  if(context.step_execution_id!==s.id||context.generation!==r.generation||context.chat_id!==r.chat_id||stableJson(JSON.parse(context.agent_ids_json))!==stableJson(ids))return false;
  const release=cut.resourceReceipts.find(x=>x.row.command_key===`resource-release:${r.creation_key}:${chat.token}`)?.row;
  const creation=cut.resourceReceipts.find(x=>x.row.id===operation.creationOperationId)?.row;
  const members=cut.resourceReceipts.filter(x=>x.row.operation_id===operation.creationOperationId).map(x=>x.row).sort((a,b)=>a.position-b.position);
  if(!release||release.execution_id!==e.id||release.input_hash!==payloadHash({creationKey:r.creation_key,token:chat.token})||release.result_json!==stableJson({phase:'chat',token:chat.token,generation:r.generation})
   ||!creation||creation.kind!=='import'||creation.status!=='completed'||members.some((m,i)=>m.position!==i)||stableJson(members.map(m=>m.agent_id))!==stableJson(ids))return false;
  const imported=JSON.parse(creation.result_json);
  if(imported.rootAgentId!==r.root_agent_id||stableJson(imported.agentIds)!==stableJson(ids))return false;
  if(cut.artifactRefs.length||cut.resourceReceipts.some(x=>x.row.conversation_id)||cut.requests.some(x=>x.row.project_id!==creation.project_id||x.row.conversation_id!==r.chat_id||[x.row.requester_agent_id,x.row.recipient_agent_id].filter(Boolean).some(id=>!ids.includes(id))||x.row.superseded_by_request_id||x.row.state==='outcome_unknown')
   ||cut.joins.some(x=>x.row.project_id!==creation.project_id||x.row.conversation_id!==r.chat_id||!ids.includes(x.row.owner_agent_id))||cut.suspensions.some(x=>x.row.dependency_kind!=='join'))return false;
  const issued=selected.attempts!.filter(a=>a.request_id);
  return issued.length===1&&issued[0]!.step_execution_id===s.id;
 }catch{return false;}
}

/** Shared ownership boundary; graph replay must separately prove each binding and audit event. */
export function issuedRequestFrontierSupported(selected:Selected,definition:BranchDefinition,hostCut?:BranchHostCut,issuedResource=false,group=false,ownerTree=false,generationOne=false):boolean {
 try {
  const issued=selected.attempts?.filter(a=>a.request_id)??[];
  if(issued.length){
    if(!hostCut||!verifyBranchHostCut(hostCut,selected.execution![0]!.id)||!hostCut.coverage.complete
      ||hostCut.roots.length!==issued.length||new Set(hostCut.roots.map(root=>root.attemptId)).size!==issued.length
      ||new Set(issued.map(a=>a.request_id)).size!==issued.length||(issuedResource?!issuedResourceFrontierSupported(selected,definition,hostCut,group,ownerTree,generationOne):hostCut.resources.length))return false;
    verifyHostProvenance(hostCut);
    for(const a of issued){
      const s=selected.steps!.find(s=>s.id===a.step_execution_id),node=definition.steps.find(n=>n.id===s?.step_id),r=hostCut.requests.find(({row})=>row.id===a.request_id)?.row;
      if(node?.kind!=='agent'||!(issuedResource?node.target.kind==='ephemeral_organization':'ref' in node.target)||!r||r.id!==`branch:${a.id}`&&!hostCut.provenance?.restorations.some(e=>Object.values(JSON.parse(e.row.receipt.receipt_json).requestMap).includes(r.id))||r.requester_agent_id!==null||r.communication_event_id!==null
        ||!hostCut.roots.some(root=>root.attemptId===a.id&&root.requestId===r.id&&!root.recoveryOfRequestId)
        ||!['open','in_progress','awaiting_answer','waiting_dependency','completed'].includes(r.state)||a.fence!==0
        ||!['waiting','completed'].includes(a.state)||a.state==='completed'&&r.state!=='completed'||r.state==='completed'&&node.requireUserCommunication)return false;
      validateHistoricalRequest(r,hostCut.updates.filter(({row})=>row.request_id===r.id).map(({row})=>row).sort((a,b)=>a.resulting_version-b.resulting_version),hostCut);
    }
  }
  return true;
 }catch{return false;}
}

/** Only an exact selected terminal version can supply a historical Step result. */
export function retainedAgentResult(cut:BranchHostCut|undefined,requestId:string):{failed:false;output?:string}|undefined {
 const request=cut?.requests.find(({row})=>row.id===requestId)?.row;
 const update=cut?.updates.find(({row})=>row.request_id===requestId&&row.resulting_version===request?.version)?.row;
 if(request?.state!=='completed'||!update||update.resulting_state!=='completed')return;
 const payload=hostUpdateFact(cut!,update).payload as Record<string,any>,output=typeof payload?.text==='string'?branchText(payload.text):undefined;
 return {failed:false,...(output!==undefined?{output}:{})};
}
