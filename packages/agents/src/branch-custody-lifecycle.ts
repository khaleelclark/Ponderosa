import {createHash} from 'node:crypto';
import type {CheckpointPackageSource} from '@ponderosa/core';
import type {BranchStore} from './branch-store.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
export interface BranchCustodyReference {kind:'checkpoint'|'initial_checkpoint'|'command'|'admission';ownerId:string;key:string;sha256:string}
const abandonKey=(key:string)=>`custody-abandoned:${payloadHash(key)}`;
function contains(value:any,needle:string):boolean {
 if(typeof value==='string')return value.includes(needle);
 return !!value&&typeof value==='object'&&Object.values(value).some(v=>contains(v,needle));
}
function checkpointLink(value:any,id:number,sha256:string):boolean {
 if(contains(value,sha256))return true;
 if(typeof value==='string'&&/^[\[{]/u.test(value.trim())){
  try{return checkpointLink(JSON.parse(value),id,sha256);}catch{throw Error('Unrecognized serialized checkpoint lineage');}
 }
 if(!value||typeof value!=='object')return false;
 return Object.entries(value).some(([key,v])=>typeof v==='number'&&v===id&&/(checkpoint|lineage|snapshot).*id/iu.test(key)||v&&(typeof v==='object'||typeof v==='string'&&/^[\[{]/u.test(v.trim()))&&checkpointLink(v,id,sha256));
}
/** Synchronous owner hooks. Package lifecycle owns bytes and its durable release journal. */
export class BranchCustodyLifecycle {
 constructor(private readonly branches:BranchStore){}
 private get db(){return this.branches.sqlite;}
 private json(bytes:string):Row {const value=JSON.parse(bytes);if(stableJson(value)!==bytes)throw Error('Noncanonical Branch lifecycle evidence');return value;}
 private identity(source:CheckpointPackageSource):string {
  if(!source?.checkpointId||!source.sourceChatId||!source.agentIds?.length||new Set(source.agentIds).size!==source.agentIds.length
   ||source.agentIds.some(id=>typeof id!=='string'||!id)||!source.intent?.executionId||!source.intent.resourceStepId||!Number.isSafeInteger(source.intent.resourceGeneration)||source.intent.resourceGeneration<0
   ||[source.intent.frontierSha256,source.intent.bindingSha256,source.intent.configurationSha256,...(source.intent.hostCutSha256!==undefined?[source.intent.hostCutSha256]:[])].some(v=>!/^[a-f0-9]{64}$/.test(v)))throw Error('Exact checkpoint source required');
  return createHash('sha256').update(source.checkpointId).digest('hex');
 }
 captureDisposed(ownerId:string,key:string,bytes:string):boolean {
  const row=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(ownerId,abandonKey(key)) as Row|undefined;
  if(!row)return false;
  const receipt=this.json(row.result_json);
  if(row.input_hash!==payloadHash(receipt.input)||receipt.schema!=='branch-custody-abandon.v1'||receipt.input.captureKey!==key||receipt.input.captureSha256!==payloadHash(this.json(bytes)))throw Error('Abandoned capture receipt differs');
  return true;
 }
 references(source:CheckpointPackageSource):BranchCustodyReference[] {
  const custodyId=this.identity(source),refs:BranchCustodyReference[]=[];
  const matches=(value:Row)=>contains(value,custodyId)||contains(value,source.checkpointId);
  for(const [table,kind] of [['branch_unit_snapshots','checkpoint'],['branch_initial_checkpoints','initial_checkpoint']] as const){
   for(const row of this.db.prepare(`SELECT id,execution_id,snapshot_json,content_hash FROM ${table} ORDER BY id`).all() as Row[]){
    const value=this.json(row.snapshot_json);if(payloadHash(value)!==row.content_hash)throw Error('Branch checkpoint lifecycle integrity failure');
    if(matches(value))refs.push({kind,ownerId:row.execution_id,key:String(row.id),sha256:row.content_hash});
   }
  }
  for(const row of this.db.prepare('SELECT execution_id,command_key,input_hash,result_json FROM branch_commands ORDER BY execution_id,command_key').all() as Row[]){
   const value=this.json(row.result_json);
   // Reconciliation/release receipts retain audit identity, not executable custody.
   if(row.command_key.startsWith('custody-abandoned:')||row.command_key.startsWith('custody-retired-checkpoints:')){
    if(!['branch-custody-abandon.v1','branch-custody-checkpoint-retirement.v1'].includes(value.schema)||row.input_hash!==payloadHash(value.input))throw Error('Custody reconciliation receipt integrity failure');
    continue;
   }
   if(row.command_key.startsWith('custody-release:')){
    if(value.schema!=='branch-resource-custody-release.v1'||row.input_hash!==payloadHash({stepExecutionId:value.stepExecutionId,input:value.input}))throw Error('Custody release receipt integrity failure');
    continue;
   }
   if(!matches(value))continue;
   if(['branch-resource-capture.v1','branch-issued-resource-capture.v1'].includes(value.schema)){
    if(value.state==='released'||this.captureDisposed(row.execution_id,row.command_key,row.result_json))continue;
   }
   refs.push({kind:'command',ownerId:row.execution_id,key:row.command_key,sha256:payloadHash(value)});
  }
  // All admission states pin until Runtime supplies an explicit canonical retirement.
  for(const row of this.db.prepare('SELECT id,source_execution_id,reservation_json,snapshot_json FROM coordination_destination_admissions ORDER BY id').all() as Row[]){
   if(matches(this.json(row.reservation_json))||matches(this.json(row.snapshot_json)))refs.push({kind:'admission',ownerId:row.source_execution_id,key:row.id,sha256:payloadHash({reservation:row.reservation_json,snapshot:row.snapshot_json})});
  }
  return refs;
 }
 private drain(source:CheckpointPackageSource,requireDeletion=true):string[] {
  const blockers:string[]=[],owner=this.branches.execution(source.intent.executionId);
  const canceled=this.db.prepare('SELECT cancel_requested FROM branch_executions WHERE id=?').get(source.intent.executionId) as Row|undefined;
  if(owner&&!['completed','failed','canceled'].includes(owner.state)&&(requireDeletion||canceled?.cancel_requested!==1))blockers.push('owner_not_terminal_or_fenced');
  if(requireDeletion&&owner&&!this.branches.resourceHistoryCustodySettled(owner.id))blockers.push('resource_cleanup_not_proven');
  const status=this.branches.unitSaver.status(source.intent.executionId);
  if(status&&['pending','coalesced','coverage_unknown','failed'].includes(status.state))blockers.push('checkpoint_writer_not_settled');
  if(this.db.prepare("SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND a.state IN ('prepared','waiting','leased','running','outcome_unknown') LIMIT 1").get(source.intent.executionId))blockers.push('attempt_not_settled');
  if(this.db.prepare(`WITH RECURSIVE owned(id) AS (SELECT ? UNION SELECT e.id FROM branch_executions e JOIN owned p ON e.parent_execution_id=p.id)
   SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id IN (SELECT id FROM owned)
    AND (a.state IN ('leased','running','outcome_unknown') OR a.process_identity_json IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM branch_checkpoints p WHERE p.execution_id=s.execution_id AND p.kind='script_process_exit' AND p.transition_key='process-exit:'||a.id||':'||a.fence)) LIMIT 1`).get(source.intent.executionId))blockers.push('owned_native_exit_unconfirmed');
  const chat=this.db.prepare('SELECT storage_cleanup_completed,server_cleanup_completed FROM conversation_deletion_receipts WHERE conversation_id=?').get(source.sourceChatId) as Row|undefined;
  if(requireDeletion&&(this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(source.sourceChatId)||chat?.storage_cleanup_completed!==1||chat.server_cleanup_completed!==1))blockers.push('source_chat_cleanup_not_proven');
  for(const id of source.agentIds){
   if(this.db.prepare(`SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running') UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? LIMIT 1`).get(id,id,id))blockers.push(`participant_not_drained:${id}`);
   const agent=this.db.prepare('SELECT deleted_at FROM agents WHERE id=?').get(id) as Row|undefined;
   const deleted=this.db.prepare('SELECT 1 FROM agent_deletion_receipts r,json_each(r.deleted_agent_ids_json) m WHERE m.value=? LIMIT 1').get(id);
   if(requireDeletion&&(agent?.deleted_at===null||!deleted))blockers.push(`participant_deletion_not_proven:${id}`);
   if(requireDeletion&&this.db.prepare(`SELECT 1 FROM agent_deletion_receipts r,json_each(r.deleted_agent_ids_json) m WHERE m.value=? AND r.storage_cleanup_completed!=1 LIMIT 1`).get(id))blockers.push(`participant_cleanup_incomplete:${id}`);
   if(this.db.prepare(`SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending') LIMIT 1`).get(id))blockers.push(`participant_activation_not_drained:${id}`);
   if(this.db.prepare(`SELECT 1 FROM coordination_requests WHERE (recipient_agent_id=? OR requester_agent_id=?) AND state NOT IN ('completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded') LIMIT 1`).get(id,id))blockers.push(`participant_request_unresolved:${id}`);
   if(this.db.prepare("SELECT 1 FROM agent_creation_operation_members m JOIN agent_creation_operations o ON o.id=m.operation_id WHERE m.agent_id=? AND o.status NOT IN ('completed','rolled_back') LIMIT 1").get(id))blockers.push(`import_unresolved:${id}`);
  }
  for(const row of this.db.prepare("SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'resource-operation:%'").all(source.intent.executionId) as Row[]){
   if(['running','unknown'].includes(this.json(row.result_json).state))blockers.push('resource_operation_unconfirmed');
  }
  return blockers;
 }
 inspect(source:CheckpointPackageSource){
  const custodyId=this.identity(source),references=this.references(source),blockers=this.drain(source),abandonmentBlockers=this.drain(source,false);
  const evidence={source,custodyId,references,blockers,abandonmentBlockers,ownerState:this.branches.execution(source.intent.executionId)?.state??'absent'};
  return {...evidence,revision:payloadHash(evidence),releaseAllowed:references.length===0&&blockers.length===0};
 }
 /** Must run in the package owner's root transaction immediately before its release intent. */
 assertRelease(source:CheckpointPackageSource,expectedRevision:string){
  if(!this.db.inTransaction)throw Error('Custody release requires same owner transaction');
  const current=this.inspect(source);
  if(current.revision!==expectedRevision||!current.releaseAllowed)throw Error('Branch custody references or drain proof changed/held');
  return current;
 }
 /** Explicitly retire selected historical rows; never infer deletion from an unavailable preview. */
 retireCheckpoints(source:CheckpointPackageSource,input:{commandKey:string;expectedRevision:string;checkpoints:{id:number;sha256:string}[]}){
  this.identity(source);
  if(!input.commandKey||input.commandKey.length>200||!input.checkpoints.length||new Set(input.checkpoints.map(c=>c.id)).size!==input.checkpoints.length
   ||input.checkpoints.some(c=>!Number.isSafeInteger(c.id)||c.id<1||!/^[a-f0-9]{64}$/.test(c.sha256)))throw Error('Exact checkpoint retirement selection required');
  return this.branches.unitTransaction(()=>{
   const owner=source.intent.executionId,key=`custody-retired-checkpoints:${payloadHash(input.commandKey)}`,exact={...input,source};
   const prior=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner,key) as Row|undefined;
   if(prior){if(prior.input_hash!==payloadHash(exact))throw Error('Checkpoint retirement command conflict');return this.json(prior.result_json);}
   const current=this.inspect(source);
   const pendingCapture=current.references.some(r=>r.kind==='command'&&r.ownerId===owner&&(()=>{
    const row=this.db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner,r.key) as Row;
    const value=this.json(row.result_json);return ['branch-resource-capture.v1','branch-issued-resource-capture.v1'].includes(value.schema)&&value.state==='capturing'&&stableJson(value.source)===stableJson(source);
   })());
   if(current.revision!==input.expectedRevision||(pendingCapture?current.abandonmentBlockers:current.blockers).length||current.references.some(r=>r.kind==='admission'))throw Error('Checkpoint retirement remains held');
   const selected=new Set(input.checkpoints.map(c=>c.id)),retiredCaptures=new Map<string,Row>();
   for(const cp of input.checkpoints){
    if(!current.references.some(r=>r.kind==='checkpoint'&&r.ownerId===owner&&r.key===String(cp.id)&&r.sha256===cp.sha256))throw Error('Checkpoint selection/hash is not current custody evidence');
    for(const row of this.db.prepare('SELECT id,snapshot_json FROM branch_unit_snapshots').all() as Row[]){
     if(!selected.has(row.id)&&checkpointLink(this.json(row.snapshot_json),cp.id,cp.sha256))throw Error('Another retained checkpoint pins the selected history');
    }
    for(const row of this.db.prepare('SELECT execution_id,command_key,result_json FROM branch_commands').all() as Row[]){
     if(row.command_key.startsWith('custody-retired-checkpoints:')||row.command_key.startsWith('custody-abandoned:'))continue;
     const command=this.json(row.result_json);
     if(!checkpointLink(command,cp.id,cp.sha256))continue;
     if(row.execution_id===owner&&command.schema==='branch-issued-resource-capture.v1'&&command.state==='retained'
      &&command.checkpointId===cp.id&&command.checkpointHash===cp.sha256&&stableJson(command.source)===stableJson(source))retiredCaptures.set(row.command_key,command);
     else throw Error('An owner command pins the selected checkpoint');
    }
    for(const row of this.db.prepare('SELECT id,snapshot_json FROM branch_initial_checkpoints').all() as Row[]){
     if(checkpointLink(this.json(row.snapshot_json),cp.id,cp.sha256))throw Error('Initial checkpoint pins selected history');
    }
   }
   const receipt={schema:'branch-custody-checkpoint-retirement.v1',input:exact,custodyId:current.custodyId,state:'retired',createdAt:new Date().toISOString()};
   for(const cp of input.checkpoints)this.db.prepare('DELETE FROM branch_unit_snapshots WHERE execution_id=? AND id=? AND content_hash=?').run(owner,cp.id,cp.sha256);
   for(const [captureKey,capture] of retiredCaptures){
    const dispositionInput={commandKey:input.commandKey,captureKey,captureSha256:payloadHash(capture),expectedRevision:input.expectedRevision,source};
    const disposition={schema:'branch-custody-abandon.v1',input:dispositionInput,custodyId:current.custodyId,state:'retired',createdAt:receipt.createdAt};
    this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(owner,abandonKey(captureKey),payloadHash(dispositionInput),stableJson(disposition),receipt.createdAt);
   }
   this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(owner,key,payloadHash(exact),stableJson(receipt),receipt.createdAt);
   return receipt;
  }).immediate();
 }
 /** Preserve the original abandoned intent and record an exact non-revivable disposition. */
 abandonCapture(source:CheckpointPackageSource,input:{commandKey:string;captureKey:string;captureSha256:string;expectedRevision:string},confirmPackageRetired:()=>{custodyId:string;sourceSha256:string;revision:string}){
  this.identity(source);
  if(!input.commandKey||input.commandKey.length>200)throw Error('Reconciliation command key required');
  return this.branches.unitTransaction(()=>{
   const owner=source.intent.executionId,key=abandonKey(input.captureKey),prior=this.db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner,key) as Row|undefined;
   const exact={...input,source};
   if(prior){if(prior.input_hash!==payloadHash(exact))throw Error('Abandonment command conflict');return this.json(prior.result_json);}
   const current=this.inspect(source),row=this.db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(owner,input.captureKey) as Row|undefined;
   const capture=row&&this.json(row.result_json);
   if(current.revision!==input.expectedRevision||current.abandonmentBlockers.length||!capture||capture.state!=='capturing'||capture.receipt
    ||!['branch-resource-capture.v1','branch-issued-resource-capture.v1'].includes(capture.schema)||stableJson(capture.source)!==stableJson(source)||payloadHash(capture)!==input.captureSha256
    ||current.references.some(ref=>ref.kind!=='command'||ref.ownerId!==owner||ref.key!==input.captureKey))throw Error('Capture remains referenced or unconfirmed; abandonment refused');
   const packageRetirement=confirmPackageRetired();
   if(packageRetirement.custodyId!==current.custodyId||packageRetirement.sourceSha256!==payloadHash(source)||!packageRetirement.revision)throw Error('Exact durable package retirement proof required');
   const receipt={schema:'branch-custody-abandon.v1',input:exact,packageRetirement,custodyId:current.custodyId,state:'abandoned',createdAt:new Date().toISOString()};
   this.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(owner,key,payloadHash(exact),stableJson(receipt),receipt.createdAt);
   return receipt;
  }).immediate();
 }
}
