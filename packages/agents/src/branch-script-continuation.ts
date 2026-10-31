import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {BranchConfiguration,BranchDefinition} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {branchText} from './branch-definition.js';
import {interpolateBranchText,validateBranchConfiguration} from './branch-parameters.js';

type Row=Record<string,any>;
export type Selected=Record<string,Row[]>;
export const SCRIPT_CONTINUATION_COMPATIBILITY={format:'script-control-frontier.v1',nodeMajor:Number(process.versions.node.split('.')[0])};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function scriptDefinitionSupported(definition:BranchDefinition):boolean {
  return !definition.steps.some(s=>s.kind!=='script'||s.runtime!=='node'||s.failure&&s.failure.action!=='stop')&&definition.policy.failure.action==='stop'
    &&!definition.controls.some(c=>!['condition','route'].includes(c.kind))&&!Object.values(definition.parameters??{}).some(p=>p.type==='secret');
}
/** Exact supported subset; all other dependency families remain ineligible. */
export function scriptFrontierSupported(selected:Selected,definition:BranchDefinition):boolean {
  try {
    const tables=['execution','paths','steps','attempts','forks','joins','loops','maps','items','sealedResults','bundles','gates','actions','resources'];
    if(stableJson(Object.keys(selected).sort())!==stableJson(tables.sort())||tables.some(key=>!Array.isArray(selected[key])))return false;
    const e=selected.execution![0],p=selected.paths![0];
    if(selected.execution!.length!==1||selected.paths!.length!==1||!e||!p||e.state!=='running'||e.admission_source!=='manual'
      ||e.parent_execution_id||e.parent_attempt_id||e.cancel_requested||e.budget_exhausted||e.recovery_traversals||e.call_depth
      ||e.output_text!==null||e.merged_into!==null||e.requested_outcome!=='canceled'||p.edge_id!==null||p.result_json!==null
      ||p.execution_id!==e.id||p.parent_path_id||p.fork_invocation_id||p.state!=='active'||p.handling_limit||p.traversals<1)return false;
    if(!scriptDefinitionSupported(definition))return false;
    if(['forks','joins','maps','items','bundles','gates','actions','resources'].some(key=>selected[key]!.length))return false;
    if(!definition.steps.some(s=>s.id===p.node_id)&&!definition.controls.some(c=>c.id===p.node_id))return false;
    const ids=new Set<string>();
    for(const row of [p,...selected.steps!,...selected.attempts!,...selected.sealedResults!]){if(typeof row.id!=='string'||ids.has(row.id))return false;ids.add(row.id);}
    const prepared=selected.steps!.filter(s=>s.state==='prepared');
    if(prepared.length!==(p.step_execution_id?1:0)||p.step_execution_id&&prepared[0]?.id!==p.step_execution_id)return false;
    if(selected.attempts!.length!==selected.steps!.length)return false;
    for(const s of selected.steps!){
      if(s.execution_id!==e.id||s.path_id!==p.id||!definition.steps.some(step=>step.id===s.step_id)||!['prepared','completed'].includes(s.state)||!Number.isSafeInteger(s.invocation)||s.invocation<1)return false;
      const attempts=selected.attempts!.filter(a=>a.step_execution_id===s.id),a=attempts[0];
      if(attempts.length!==1||!a||a.error||a.number!==1||a.state!==s.state||a.purpose!=='step'||a.request_id||a.recovery_of_request_id||a.cancel_requested||a.runtime_outcome_json||a.input_hash!==hash(s.input_text))return false;
      const sealed=selected.sealedResults!.filter(r=>r.step_execution_id===s.id);
      if(s.state==='prepared'){
        if(s.id!==p.step_execution_id||s.step_id!==p.node_id||s.input_text!==p.input_text||a.fence!==0||s.result_json!==null||a.result_json!==null||sealed.length)return false;
      }else{
        const r=sealed[0],result=JSON.parse(s.result_json);
        if(Object.keys(result).some(key=>!['failed','output'].includes(key))||result.output!==undefined&&branchText(result.output)!==result.output)return false;
        if(sealed.length!==1||!r||r.execution_id!==e.id||r.path_id!==p.id||r.terminal_attempt_id!==a.id||result.failed!==false
          ||stableJson(result)!==s.result_json||a.result_json!==s.result_json||r.result_json!==s.result_json||r.content_hash!==hash(s.result_json))return false;
      }
    }
    if(selected.sealedResults!.length!==selected.steps!.filter(s=>s.state==='completed').length||p.last_result_id&&!selected.sealedResults!.some(r=>r.id===p.last_result_id))return false;
    for(const r of selected.loops!){if(r.execution_id!==e.id||r.path_id!==p.id||!definition.edges.some(edge=>edge.id===r.edge_id&&edge.loop)||!Number.isSafeInteger(r.iterations)||r.iterations<1)return false;}
    if(e.traversals!==p.traversals||e.loop_iterations!==selected.loops!.reduce((total,r)=>total+r.iterations,0))return false;
    return [e.traversals,e.loop_iterations,e.recovery_traversals,p.traversals].every(n=>Number.isSafeInteger(n)&&n>=0);
  }catch{return false;}
}
export function encodeScriptContinuation(db:Database.Database,executionId:string,selected:Selected):Row|undefined {
  const owner=db.prepare(`SELECT e.configuration_json,v.definition_json,v.content_hash version_hash,b.content_hash binding_hash,b.bindings_json
    FROM branch_executions e JOIN branch_versions v ON v.id=e.version_id JOIN branch_bindings b ON b.id=e.binding_revision_id WHERE e.id=?`).get(executionId) as Row|undefined;
  if(!owner)return;
  const definition=JSON.parse(owner.definition_json) as BranchDefinition,configuration=JSON.parse(owner.configuration_json);
  if(Object.keys(configuration.secretBindings??{}).length||!scriptFrontierSupported(selected,definition))return;
  const {secretBindings,...safeConfiguration}=configuration;
  if(stableJson(validateBranchConfiguration(safeConfiguration,definition,true))!==stableJson(safeConfiguration))return;
  if(payloadHash(definition)!==owner.version_hash||payloadHash(JSON.parse(owner.bindings_json))!==owner.binding_hash)throw Error('Continuation pins failed verification');
  const audit=db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(executionId);
  const row=db.prepare('SELECT checkpoint_invocation_json FROM branch_executions WHERE id=?').get(executionId) as Row;
  const invocation=JSON.parse(row.checkpoint_invocation_json),checkpoint=safeConfiguration.checkpointMode==='exit'?{
    invocationId:invocation.id,mode:invocation.mode,closing:invocation.state==='interrupted'||invocation.state==='terminal',
    invocation:{id:invocation.id,ordinal:invocation.ordinal,mode:invocation.mode,state:invocation.state,primaryOutcome:invocation.primary_outcome,interruptionId:invocation.interruptionId}
  }:undefined;
  const provenance=composeScriptCut(db,executionId,selected,definition,safeConfiguration,audit,checkpoint,undefined,true);
  if(!provenance)return;
  const e=selected.execution![0]!;
  return {schema:'ponderosa.branch.script-continuation.v1',compatibility:SCRIPT_CONTINUATION_COMPATIBILITY,
    versionId:e.version_id,versionHash:owner.version_hash,bindingRevisionId:e.binding_revision_id,bindingHash:owner.binding_hash,configuration:safeConfiguration,
    audit,provenance,...(checkpoint?{checkpoint}:{})};
}

export function scriptAuditSupported(audit:unknown):boolean {
  if(!Array.isArray(audit)||!audit.some(r=>r.kind==='trigger_accepted')||!audit.some(r=>r.kind==='workflow_started'))return false;
  let previous=0;const keys=new Set<string>();
  try{return audit.every(r=>{
    if(!Number.isSafeInteger(r.id)||r.id<=previous||typeof r.kind!=='string'||typeof r.transition_key!=='string'||keys.has(r.transition_key)||typeof r.created_at!=='string'||typeof r.evidence_json!=='string'||stableJson(JSON.parse(r.evidence_json))!==r.evidence_json)return false;
    previous=r.id;keys.add(r.transition_key);return true;
  });}catch{return false;}
}

type Cut={executionId:string;selected:Selected;audit:Row[];checkpoint?:Row;provenance?:unknown;seed?:{selected:Selected;idMap:Record<string,string>};reference?:Row};

/** Resolve owned immutable links iteratively; wrapped text never supplies replay authority. */
function composeScriptCut(db:Database.Database,executionId:string,selected:Selected,definition:BranchDefinition,configuration:BranchConfiguration,audit:unknown,checkpoint?:Row,provenance?:unknown,encoding=false):Row[]|undefined {
  try {
    const frames:Cut[]=[],visited=new Set<string>();
    let cut:Cut={executionId,selected,audit:audit as Row[],checkpoint,provenance};
    const readSnapshot=(id:number,owner:string)=>{
      if(!Number.isSafeInteger(id)||id<1||typeof owner!=='string'||!owner)return;
      const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(id,owner) as Row|undefined;
      if(!row)return;
      const value=JSON.parse(row.snapshot_json);
      if(stableJson(value)!==row.snapshot_json||payloadHash(value)!==row.content_hash)return;
      return {value,hash:row.content_hash};
    };
    for(;;){
      if(visited.has(cut.executionId)||!scriptAuditSupported(cut.audit))return;
      visited.add(cut.executionId);frames.push(cut);
      const e=cut.selected.execution?.[0];
      const owner=db.prepare('SELECT branch_id,version_id,binding_revision_id FROM branch_executions WHERE id=?').get(cut.executionId) as Row|undefined;
      const root=selected.execution?.[0];
      if(!e||!owner||e.id!==cut.executionId||e.branch_id!==root?.branch_id||e.version_id!==root?.version_id||e.binding_revision_id!==root?.binding_revision_id
        ||['branch_id','version_id','binding_revision_id'].some(key=>owner[key]!==e[key])||e.input_text!==root?.input_text||e.depth_ceiling!==configuration.limits.maxCallDepth)return;
      const origins=cut.audit.filter(row=>row.kind==='historical_rewind'),wrappers=cut.audit.filter(row=>row.kind==='restored_prefix');
      if(!origins.length){if(wrappers.length)return;break;}
      if(origins.length!==1||wrappers.length!==1||cut.audit[0]?.kind!=='trigger_accepted'||cut.audit[1]!==wrappers[0]||cut.audit[2]!==origins[0]
        ||origins[0]!.transition_key!=='rewind-origin')return;
      const origin=JSON.parse(origins[0]!.evidence_json),stored=readSnapshot(origin.lineageId,cut.executionId);
      if(!stored)return;
      const line=stored.value,source=readSnapshot(line.checkpointId,line.sourceExecutionId);
      if(!source||line.schema!=='ponderosa.branch.rewind-lineage.v1'||line.executionId!==cut.executionId||source.hash!==line.checkpointHash
        ||typeof line.commandKey!=='string'||!line.commandKey||stableJson(line.compatibility)!==stableJson(SCRIPT_CONTINUATION_COMPATIBILITY)
        ||line.commandHash!==payloadHash({executionId:line.sourceExecutionId,checkpointId:line.checkpointId,expectedHash:line.checkpointHash})
        ||stableJson(origin)!==stableJson({sourceExecutionId:line.sourceExecutionId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash,commandKey:line.commandKey,lineageId:origin.lineageId})
        ||wrappers[0]!.transition_key!=='restored-prefix'
        ||wrappers[0]!.evidence_json!==stableJson({sourceExecutionId:line.sourceExecutionId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash,lineageId:origin.lineageId}))return;
      const receipt=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(line.sourceExecutionId,`historical-rewind:${payloadHash(line.commandKey)}`) as Row|undefined;
      if(!receipt||receipt.input_hash!==line.commandHash||receipt.result_json!==stableJson({executionId:cut.executionId,lineageId:origin.lineageId}))return;
      const snapshot=source.value,c=snapshot.continuation,se=snapshot.selected?.execution?.[0];
      if(snapshot.schema!=='branch-unit-selected.v2'||snapshot.restore_supported!==true||c?.schema!=='ponderosa.branch.script-continuation.v1'
        ||stableJson(c.compatibility)!==stableJson(SCRIPT_CONTINUATION_COMPATIBILITY)||!se||se.id!==line.sourceExecutionId||se.version_id!==c.versionId||se.binding_revision_id!==c.bindingRevisionId
        ||c.checkpoint&&(snapshot.invocationId!==c.checkpoint.invocationId||snapshot.mode!==c.checkpoint.mode||snapshot.closing!==c.checkpoint.closing)
        ||stableJson(line.sourceCheckpointInvocation??null)!==stableJson(c.checkpoint?.invocation??null)
        ||stableJson(c.configuration)!==stableJson(configuration)||Object.hasOwn(c.configuration,'secretBindings'))return;
      const version=db.prepare('SELECT content_hash,definition_json FROM branch_versions WHERE id=? AND branch_id=?').get(c.versionId,se.branch_id) as Row|undefined;
      const binding=db.prepare('SELECT content_hash,bindings_json FROM branch_bindings WHERE id=? AND branch_id=?').get(c.bindingRevisionId,se.branch_id) as Row|undefined;
      if(!version||!binding||version.content_hash!==c.versionHash||payloadHash(JSON.parse(version.definition_json))!==c.versionHash||payloadHash(definition)!==c.versionHash
        ||binding.content_hash!==c.bindingHash||payloadHash(JSON.parse(binding.bindings_json))!==c.bindingHash)return;
      const keys=['paths','steps','attempts','sealedResults'].flatMap(key=>snapshot.selected[key].map((row:Row)=>row.id));
      const ids=line.idMap;
      if(!ids||Array.isArray(ids)||stableJson(Object.keys(ids).sort())!==stableJson([...keys].sort())
        ||Object.values(ids).some(id=>typeof id!=='string'||!id||keys.includes(id))||new Set(Object.values(ids)).size!==keys.length)return;
      cut.seed={selected:snapshot.selected,idMap:ids};
      cut.reference={executionId:cut.executionId,lineageId:origin.lineageId,lineageHash:stored.hash,sourceExecutionId:line.sourceExecutionId,checkpointId:line.checkpointId,checkpointHash:line.checkpointHash};
      cut={executionId:line.sourceExecutionId,selected:snapshot.selected,audit:c.audit,checkpoint:c.checkpoint,provenance:c.provenance};
    }
    const composed:Row[]=[];
    for(const frame of frames.reverse()){
      if(frame.reference)composed.push(frame.reference);
      if(!(encoding&&frame.executionId===executionId)&&stableJson(frame.provenance??[])!==stableJson(composed))return;
      if(!replayScriptCut(db,frame.executionId,frame.selected,definition,configuration,frame.audit,frame.checkpoint,frame.seed))return;
    }
    return composed;
  }catch{return;}
}

export function scriptCutSupported(db:Database.Database,executionId:string,selected:Selected,definition:BranchDefinition,configuration:BranchConfiguration,audit:unknown,checkpoint?:Row,provenance?:unknown):boolean {
  return composeScriptCut(db,executionId,selected,definition,configuration,audit,checkpoint,provenance)!==undefined;
}

/** The audit and inventory must describe the same committed single-path cut. */
function replayScriptCut(db:Database.Database,executionId:string,selected:Selected,definition:BranchDefinition,configuration:BranchConfiguration,audit:unknown,checkpoint?:Row,seed?:{selected:Selected;idMap:Record<string,string>}):boolean {
  try {
    if(!scriptFrontierSupported(selected,definition)||!scriptAuditSupported(audit))return false;
    const events=audit as Row[],e=selected.execution![0]!,p=selected.paths![0]!;
    const closing=checkpoint?.invocation;
    if(configuration.checkpointMode==='exit'){
      if(!closing||stableJson(Object.keys(checkpoint!).sort())!==stableJson(['closing','invocation','invocationId','mode'])
        ||stableJson(Object.keys(closing).sort())!==stableJson(['id','interruptionId','mode','ordinal','primaryOutcome','state'])
        ||checkpoint!.mode!=='exit'||checkpoint!.closing!==true||checkpoint!.invocationId!==closing.id||closing.mode!=='exit'
        ||closing.state!=='interrupted'||closing.primaryOutcome!=='interrupted'||typeof closing.id!=='string'||typeof closing.interruptionId!=='string'
        ||!Number.isSafeInteger(closing.ordinal)||closing.ordinal<1)return false;
    }else if(checkpoint)return false;
    const owner=db.prepare('SELECT branch_id,version_id,binding_revision_id,input_hash,configuration_json FROM branch_executions WHERE id=?').get(executionId) as Row|undefined;
    if(!owner||e.id!==executionId||['branch_id','version_id','binding_revision_id','input_hash'].some(key=>e[key]!==owner[key])
      ||e.input_hash!==payloadHash({input:branchText(e.input_text),source:'manual'})
      ||stableJson(configuration)!==stableJson(JSON.parse(owner.configuration_json)))return false;
    // A prefix must include every owned event through its boundary, not just its last ID.
    const owned=db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? AND id<=? ORDER BY id').all(executionId,events.at(-1)!.id);
    if(stableJson(owned)!==stableJson(events))return false;
    let node:string|undefined=definition.entry,input=e.input_text,traversals=0,last:string|null=null,current:Row|undefined,settled=false;
    let started=false,accepted=false,pendingLoop:string|undefined,interruption:Row|undefined,activeInvocation:Row|undefined;
    const authorized=new Map<string,number>(),exited=new Set<string>(),seen=new Set<string>(),invocations=new Map<string,number>(),loops=new Map<string,number>(),fences=new Map<string,number>();
    if(seed){
      const old=seed.selected,ids=seed.idMap,sp=old.paths![0]!;
      if(p.id!==ids[sp.id])return false;
      for(const oldStep of old.steps!){
        const step=selected.steps!.find(row=>row.id===ids[oldStep.id]);
        if(!step||step.path_id!==ids[oldStep.path_id]||['step_id','invocation','input_text'].some(key=>step[key]!==oldStep[key])
          ||oldStep.state==='completed'&&(step.state!=='completed'||step.result_json!==oldStep.result_json))return false;
        seen.add(step.id);invocations.set(step.step_id,Math.max(invocations.get(step.step_id)??0,step.invocation));
      }
      for(const oldAttempt of old.attempts!){
        const attempt=selected.attempts!.find(row=>row.id===ids[oldAttempt.id]);
        if(!attempt||attempt.step_execution_id!==ids[oldAttempt.step_execution_id]||['number','input_hash','purpose'].some(key=>attempt[key]!==oldAttempt[key])
          ||oldAttempt.state==='completed'&&(attempt.state!=='completed'||attempt.fence!==0||attempt.result_json!==oldAttempt.result_json))return false;
        fences.set(attempt.id,0);
      }
      for(const oldResult of old.sealedResults!){
        const result=selected.sealedResults!.find(row=>row.id===ids[oldResult.id]);
        if(!result||result.path_id!==ids[oldResult.path_id]||result.step_execution_id!==ids[oldResult.step_execution_id]
          ||result.terminal_attempt_id!==ids[oldResult.terminal_attempt_id]||result.result_json!==oldResult.result_json||result.content_hash!==oldResult.content_hash)return false;
      }
      node=sp.node_id;input=sp.input_text;traversals=sp.traversals;last=sp.last_result_id?ids[sp.last_result_id]!:null;
      current=sp.step_execution_id?selected.steps!.find(row=>row.id===ids[sp.step_execution_id]):undefined;
      for(const loop of old.loops!)loops.set(loop.edge_id,loop.iterations);
    }
    const text=(value:string)=>interpolateBranchText(value,definition,configuration);
    const follow=(edge:BranchDefinition['edges'][number]|undefined,output:string)=>{
      pendingLoop=edge?.loop?edge.id:undefined;
      node=edge?.to;input=edge?.input?.kind==='literal'?text(edge.input.text):output;
    };
    for(const event of events){
      const v=JSON.parse(event.evidence_json);
      if(pendingLoop&&event.kind!=='loop_traversed')return false;
      switch(event.kind){
        case 'trigger_accepted':
          if(accepted||started||v.versionId!==e.version_id||v.bindingRevisionId!==e.binding_revision_id||v.inputHash!==e.input_hash)return false;
          accepted=true;break;
        case 'workflow_started':if(!accepted||started)return false;started=true;break;
        case 'restored_prefix':case 'historical_rewind':if(!seed||!accepted||started)return false;break;
        case 'step_prepared':{
          if(interruption||!started||current||v.stepId!==node||seen.has(v.stepExecutionId))return false;
          const s=selected.steps!.find(s=>s.id===v.stepExecutionId);
          if(!s||s.step_id!==node||s.input_text!==input||s.invocation!==(invocations.get(node!)??0)+1)return false;
          invocations.set(node!,s.invocation);seen.add(s.id);current=s;settled=false;traversals++;break;
        }
        case 'script_leased':case 'script_authorized':case 'script_process_exit':case 'script_cleanup_observed':{
          const attemptId=event.kind==='script_process_exit'?event.transition_key.slice('process-exit:'.length).replace(/:[0-9]+$/u,''):v.attemptId;
          const a=selected.attempts!.find(a=>a.id===attemptId);
          const step=selected.steps!.find(s=>s.id===a?.step_execution_id);
          if(!a||!step||!seen.has(step.id)||step.state!=='completed')return false;
          if(!['script_cleanup_observed','script_process_exit'].includes(event.kind)&&current?.id!==step.id)return false;
          if(interruption&&['script_leased','script_authorized'].includes(event.kind))return false;
          if(event.kind==='script_authorized'){
            const fence=fences.get(a.id);
            if(!fence||fence!==a.fence||event.transition_key!==`launched:${a.id}:${fence}`)return false;
            authorized.set(a.id,fence);
          }
          if(event.kind==='script_process_exit'){
            // Other-generation observations remain evidence, never proof of this cut's exit.
            if(event.transition_key===`process-exit:${a.id}:${a.fence}`&&authorized.get(a.id)===a.fence&&fences.get(a.id)===a.fence){
              if(configuration.checkpointMode==='exit'&&(v.code!==0||v.error||v.stdout!==JSON.parse(step.result_json).output||v.outputHash!==hash(v.stdout)))return false;
              exited.add(a.id);
            }
          }
          if(event.kind==='script_leased'){
            if(event.transition_key!==`leased:${a.id}:${v.fence}`||v.fence!==(fences.get(a.id)??0)+1||v.sourceHash!==hash((definition.steps.find(s=>s.id===step.step_id) as Extract<BranchDefinition['steps'][number],{kind:'script'}>).source))return false;
            fences.set(a.id,v.fence);
          }
          break;
        }
        case 'step_settled':{
          const a=selected.attempts!.find(a=>a.id===v.attemptId);
          if(!current||settled||!a||a.step_execution_id!==current.id||stableJson(v.result)!==current.result_json)return false;
          settled=true;break;
        }
        case 'result_sealed':{
          const r=selected.sealedResults!.find(r=>r.id===v.resultId);
          if(!current||!settled||!r||r.step_execution_id!==current.id||v.stepExecutionId!==current.id||v.terminalAttemptId!==r.terminal_attempt_id||v.contentHash!==r.content_hash)return false;
          last=r.id;const result=JSON.parse(current.result_json);
          follow(definition.edges.find(edge=>edge.from===node&&edge.on==='success'),result.output??'');current=undefined;break;
        }
        case 'condition_selected':case 'route_selected':case 'route_invalid':{
          if(interruption||!started||current||v.pathId!==p.id)return false;
          const c=definition.controls.find(c=>c.id===node);if(!c)return false;
          let edge:BranchDefinition['edges'][number]|undefined;
          if(c.kind==='condition'){
            if(event.kind!=='condition_selected')return false;
            edge=definition.edges.find(edge=>edge.from===node&&edge.on===(input===text(c.predicate.equals)?'selected':'failure'));
          }else if(c.kind==='route'){
            const match=definition.edges.find(edge=>edge.from===node&&edge.on==='selected'&&edge.choice?.toLowerCase()===input.trim().toLowerCase());
            if(v.routeId!==node||v.choice!==input.trim()||event.kind!==(match?'route_selected':'route_invalid'))return false;
            edge=match??definition.edges.find(edge=>edge.from===node&&edge.on==='failure');
          }else return false;
          if(!edge||v.edgeId!==edge.id)return false;
          traversals++;follow(edge,input);break;
        }
        case 'loop_traversed':{
          const count=(loops.get(v.edgeId)??0)+1;
          if(v.pathId!==p.id||v.edgeId!==pendingLoop||v.iteration!==count)return false;
          loops.set(v.edgeId,count);pendingLoop=undefined;break;
        }
        case 'checkpoint_interrupt_requested':
          if(configuration.checkpointMode!=='exit'||!started||interruption||typeof v.interruptionId!=='string'||typeof v.invocationId!=='string'
            ||!Number.isSafeInteger(v.ordinal)||v.ordinal<1||!v.commandKey
            ||activeInvocation&&(activeInvocation.id!==v.invocationId||activeInvocation.ordinal!==v.ordinal)||!activeInvocation&&v.ordinal!==1)return false;
          interruption=v;break;
        case 'checkpoint_interrupt_resumed':
          if(!interruption||v.interruptionId!==interruption.interruptionId||v.invocationId!==interruption.invocationId
            ||v.nextOrdinal!==interruption.ordinal+1||typeof v.nextInvocationId!=='string'||v.nextInvocationId===v.invocationId)return false;
          activeInvocation={id:v.nextInvocationId,ordinal:v.nextOrdinal};interruption=undefined;break;
        case 'execution_budget_held':case 'execution_budget_released':break;
        default:return false;
      }
    }
    if(configuration.checkpointMode==='exit'&&(!interruption||interruption.interruptionId!==closing.interruptionId
      ||interruption.invocationId!==closing.id||interruption.ordinal!==closing.ordinal||[...authorized.keys()].some(id=>!exited.has(id))))return false;
    if(!started||pendingLoop||current&&current.state!=='prepared'||seen.size!==selected.steps!.length)return false;
    if(p.node_id!==node||p.input_text!==input||p.last_result_id!==last||p.step_execution_id!==(current?.id??null)||p.traversals!==traversals)return false;
    if(selected.attempts!.some(a=>a.fence!==(fences.get(a.id)??0)))return false;
    if(selected.loops!.length!==loops.size||selected.loops!.some(r=>loops.get(r.edge_id)!==r.iterations))return false;
    return true;
  }catch{return false;}
}
