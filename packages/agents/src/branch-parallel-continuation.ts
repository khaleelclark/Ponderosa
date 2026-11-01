import {createHash} from 'node:crypto';
import type {BranchConfiguration,BranchDefinition} from '@ponderosa/core';
import {branchText} from './branch-definition.js';
import {extractBranchMapItems} from './branch-map-items.js';
import {interpolateBranchText} from './branch-parameters.js';
import {stableJson,payloadHash} from './coordination-v3-canonical-json.js';
import {branchContinuationIds,remapBranchFrontier} from './branch-continuation-remap.js';
import type {Selected} from './branch-script-continuation.js';
type Row=Record<string,any>;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const keys=['paths','steps','attempts','sealedResults','forks','joins','maps','items'] as const;
export const hasParallelControls=(d:BranchDefinition)=>d.controls.some(c=>c.kind==='fork'||c.kind==='map');
/** First admitted parallel subset: successful Script-only, all-Join, acyclic owners. */
export function parallelDefinitionSupported(d:BranchDefinition):boolean {
 return hasParallelControls(d)&&d.policy.failure.action==='stop'&&!d.edges.some(e=>e.loop)
  &&d.steps.every(s=>s.kind==='script'&&s.runtime==='node'&&(!s.failure||s.failure.action==='stop'))
  &&d.controls.every(c=>c.kind==='fork'||c.kind==='map'||c.kind==='join'&&c.mode==='all')
  &&!Object.values(d.parameters??{}).some(p=>p.type==='secret');
}
export function parallelFrontierSupported(s:Selected,d:BranchDefinition):boolean {
 try{
  const expected=['execution',...keys,'loops','bundles','gates','actions','resources'];
  if(!parallelDefinitionSupported(d)||stableJson(Object.keys(s).sort())!==stableJson(expected.sort())||expected.some(k=>!Array.isArray(s[k])))return false;
  const e=s.execution![0];
  if(s.execution!.length!==1||!e||!['running','waiting'].includes(e.state)||e.admission_source!=='manual'||e.parent_execution_id||e.parent_attempt_id||e.call_depth||e.cancel_requested||e.budget_exhausted||e.recovery_traversals||e.loop_iterations||e.output_text!==null||e.merged_into!==null||e.requested_outcome!=='canceled')return false;
  if(['loops','bundles','gates','actions','resources'].some(k=>s[k]!.length))return false;
  branchContinuationIds(s);
  if(s.paths!.filter(p=>p.parent_path_id===null).length!==1||!s.paths!.length)return false;
  if(s.paths!.some(p=>p.execution_id!==e.id||p.handling_limit||!['active','waiting','joining','arrived','completed'].includes(p.state)||!Number.isSafeInteger(p.traversals)||p.traversals<0))return false;
  if(!s.paths!.some(p=>['active','waiting','joining'].includes(p.state))||e.state!==(s.paths!.some(p=>p.state==='active')?'running':'waiting'))return false;
  if(e.traversals!==s.paths!.reduce((n,p)=>n+p.traversals,0))return false;
  for(const step of s.steps!){
   const a=s.attempts!.filter(a=>a.step_execution_id===step.id),r=s.sealedResults!.filter(r=>r.step_execution_id===step.id);
   if(step.execution_id!==e.id||!d.steps.some(node=>node.id===step.step_id)||!['prepared','completed'].includes(step.state)||a.length!==1)return false;
   const attempt=a[0]!;
   if(Object.keys(attempt).some(key=>!['id','step_execution_id','number','state','request_id','fence','input_hash','result_json','available_at','purpose','recovery_of_request_id','cancel_requested','runtime_outcome_json','error','created_at','updated_at'].includes(key)))return false;
   if(attempt.number!==1||attempt.state!==step.state||attempt.purpose!=='step'||attempt.error||attempt.request_id||attempt.recovery_of_request_id||attempt.runtime_outcome_json||attempt.cancel_requested||attempt.input_hash!==hash(step.input_text)||attempt.result_json!==step.result_json||!Number.isSafeInteger(attempt.fence)||attempt.fence<0)return false;
   if(step.state==='prepared'){
    if(attempt.fence||step.result_json!==null||r.length||!s.paths!.some(p=>p.id===step.path_id&&p.step_execution_id===step.id&&p.state==='active'))return false;
   }else{
    const result=JSON.parse(step.result_json);
    if(result.failed!==false||Object.keys(result).some(k=>!['failed','output'].includes(k))||result.output!==undefined&&branchText(result.output)!==result.output||stableJson(result)!==step.result_json||r.length!==1)return false;
    if(r[0]!.execution_id!==e.id||r[0]!.path_id!==step.path_id||r[0]!.terminal_attempt_id!==attempt.id||r[0]!.result_json!==step.result_json||r[0]!.content_hash!==hash(step.result_json))return false;
   }
  }
  if(s.attempts!.length!==s.steps!.length||s.sealedResults!.length!==s.steps!.filter(row=>row.state==='completed').length)return false;
  return true;
 }catch{return false;}
}

/** Replay graph transitions, not scheduler timing. Unknown observations never supply authority. */
export function replayParallelCut(s:Selected,d:BranchDefinition,c:BranchConfiguration,events:Row[],checkpoint?:Row,seed?:{selected:Selected;idMap:Record<string,string>}):boolean {
 try{
  if(!parallelFrontierSupported(s,d))return false;
  const e=s.execution![0]!,root=s.paths!.find(p=>p.parent_path_id===null)!;
  const m:Selected=Object.fromEntries(keys.map(k=>[k,[]]));
  function require(ok:unknown):asserts ok {if(!ok)throw Error('Parallel audit differs from selected frontier');}
  const find=(key:string,id:string)=>{const r=m[key]!.find(r=>r.id===id);require(r);return r!;};
  const final=(key:string,id:string)=>{const r=s[key]!.find(r=>r.id===id);require(r);return r!;};
  const text=(v:string)=>interpolateBranchText(v,d,c);
  const pendingArrivals=new Set<string>(),sealedMaps=new Set<string>(),completedItems=new Set<string>(),authorized=new Set<string>(),exited=new Set<string>();
  let started=false,accepted=false,interruption:Row|undefined,invocation:Row|undefined;
  if(seed){
   const old=seed.selected,source=old.execution![0]!.id;
   const mapped=remapBranchFrontier(old,seed.idMap,source,e.id);
   for(const k of keys)m[k]=mapped[k]!;
   for(const map of m.maps!)sealedMaps.add(map.id);
   for(const item of m.items!)if(find('paths',item.path_id).state==='arrived')completedItems.add(item.id);
  }else m.paths!.push({id:root.id,execution_id:e.id,parent_path_id:null,fork_invocation_id:null,edge_id:null,state:'active',node_id:d.entry,step_execution_id:null,input_text:e.input_text,result_json:null,traversals:0,handling_limit:0,last_result_id:null});
  const move=(p:Row,edge:BranchDefinition['edges'][number]|undefined,output:string,result:Row)=>{
   if(edge){p.node_id=edge.to;p.input_text=edge.input?.kind==='literal'?text(edge.input.text):output;p.step_execution_id=null;p.state='active';}
   else if(p.fork_invocation_id){p.state='arrived';p.result_json=stableJson(result);pendingArrivals.add(p.id);}
   else {p.state='completed';p.result_json=stableJson(result);}
  };
  const fork=(id:string,p:Row,node:Row,isMap:boolean)=>{
   require(!m.forks!.some(f=>f.id===id));
   const f={id,execution_id:e.id,parent_path_id:p.id,fork_id:node.id,join_id:node.joinId,state:'open',selected_paths_json:null,result_json:null};m.forks!.push(f);
   p.traversals++;p.state='joining';p.node_id=node.joinId;if(isMap)p.step_execution_id=null;
   return f;
  };
  for(const event of events){
   const v=JSON.parse(event.evidence_json),key=event.transition_key;
   switch(event.kind){
    case 'trigger_accepted':require(!accepted&&!started&&v.versionId===e.version_id&&v.bindingRevisionId===e.binding_revision_id&&v.inputHash===e.input_hash);accepted=true;break;
    case 'workflow_started':require(accepted&&!started);started=true;break;
    case 'restored_prefix':case 'historical_rewind':require(seed&&accepted&&!started);break;
    case 'step_prepared':{
     require(started&&!interruption&&!m.steps!.some(row=>row.id===v.stepExecutionId));
     const srow=final('steps',v.stepExecutionId),p=find('paths',srow.path_id),a=s.attempts!.find(a=>a.step_execution_id===srow.id)!;
     require(p.state==='active'&&!p.step_execution_id&&p.node_id===v.stepId&&srow.step_id===v.stepId&&srow.input_text===p.input_text&&srow.invocation===1+m.steps!.filter(row=>row.path_id===p.id&&row.step_id===srow.step_id).reduce((n,row)=>Math.max(n,row.invocation),0));
     m.steps!.push({...srow,state:'prepared',result_json:null});m.attempts!.push({...a,state:'prepared',fence:0,result_json:null});p.step_execution_id=srow.id;p.traversals++;break;
    }
    case 'script_leased':case 'script_authorized':case 'script_process_exit':case 'script_cleanup_observed':{
     const id=event.kind==='script_process_exit'?key.slice('process-exit:'.length).replace(/:[0-9]+$/u,''):v.attemptId;
     const a=find('attempts',id),step=find('steps',a.step_execution_id),node=d.steps.find(n=>n.id===step.step_id);
     require(node?.kind==='script');
     if(event.kind==='script_leased'){
      require(!interruption&&a.state==='prepared'&&key===`leased:${a.id}:${v.fence}`&&v.fence===a.fence+1&&v.sourceHash===hash(node.source)&&v.inputBundleId===undefined&&v.inputBundleHash===undefined);a.fence=v.fence;a.state='leased';step.state='leased';
     }else if(event.kind==='script_authorized'){
      require(!interruption&&a.state==='leased'&&key===`launched:${a.id}:${a.fence}`&&!authorized.has(a.id));authorized.add(a.id);a.state='running';step.state='running';
     }else if(event.kind==='script_process_exit'){
      require(authorized.has(a.id)&&key===`process-exit:${a.id}:${a.fence}`&&!exited.has(a.id)&&v.code===0&&!v.error&&typeof v.stdout==='string'&&v.stdout===(JSON.parse(final('steps',step.id).result_json).output??'')&&v.outputHash===hash(v.stdout));exited.add(a.id);
     }else require(exited.has(a.id)&&key===`cleaned:${a.id}:${a.fence}`);
     break;
    }
    case 'step_settled':{
     const a=find('attempts',v.attemptId),step=find('steps',a.step_execution_id);
     require(a.state==='running'&&authorized.has(a.id)&&exited.has(a.id)&&key===`settled:${a.id}`&&v.result.failed===false&&stableJson(v.result)===final('steps',step.id).result_json);
     a.state='completed';step.state='completed';a.result_json=step.result_json=stableJson(v.result);break;
    }
    case 'result_sealed':{
     const step=find('steps',v.stepExecutionId),p=find('paths',step.path_id),r=final('sealedResults',v.resultId);
     require(step.state==='completed'&&p.step_execution_id===step.id&&!m.sealedResults!.some(row=>row.step_execution_id===step.id)&&r.step_execution_id===step.id&&v.terminalAttemptId===r.terminal_attempt_id&&v.contentHash===r.content_hash&&key===`sealed:${r.id}`);
     m.sealedResults!.push({...r});p.last_result_id=r.id;
     const result=JSON.parse(step.result_json);move(p,d.edges.find(edge=>edge.from===step.step_id&&edge.on==='success'),result.output??'',result);break;
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
     const p=find('paths',v.pathId),f=find('forks',v.forkInvocationId);require(key===`arrival:${p.id}`&&p.fork_invocation_id===f.id&&v.outcome==='completed'&&!m.joins!.some(row=>row.path_id===p.id));
     let output:string;
     if(pendingArrivals.delete(p.id))output=JSON.parse(p.result_json).output??'';
     else {require(p.state==='active'&&!p.step_execution_id&&p.node_id===f.join_id);p.traversals++;output=p.input_text;p.state='arrived';p.result_json=stableJson({failed:false,output});}
     m.joins!.push({execution_id:e.id,fork_invocation_id:f.id,join_id:f.join_id,path_id:p.id,outcome:'completed',output_text:output});
     const map=m.maps!.find(row=>row.id===f.id);if(map&&m.items!.filter(row=>row.map_invocation_id===map.id).every(row=>find('paths',row.path_id).state==='arrived'))map.state='completed';break;
    }
    case 'map_item_completed':{
     const item=find('items',v.itemId);require(!completedItems.has(item.id)&&v.mapInvocationId===item.map_invocation_id&&v.pathId===item.path_id&&v.index===item.item_index&&v.outcome==='completed'&&key===`map-settled:${item.id}`&&m.joins!.some(row=>row.path_id===item.path_id));completedItems.add(item.id);break;
    }
    case 'join_resolved':{
     const f=find('forks',v.forkInvocationId),p=find('paths',f.parent_path_id),join=d.controls.find(n=>n.id===f.join_id),children=m.paths!.filter(row=>row.fork_invocation_id===f.id),map=m.maps!.find(row=>row.id===f.id);
     require(f.state==='open'&&p.state==='joining'&&join?.kind==='join'&&join.mode==='all'&&key===`joined:${f.id}`&&children.every(row=>m.joins!.some(a=>a.path_id===row.id))&&(!map||sealedMaps.has(map.id)&&m.items!.filter(row=>row.map_invocation_id===map.id).every(row=>completedItems.has(row.id))));
     const ordered=[...children].sort((a,b)=>map?Number(a.edge_id.slice(a.edge_id.lastIndexOf(':')+1))-Number(b.edge_id.slice(b.edge_id.lastIndexOf(':')+1)):join.inputOrder.indexOf(a.edge_id)-join.inputOrder.indexOf(b.edge_id));
     const output=ordered.map(child=>{
      const item=map?m.items!.find(row=>row.path_id===child.id):undefined,target=d.edges.find(edge=>edge.id===child.edge_id)?.to;
      const label=item?`${item.item_index+1}: ${String(item.input_text).slice(0,80)}`:[...d.steps,...d.controls].find(node=>node.id===target)?.label||target||child.edge_id;
      return `[${label}]\n${m.joins!.find(row=>row.path_id===child.id)!.output_text}`;
     }).join('\n\n');branchText(output);
     const result={failed:false,output};require(stableJson(v.selectedPathIds)===stableJson(ordered.map(row=>row.id))&&stableJson(v.result)===stableJson(result));
     f.state='closed';f.selected_paths_json=stableJson(v.selectedPathIds);f.result_json=stableJson(result);move(p,d.edges.find(edge=>edge.from===join.id&&edge.on==='success'),output,result);break;
    }
    case 'checkpoint_interrupt_requested':require(started&&!interruption&&c.checkpointMode==='exit'&&typeof v.interruptionId==='string'&&typeof v.invocationId==='string'&&v.commandKey&&Number.isSafeInteger(v.ordinal)&&v.ordinal>0&&(!invocation?v.ordinal===1:invocation.id===v.invocationId&&invocation.ordinal===v.ordinal));interruption=v;break;
    case 'checkpoint_interrupt_resumed':require(interruption&&v.interruptionId===interruption.interruptionId&&v.invocationId===interruption.invocationId&&v.nextOrdinal===interruption.ordinal+1&&typeof v.nextInvocationId==='string'&&v.nextInvocationId!==v.invocationId);invocation={id:v.nextInvocationId,ordinal:v.nextOrdinal};interruption=undefined;break;
    case 'execution_budget_held':case 'execution_budget_released':break;
    default:return false;
   }
  }
  require(started&&pendingArrivals.size===0&&authorized.size===exited.size);
  if(c.checkpointMode==='exit')require(interruption&&checkpoint?.invocation?.interruptionId===interruption.interruptionId&&checkpoint.invocation.id===interruption.invocationId&&checkpoint.invocation.ordinal===interruption.ordinal);
  for(const key of keys){
   const normalize=(rows:Row[])=>rows.map(row=>{const {created_at,updated_at,...rest}=row;return stableJson(rest);}).sort();
   require(stableJson(normalize(m[key]!))===stableJson(normalize(s[key]!)));
  }
  require(m.maps!.every(map=>sealedMaps.has(map.id))&&m.items!.every(item=>(find('paths',item.path_id).state==='arrived')===completedItems.has(item.id)));
  return true;
 }catch{return false;}
}
