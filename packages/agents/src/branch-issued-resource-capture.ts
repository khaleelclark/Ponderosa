import {captureGenerationOneHost} from './branch-resource-generation-one.js';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {CheckpointPackageSource,CheckpointPackageReceipt} from '@ponderosa/core';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut} from './branch-host-cut.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
import {receiptMatchesSource,resourceCaptureFrontierHash} from './branch-resource-capture.js';
import {issuedResourceContinuationSupported,encodeIssuedResourceContinuation} from './branch-issued-resource-continuation.js';
type Row=Record<string,any>;
const key=(commandKey:string)=>`issued-resource-capture:${commandKey}`;

/** This journal is separate from the pre-opening generation's capture receipt. */
export function issuedResourceCapture(db:Database.Database,executionId:string,stepId:string,commandKey:string):Row|undefined {
 const row=db.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key(commandKey)) as Row|undefined;
 if(!row)return;
 if(db.prepare('SELECT 1 FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`custody-abandoned:${payloadHash(key(commandKey))}`))throw Error('Issued capture was explicitly abandoned');
 const value=JSON.parse(row.result_json);
 if(value.schema!=='branch-issued-resource-capture.v1'||stableJson(value)!==row.result_json||value.source.intent.resourceStepId!==stepId
  ||row.input_hash!==payloadHash({stepId,generation:value.source.intent.resourceGeneration,commandKey})||payloadHash(value.snapshot.hostDependencies)!==value.source.intent.hostCutSha256
  ||resourceCaptureFrontierHash(value.snapshot.selected)!==value.source.intent.frontierSha256)throw Error('Issued resource capture journal differs');
 if(value.source.intent.resourceGeneration>0&&value.reviewHash!==payloadHash({selected:value.snapshot.selected,host:value.snapshot.hostDependencies,generationRetry:value.snapshot.issuedContinuation?.generationRetry,issuedContinuation:value.snapshot.issuedContinuation}))throw Error('Issued capture preview differs');
 if(value.state==='retained'){
  const sealed=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=? AND execution_id=?').get(value.checkpointId,executionId) as Row|undefined;
  if(!sealed||sealed.content_hash!==value.checkpointHash||payloadHash(JSON.parse(sealed.snapshot_json))!==value.checkpointHash||stableJson(JSON.parse(sealed.snapshot_json))!==stableJson({...value.snapshot,issuedResourceCustody:value.receipt})||!receiptMatchesSource(value.receipt,value.source))throw Error('Issued resource checkpoint seal differs');
 }
 return value;
}
export function reserveIssuedResourceCapture(db:Database.Database,executionId:string,stepId:string,generation:number,commandKey:string,expectedReviewHash?:string):Row {
 if(!db.inTransaction)throw Error('Issued resource capture requires owner transaction');
 if(typeof commandKey!=='string'||!commandKey.trim()||commandKey.length>200||!Number.isSafeInteger(generation)||generation<0)throw Error('Exact issued resource capture intent required');
 if(db.prepare('SELECT 1 FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,`custody-abandoned:${payloadHash(key(commandKey))}`))throw Error('Issued capture was explicitly abandoned');
 const previous=issuedResourceCapture(db,executionId,stepId,commandKey);
 if(previous){if(generation>0&&expectedReviewHash!==previous.reviewHash)throw Error('Issued capture preview conflict');if(previous.source.intent.resourceGeneration!==generation)throw Error('Issued resource capture command conflict');return previous;}
 const originalSelected=selectBranchUnit(db,executionId),e=originalSelected.execution?.[0],r=originalSelected.resources?.[0];
 const retry=generation>0?captureGenerationOneHost(db,originalSelected):undefined,selected=retry?.selected??originalSelected;
 const pins=db.prepare(`SELECT b.deleting,b.enabled,b.active_version_id version_id,b.binding_revision_id,b.configuration_json,
  v.content_hash version_hash,x.content_hash binding_hash FROM branches b JOIN branch_versions v ON v.id=b.active_version_id JOIN branch_bindings x ON x.id=b.binding_revision_id WHERE b.id=?`).get(e?.branch_id) as Row|undefined;
 const configuration=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(executionId) as Row|undefined;
 // No caller may convert an earlier pre-opening package into an issued checkpoint.
 if(!e||!r||!pins||pins.deleting||!pins.enabled||!['running','waiting','completed','failed','canceled'].includes(e.state)||e.parent_execution_id
  ||selected.resources?.length!==1||r.step_execution_id!==stepId||r.generation!==generation||!r.chat_id||!['active','draining'].includes(r.state)
  ||e.version_id!==pins.version_id||e.binding_revision_id!==pins.binding_revision_id||!configuration||stableJson(JSON.parse(configuration.configuration_json))!==stableJson(JSON.parse(pins.configuration_json))
  ||Object.keys(JSON.parse(configuration.configuration_json).secretBindings??{}).length||!selected.attempts?.some(a=>a.request_id)
  ||selected.attempts.some(a=>a.recovery_of_request_id||a.state==='outcome_unknown'))throw Error('Issued capture requires one current nonsecret standalone replayable resource generation');
 const hostDependencies=retry?.host??captureBranchHostCut(db,executionId,selected);
 if(!hostDependencies?.coverage.complete||hostDependencies.bindingPin.requiredSecretRefs.length||hostDependencies.artifactRefs.length||hostDependencies.requests.some(({row})=>row.state==='outcome_unknown'||row.superseded_by_request_id))throw Error('Issued capture requires complete known Request evidence without runtime artifacts or recovery chains');
 const imported=JSON.parse(r.import_operation_json??'null'),agentIds=imported?.result?.agentIds as string[]|undefined;
 const members=(db.prepare('SELECT agent_id FROM branch_resource_members WHERE step_execution_id=? ORDER BY agent_id').all(stepId) as Row[]).map(m=>m.agent_id);
 if(imported?.state!=='completed'||!Array.isArray(agentIds)||!agentIds.length||new Set(agentIds).size!==agentIds.length||agentIds.some(id=>typeof id!=='string'||!id)||stableJson([...agentIds].sort())!==stableJson(members)||agentIds.length!==r.requested_count)throw Error('Issued source import membership differs');
 if(hostDependencies.requests.some(({row})=>row.conversation_id!==r.chat_id||[row.requester_agent_id,row.recipient_agent_id].filter(Boolean).some(id=>!agentIds.includes(id)))||hostDependencies.joins.some(({row})=>row.conversation_id!==r.chat_id||!agentIds.includes(row.owner_agent_id))||hostDependencies.suspensions.some(({row})=>row.dependency_kind!=='join'))throw Error('Issued capture exceeds one resource participant scope');
 for(const id of agentIds)if(!db.prepare('SELECT 1 FROM agents WHERE id=? AND conversation_id=? AND deleted_at IS NULL').get(id,r.chat_id)
  ||db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? LIMIT 1").get(id,id,id))throw Error('Issued resource participants must survive and drain before capture');
 const issuedContinuation=encodeIssuedResourceContinuation(db,executionId,selected,hostDependencies,false,retry?.generationRetry);
 if(retry&&(!expectedReviewHash||expectedReviewHash!==payloadHash({...retry,issuedContinuation})))throw Error('Exact later-generation preview changed or missing');
 const source:CheckpointPackageSource={checkpointId:randomUUID(),sourceChatId:r.chat_id,agentIds:[...agentIds],intent:{executionId,resourceStepId:stepId,resourceGeneration:generation,frontierSha256:resourceCaptureFrontierHash(selected),bindingSha256:pins.binding_hash,configurationSha256:payloadHash(Object.fromEntries(Object.entries(JSON.parse(configuration.configuration_json)).filter(([k])=>k!=='secretBindings'))),hostCutSha256:payloadHash(hostDependencies)}};
 // Refused by ordinary rewind. Only the dedicated reviewed destination consumer may admit it.
 const snapshot={schema:'branch-unit-selected.v2',captureKind:'issued_resource',restore_supported:false,selected,hostDependencies,issuedContinuation};
 const journal={schema:'branch-issued-resource-capture.v1',state:'capturing',source,snapshot,...(retry?{reviewHash:payloadHash({...retry,issuedContinuation})}:{})};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,key(commandKey),payloadHash({stepId,generation,commandKey}),stableJson(journal),new Date().toISOString());
 return journal;
}
export function sealIssuedResourceCapture(db:Database.Database,executionId:string,stepId:string,commandKey:string,receipt:CheckpointPackageReceipt):void {
 if(!db.inTransaction)throw Error('Issued sealing requires the source boundary transaction');
 const journal=issuedResourceCapture(db,executionId,stepId,commandKey);
 if(!journal||!receiptMatchesSource(receipt,journal.source))throw Error('Issued receipt does not bind its exact host cut');
 if(journal.state==='retained'){if(stableJson(journal.receipt)!==stableJson(receipt))throw Error('Issued retained receipt differs');return;}
 const originalSelected=selectBranchUnit(db,executionId),retry=journal.source.intent.resourceGeneration>0?captureGenerationOneHost(db,originalSelected):undefined,selected=retry?.selected??originalSelected,host=retry?.host??captureBranchHostCut(db,executionId,selected);
 const e=selected.execution?.[0],branch=db.prepare('SELECT * FROM branches WHERE id=?').get(e?.branch_id) as Row|undefined;
 if(!branch||branch.deleting||!branch.enabled||branch.active_version_id!==e?.version_id||branch.binding_revision_id!==e?.binding_revision_id
  ||payloadHash(Object.fromEntries(Object.entries(JSON.parse(branch.configuration_json)).filter(([k])=>k!=='secretBindings')))!==journal.source.intent.configurationSha256
  ||Object.keys(JSON.parse(branch.configuration_json).secretBindings??{}).length)throw Error('Issued capture current owner pins changed');
 if(resourceCaptureFrontierHash(selected)!==journal.source.intent.frontierSha256||payloadHash(host)!==journal.source.intent.hostCutSha256)throw Error('Issued frontier changed during private-byte capture');
 if(!journal.snapshot.issuedContinuation||!host||stableJson(encodeIssuedResourceContinuation(db,executionId,selected,host,false,retry?.generationRetry))!==stableJson(journal.snapshot.issuedContinuation))throw Error('Issued executable continuation/audit changed during private-byte capture');
 const snapshot={...journal.snapshot,issuedResourceCustody:receipt},snapshotHash=payloadHash(snapshot);
 const result=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(executionId,stableJson(snapshot),snapshotHash);
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson({...journal,state:'retained',receipt,checkpointId:Number(result.lastInsertRowid),checkpointHash:snapshotHash}),executionId,key(commandKey));
}

/** Read only the saved, hash-bound continuation; mutable active Branch policy is irrelevant. */
export function issuedCaptureRetryBudget(db:Database.Database,executionId:string,journal:Row):import('@ponderosa/core').BranchCaptureRetryBudget {
 const snapshot=journal.snapshot,c=snapshot?.issuedContinuation;
 if(!c?.generationRetry)return {state:'unavailable',reason:'missing_saved_retry_proof'};
 if(journal.reviewHash!==payloadHash({selected:snapshot.selected,host:snapshot.hostDependencies,generationRetry:c.generationRetry,issuedContinuation:c})||c.bindingHash!==journal.source.intent.bindingSha256||payloadHash(c.configuration)!==journal.source.intent.configurationSha256||!issuedResourceContinuationSupported(db,executionId,snapshot.selected,snapshot.hostDependencies,c))throw Error('Saved capture retry budget proof differs');
 const r=snapshot.selected.resources[0],attempts=snapshot.selected.attempts.filter((a:Row)=>a.step_execution_id===r.step_execution_id);
 const version=db.prepare('SELECT definition_json FROM branch_versions WHERE id=? AND branch_id=?').get(c.versionId,snapshot.selected.execution[0].branch_id) as Row;
 const step=snapshot.selected.steps.find((s:Row)=>s.id===r.step_execution_id),policy=JSON.parse(version.definition_json).steps.find((s:Row)=>s.id===step?.step_id)?.failure;
 const attempt=attempts[0];
 if(attempts.length!==1||!Number.isSafeInteger(attempt?.number)||attempt.number!==r.generation+1||!attempt.request_id||policy?.action!=='retry'||!Number.isSafeInteger(policy.maxAttempts)||policy.maxAttempts<attempt.number)throw Error('Saved capture retry budget inventory differs');
 return {state:'verified',consumedAttempts:attempt.number,maxAttempts:policy.maxAttempts,evidenceHash:payloadHash({snapshot,reviewHash:journal.reviewHash})};
}
