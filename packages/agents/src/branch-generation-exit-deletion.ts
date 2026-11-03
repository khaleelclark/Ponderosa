import {readFinalResourceExit} from './branch-final-resource-exit.js';
import type Database from 'better-sqlite3';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {receiptMatchesSource,resourceCaptureFrontierHash} from './branch-resource-capture.js';
import {verifyRetainedProviderExitEvidence} from './provider-exit-evidence.js';
import {verifyBranchHostCut} from './branch-host-cut.js';

/** Deletion proof only; never releases the permanent intake/lease fence. */
export function requireGenerationExitDeletionReady(db:Database.Database,scope:{agentId?:string;conversationId?:string;projectId?:string;branchId?:string;executionId?:string}):void {
 db.transaction(()=>{
 const fences=db.prepare(`WITH RECURSIVE owner_executions(id) AS (
 SELECT id FROM branch_executions WHERE branch_id=? OR id=?
 UNION SELECT child.id FROM branch_executions child JOIN owner_executions parent ON child.parent_execution_id=parent.id
 ) SELECT identity,input_json,receipt_json,receipt_sha256 FROM host_lifecycle_commits f
 WHERE kind='branch-generation-exit-fence' AND (
 /* Legacy receipts lack immutable Branch identity: validate them conservatively. */
 (? IS NOT NULL AND (json_extract(receipt_json,'$.resource.original_branch_id')=?
  OR json_extract(receipt_json,'$.resource.original_branch_id') IS NULL))
 OR json_extract(receipt_json,'$.input.executionId') IN (SELECT id FROM owner_executions)
 OR json_extract(receipt_json,'$.input.executionId')=? OR
 json_extract(receipt_json,'$.input.projectId')=? OR json_extract(receipt_json,'$.input.conversationId')=?
 OR EXISTS(SELECT 1 FROM json_each(receipt_json,'$.input.agentIds') m WHERE m.value=?)
 OR EXISTS(SELECT 1 FROM agents a WHERE a.id=? AND a.conversation_id=json_extract(f.receipt_json,'$.input.conversationId')))`)
 .all(scope.branchId??null,scope.executionId??null,scope.branchId??null,scope.branchId??null,scope.executionId??null,scope.projectId??null,scope.conversationId??null,scope.agentId??null,scope.agentId??null) as Array<{identity:string;input_json:string;receipt_json:string;receipt_sha256:string}>;
 for(const f of fences){
  const fail=()=>{throw Error('Original generation deletion requires an exact sealed capture and intake fence receipt');};
  const retained=JSON.parse(f.receipt_json),input=retained.input;
  if(retained.schema!=='branch-generation-exit-fence.v1'||stableJson(retained)!==f.receipt_json||payloadHash(retained)!==f.receipt_sha256||stableJson(input)!==f.input_json||f.identity!==payloadHash({executionId:input.executionId,stepExecutionId:input.stepExecutionId,generation:input.generation}))fail();
  if(retained.purpose==='final-resource'){
   const final=readFinalResourceExit(db,input.executionId,input.stepExecutionId);
   if(final.identity.projectId!==input.projectId||final.identity.chatId!==input.conversationId||final.identity.generation!==input.generation||stableJson(final.identity.agentIds)!==stableJson(input.agentIds)
    ||final.intakeFence.identity!==f.identity||final.intakeFence.sha256!==f.receipt_sha256||final.identity.branchId!==retained.resource.original_branch_id)fail();
   continue;
  }
  if(retained.purpose!==undefined)fail();
  const row=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(input.executionId,`resource-generation-exit:${input.stepExecutionId}:${input.generation}`) as {input_hash:string;result_json:string}|undefined;
  if(!row)fail();
  const j=JSON.parse(row!.result_json),i=j.identity,e=j.envelope,fence={identity:f.identity,sha256:f.receipt_sha256};
  if(stableJson(j)!==row!.result_json||j.schema!=='branch-resource-generation-exit.v1'||j.state!=='sealed'||!i||row!.input_hash!==payloadHash(i)||i.executionId!==input.executionId||i.stepId!==input.stepExecutionId||i.generation!==input.generation||i.projectId!==input.projectId||i.chatId!==input.conversationId||stableJson([...i.agentIds].sort())!==stableJson(input.agentIds)||stableJson(j.intakeFence)!==stableJson(fence)||!e||stableJson(e.intakeFence)!==stableJson(fence)||e.schema!=='branch-prior-generation.v1'||stableJson(e.identity)!==stableJson(i)||payloadHash(e)!==j.envelopeSha256)fail();
  if(retained.resource.original_branch_id!==undefined&&retained.resource.original_branch_id!==i.branchId)fail();
  const s=j.source;
  if(!s||s.sourceChatId!==i.chatId||stableJson([...s.agentIds].sort())!==stableJson(input.agentIds)||s.intent.executionId!==i.executionId||s.intent.resourceStepId!==i.stepId||s.intent.resourceGeneration!==i.generation||s.intent.configurationSha256!==i.configurationSha256||s.intent.frontierSha256!==resourceCaptureFrontierHash(e.selected)||s.intent.hostCutSha256!==payloadHash(e.hostDependencies)||!verifyBranchHostCut(e.hostDependencies,i.executionId)||!receiptMatchesSource(j.receipt,s))fail();
  if(e.providerExitEvidence.projectId!==i.projectId||e.providerExitEvidence.conversationId!==i.chatId||stableJson(e.providerExitEvidence.participants.map((p:{agentId:string})=>p.agentId).sort())!==stableJson(input.agentIds)||s.intent.bindingSha256!==e.hostDependencies?.bindingPin?.sha256)fail();
  for(const native of e.nativeScriptExits)if(payloadHash(native.proof)!==native.sha256||native.proof.kind!=='script_process_exit'||native.proof.transition_key!==`process-exit:${native.attemptId}:${native.fence}`)fail();
  verifyRetainedProviderExitEvidence(db,e.providerExitEvidence);
  const snapshot={schema:'branch-unit-selected.v2',captureKind:'retired_resource_generation',restore_supported:false,priorGeneration:{...e,source:s,receipt:j.receipt,envelopeSha256:j.envelopeSha256}};
  const cp=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(j.checkpointId,i.executionId) as {snapshot_json:string;content_hash:string}|undefined;
  if(!cp||cp.snapshot_json!==stableJson(snapshot)||cp.content_hash!==payloadHash(snapshot)||cp.content_hash!==j.checkpointHash)fail();
 }
 })();
}
