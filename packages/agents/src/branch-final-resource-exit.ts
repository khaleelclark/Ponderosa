import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {fenceBranchFinalResourceExit} from './branch-generation-exit-fence.js';
import {captureFinalResourceExitEnvelope} from './branch-generation-exit-capture.js';
import {captureFinalProviderStarts,verifyFinalProviderStarts} from './provider-start-journal.js';
import {captureFinalProviderExits,verifyFinalProviderExits,verifyRetainedProviderExitEvidence} from './provider-exit-evidence.js';
import {encodeIssuedResourceContinuation,issuedResourceContinuationSupported,readIssuedResourceContinuation} from './branch-issued-resource-continuation.js';
import {issuedResourceCapture} from './branch-issued-resource-capture.js';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut,verifyBranchHostCut} from './branch-host-cut.js';
import {verifyHostProvenance} from './branch-host-provenance.js';
import {captureGenerationOneHost,generationOneEvidence} from './branch-resource-generation-one.js';
type Row=Record<string,any>;
export const finalResourceExitKey=(stepId:string,generation=0)=>`resource-final-exit:${stepId}:${generation}`;
function issuedCaptureCommands(db:Database.Database,executionId:string,stepId:string):string[]{
 const prefix='issued-resource-capture:';
 const matches:string[]=[];
 for(const row of db.prepare("SELECT command_key,input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'issued-resource-capture:%'").all(executionId) as Row[]){
  const journal=JSON.parse(row.result_json),intent=journal.source?.intent,commandKey=row.command_key.slice(prefix.length);
  if(journal.schema!=='branch-issued-resource-capture.v1'||stableJson(journal)!==row.result_json||!['capturing','retained'].includes(journal.state)
    ||!commandKey||typeof intent?.resourceStepId!=='string'||!intent.resourceStepId||intent.executionId!==executionId
    ||!Number.isSafeInteger(intent.resourceGeneration)||intent.resourceGeneration<0
    ||row.input_hash!==payloadHash({stepId:intent.resourceStepId,generation:intent.resourceGeneration,commandKey}))throw Error('Issued capture command owner differs');
  const disposed=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`custody-abandoned:${payloadHash(row.command_key)}`) as Row|undefined;
  if(disposed){
   const d=JSON.parse(disposed.result_json),input=d.input,custodyId=typeof journal.source?.checkpointId==='string'?createHash('sha256').update(journal.source.checkpointId).digest('hex'):'';
   if(stableJson(d)!==disposed.result_json||d.schema!=='branch-custody-abandon.v1'||disposed.input_hash!==payloadHash(input)||input?.captureKey!==row.command_key
    ||input.captureSha256!==payloadHash(journal)||stableJson(input.source)!==stableJson(journal.source)||typeof input.commandKey!=='string'||!input.commandKey||typeof input.expectedRevision!=='string'||!input.expectedRevision||d.custodyId!==custodyId||!custodyId)throw Error('Issued capture disposition differs');
   if(d.state==='abandoned'){
    if(journal.state!=='capturing'||journal.receipt||d.packageRetirement?.custodyId!==custodyId||d.packageRetirement?.sourceSha256!==payloadHash(journal.source)||typeof d.packageRetirement?.revision!=='string'||!d.packageRetirement.revision)throw Error('Issued capture abandonment proof differs');
   }else if(d.state==='retired'){
    const retirement=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`custody-retired-checkpoints:${payloadHash(input.commandKey)}`) as Row|undefined;
    const proof=retirement&&JSON.parse(retirement.result_json),checkpoint=proof?.checkpointEvidence?.find((item:Row)=>item.id===journal.checkpointId&&item.execution_id===executionId);
    if(journal.state!=='retained'||!retirement||stableJson(proof)!==retirement.result_json||retirement.input_hash!==payloadHash(proof.input)
      ||proof.schema!=='branch-custody-checkpoint-retirement.v1'||proof.state!=='retired'||proof.custodyId!==custodyId
      ||proof.input?.commandKey!==input.commandKey||proof.input?.expectedRevision!==input.expectedRevision||stableJson(proof.input?.source)!==stableJson(journal.source)
      ||!proof.input?.checkpoints?.some((item:Row)=>item.id===journal.checkpointId&&item.sha256===journal.checkpointHash)
      ||!checkpoint||checkpoint.content_hash!==journal.checkpointHash||payloadHash(JSON.parse(checkpoint.snapshot_json))!==journal.checkpointHash
      ||stableJson(JSON.parse(checkpoint.snapshot_json))!==stableJson({...journal.snapshot,issuedResourceCustody:journal.receipt}))throw Error('Issued checkpoint retirement proof differs');
   }else throw Error('Issued capture disposition state differs');
   continue;
  }
  if(intent.resourceStepId===stepId)matches.push(commandKey);
 }
 return matches;
}
export function finalResourceIssuedCheckpointRequired(db:Database.Database,executionId:string,stepId:string):boolean{
 if(issuedCaptureCommands(db,executionId,stepId).length)return true;
 return (db.prepare('SELECT snapshot_json FROM branch_unit_snapshots WHERE execution_id=?').all(executionId) as Row[]).some(row=>{
  const snapshot=JSON.parse(row.snapshot_json);
  return snapshot.captureKind==='issued_resource'&&snapshot.selected?.resources?.some((resource:Row)=>resource.step_execution_id===stepId);
 });
}
function issuedCheckpoint(db:Database.Database,executionId:string,stepId:string){
 // A retained journal remains an obligation even if its committed snapshot goes missing.
 const journals=issuedCaptureCommands(db,executionId,stepId).map(command=>issuedResourceCapture(db,executionId,stepId,command));
 if(journals.some(journal=>journal?.state!=='retained'))throw Error('Issued resource checkpoint capture remains unresolved');
 const checkpoint=(db.prepare('SELECT id,snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? ORDER BY id DESC').all(executionId) as Row[]).find(row=>{
  const snapshot=JSON.parse(row.snapshot_json);
  return snapshot.captureKind==='issued_resource'&&snapshot.selected?.resources?.some((resource:Row)=>resource.step_execution_id===stepId);
 });
 if(checkpoint&&!journals.some(journal=>journal?.checkpointId===checkpoint.id&&journal?.checkpointHash===checkpoint.content_hash))throw Error('Issued checkpoint retained capture journal unavailable');
 return checkpoint;
}
function scope(db:Database.Database,stepId:string){
 const r=db.prepare('SELECT r.*,e.branch_id,e.version_id,e.binding_revision_id,e.configuration_json,e.parent_execution_id,e.parent_attempt_id,e.call_depth,e.admission_source,e.provenance_json FROM branch_resources r JOIN branch_executions e ON e.id=r.execution_id WHERE r.step_execution_id=?').get(stepId) as Row|undefined;
 if(!r||!Number.isSafeInteger(r.generation)||r.generation<0||r.retry_draining!==0||!['active','draining'].includes(r.state)||r.parent_execution_id||r.parent_attempt_id||r.call_depth!==0||r.admission_source!=='manual'||JSON.parse(r.provenance_json).source!=='manual')throw Error('Original standalone manual final resource required');
 const pins=db.prepare('SELECT v.definition_json,v.content_hash,b.bindings_json,b.content_hash binding_hash FROM branch_versions v JOIN branch_bindings b ON b.branch_id=v.branch_id WHERE v.id=? AND b.id=? AND v.branch_id=?').get(r.version_id,r.binding_revision_id,r.branch_id) as Row|undefined;
 if(!pins||JSON.parse(pins.definition_json).steps.some((s:Row)=>s.kind==='agent'&&s.target.kind!=='ephemeral_organization')||JSON.parse(pins.definition_json).trigger?.kind!=='manual'||payloadHash(JSON.parse(pins.definition_json))!==pins.content_hash||payloadHash(JSON.parse(pins.bindings_json))!==pins.binding_hash)throw Error('Final resource pins differ');
 const count=db.prepare('SELECT count(*) n FROM branch_resources WHERE execution_id=?').get(r.execution_id) as {n:number};
 if(count.n!==1)throw Error('Final resource group scope unsupported');
 const chat=db.prepare('SELECT project_id,branch_id,branch_execution_id FROM conversations WHERE id=?').get(r.chat_id) as Row|undefined;
 const ids=(db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(stepId) as Row[]).map(r=>r.agent_id);
 const live=(db.prepare('SELECT id FROM agents WHERE conversation_id=? AND deleted_at IS NULL ORDER BY id').all(r.chat_id) as Row[]).map(r=>r.id);
 if(!chat||chat.branch_id!==r.branch_id||chat.branch_execution_id!==r.execution_id||!ids.length||stableJson(ids)!==stableJson(live)||db.prepare('SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=?').get(r.chat_id))throw Error('Final resource complete precleanup identity required');
 const context=db.prepare('SELECT * FROM branch_ephemeral_contexts WHERE step_execution_id=? AND generation=?').get(stepId,r.generation) as Row|undefined;
 if(!context||context.chat_id!==r.chat_id||stableJson(JSON.parse(context.agent_ids_json).sort())!==stableJson(ids))throw Error('Final resource context differs');
 // A permanent fence must never be installed for a frontier that cannot yet be replayed.
 const selected=selectBranchUnit(db,r.execution_id);
 const retry=r.generation>0?captureGenerationOneHost(db,selected):undefined;
 const currentSelected=retry?.selected??selected,host=retry?.host??captureBranchHostCut(db,r.execution_id,currentSelected);
 if(!host)throw Error('Final resource replay host unavailable');
 encodeIssuedResourceContinuation(db,r.execution_id,currentSelected,host,false,retry?.generationRetry);
 const checkpoint=issuedCheckpoint(db,r.execution_id,stepId);
 if(!checkpoint&&finalResourceIssuedCheckpointRequired(db,r.execution_id,stepId))throw Error('Committed issued resource checkpoint unavailable');
 if(checkpoint)readIssuedResourceContinuation(db,r.execution_id,checkpoint.id,checkpoint.content_hash);
 return {executionId:r.execution_id,stepId,generation:r.generation,projectId:chat.project_id,chatId:r.chat_id,agentIds:ids,creationKey:r.creation_key,branchId:r.branch_id,versionId:r.version_id,bindingRevisionId:r.binding_revision_id,configurationSha256:payloadHash(JSON.parse(r.configuration_json))};
}
export function fenceFinalResourceExit(db:Database.Database,stepId:string){
 if(!db.inTransaction)throw Error('Final fence requires owner transaction');
 const identity=scope(db,stepId);
 const intakeFence=fenceBranchFinalResourceExit(db,{executionId:identity.executionId,stepExecutionId:stepId,generation:identity.generation,projectId:identity.projectId,conversationId:identity.chatId,agentIds:identity.agentIds});
 return {purpose:'final-resource' as const,identity,intakeFence};
}
export function captureFinalResourceExit(db:Database.Database,journal:ReturnType<typeof fenceFinalResourceExit>):void {
 if(!db.inTransaction)throw Error('Final capture requires owner transaction');
 if(stableJson(scope(db,journal.identity.stepId))!==stableJson(journal.identity))throw Error('Final resource identity changed after drain');
 // Recheck cleanup eligibility and immutable creation/fence bytes inside the commit.
 if(stableJson(fenceFinalResourceExit(db,journal.identity.stepId))!==stableJson(journal))throw Error('Final fence changed after drain');
 const envelope=captureFinalResourceExitEnvelope(db,journal),i=journal.identity;
 const continuationSelected=i.generation>0?generationOneEvidence(db,envelope.selected).selected:envelope.selected;
 const latestContinuation=encodeIssuedResourceContinuation(db,i.executionId,continuationSelected,envelope.hostDependencies,false,envelope.generationRetry);
 const selectedRow=issuedCheckpoint(db,i.executionId,i.stepId);
 if(!selectedRow)throw Error('Actual committed issued-resource selected checkpoint required');
 readIssuedResourceContinuation(db,i.executionId,selectedRow.id,selectedRow.content_hash);
 const configuration=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(i.executionId) as Row;
 const definition=db.prepare('SELECT definition_json,content_hash FROM branch_versions WHERE id=? AND branch_id=?').get(i.versionId,i.branchId) as Row;
 const bindings=db.prepare('SELECT bindings_json,content_hash FROM branch_bindings WHERE id=? AND branch_id=?').get(i.bindingRevisionId,i.branchId) as Row;
 const starts=captureFinalProviderStarts(db,{projectId:i.projectId,conversationId:i.chatId,agentIds:i.agentIds},envelope.providerExitEvidence);
 const exits=captureFinalProviderExits(db,envelope.providerExitEvidence);
 const value={schema:'branch-final-resource-exit.v1',purpose:'final-resource',identity:i,intakeFence:journal.intakeFence,envelope,latestContinuation,
  selectedCheckpoint:selectedRow,configuration,definition,bindings,starts,exits};
 if(Buffer.byteLength(stableJson(value))>32*1024*1024)throw Error('Final resource exit envelope exceeds bound');
 const json=stableJson(value),hash=payloadHash(value),key=finalResourceExitKey(i.stepId,i.generation);
 const prior=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(i.executionId,key) as Row|undefined;
 if(prior){if(prior.input_hash!==hash||prior.result_json!==json)throw Error('Final resource exit command conflict');}
 else db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(i.executionId,key,hash,json,new Date().toISOString());
 readFinalResourceExit(db,i.executionId,i.stepId);
 if(stableJson(selectBranchUnit(db,i.executionId))!==stableJson(envelope.selected))throw Error('Final source frontier changed before commit');
}

/** Native deletion readback; no final command can be replaced by a retry snapshot. */
export function readFinalResourceExit(db:Database.Database,executionId:string,stepId:string){
 return db.transaction(()=>{
 const prefix=`resource-final-exit:${stepId}:`;
 const rows=db.prepare('SELECT command_key,input_hash,result_json FROM branch_commands WHERE execution_id=? AND substr(command_key,1,?)=?').all(executionId,prefix.length,prefix) as Row[];
 if(rows.length!==1)throw Error('Authentic final resource exit command unavailable or ambiguous');
 const row=rows[0]!;
 const value=JSON.parse(row.result_json);
 if(!Number.isSafeInteger(value.identity?.generation)||value.identity.generation<0||row.command_key!==finalResourceExitKey(stepId,value.identity.generation))throw Error('Final exit generation key differs');
 verifyFinalResourceExitBytes(value,row.input_hash);
 if(value.identity.executionId!==executionId||value.identity.stepId!==stepId)throw Error('Final exit owner differs');
 if(value.identity.generation>0){
  // Readback must still have the exact independent prior retirement chain, not just its saved hash.
  const e=value.envelope,proof=generationOneEvidence(db,e.selected);
  if(stableJson(e.generationRetry)!==stableJson(value.latestContinuation?.generationRetry)
   ||!issuedResourceContinuationSupported(db,executionId,proof.selected,e.hostDependencies,value.latestContinuation))throw Error('Final prior generation replay differs');
 }
 const f=db.prepare("SELECT input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(value.intakeFence.identity) as Row|undefined;
 const retained=value.starts.rows.find((r:Row)=>r.kind==='branch-generation-exit-fence');
 if(!f||!retained||f.input_json!==retained.input_json||f.receipt_json!==retained.receipt_json||f.receipt_sha256!==retained.receipt_sha256)throw Error('Final original permanent fence unavailable');
 verifyRetainedProviderExitEvidence(db,value.envelope.providerExitEvidence);
 const currentStarts=captureFinalProviderStarts(db,{projectId:value.identity.projectId,conversationId:value.identity.chatId,agentIds:value.identity.agentIds},value.envelope.providerExitEvidence);
 if(stableJson(currentStarts)!==stableJson(value.starts))throw Error('Final original start census changed');
 for(const retained of value.exits.commits){
  const original=db.prepare('SELECT input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind=? AND identity=?').get(retained.kind,retained.identity) as Row|undefined;
  if(!original||original.input_json!==retained.input_json||original.receipt_json!==retained.receipt_json||original.receipt_sha256!==retained.receipt_sha256)throw Error('Final original provider commit changed');
 }
 const cp=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(value.selectedCheckpoint.id,executionId) as Row|undefined;
 if(!cp||cp.snapshot_json!==value.selectedCheckpoint.snapshot_json||cp.content_hash!==value.selectedCheckpoint.content_hash)throw Error('Final committed selected checkpoint differs');
 return value;
 })();
}

/** Structural bytes checks only; native callers also require the original live census/readbacks. */
function verifyFinalResourceExitBytes(v:Row,hash:string):void {
 if(v.schema!=='branch-final-resource-exit.v1'||v.purpose!=='final-resource'||payloadHash(v)!==hash||Buffer.byteLength(stableJson(v))>32*1024*1024)throw Error('Final exit command integrity differs');
 const i=v.identity,e=v.envelope;
 if(!Number.isSafeInteger(i.generation)||i.generation<0||e.schema!=='branch-final-resource-exit-envelope.v1'||stableJson(e.identity)!==stableJson(i)||stableJson(e.intakeFence)!==stableJson(v.intakeFence)||!verifyBranchHostCut(e.hostDependencies,i.executionId))throw Error('Final exit envelope scope differs');
 verifyHostProvenance(e.hostDependencies);
 const h=e.hostDependencies,selected=e.selected,r=selected.resources?.[0],execution=selected.execution?.[0];
 const terminal=['completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'];
 if(!h.coverage.complete||h.coverage.missingReferences.length||h.artifactRefs.length||h.bindingPin.requiredSecretRefs.length
  ||selected.resources?.length!==1||!r||r.execution_id!==i.executionId||r.step_execution_id!==i.stepId||r.generation!==i.generation||r.retry_draining!==0||r.chat_id!==i.chatId||r.creation_key!==i.creationKey
  ||!execution||execution.id!==i.executionId||execution.branch_id!==i.branchId||execution.version_id!==i.versionId||execution.binding_revision_id!==i.bindingRevisionId||execution.admission_source!=='manual'||execution.parent_execution_id||execution.parent_attempt_id||execution.call_depth
  ||h.bindingPin.revisionId!==i.bindingRevisionId||h.bindingPin.sha256!==v.bindings.content_hash
  ||h.requests.some(({row}:Row)=>!terminal.includes(row.state))||h.joins.some(({row}:Row)=>row.state==='open')||h.suspensions.some(({row}:Row)=>row.state==='open'||row.dependency_kind!=='join'))throw Error('Final complete host/resource closure differs');
 const closure=e.effectClosure;
 if(!closure||closure.requests.some((q:Row)=>{const {reply_authority_json: _authority,...hostRequest}=q;return !terminal.includes(q.state)||!h.requests.some(({row}:Row)=>stableJson(row)===stableJson(hostRequest));})
  ||closure.joins.some((q:Row)=>q.state==='open'||!h.joins.some(({row}:Row)=>stableJson(row)===stableJson(q)))
  ||closure.activations.some((a:Row)=>!i.agentIds.includes(a.agent_id)||['pending','attached','retry_pending','outcome_unknown'].includes(a.state))
  ||closure.imports.some((o:Row)=>!['completed','rolled_back'].includes(o.status)))throw Error('Final effect census remains unresolved');
 const imported=JSON.parse(r.import_operation_json);
 if(imported.state!=='completed'||imported.schema!=='branch-resource-operation.v1'||imported.phase!=='import'||!closure.imports.some((o:Row)=>o.id===imported.creationOperationId&&o.kind==='import'&&o.status==='completed'&&o.project_id===i.projectId&&o.conversation_id===i.chatId))throw Error('Final completed creation provenance differs');
 const context=h.resourceContexts.filter(({row}:Row)=>row.step_execution_id===i.stepId);
 if(context.length!==1||context[0].row.generation!==i.generation||context[0].row.chat_id!==i.chatId||stableJson(JSON.parse(context[0].row.agent_ids_json).sort())!==stableJson(i.agentIds))throw Error('Final captured context differs');
 const members=h.resourceMembers.filter(({row}:Row)=>row.step_execution_id===i.stepId).map(({row}:Row)=>row.agent_id).sort();
 if(stableJson(members)!==stableJson(i.agentIds))throw Error('Final captured membership differs');
 for(const attempt of selected.attempts??[])if(['prepared','leased','running','outcome_unknown'].includes(attempt.state)||attempt.state==='waiting'&&!attempt.request_id)throw Error('Final native/effect attempt remains unsettled');
 for(const native of e.nativeScriptExits){
  if(payloadHash(native.proof)!==native.sha256||native.proof.kind!=='script_process_exit'||native.proof.transition_key!==`process-exit:${native.attemptId}:${native.fence}`||!selected.attempts.some((a:Row)=>a.id===native.attemptId&&a.fence===native.fence))throw Error('Final observed native exit differs');
 }
 const f=v.starts.rows.find((r:Row)=>r.kind==='branch-generation-exit-fence');
 if(!f||v.intakeFence.identity!==f.identity||v.intakeFence.sha256!==f.receipt_sha256)throw Error('Final fence reference differs');
 const originalFence=JSON.parse(f.receipt_json);
 if(originalFence.input.executionId!==i.executionId||originalFence.input.stepExecutionId!==i.stepId||originalFence.input.generation!==i.generation||originalFence.resource.creation_key!==i.creationKey||originalFence.resource.original_branch_id!==i.branchId)throw Error('Final fence original owner differs');
 const cp=JSON.parse(v.selectedCheckpoint.snapshot_json);
 if(stableJson(cp)!==v.selectedCheckpoint.snapshot_json||payloadHash(cp)!==v.selectedCheckpoint.content_hash||cp.schema!=='branch-unit-selected.v2'||cp.captureKind!=='issued_resource'||cp.selected?.execution?.[0]?.id!==i.executionId)throw Error('Final committed selected bytes differ');

 if(v.definition.content_hash!==payloadHash(JSON.parse(v.definition.definition_json))||v.bindings.content_hash!==payloadHash(JSON.parse(v.bindings.bindings_json))||payloadHash(JSON.parse(v.configuration.configuration_json))!==i.configurationSha256)throw Error('Final exit pins differ');
 verifyFinalProviderStarts(v.starts,{projectId:i.projectId,conversationId:i.chatId,agentIds:i.agentIds},e.providerExitEvidence);
 verifyFinalProviderExits(v.exits,e.providerExitEvidence);
}


/** No current portable fact carrier independently commits complete start/provider/effect absence. */
export function verifyRetainedFinalExitCommand(_owner:import('@ponderosa/core').BranchPortableRuntimeOwner,_command:Row):never {
 // Self-consistent nested command/fact/owner hashes cannot authenticate omitted original activity.
 throw Error('Retained final resource exit proof unsupported: independent complete original start/provider/effect census commitment unavailable');
}
