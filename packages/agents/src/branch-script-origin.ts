import type Database from 'better-sqlite3';
import type {BranchDefinition,BranchPortableRuntimeOwner} from '@ponderosa/core';
import {branchText} from './branch-definition.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
const triggerLimits={maxDepth:64,maxNodes:250_000};

// Standalone, serial-tree and parallel/mixed-tree retries require separate opt-ins.
export function automaticScriptDefinitionSupported(definition:BranchDefinition,calls=false,scriptRetries=false,parallelRetries=false,serialTreeRetries=false,parallelTreeRetries=false):boolean {
  const retries=!calls&&(scriptRetries&&definition.controls.every(c=>['condition','route'].includes(c.kind))
    ||parallelRetries&&definition.controls.some(c=>c.kind==='fork'||c.kind==='map'))
    ||calls&&(serialTreeRetries&&definition.controls.every(c=>['condition','route'].includes(c.kind))||parallelTreeRetries);
  return ['schedule','webhook','filesystem'].includes(definition.trigger.kind)&&definition.policy.failure.action==='stop'&&definition.steps.every(s=>(s.kind==='script'||s.kind==='human_gate'||calls&&s.kind==='branch_call')&&(!s.failure||s.failure.action==='stop'||retries&&s.kind==='script'&&s.runtime==='node'&&s.failure.action==='retry'))&&definition.controls.every(c=>['condition','route','fork','map','join'].includes(c.kind));
}
/** Same immutable untrusted input at native intake and historical verification. */
export function branchTriggerInput(payload:unknown,occurrenceId:string,provenance:Row,payloadMediaType:string):string {
  try {return branchText(stableJson({payload,occurrenceId,provenance,payloadMediaType}));}
  catch {return stableJson({artifactRef:`trigger-occurrence:${occurrenceId}`,notice:'Event exceeds inline input limit. Retrieve this explicit occurrence reference for its complete untrusted payload and provenance.'});}
}
/** Occurrence data is historical evidence only, never scheduler or destination authority. */
export function automaticScriptOriginSupported(db:Database.Database|null,e:Row,definition:BranchDefinition,source?:BranchPortableRuntimeOwner|null,calls=false,scriptRetries=false,parallelRetries=false,serialTreeRetries=false,parallelTreeRetries=false):boolean {
 try {
  if(source===null||!source&&!db||!automaticScriptDefinitionSupported(definition,calls,scriptRetries,parallelRetries,serialTreeRetries,parallelTreeRetries)||e.admission_source!=='automatic'||e.parent_execution_id||e.parent_attempt_id||e.call_depth)return false;
  const read=(kind:string)=>{const facts=source!.facts.filter(f=>f.kind===kind);if(facts.length!==1)throw Error('Missing original origin fact');return JSON.parse(facts[0]!.json);};
  const original=source?read('frontier').execution[0]:db!.prepare('SELECT * FROM branch_executions WHERE id=?').get(e.id) as Row|undefined;
  if(!original||['id','branch_id','version_id','binding_revision_id','occurrence_key','admission_source','input_text','input_hash'].some(key=>original[key]!==e[key]))return false;
  const origin=source?read('provenance'):JSON.parse(original.provenance_json);
  if(origin.source!=='trigger'||typeof origin.occurrenceId!=='string'||!origin.occurrenceId||e.occurrence_key!==`trigger:${origin.occurrenceId}`)return false;
  const retained=source?read('trigger'):undefined;
  if(source&&(retained.currentAuthority!==false||retained.disposition!=='retained_data'))return false;
  const row=source?retained.occurrence:db!.prepare('SELECT * FROM trigger_occurrences WHERE id=? AND branch_execution_id=? AND branch_id=?').get(origin.occurrenceId,e.id,e.branch_id) as Row|undefined;
  if(!row||row.id!==origin.occurrenceId||row.branch_execution_id!==e.id||row.branch_id!==e.branch_id||row.state!=='activated'||typeof row.trigger_id!=='string'||!row.trigger_id||typeof row.occurrence_key!=='string'||!row.occurrence_key||typeof row.payload_media_type!=='string'||!row.payload_media_type)return false;
  const payload=JSON.parse(row.payload_json),provenance=JSON.parse(row.provenance_json),snapshot=JSON.parse(row.trigger_snapshot_json);
  if(stableJson(payload,triggerLimits)!==row.payload_json||stableJson(provenance,triggerLimits)!==row.provenance_json||stableJson(snapshot,triggerLimits)!==row.trigger_snapshot_json||typeof provenance.source!=='string'||!provenance.source)return false;
  if(snapshot.productScope!=='branches'||snapshot.id!==row.trigger_id||snapshot.branchId!==e.branch_id||snapshot.sourceKind!==definition.trigger.kind||snapshot.enabled!==true||snapshot.fullAccess!==true||!snapshot.sourceConfig||typeof snapshot.sourceConfig!=='object'||Array.isArray(snapshot.sourceConfig))return false;
  const inputHash=payloadHash({triggerId:row.trigger_id,occurrenceKey:row.occurrence_key,payload,payloadMediaType:row.payload_media_type},triggerLimits);
  if(row.input_hash!==inputHash||e.input_hash!==inputHash||e.input_text!==branchTriggerInput(payload,row.id,provenance,row.payload_media_type)||stableJson(origin)!==stableJson({...provenance,source:'trigger',occurrenceId:row.id,contentInjected:false}))return false;
  const events:Row[]=source?source.facts.filter(f=>f.kind==='transition').map(f=>JSON.parse(f.json)):db!.prepare('SELECT kind,transition_key,evidence_json FROM branch_checkpoints WHERE execution_id=? ORDER BY id').all(e.id) as Row[];
  const accepted=events.filter(a=>a.kind==='trigger_accepted'),started=events.filter(a=>a.kind==='workflow_started');
  if(accepted.length!==1||accepted[0].transition_key!=='accepted'||accepted[0].evidence_json!==stableJson({versionId:e.version_id,bindingRevisionId:e.binding_revision_id,inputHash})||started.length!==1||started[0].transition_key!=='workflow-started')return false;
  const start=JSON.parse(started[0].evidence_json);
  if(stableJson(start)!==started[0].evidence_json||!['charged','unlimited'].includes(start.admission?.kind)||start.admission.budget?.branchId!==e.branch_id)return false;
  return !!source||typeof original.admitted_at==='string'&&!!original.admitted_at&&original.admission_json===stableJson(start.admission);
 }catch{return false;}
}
