import {branchScriptFailureSummary} from '@ponderosa/core';
import {createHash} from 'node:crypto';
import type {BranchConfiguration,BranchDefinition} from '@ponderosa/core';
import {branchText} from './branch-definition.js';
import {extractBranchMapItems} from './branch-map-items.js';
import {interpolateBranchText} from './branch-parameters.js';
import {stableJson,payloadHash} from './coordination-v3-canonical-json.js';
import {branchContinuationIds,remapBranchFrontier} from './branch-continuation-remap.js';
import type {BranchHostCut} from './branch-host-cut.js';
import {issuedRequestFrontierSupported,retainedAgentResult} from './branch-issued-continuation.js';
import type {Selected,ScriptOwnerContext} from './branch-script-continuation.js';
type Row=Record<string,any>;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const keys=['paths','steps','attempts','sealedResults','forks','joins','maps','items','loops','bundles','gates'] as const;
export const hasParallelControls=(d:BranchDefinition)=>d.controls.some(c=>c.kind==='fork'||c.kind==='map');
/** Only graph families with an exact host replay codec are admitted. */
export function parallelDefinitionSupported(d:BranchDefinition,calls=false,issuedResource=false):boolean {
 return hasParallelControls(d)&&d.policy.failure.action==='stop'
  &&d.steps.every(s=>(s.kind==='script'&&s.runtime==='node'||s.kind==='agent'&&('ref' in s.target||issuedResource&&s.target.kind==='ephemeral_organization')||s.kind==='human_gate'||calls&&s.kind==='branch_call')&&(!s.failure||s.failure.action==='stop'||s.failure.action==='retry'&&(s.kind==='script'||issuedResource&&s.kind==='agent'&&s.target.kind==='ephemeral_organization'&&s.failure.freshContext===true)))
  &&d.controls.every(c=>['fork','map','join','condition','route'].includes(c.kind))
  &&!Object.values(d.parameters??{}).some(p=>p.type==='secret');
}
export function parallelFrontierSupported(s:Selected,d:BranchDefinition,context?:ScriptOwnerContext,hostCut?:BranchHostCut):boolean {
 try{
  if(!issuedRequestFrontierSupported(s,d,hostCut,context?.issuedResource,context?.issuedGroup,false,context?.resourceGeneration))return false;
  const expected=['execution',...keys,'actions','resources'];
  if(!parallelDefinitionSupported(d,!!context,context?.issuedResource)||stableJson(Object.keys(s).sort())!==stableJson(expected.sort())||expected.some(k=>!Array.isArray(s[k])))return false;
  const e=s.execution![0],terminal=context?.terminal===true;
  if(s.execution!.length!==1||!e||!(terminal?e.state===(context?.terminalState??'completed'):['running','waiting'].includes(e.state))||e.admission_source!==(context?.parent?'call':'manual')||!context&&(e.parent_execution_id||e.parent_attempt_id||e.call_depth)||e.cancel_requested||e.budget_exhausted||e.recovery_traversals||!terminal&&e.output_text!==null||e.merged_into!==null||e.requested_outcome!=='canceled')return false;
  if(s.actions!.length||(!context?.issuedResource&&s.resources!.length)||context?.resourceCleanup)return false;
  branchContinuationIds(s);
  if(s.paths!.filter(p=>p.parent_path_id===null).length!==1||!s.paths!.length)return false;
  if(s.paths!.some(p=>p.execution_id!==e.id||p.handling_limit||!['active','waiting','joining','arrived','completed','canceled','failed','skipped'].includes(p.state)||!Number.isSafeInteger(p.traversals)||p.traversals<0))return false;
  if(!terminal&&(!s.paths!.some(p=>['active','waiting','joining'].includes(p.state))||e.state!==(s.paths!.some(p=>p.state==='active')?'running':'waiting')))return false;
  if(e.traversals!==s.paths!.reduce((n,p)=>n+p.traversals,0)+(context?.descendantTraversals??0))return false;
  for(const step of s.steps!){
   const a=s.attempts!.filter(a=>a.step_execution_id===step.id).sort((a,b)=>a.number-b.number),r=s.sealedResults!.filter(r=>r.step_execution_id===step.id);
   const node=d.steps.find(node=>node.id===step.step_id),policy=node?.failure??d.policy.failure;
   if(step.execution_id!==e.id||!d.steps.some(node=>node.id===step.step_id)||!['prepared','waiting','completed','failed','canceled'].includes(step.state)||!a.length)return false;
   const attempt=a.at(-1)!;
   if(a.length>1&&(node?.kind!=='script'||policy.action!=='retry'||a.length>policy.maxAttempts))return false;
   for(const [index,prior] of a.entries()){
    if(Object.keys(prior).some(key=>!['id','step_execution_id','number','state','request_id','fence','input_hash','result_json','available_at','purpose','recovery_of_request_id','cancel_requested','runtime_outcome_json','error','created_at','updated_at'].includes(key)))return false;
    if(prior.number!==index+1+(context?.issuedResource&&step.id===s.resources![0]?.step_execution_id?(context.resourceGeneration??0):0)||prior.purpose!=='step'||prior.error||prior.request_id&&(node?.kind!=='agent'||prior!==attempt)||prior.recovery_of_request_id||prior.runtime_outcome_json||prior.input_hash!==hash(step.input_text)||!Number.isSafeInteger(prior.fence)||prior.fence<0)return false;
    if(prior!==attempt&&(prior.state!=='failed'||prior.cancel_requested||!prior.result_json||JSON.parse(prior.result_json).failed!==true))return false;
   }
   if(d.steps.find(node=>node.id===step.step_id)?.kind==='agent'&&(!attempt.request_id&&step.state!=='prepared'||attempt.fence!==0))return false;
   if(Object.keys(attempt).some(key=>!['id','step_execution_id','number','state','request_id','fence','input_hash','result_json','available_at','purpose','recovery_of_request_id','cancel_requested','runtime_outcome_json','error','created_at','updated_at'].includes(key)))return false;
   if(attempt.state!==step.state||attempt.purpose!=='step'||attempt.error||attempt.request_id&&node?.kind!=='agent'||attempt.recovery_of_request_id||attempt.runtime_outcome_json||attempt.cancel_requested&&step.state!=='canceled'||attempt.input_hash!==hash(step.input_text)||attempt.result_json!==step.result_json||!Number.isSafeInteger(attempt.fence)||attempt.fence<0)return false;
   if(step.state==='prepared'||step.state==='waiting'||step.state==='canceled'){
    if(step.state!=='canceled'&&attempt.fence||step.result_json!==null||r.length||!s.paths!.some(p=>p.id===step.path_id&&p.step_execution_id===step.id&&(p.state===(step.state==='prepared'||attempt.request_id?'active':step.state)||step.state==='prepared'&&a.length>1&&policy.action==='retry'&&policy.delayMs>0&&p.state==='waiting')))return false;
    if(step.state==='waiting'&&!attempt.request_id&&!s.gates!.some(g=>g.step_execution_id===step.id&&g.state==='waiting')&&!context?.children[attempt.id])return false;
   }else{
    const result=JSON.parse(step.result_json);
    if(result.failed!==(step.state==='failed')||Object.keys(result).some(k=>!['failed','output'].includes(k))||result.output!==undefined&&branchText(result.output)!==result.output||stableJson(result)!==step.result_json||r.length!==1)return false;
    if(r[0]!.execution_id!==e.id||r[0]!.path_id!==step.path_id||r[0]!.terminal_attempt_id!==attempt.id||r[0]!.result_json!==step.result_json||r[0]!.content_hash!==hash(step.result_json))return false;
   }
  }
  if(s.attempts!.some(a=>!s.steps!.some(step=>step.id===a.step_execution_id))||s.sealedResults!.length!==s.steps!.filter(row=>row.state==='completed'||row.state==='failed').length)return false;
  if(e.loop_iterations!==s.loops!.reduce((n,row)=>n+row.iterations,0)+(context?.descendantLoops??0))return false;
  for(const gate of s.gates!){const step=s.steps!.find(row=>row.id===gate.step_execution_id),node=d.steps.find(row=>row.id===step?.step_id);if(!step||node?.kind!=='human_gate'||!['waiting','resolved','canceled'].includes(gate.state))return false;}
  return true;
 }catch{return false;}
}

/** Replay graph transitions, not scheduler timing. Unknown observations never supply authority. */
export function replayParallelCut(s:Selected,d:BranchDefinition,c:BranchConfiguration,events:Row[],checkpoint?:Row,seed?:{selected:Selected;idMap:Record<string,string>;requestMap?:Record<string,string>},context?:ScriptOwnerContext,hostCut?:BranchHostCut):boolean {
 try{
  if(!parallelFrontierSupported(context?.resourceRetry?.selected??s,d,context?.resourceRetry?{...context,resourceRetry:undefined,resourceGeneration:context.resourceRetry.generation}:context,context?.resourceRetry?.currentHost??hostCut))return false;
  const e=s.execution![0]!,root=s.paths!.find(p=>p.parent_path_id===null)!;
  const m:Selected=Object.fromEntries(keys.map(k=>[k,[]]));
  function require(ok:unknown):asserts ok {if(!ok)throw Error('Parallel audit differs from selected frontier');}
  const find=(key:string,id:string)=>{const r=m[key]!.find(r=>r.id===id);require(r);return r!;};
  const final=(key:string,id:string)=>{const r=s[key]!.find(r=>r.id===id);require(r);return r!;};
  const text=(v:string)=>interpolateBranchText(v,d,c);
  const boundRequests=new Set<string>();
  const pendingArrivals=new Set<string>(),sealedMaps=new Set<string>(),completedItems=new Set<string>(),authorized=new Set<string>(),exited=new Set<string>();
  const retry=context?.resourceRetry;let retryIndex=0,retryScheduled=false;
  const activeResources=()=>retry&&retryIndex<retry.generations.length?[retry.generations[retryIndex]!.oldResource]:s.resources!;
  const reservedResources=new Set<string>(),operationsByResource=new Map<string,Map<string,Row>>();
  let started=false,accepted=false,interruption:Row|undefined,invocation:Row|undefined,gateClosing:Row|undefined,terminalObserved=context?.restoredTerminal===true;
  const pendingLoops:{pathId:string;edgeId:string;iteration:number}[]=[],pendingOutcomes=new Map<string,string>(),gateDecisions=new Map<string,string>(),admitted=new Set<string>(),completedChildren=new Set<string>(),cancelledItems=new Set<string>(),cancelledGates=new Set<string>();
  if(seed){
   const old=seed.selected,source=old.execution![0]!.id;
   const mapped=remapBranchFrontier(old,Object.fromEntries(branchContinuationIds(old).map(id=>[id,seed.idMap[id]!])),source,e.id,seed.requestMap);
   for(const k of keys)m[k]=mapped[k]!;
   for(const a of m.attempts!)if(a.request_id)boundRequests.add(a.id);
   for(const map of m.maps!)sealedMaps.add(map.id);
   for(const item of m.items!)if(['arrived','canceled'].includes(find('paths',item.path_id).state))completedItems.add(item.id);
   for(const gate of m.gates!)if(gate.state==='resolved')gateDecisions.set(gate.id,JSON.parse(gate.response_json).decision);
   for(const a of m.attempts!)if(context?.children[a.id]){admitted.add(a.id);if(context.children[a.id]!.completed)completedChildren.add(a.id);}
  }else m.paths!.push({id:root.id,execution_id:e.id,parent_path_id:null,fork_invocation_id:null,edge_id:null,state:'active',node_id:d.entry,step_execution_id:null,input_text:e.input_text,result_json:null,traversals:0,handling_limit:0,last_result_id:null});
  const move=(p:Row,edge:BranchDefinition['edges'][number]|undefined,output:string,result:Row)=>{
   if(edge?.loop){const iteration=1+m.loops!.filter(row=>row.edge_id===edge.id).reduce((n,row)=>n+row.iterations,0);let row=m.loops!.find(row=>row.path_id===p.id&&row.edge_id===edge.id);if(!row){row={execution_id:e.id,path_id:p.id,edge_id:edge.id,iterations:0};m.loops!.push(row);}row.iterations++;pendingLoops.push({pathId:p.id,edgeId:edge.id,iteration});}
   if(edge){p.node_id=edge.to;p.input_text=edge.input?.kind==='literal'?text(edge.input.text):output;p.step_execution_id=null;p.state='active';}
   else if(p.fork_invocation_id){p.state='arrived';p.result_json=stableJson({failed:result.failed,output});pendingArrivals.add(p.id);pendingOutcomes.set(p.id,result.failed?'failed':'completed');}
   else {p.state=result.failed?'failed':'completed';p.result_json=stableJson(result);}
  };
  const fork=(id:string,p:Row,node:Row,isMap:boolean)=>{
   require(!m.forks!.some(f=>f.id===id));
   const f={id,execution_id:e.id,parent_path_id:p.id,fork_id:node.id,join_id:node.joinId,state:'open',selected_paths_json:null,result_json:null};m.forks!.push(f);
   p.traversals++;p.state='joining';p.node_id=node.joinId;if(isMap)p.step_execution_id=null;
   return f;
  };
  const updateMaps=()=>{for(const map of m.maps!)if(m.items!.filter(item=>item.map_invocation_id===map.id).every(item=>['arrived','canceled','failed','completed','skipped'].includes(find('paths',item.path_id).state)))map.state='completed';};
  const cancel=(id:string)=>{
   const owned=new Set([id]);for(let count=-1;count!==owned.size;){count=owned.size;for(const p of m.paths!)if(owned.has(p.parent_path_id))owned.add(p.id);}
   for(const p of m.paths!.filter(p=>owned.has(p.id)&&['active','waiting','joining'].includes(p.state))){
    let pending=false;
    for(const step of m.steps!.filter(step=>step.path_id===p.id&&!['completed','failed','canceled'].includes(step.state))){
     const a=m.attempts!.filter(a=>a.step_execution_id===step.id).sort((a,b)=>b.number-a.number)[0]!,node=d.steps.find(node=>node.id===step.step_id);
     require(!context?.children[a.id]&&!a.request_id);
     const launched=node?.kind==='script'&&a.state==='running'&&authorized.has(a.id);
     require(launched||['prepared','waiting'].includes(a.state)&&!authorized.has(a.id));
     a.fence++;a.cancel_requested=1;a.state=step.state=launched?'outcome_unknown':'canceled';pending||=launched;
    }
    p.state=pending?'canceling':'canceled';const item=m.items!.find(item=>item.path_id===p.id);if(item)cancelledItems.add(item.id);
    for(const g of m.gates!.filter(g=>g.state==='waiting'&&m.steps!.some(step=>step.id===g.step_execution_id&&step.path_id===p.id))){g.state='canceled';g.revision++;cancelledGates.add(g.id);}
   }updateMaps();
  };
  for(const event of events){
   const v=JSON.parse(event.evidence_json),key=event.transition_key;
   require(!pendingLoops.length||event.kind==='loop_traversed'||event.kind==='map_item_canceled'&&cancelledItems.has(v.itemId)||event.kind==='gate_canceled'&&cancelledGates.has(v.gateId));
   switch(event.kind){
    case 'trigger_accepted':require(!accepted&&!started&&v.versionId===e.version_id&&v.bindingRevisionId===e.binding_revision_id&&v.inputHash===e.input_hash);accepted=true;break;
    case 'workflow_started':require(accepted&&!started);started=true;break;
    case 'restored_prefix':case 'historical_rewind':require(seed&&accepted&&!started);break;
    case 'tree_restored_prefix':case 'tree_historical_rewind':require(context&&seed&&accepted&&!started);if(event.kind==='tree_historical_rewind'&&context.restoredTerminal)started=true;break;
    case 'step_prepared':{
     require(started&&!interruption&&!m.steps!.some(row=>row.id===v.stepExecutionId));
     const srow=final('steps',v.stepExecutionId),p=find('paths',srow.path_id),a=s.attempts!.find(a=>a.step_execution_id===srow.id&&a.number===1)!;
     require(p.state==='active'&&!p.step_execution_id&&p.node_id===v.stepId&&srow.step_id===v.stepId&&srow.input_text===p.input_text&&srow.invocation===1+m.steps!.filter(row=>row.path_id===p.id&&row.step_id===srow.step_id).reduce((n,row)=>Math.max(n,row.invocation),0));
     m.steps!.push({...srow,state:'prepared',result_json:null});m.attempts!.push({...a,state:'prepared',request_id:null,fence:0,cancel_requested:0,result_json:null});p.step_execution_id=srow.id;p.traversals++;break;
    }
    case 'resource_reserved':{
     const resource=activeResources().find(r=>key===`resource:${r.step_execution_id}`);
     require(context?.issuedResource&&resource&&!reservedResources.has(resource.step_execution_id)&&started&&!interruption);
     const step=find('steps',resource.step_execution_id),p=find('paths',step.path_id);
     require(step.state==='prepared'&&p.step_execution_id===step.id&&v.templateRef===resource.template_ref&&v.count===resource.requested_count&&key===`resource:${step.id}`);
     reservedResources.add(resource.step_execution_id);operationsByResource.set(resource.step_execution_id,new Map());break;
    }
    case 'resource_operation':{
     const resource=activeResources().find(r=>key.startsWith(`resource-operation:${r.creation_key}:${v.phase}:`));
     require(context?.issuedResource&&resource&&reservedResources.has(resource.step_execution_id)&&started&&!interruption);
     const resourceOperations=operationsByResource.get(resource.step_execution_id)!;
     const step=find('steps',resource.step_execution_id);
     require(step.state==='prepared'&&v.schema==='branch-resource-operation.v1'&&['chat','import'].includes(v.phase)&&typeof v.token==='string'
      &&key.startsWith(`resource-operation:${resource.creation_key}:${v.phase}:${v.token}:${v.state}:`)&&['running','completed'].includes(v.state));
     const previous=resourceOperations.get(v.phase);
     require(!previous?v.state==='running':previous.state==='running'&&previous.token===v.token);
     require(v.phase!=='import'||resourceOperations.get('chat')?.state==='completed');
     require(v.phase!=='chat'||v.releaseRequired===true&&v.generation===resource.generation);
     require(v.state!=='completed'||stableJson(v)===resource[`${v.phase}_operation_json`]);
     require(v.phase!=='import'||!previous?.creationOperationId||v.creationOperationId===previous.creationOperationId);
     resourceOperations.set(v.phase,v);break;
    }
    case 'resource_created':{
     const resource=activeResources().find(r=>key===`resource-bound:${r.step_execution_id}:${r.generation}`);
     require(context?.issuedResource&&resource&&reservedResources.has(resource.step_execution_id)&&started&&!interruption&&operationsByResource.get(resource.step_execution_id)?.get('import')?.state==='completed');
     const step=find('steps',resource.step_execution_id),a=m.attempts!.filter(a=>a.step_execution_id===step.id).sort((a,b)=>b.number-a.number)[0]!;
     const captured=final('attempts',a.id),operation=JSON.parse(resource.import_operation_json),p=find('paths',step.path_id);
     require(a.state==='prepared'&&step.state==='prepared'&&p.step_execution_id===step.id&&!boundRequests.has(a.id)
      &&key===`resource-bound:${step.id}:${resource.generation}`&&captured.request_id
      &&stableJson(v)===stableJson({...operation.result,requestId:captured.request_id,creationKey:resource.creation_key})
      &&hostCut?.roots.some(root=>root.attemptId===a.id&&root.requestId===captured.request_id));
     boundRequests.add(a.id);a.request_id=captured.request_id;a.state=step.state='waiting';p.state='active';break;
    }
    case 'request_bound':{
     const a=find('attempts',v.attemptId),captured=final('attempts',a.id),step=find('steps',a.step_execution_id),p=find('paths',step.path_id),node=d.steps.find(n=>n.id===step.step_id);
     require(started&&!interruption&&node?.kind==='agent'&&a.state==='prepared'&&step.state==='prepared'&&p.state==='active'&&p.step_execution_id===step.id
      &&key===`request:${a.id}`&&!boundRequests.has(a.id)&&captured.request_id===v.requestId&&hostCut?.roots.some(root=>root.attemptId===a.id&&root.requestId===v.requestId));
     boundRequests.add(a.id);a.request_id=v.requestId;a.state=step.state='waiting';break;
    }
    case 'script_leased':case 'script_authorized':case 'script_process_exit':case 'script_cleanup_observed':{
     const id=event.kind==='script_process_exit'?key.slice('process-exit:'.length).replace(/:[0-9]+$/u,''):v.attemptId;
     const a=find('attempts',id),step=find('steps',a.step_execution_id),node=d.steps.find(n=>n.id===step.step_id);
     require(node?.kind==='script');
     if(event.kind==='script_leased'){
      require(!interruption&&a.state==='prepared'&&(!a.available_at||event.created_at>=a.available_at)&&key===`leased:${a.id}:${v.fence}`&&v.fence===a.fence+1&&v.sourceHash===hash(node.source));const match=/^branch-result-bundle:([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(step.input_text),bundle=match&&match[1]===e.id?m.bundles!.find(row=>row.id===match[2]):undefined;require(v.inputBundleId===bundle?.id&&v.inputBundleHash===bundle?.content_hash);a.fence=v.fence;a.state='leased';step.state='leased';find('paths',step.path_id).state='active';
     }else if(event.kind==='script_authorized'){
      require(!interruption&&a.state==='leased'&&key===`launched:${a.id}:${a.fence}`&&!authorized.has(a.id));authorized.add(a.id);a.state='running';step.state='running';
     }else if(event.kind==='script_process_exit'){
      const captured=final('attempts',a.id),canceled=captured.state==='canceled'&&captured.cancel_requested===1;
      const fence=a.cancel_requested?a.fence-1:a.fence;
      require(authorized.has(a.id)&&key===`process-exit:${a.id}:${fence}`&&!exited.has(a.id)&&(Number.isInteger(v.code)||v.code===null)&&(v.error===undefined||typeof v.error==='string')&&typeof v.stdout==='string'&&v.outputHash===hash(v.stdout));
      if(!canceled){const summary=branchScriptFailureSummary(v.code,v.error),result=JSON.parse(captured.result_json);require(result.failed===(summary!==undefined)&&result.output===(summary??v.stdout));}
      else require(captured.result_json===null);
      exited.add(a.id);
     }else {
      require(exited.has(a.id)&&key===`cleaned:${a.id}:${a.fence}`);
      if(a.cancel_requested){
       const p=find('paths',step.path_id);require(a.state==='outcome_unknown'&&step.state==='outcome_unknown'&&p.state==='canceling');
       a.state=step.state=p.state='canceled';const item=m.items!.find(item=>item.path_id===p.id);if(item)completedItems.add(item.id);updateMaps();
      }
     }
     break;
    }
    case 'step_settled':{
     const a=find('attempts',v.attemptId),step=find('steps',a.step_execution_id);
     const node=d.steps.find(row=>row.id===step.step_id);
     require(key===`settled:${a.id}`&&stableJson(v.result)===final('attempts',a.id).result_json);
     if(node?.kind==='script')require(a.state==='running'&&authorized.has(a.id)&&exited.has(a.id));
     else if(node?.kind==='agent'){const prior=retry?.generations[retryIndex]?.prior,result=prior?.id===a.id?JSON.parse(prior.result_json):retainedAgentResult(hostCut,a.request_id);require(a.state==='waiting'&&boundRequests.has(a.id)&&!node.requireUserCommunication&&result&&stableJson(v.result)===stableJson(result));}
     else if(node?.kind==='branch_call')require(a.state==='waiting'&&completedChildren.has(a.id)&&stableJson(v.result)===stableJson({failed:context!.children[a.id]!.failed===true,...(context!.children[a.id]!.output!==null?{output:context!.children[a.id]!.output}:{})}));
     else {require(a.state==='waiting'&&node?.kind==='human_gate');const gate=m.gates!.find(row=>row.step_execution_id===step.id);require(gate&&gateDecisions.has(gate.id));const response=JSON.parse(gate.response_json),output=response.output??response.choice??gate.proposal_text,routed=gateDecisions.get(gate.id)==='approve'||d.edges.some(edge=>edge.from===node.id&&edge.on==='rejected');require(stableJson(v.result)===stableJson({failed:false,output:routed?output:`Approval rejected at ${node.label||node.id}.`}));}
     a.state=step.state=v.result.failed?'failed':'completed';a.result_json=step.result_json=stableJson(v.result);break;
    }
    case 'retry_scheduled':{
     require(started&&!interruption&&key===`retry:${v.attemptId}`&&!m.attempts!.some(a=>a.id===v.attemptId));
     const next=final('attempts',v.attemptId),step=find('steps',next.step_execution_id),p=find('paths',step.path_id),node=d.steps.find(node=>node.id===step.step_id),policy=node?.failure??d.policy.failure;
     const prior=m.attempts!.filter(a=>a.step_execution_id===step.id).sort((a,b)=>b.number-a.number)[0];
     const resourceRetry=retry?.generations[retryIndex];
     require((node?.kind==='script'&&exited.has(prior?.id)||node?.kind==='agent'&&resourceRetry&&resourceRetry.prior.id===prior?.id&&resourceRetry.next.id===next.id&&policy.action==='retry'&&policy.freshContext===true&&!retryScheduled)&&policy.action==='retry'&&prior&&prior.state==='failed'&&step.state==='failed'&&p.step_execution_id===step.id&&!m.sealedResults!.some(r=>r.step_execution_id===step.id));
     require(next.number===prior.number+1&&next.number<=policy.maxAttempts&&v.delayMs===policy.delayMs&&!d.edges.some(edge=>edge.from===node.id&&edge.on==='failure'));
     require(next.created_at===event.created_at&&next.available_at===new Date(Date.parse(event.created_at)+policy.delayMs).toISOString());
     m.attempts!.push({...next,state:'prepared',request_id:null,fence:0,cancel_requested:0,result_json:null});step.state='prepared';step.result_json=null;p.state=policy.delayMs?'waiting':'active';if(node?.kind==='agent')retryScheduled=true;break;
    }
    case 'resource_retired':{
     const generation=retry?.generations[retryIndex];
     require(generation&&retryScheduled&&v.stepExecutionId===generation.oldResource.step_execution_id&&key===`resource-retired:${v.stepExecutionId}:${retryIndex}`&&stableJson(events.filter(a=>a.id<event.id))===stableJson(generation.retirementAudit));
     const step=find('steps',v.stepExecutionId);require(step.state==='prepared');
     retryIndex++;retryScheduled=false;operationsByResource.set(step.id,new Map());break;
    }
    case 'result_sealed':{
     const step=find('steps',v.stepExecutionId),p=find('paths',step.path_id),r=final('sealedResults',v.resultId);
     require(['completed','failed'].includes(step.state)&&p.step_execution_id===step.id&&!m.sealedResults!.some(row=>row.step_execution_id===step.id)&&r.step_execution_id===step.id&&v.terminalAttemptId===r.terminal_attempt_id&&v.contentHash===r.content_hash&&key===`sealed:${r.id}`);
     const node=d.steps.find(node=>node.id===step.step_id),policy=node?.failure??d.policy.failure,a=find('attempts',r.terminal_attempt_id);
     require(a.step_execution_id===step.id&&a.result_json===step.result_json);
     if(step.state==='failed'&&node?.kind==='script'&&policy.action==='retry'&&!d.edges.some(edge=>edge.from===step.step_id&&edge.on==='failure'))require(a.number>=policy.maxAttempts);
     m.sealedResults!.push({...r});p.last_result_id=r.id;
     const result=JSON.parse(step.result_json),gate=m.gates!.find(row=>row.step_execution_id===step.id),on=gate?(gateDecisions.get(gate.id)==='approve'?'approved':'rejected'):result.failed?'failure':'success';const edge=d.edges.find(edge=>edge.from===step.step_id&&edge.on===on);move(p,edge,result.output??'',result);if(gate&&on==='rejected'&&!edge){if(pendingArrivals.has(p.id))pendingOutcomes.set(p.id,'unselected');else p.state='skipped';}break;
    }
    case 'fork_started':{
     require(started&&!interruption&&key===`fork:${v.forkInvocationId}`);const p=find('paths',v.pathId),node=d.controls.find(n=>n.id===p.node_id);
     require(p.state==='active'&&!p.step_execution_id&&node?.kind==='fork');fork(v.forkInvocationId,p,node,false);
     const children=s.paths!.filter(row=>row.fork_invocation_id===v.forkInvocationId),edges=d.edges.filter(edge=>edge.from===node.id);require(children.length===edges.length);
     for(const edge of edges){const child=children.find(row=>row.edge_id===edge.id);require(child&&!m.paths!.some(row=>row.id===child.id));m.paths!.push({id:child.id,execution_id:e.id,parent_path_id:p.id,fork_invocation_id:v.forkInvocationId,edge_id:edge.id,state:'active',node_id:edge.to,step_execution_id:null,input_text:edge.input?.kind==='literal'?text(edge.input.text):p.input_text,result_json:null,traversals:0,handling_limit:0,last_result_id:null});}break;
    }
    case 'map_admitted':{
     require(started&&!interruption&&key===`map-admitted:${v.mapInvocationId}`);const p=find('paths',v.pathId),node=d.controls.find(n=>n.id===p.node_id);
     require(p.state==='active'&&!p.step_execution_id&&node?.kind==='map'&&v.mapId===node.id&&v.sourceMode===node.source&&v.maxItems===node.maxItems&&v.maxConcurrentItems===node.maxConcurrentItems);
     const inputs=extractBranchMapItems(p.input_text,node.source,node.maxItems);require(inputs.length===v.itemCount);fork(v.mapInvocationId,p,node,true);
     const source=m.sealedResults!.find(r=>r.id===p.last_result_id),sourceId=source&&JSON.parse(source.result_json).output===p.input_text?source.id:null;
     m.maps!.push({id:v.mapInvocationId,execution_id:e.id,map_id:node.id,parent_path_id:p.id,join_id:node.joinId,source_result_id:sourceId,item_count:inputs.length,items_hash:payloadHash(inputs),state:inputs.length?'open':'completed'});
     const edge=d.edges.find(edge=>edge.from===node.id&&edge.on==='selected')!;
     for(const [index,input] of inputs.entries()){
      const item=final('items',`${v.mapInvocationId}:${index}`);require(!m.paths!.some(row=>row.id===item.path_id));
      m.items!.push({id:item.id,map_invocation_id:v.mapInvocationId,item_index:index,path_id:item.path_id,input_text:input,input_hash:hash(input),dispatched:0});
      m.paths!.push({id:item.path_id,execution_id:e.id,parent_path_id:p.id,fork_invocation_id:v.mapInvocationId,edge_id:`${edge.id}:${index}`,state:'waiting',node_id:node.workerId,step_execution_id:null,input_text:input,result_json:null,traversals:0,handling_limit:0,last_result_id:null});
     }break;
    }
    case 'map_items_sealed':{
     const map=find('maps',v.mapInvocationId);require(!sealedMaps.has(map.id)&&v.mapId===map.map_id&&v.pathId===map.parent_path_id&&v.count===map.item_count&&v.itemsHash===map.items_hash&&v.sourceResultId===map.source_result_id&&key===`map-sealed:${map.id}`);sealedMaps.add(map.id);break;
    }
    case 'map_item_started':{
     require(!interruption);const item=find('items',v.itemId),map=find('maps',item.map_invocation_id),p=find('paths',item.path_id),node=d.controls.find(n=>n.id===map.map_id);
     require(node?.kind==='map'&&sealedMaps.has(map.id)&&item.dispatched===0&&p.state==='waiting'&&v.mapInvocationId===map.id&&v.pathId===p.id&&v.index===item.item_index&&key===`map-started:${item.id}`);
     require(m.items!.filter(row=>row.map_invocation_id===map.id&&row.dispatched&&['active','waiting','joining'].includes(find('paths',row.path_id).state)).length<node.maxConcurrentItems);
     require(!m.items!.some(row=>row.map_invocation_id===map.id&&!row.dispatched&&row.item_index<item.item_index));item.dispatched=1;p.state='active';break;
    }
    case 'join_arrival':{
     const p=find('paths',v.pathId),f=find('forks',v.forkInvocationId);require(key===`arrival:${p.id}`&&p.fork_invocation_id===f.id&&['completed','failed','unselected'].includes(v.outcome)&&!m.joins!.some(row=>row.path_id===p.id));
     let output:string;
     if(pendingArrivals.delete(p.id)){require(v.outcome===pendingOutcomes.get(p.id));pendingOutcomes.delete(p.id);output=JSON.parse(p.result_json).output??'';}
     else {require(v.outcome==='completed'&&p.state==='active'&&!p.step_execution_id&&p.node_id===f.join_id);p.traversals++;output=p.input_text;p.state='arrived';p.result_json=stableJson({failed:false,output});}
     m.joins!.push({execution_id:e.id,fork_invocation_id:f.id,join_id:f.join_id,path_id:p.id,outcome:v.outcome,output_text:output});
     updateMaps();break;
    }
    case 'map_item_completed':case 'map_item_failed':{
     const item=find('items',v.itemId);require(!completedItems.has(item.id)&&v.mapInvocationId===item.map_invocation_id&&v.pathId===item.path_id&&v.index===item.item_index&&v.outcome===m.joins!.find(row=>row.path_id===item.path_id)?.outcome&&event.kind===(v.outcome==='completed'?'map_item_completed':'map_item_failed')&&key===`map-settled:${item.id}`&&m.joins!.some(row=>row.path_id===item.path_id));completedItems.add(item.id);break;
    }
    case 'join_resolved':{
     const f=find('forks',v.forkInvocationId),p=find('paths',f.parent_path_id),join=d.controls.find(n=>n.id===f.join_id),children=m.paths!.filter(row=>row.fork_invocation_id===f.id),map=m.maps!.find(row=>row.id===f.id);
     require(f.state==='open'&&p.state==='joining'&&join?.kind==='join'&&key===`joined:${f.id}`&&(!map||sealedMaps.has(map.id)));
     const arrivals=m.joins!.filter(row=>row.fork_invocation_id===f.id),successes=arrivals.filter(row=>row.outcome==='completed'),excluded=arrivals.filter(row=>row.outcome==='unselected').length,remaining=children.length-arrivals.length;
     const required=join.mode==='all'?children.length-excluded:join.mode==='any'?1:join.quorum!,satisfied=successes.length>=required&&(join.mode!=='all'||remaining===0),impossible=successes.length+remaining<required;
     require(satisfied||impossible&&!(join.onUnmet==='continue'&&remaining>0));
     const successful=children.filter(child=>successes.some(row=>row.path_id===child.id)).sort((a,b)=>map?Number(a.edge_id.slice(a.edge_id.lastIndexOf(':')+1))-Number(b.edge_id.slice(b.edge_id.lastIndexOf(':')+1)):join.inputOrder.indexOf(a.edge_id)-join.inputOrder.indexOf(b.edge_id));
     const ordered=satisfied?successful.slice(0,required):join.onUnmet==='continue'?successful:[];
     const output=ordered.map(child=>{
      const item=map?m.items!.find(row=>row.path_id===child.id):undefined,target=d.edges.find(edge=>edge.id===child.edge_id)?.to;
      const label=item?`${item.item_index+1}: ${String(item.input_text).slice(0,80)}`:[...d.steps,...d.controls].find(node=>node.id===target)?.label||target||child.edge_id;
      return `[${label}]\n${m.joins!.find(row=>row.path_id===child.id)!.output_text}`;
     }).join('\n\n')+(satisfied||map&&children.length===0?'':`\n\n[Partial result: ${arrivals.length-successes.length} path(s) did not succeed]`);
     let result:Row|undefined;
     if(!satisfied&&join.onUnmet!=='continue')result={failed:true,output:'Join could not satisfy its required successful paths'};
     else {let joined=output;try{joined=branchText(output);}catch{if(Buffer.byteLength(output)>8_000_000)joined='';else {const bundle=s.bundles!.find(row=>row.fork_invocation_id===f.id&&row.content_text===output&&row.content_hash===hash(output));require(bundle&&!m.bundles!.some(row=>row.id===bundle.id));m.bundles!.push({...bundle});joined=`branch-result-bundle:${e.id}:${bundle.id}`;}if(!joined){result={failed:true,output:'Joined text exceeds the inline contract; use explicit artifact references'};}}result??={failed:false,output:joined};}
     require(stableJson(v.selectedPathIds)===stableJson(ordered.map(row=>row.id))&&stableJson(v.result)===stableJson(result));require(result);
     f.state='closed';f.selected_paths_json=stableJson(v.selectedPathIds);f.result_json=stableJson(result);if(join.remainder==='cancel')for(const child of children)if(!arrivals.some(row=>row.path_id===child.id))cancel(child.id);
     move(p,d.edges.find(edge=>edge.from===join.id&&edge.on===(result.failed?'failure':'success')),result.output??'',result);break;
    }
    case 'condition_selected':case 'route_selected':case 'route_invalid':{
     require(started&&!interruption);const p=find('paths',v.pathId),node=d.controls.find(row=>row.id===p.node_id);require(p.state==='active'&&!p.step_execution_id&&node);
     let edge:BranchDefinition['edges'][number]|undefined;
     p.traversals++;
     if(node.kind==='condition'){
      const matched=p.input_text===text(node.predicate.equals);require(event.kind==='condition_selected');edge=d.edges.find(edge=>edge.from===node.id&&edge.on===(matched?'selected':'failure'));
      require(edge&&v.edgeId===edge.id&&key===`condition:${p.id}:${p.traversals-1}:${node.id}`);
      if(!matched&&p.fork_invocation_id&&find('forks',p.fork_invocation_id).join_id===edge.to){p.state='arrived';p.result_json=stableJson({failed:false,output:''});pendingArrivals.add(p.id);pendingOutcomes.set(p.id,'unselected');break;}
      move(p,edge,p.input_text,{failed:false,output:p.input_text});
     }else{
      require(node.kind==='route');const match=d.edges.find(edge=>edge.from===node.id&&edge.on==='selected'&&edge.choice?.toLowerCase()===p.input_text.trim().toLowerCase());edge=match??d.edges.find(edge=>edge.from===node.id&&edge.on==='failure');
      require(edge&&v.routeId===node.id&&v.choice===p.input_text.trim()&&event.kind===(match?'route_selected':'route_invalid')&&v.edgeId===edge.id&&key===`route:${p.id}:${p.traversals-1}:${node.id}`);move(p,edge,p.input_text,{failed:!match,output:p.input_text});
     }break;
    }
    case 'loop_traversed':{
     const expected=pendingLoops.shift();require(expected&&v.pathId===expected.pathId&&v.edgeId===expected.edgeId&&v.iteration===expected.iteration&&key===`loop:${v.pathId}:${v.edgeId}:${v.iteration}`);break;
    }
    case 'gate_opened':{
     require(!interruption);const captured=final('gates',v.gateId),step=find('steps',captured.step_execution_id),a=find('attempts',captured.attempt_id),p=find('paths',step.path_id),node=d.steps.find(row=>row.id===step.step_id);
     require(node?.kind==='human_gate'&&step.state==='prepared'&&a.state==='prepared'&&a.step_execution_id===step.id&&p.step_execution_id===step.id&&!m.gates!.some(row=>row.id===captured.id)&&v.revision===0&&v.purpose==='approval'&&v.prompt===text(node.prompt)&&v.proposal===step.input_text&&key===`gate:${captured.id}:0`);
     m.gates!.push({id:captured.id,step_execution_id:step.id,state:'waiting',proposal_text:step.input_text,choices_json:node.choices?stableJson(node.choices):null,revision:0,response_json:null,purpose:'approval',attempt_id:a.id,prompt_text:text(node.prompt)});a.state=step.state=p.state='waiting';break;
    }
    case 'gate_resolved':{
     const g=find('gates',v.gateId),step=find('steps',g.step_execution_id),node=d.steps.find(row=>row.id===step.step_id),response=JSON.parse(final('gates',g.id).response_json);
     require(node?.kind==='human_gate'&&g.state==='waiting'&&g.revision===0&&v.revision===0&&key===`gate-resolved:${g.id}:0`&&response.decision===v.decision&&['approve','reject'].includes(v.decision)&&response.expectedRevision===0&&typeof response.commandKey==='string');
     let output=g.proposal_text;
     if(response.choice!==undefined){require(node.choices?.includes(response.choice)&&response.output===undefined);output=response.choice;}
     else require(!node.choices?.length||response.decision!=='approve');
     if(response.output!==undefined){require(node.editable);output=branchText(response.output);}
     require(output===v.output);g.state='resolved';g.revision=1;g.response_json=stableJson(response);gateDecisions.set(g.id,v.decision);break;
    }
    case 'gate_checkpoint_closed':{
     const gate=find('gates',v.gateId);require(gate.state==='waiting'&&typeof v.invocationId==='string'&&Number.isSafeInteger(v.ordinal)&&v.ordinal>0&&v.mode===(c.checkpointMode??'async')&&key===`gate-invocation:${v.invocationId}`);gateClosing=v;break;
    }
    case 'gate_canceled':{
     const gate=find('gates',v.gateId);require(cancelledGates.delete(gate.id)&&gate.state==='canceled'&&v.revision===gate.revision-1&&key===`gate-canceled:${gate.id}:${v.revision}`);break;
    }
    case 'map_item_canceled':{
     const item=find('items',v.itemId);require(cancelledItems.delete(item.id)&&v.pendingCleanup===(find('paths',item.path_id).state==='canceling')&&v.mapInvocationId===item.map_invocation_id&&v.index===item.item_index&&v.pathId===item.path_id&&key===`map-canceled:${item.id}`);if(!v.pendingCleanup)completedItems.add(item.id);break;
    }
    case 'child_admitted':case 'child_completed':{
     const a=find('attempts',v.attemptId),step=find('steps',a.step_execution_id),p=find('paths',step.path_id),child=context?.children[a.id],node=d.steps.find(row=>row.id===step.step_id);
     require(child&&node?.kind==='branch_call'&&p.step_execution_id===step.id&&child.executionId===v.childExecutionId);
     if(event.kind==='child_admitted'){require(!admitted.has(a.id)&&a.state==='prepared'&&v.definitionId===child.versionId&&key===`call:${a.id}`);admitted.add(a.id);a.state=step.state=p.state='waiting';}
     else {require(admitted.has(a.id)&&!completedChildren.has(a.id)&&child.completed&&v.versionId===child.versionId&&v.state===(child.failed?'failed':'completed'));completedChildren.add(a.id);}
     break;
    }
    case 'completed':case 'failed':require(event.kind===(context?.terminalState??'completed')&&context?.terminal&&!terminalObserved&&m.paths!.every(p=>!['active','waiting','joining'].includes(p.state))&&JSON.parse(find('paths',root.id).result_json).output===v.output&&(v.output??null)===e.output_text);terminalObserved=true;break;
    case 'checkpoint_restore_held':require(context?.parent&&seed&&accepted&&!started&&!interruption&&c.checkpointMode==='exit'&&typeof v.interruptionId==='string'&&typeof v.invocationId==='string'&&v.ordinal===1);interruption=v;break;
    case 'checkpoint_interrupt_requested':require(started&&!interruption&&c.checkpointMode==='exit'&&typeof v.interruptionId==='string'&&typeof v.invocationId==='string'&&v.commandKey&&Number.isSafeInteger(v.ordinal)&&v.ordinal>0&&(!invocation?v.ordinal===1:invocation.id===v.invocationId&&invocation.ordinal===v.ordinal));interruption=v;break;
    case 'checkpoint_interrupt_resumed':require(interruption&&v.interruptionId===interruption.interruptionId&&v.invocationId===interruption.invocationId&&v.nextOrdinal===interruption.ordinal+1&&typeof v.nextInvocationId==='string'&&v.nextInvocationId!==v.invocationId);invocation={id:v.nextInvocationId,ordinal:v.nextOrdinal};interruption=undefined;break;
    case 'execution_budget_held':case 'execution_budget_released':break;
    default:return false;
   }
  }
  require(!retry||retryIndex===retry.generations.length&&!retryScheduled);
  require(!context?.issuedResource||reservedResources.size===s.resources!.length&&s.resources!.every(resource=>['chat','import'].every(phase=>operationsByResource.get(resource.step_execution_id)?.get(phase)?.state==='completed')));
  require(boundRequests.size===s.attempts!.filter(a=>a.request_id).length);
  require(started&&cancelledItems.size===0&&cancelledGates.size===0&&pendingLoops.length===0&&pendingArrivals.size===0&&authorized.size===exited.size);
  if(c.checkpointMode==='exit'&&!context?.terminal){const closing=checkpoint?.invocation;require(closing);if(m.gates!.some(g=>g.state==='waiting')&&closing.interruptionId===undefined)require(gateClosing&&gateClosing.invocationId===closing.id&&gateClosing.ordinal===closing.ordinal);else require(interruption&&closing.interruptionId===interruption.interruptionId&&closing.id===interruption.invocationId&&closing.ordinal===interruption.ordinal);}
  if(context){require(terminalObserved===context.terminal&&Object.entries(context.children).every(([id,child])=>admitted.has(id)&&completedChildren.has(id)===child.completed));}
  for(const key of keys){
   const normalize=(rows:Row[])=>rows.map(row=>{const {created_at,updated_at,...rest}=row;return stableJson(rest);}).sort();
   require(stableJson(normalize(m[key]!))===stableJson(normalize(s[key]!)));
  }
  require(m.maps!.every(map=>sealedMaps.has(map.id))&&m.items!.every(item=>(['arrived','canceled'].includes(find('paths',item.path_id).state))===completedItems.has(item.id)));
  return true;
 }catch{return false;}
}
