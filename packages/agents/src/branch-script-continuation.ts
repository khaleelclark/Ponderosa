import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {BranchDefinition} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {branchText} from './branch-definition.js';
import {validateBranchConfiguration} from './branch-parameters.js';

type Row=Record<string,any>;
export type Selected=Record<string,Row[]>;
export const SCRIPT_CONTINUATION_COMPATIBILITY={format:'script-control-frontier.v1',nodeMajor:Number(process.versions.node.split('.')[0])};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
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
    if(definition.steps.some(s=>s.kind!=='script'||s.runtime!=='node'||s.failure&&s.failure.action!=='stop')||definition.policy.failure.action!=='stop'
      ||definition.controls.some(c=>!['condition','route'].includes(c.kind))||Object.values(definition.parameters??{}).some(p=>p.type==='secret'))return false;
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
  const e=selected.execution![0]!;
  return {schema:'ponderosa.branch.script-continuation.v1',compatibility:SCRIPT_CONTINUATION_COMPATIBILITY,
    versionId:e.version_id,versionHash:owner.version_hash,bindingRevisionId:e.binding_revision_id,bindingHash:owner.binding_hash,configuration:safeConfiguration,
    audit:db.prepare('SELECT id,transition_key,kind,evidence_json,created_at FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(executionId)};
}

export function scriptAuditSupported(audit:unknown):boolean {
  if(!Array.isArray(audit)||!audit.some(r=>r.kind==='trigger_accepted')||!audit.some(r=>r.kind==='workflow_started'))return false;
  let previous=0;const keys=new Set<string>();
  try{return audit.every(r=>{
    if(!Number.isSafeInteger(r.id)||r.id<=previous||typeof r.kind!=='string'||typeof r.transition_key!=='string'||keys.has(r.transition_key)||typeof r.created_at!=='string'||typeof r.evidence_json!=='string'||stableJson(JSON.parse(r.evidence_json))!==r.evidence_json)return false;
    previous=r.id;keys.add(r.transition_key);return true;
  });}catch{return false;}
}
