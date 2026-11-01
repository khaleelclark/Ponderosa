import {captureGenerationOneHost} from './branch-resource-generation-one.js';
import {fenceBranchGenerationExit,generationExitHeld} from './branch-generation-exit-fence.js';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {CheckpointPackageSource,CheckpointPackageReceipt} from '@ponderosa/core';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut,verifyBranchHostCut} from './branch-host-cut.js';
import {readProviderExitEvidence,verifyRetainedProviderExitEvidence} from './provider-exit-evidence.js';
import {receiptMatchesSource,resourceCaptureFrontierHash} from './branch-resource-capture.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
export const generationExitKey=(stepId:string,generation:number)=>`resource-generation-exit:${stepId}:${generation}`;
export function requireGenerationExitIntakeFence(db:Database.Database,scope:{agentIds:string[];chatId:string}){
 if(!scope.agentIds.length||!scope.agentIds.every(id=>generationExitHeld(db,id,scope.chatId)))throw Error('Canonical generation intake fence unavailable; capture held');
}
function fenceInput(scope:Row){return {executionId:scope.executionId,stepExecutionId:scope.stepId,generation:scope.generation,projectId:scope.projectId,conversationId:scope.chatId,agentIds:[...scope.agentIds].sort()};}
function verifyIntakeFence(db:Database.Database,journal:Row){
 const input=fenceInput(journal.identity),key=payloadHash({executionId:input.executionId,stepExecutionId:input.stepExecutionId,generation:input.generation});
 const row=db.prepare("SELECT input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence' AND identity=?").get(key) as Row|undefined;
 if(!row)throw Error('Canonical generation intake fence missing');
 const receipt=JSON.parse(row.receipt_json);
 if(stableJson(input)!==row.input_json||stableJson(receipt)!==row.receipt_json||stableJson(receipt.input)!==row.input_json||payloadHash(receipt)!==row.receipt_sha256||stableJson(journal.intakeFence)!==stableJson({identity:key,sha256:row.receipt_sha256}))throw Error('Canonical generation intake fence receipt differs');
 if(receipt.resource.original_branch_id!==undefined&&receipt.resource.original_branch_id!==journal.identity.branchId)throw Error('Canonical generation original Branch differs');
 requireGenerationExitIntakeFence(db,journal.identity);
}
function identity(db:Database.Database,stepId:string){
 const r=db.prepare('SELECT r.*,e.branch_id,e.parent_execution_id,e.version_id,e.binding_revision_id,e.configuration_json FROM branch_resources r JOIN branch_executions e ON e.id=r.execution_id WHERE r.step_execution_id=?').get(stepId) as Row|undefined;
 if(!r||r.retry_draining!==1||!['active','draining'].includes(r.state)||!r.chat_id||r.parent_execution_id)throw Error('Current standalone retry-draining generation required before cleanup');
 const chat=db.prepare('SELECT project_id,branch_id,branch_execution_id AS execution_id FROM conversations WHERE id=?').get(r.chat_id) as Row|undefined;
 const members=db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(stepId) as Row[];
 const agentIds=members.map(m=>m.agent_id),live=db.prepare('SELECT id FROM agents WHERE conversation_id=? AND deleted_at IS NULL ORDER BY id').all(r.chat_id) as Row[];
 if(!chat||chat.branch_id!==r.branch_id||chat.execution_id!==r.execution_id||!agentIds.length||stableJson(agentIds)!==stableJson(live.map(a=>a.id))||db.prepare('SELECT 1 FROM conversation_deletion_receipts WHERE conversation_id=?').get(r.chat_id))throw Error('Original generation Chat and complete live members required');
 return {executionId:r.execution_id,stepId,generation:r.generation,projectId:chat.project_id,chatId:r.chat_id,agentIds,creationKey:r.creation_key,branchId:r.branch_id,versionId:r.version_id,bindingRevisionId:r.binding_revision_id,configurationSha256:payloadHash(JSON.parse(r.configuration_json))};
}
export function readGenerationExitCapture(db:Database.Database,executionId:string,stepId:string,generation:number):Row|undefined {
 const row=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,generationExitKey(stepId,generation)) as Row|undefined;
 if(!row)return;
 const v=JSON.parse(row.result_json);
 if(stableJson(v)!==row.result_json||v.schema!=='branch-resource-generation-exit.v1'||v.identity.executionId!==executionId||v.identity.stepId!==stepId||v.identity.generation!==generation||row.input_hash!==payloadHash(v.identity)||!['fencing','capturing','sealed'].includes(v.state))throw Error('Generation exit journal integrity differs');
 verifyIntakeFence(db,v);
 if(v.state!=='fencing'){
  const e=v.envelope;
  if(stableJson(e.intakeFence)!==stableJson(v.intakeFence)||e.schema!=='branch-prior-generation.v1'||v.source.intent.executionId!==executionId||v.source.intent.resourceStepId!==stepId||v.source.intent.resourceGeneration!==generation||v.source.intent.bindingSha256!==e.hostDependencies?.bindingPin?.sha256||v.source.intent.configurationSha256!==v.identity.configurationSha256||v.source.sourceChatId!==v.identity.chatId||stableJson(v.source.agentIds)!==stableJson(v.identity.agentIds)||e.providerExitEvidence.conversationId!==v.identity.chatId||e.providerExitEvidence.projectId!==v.identity.projectId||stableJson(e.providerExitEvidence.participants.map((p:Row)=>p.agentId).sort())!==stableJson([...v.identity.agentIds].sort()))throw Error('Generation custody/exit identity differs');
  for(const native of e.nativeScriptExits)if(payloadHash(native.proof)!==native.sha256||native.proof.kind!=='script_process_exit'||native.proof.transition_key!==`process-exit:${native.attemptId}:${native.fence}`)throw Error('Retained native exit evidence differs');
  if(payloadHash(e)!==v.envelopeSha256||!verifyBranchHostCut(e.hostDependencies,executionId)||resourceCaptureFrontierHash(e.selected)!==v.source.intent.frontierSha256||payloadHash(e.hostDependencies)!==v.source.intent.hostCutSha256||stableJson(e.identity)!==stableJson(v.identity))throw Error('Generation exit envelope differs');
  verifyRetainedProviderExitEvidence(db,e.providerExitEvidence);
 }
 if(v.state==='sealed'){
  const cp=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(v.checkpointId,executionId) as Row|undefined;
  const snapshot={schema:'branch-unit-selected.v2',captureKind:'retired_resource_generation',restore_supported:false,priorGeneration:{...v.envelope,source:v.source,receipt:v.receipt,envelopeSha256:v.envelopeSha256}};
  if(!receiptMatchesSource(v.receipt,v.source)||!cp||cp.snapshot_json!==stableJson(snapshot)||cp.content_hash!==payloadHash(snapshot)||cp.content_hash!==v.checkpointHash)throw Error('Generation exit snapshot/custody seal differs');
 }
 return v;
}
export function fenceGenerationExitCapture(db:Database.Database,stepId:string):Row {
 if(!db.inTransaction)throw Error('Generation exit fence requires owner transaction');
 const scope=identity(db,stepId),old=readGenerationExitCapture(db,scope.executionId,stepId,scope.generation);
 if(old){if(stableJson(old.identity)!==stableJson(scope))throw Error('Generation exit identity changed');return old;}
 const intakeFence=fenceBranchGenerationExit(db,fenceInput(scope));
 const value={schema:'branch-resource-generation-exit.v1',identity:scope,intakeFence,state:'fencing'};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(scope.executionId,generationExitKey(stepId,scope.generation),payloadHash(scope),stableJson(value),new Date().toISOString());return value;
}
/** Capture only after live runtime drain, while every original identity still exists. */
function envelope(db:Database.Database,journal:Row,expectedRevision?:string){
 const scope=identity(db,journal.identity.stepId);
 if(stableJson(scope)!==stableJson(journal.identity))throw Error('Generation exit owner/generation changed');
 verifyIntakeFence(db,journal);
 const branch=db.prepare('SELECT * FROM branches WHERE id=?').get(scope.branchId) as Row|undefined;
 if(!branch?.enabled||branch.deleting||branch.active_version_id!==scope.versionId||branch.binding_revision_id!==scope.bindingRevisionId||payloadHash(JSON.parse(branch.configuration_json))!==scope.configurationSha256||Object.keys(JSON.parse(branch.configuration_json).secretBindings??{}).length)throw Error('Generation exit current owner pins changed');
 const selected=selectBranchUnit(db,scope.executionId);
 if(selected.resources.length<1||selected.resources.length>32)throw Error('Bounded local resource owner required');
 const retry=scope.generation>0?captureGenerationOneHost(db,selected,true):undefined;
 const hostDependencies=retry?.host??captureBranchHostCut(db,scope.executionId,selected);
 if(!hostDependencies?.coverage.complete||hostDependencies.artifactRefs.length||hostDependencies.bindingPin.requiredSecretRefs.length||hostDependencies.requests.some(({row})=>!['completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded'].includes(row.state))||hostDependencies.joins.some(({row})=>row.state==='open')||hostDependencies.suspensions.some(({row})=>row.state==='open'||row.dependency_kind!=='join'))throw Error('Complete settled historical Request/Join/effect closure required');
 if(db.prepare("SELECT 1 FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND (a.state IN ('leased','running','outcome_unknown') OR a.request_id IS NULL AND a.state='waiting') LIMIT 1").get(scope.executionId))throw Error('Owner native/attempt effects remain unsettled');
 if(db.prepare('SELECT 1 FROM branch_executions WHERE parent_execution_id=? LIMIT 1').get(scope.executionId))throw Error('Called owner history remains unsupported');
 const nativeScriptExits:Row[]=[];
 for(const attempt of db.prepare('SELECT a.* FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? AND a.process_identity_json IS NOT NULL ORDER BY a.id').all(scope.executionId) as Row[]){
  const proof=db.prepare("SELECT * FROM branch_checkpoints WHERE execution_id=? AND kind='script_process_exit' AND transition_key=?").get(scope.executionId,`process-exit:${attempt.id}:${attempt.fence}`) as Row|undefined;
  if(!proof)throw Error('Independently observed native Script exit required');nativeScriptExits.push({attemptId:attempt.id,fence:attempt.fence,processIdentity:JSON.parse(attempt.process_identity_json),proof,sha256:payloadHash(proof)});
 }
 const effectClosure={requests:[] as Row[],joins:[] as Row[],activations:[] as Row[],imports:[] as Row[]};
 for(const agentId of scope.agentIds){
  const requests=db.prepare('SELECT * FROM coordination_requests WHERE recipient_agent_id=? OR requester_agent_id=? ORDER BY id').all(agentId,agentId) as Row[];
  const joins=db.prepare('SELECT DISTINCT j.* FROM coordination_joins j LEFT JOIN coordination_join_members m ON m.join_id=j.id LEFT JOIN coordination_requests q ON q.id=m.request_id WHERE j.owner_agent_id=? OR q.recipient_agent_id=? OR q.requester_agent_id=? ORDER BY j.id').all(agentId,agentId,agentId) as Row[];
  if(requests.some(q=>!hostDependencies.requests.some(e=>e.row.id===q.id))||joins.some(j=>j.state==='open'||!hostDependencies.joins.some(e=>e.row.id===j.id)))throw Error('Generation participant effects exceed captured host closure');
  effectClosure.requests.push(...requests);effectClosure.joins.push(...joins);
  effectClosure.activations.push(...db.prepare('SELECT * FROM agent_activations WHERE agent_id=? ORDER BY id').all(agentId) as Row[]);
  effectClosure.imports.push(...db.prepare('SELECT o.* FROM agent_creation_operations o JOIN agent_creation_operation_members m ON m.operation_id=o.id WHERE m.agent_id=? ORDER BY o.id').all(agentId) as Row[]);
  if(db.prepare("SELECT 1 FROM agent_activations WHERE agent_id=? AND state IN ('pending','attached','retry_pending','outcome_unknown') UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? UNION ALL SELECT 1 FROM coordination_requests WHERE (recipient_agent_id=? OR requester_agent_id=?) AND state NOT IN ('completed','failed','blocked','cancelled','expired','recipient_unavailable','superseded') UNION ALL SELECT 1 FROM agent_creation_operation_members m JOIN agent_creation_operations o ON o.id=m.operation_id WHERE m.agent_id=? AND o.status NOT IN ('completed','rolled_back') LIMIT 1").get(agentId,agentId,agentId,agentId,agentId))throw Error('Generation participant effects remain unresolved');
 }
 for(const row of db.prepare("SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'resource-operation:%'").all(scope.executionId) as Row[])if(['running','unknown'].includes(JSON.parse(row.result_json).state))throw Error('Resource operation outcome remains unknown');
 const participants=scope.agentIds.map(agentId=>({agentId,runIds:(db.prepare('SELECT id FROM scheduler_runs WHERE agent_id=? ORDER BY id').all(agentId) as Row[]).map(r=>r.id)}));
 const providerExitEvidence=readProviderExitEvidence(db,{projectId:scope.projectId,conversationId:scope.chatId,participants,expectedRevision});
 if(Buffer.byteLength(stableJson(effectClosure))>16*1024*1024)throw Error('Generation effect closure exceeds bound');
 const result={schema:'branch-prior-generation.v1' as const,identity:scope,intakeFence:journal.intakeFence as {identity:string;sha256:string},selected,hostDependencies,...(retry?{generationRetry:retry.generationRetry}:{}),nativeScriptExits,effectClosure,providerExitEvidence,nativeState:'not_captured' as const,restore_supported:false as const};
 if(Buffer.byteLength(stableJson(result))>32*1024*1024)throw Error('Generation envelope exceeds bound');return result;
}
export function reserveGenerationExitCapture(db:Database.Database,executionId:string,stepId:string,generation:number):Row {
 if(!db.inTransaction)throw Error('Generation exit reservation requires owner transaction');
 const journal=readGenerationExitCapture(db,executionId,stepId,generation);
 if(!journal)throw Error('Generation intake fence required');
 if(journal.state==='sealed')return journal;
 if(journal.state==='capturing'){if(payloadHash(envelope(db,journal,journal.envelope.providerExitEvidence.revision))!==journal.envelopeSha256)throw Error('Generation capture frontier changed; package effects held');return journal;}
 const e=envelope(db,journal),source:CheckpointPackageSource={checkpointId:randomUUID(),sourceChatId:journal.identity.chatId,agentIds:journal.identity.agentIds,intent:{executionId,resourceStepId:stepId,resourceGeneration:generation,frontierSha256:resourceCaptureFrontierHash(e.selected),hostCutSha256:payloadHash(e.hostDependencies),bindingSha256:e.hostDependencies.bindingPin.sha256,configurationSha256:journal.identity.configurationSha256}};
 const value={...journal,state:'capturing',envelope:e,envelopeSha256:payloadHash(e),source};
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(value),executionId,generationExitKey(stepId,generation));return value;
}
export function sealGenerationExitCapture(db:Database.Database,executionId:string,stepId:string,generation:number,receipt:CheckpointPackageReceipt):void {
 if(!db.inTransaction)throw Error('Generation exit seal requires same owner transaction');
 const journal=readGenerationExitCapture(db,executionId,stepId,generation);
 if(!journal||journal.state==='fencing'||!receiptMatchesSource(receipt,journal.source))throw Error('Exact generation package receipt required');
 if(journal.state==='sealed'){if(stableJson(journal.receipt)!==stableJson(receipt))throw Error('Generation custody replay conflict');return;}
 const current=envelope(db,journal,journal.envelope.providerExitEvidence.revision);
 if(payloadHash(current)!==journal.envelopeSha256)throw Error('Generation frontier/host/exit/effects changed before seal');
 const snapshot={schema:'branch-unit-selected.v2',captureKind:'retired_resource_generation',restore_supported:false,priorGeneration:{...journal.envelope,source:journal.source,receipt,envelopeSha256:journal.envelopeSha256}},contentHash=payloadHash(snapshot);
 const saved=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(executionId,stableJson(snapshot),contentHash);
 const value={...journal,state:'sealed',receipt,checkpointId:Number(saved.lastInsertRowid),checkpointHash:contentHash};
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(value),executionId,generationExitKey(stepId,generation));
}

export type BranchPriorGenerationEnvelope=ReturnType<typeof envelope>;

