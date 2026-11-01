import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {CheckpointPackageSource,CheckpointPackageReceipt} from '@ponderosa/core';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut} from './branch-host-cut.js';
import {resourceCaptureFrontierHash,receiptMatchesSource} from './branch-resource-capture.js';
import {encodeIssuedResourceContinuation,issuedResourceContinuationSupported} from './branch-issued-resource-continuation.js';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
const key=(command:string)=>`issued-group-capture:${payloadHash(command)}`;
export function readIssuedGroup(db:Database.Database,executionId:string,checkpointId:number,expectedHash:string):Row {
 const row=db.prepare('SELECT snapshot_json,content_hash FROM branch_unit_snapshots WHERE execution_id=? AND id=?').get(executionId,checkpointId) as Row|undefined;
 if(!row||row.content_hash!==expectedHash)throw Error('Issued group checkpoint unavailable');
 const s=JSON.parse(row.snapshot_json),e=s.selected?.execution?.[0];
 if(stableJson(s)!==row.snapshot_json||payloadHash(s)!==expectedHash||s.schema!=='branch-unit-selected.v2'||s.captureKind!=='issued_group'||s.issuedContinuation?.group!==true
  ||s.selected.resources!.length!==2||s.selected.paths!.length!==1||e?.id!==executionId||!Array.isArray(s.issuedGroupCustody)||s.issuedGroupCustody.length!==2
  ||!issuedResourceContinuationSupported(db,executionId,s.selected,s.hostDependencies,s.issuedContinuation))throw Error('Issued group checkpoint integrity/replay unsupported');
 const seen=new Set<string>();
 for(const r of s.selected.resources){
  const receipt=s.issuedGroupCustody.find((c:Row)=>c.intent.resourceStepId===r.step_execution_id);
  if(!receipt||seen.has(receipt.custodyId)||receipt.intent.executionId!==executionId||receipt.sourceChatId!==r.chat_id||receipt.intent.resourceGeneration!==0
   ||receipt.intent.frontierSha256!==resourceCaptureFrontierHash(s.selected)||receipt.intent.hostCutSha256!==payloadHash(s.hostDependencies)
   ||receipt.intent.bindingSha256!==s.issuedContinuation.bindingHash||receipt.intent.configurationSha256!==payloadHash(s.issuedContinuation.configuration)
   ||stableJson(receipt.agentIds)!==stableJson(JSON.parse(r.import_operation_json).result.agentIds))throw Error('Issued group custody differs');
  const {version,custodyId,boundaryId,sha256,byteLength,...source}=receipt;
  if(!receiptMatchesSource(receipt,source))throw Error('Issued group custody receipt invalid');seen.add(custodyId);
 }
 return s;
}
export function reserveIssuedGroupCapture(db:Database.Database,executionId:string,commandKey:string):Row {
 if(!db.inTransaction||typeof commandKey!=='string'||!commandKey.trim()||commandKey.length>200)throw Error('Group capture owner transaction/command required');
 const old=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key(commandKey)) as Row|undefined;
 if(old)return JSON.parse(old.result_json);
 const selected=selectBranchUnit(db,executionId),host=captureBranchHostCut(db,executionId,selected),e=selected.execution![0]!;
 if(selected.resources!.length!==2||selected.paths!.length!==1||!host?.coverage.complete||host.artifactRefs.length||e.parent_execution_id
  ||selected.resources!.some(r=>r.generation!==0||r.retry_draining||!['active','draining'].includes(r.state)))throw Error('Exactly two generation-zero serial issued resources required');
 const branch=db.prepare('SELECT enabled,deleting,active_version_id,binding_revision_id,configuration_json FROM branches WHERE id=?').get(e.branch_id) as Row;
 const configuration=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(executionId) as Row;
 if(!branch?.enabled||branch.deleting||branch.active_version_id!==e.version_id||branch.binding_revision_id!==e.binding_revision_id||branch.configuration_json!==configuration.configuration_json)throw Error('Current group owner pins unavailable');
 const issuedContinuation=encodeIssuedResourceContinuation(db,executionId,selected,host,true);
 const sources:CheckpointPackageSource[]=selected.resources!.map(r=>{
  const ids=JSON.parse(r.import_operation_json).result.agentIds as string[];
  for(const id of ids)if(!db.prepare('SELECT 1 FROM agents WHERE id=? AND conversation_id=? AND deleted_at IS NULL').get(id,r.chat_id)
   ||db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? LIMIT 1").get(id,id))throw Error('Group participants must survive with observed runtime drain');
  return {checkpointId:randomUUID(),sourceChatId:r.chat_id,agentIds:ids,intent:{executionId,resourceStepId:r.step_execution_id,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(selected),hostCutSha256:payloadHash(host),bindingSha256:issuedContinuation.bindingHash,configurationSha256:payloadHash(issuedContinuation.configuration)}};
 });
 const value={state:'capturing',sources,receipts:[],snapshot:{schema:'branch-unit-selected.v2',captureKind:'issued_group',restore_supported:false,selected,hostDependencies:host,issuedContinuation}};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,key(commandKey),payloadHash({commandKey}),stableJson(value),new Date().toISOString());return value;
}
export function sealIssuedGroupMember(db:Database.Database,executionId:string,commandKey:string,receipt:CheckpointPackageReceipt):void {
 if(!db.inTransaction)throw Error('Group seal requires capture owner transaction');
 const row=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key(commandKey)) as Row;
 if(!row)throw Error('Group capture intent unavailable');const v=JSON.parse(row.result_json),source=v.sources.find((s:Row)=>s.checkpointId===receipt.checkpointId);
 if(!source||!receiptMatchesSource(receipt,source))throw Error('Group member custody differs');
 const prior=v.receipts.find((r:Row)=>r.checkpointId===receipt.checkpointId);
 if(prior){if(stableJson(prior)!==stableJson(receipt))throw Error('Group member custody conflict');return;}
 const selected=selectBranchUnit(db,executionId),host=captureBranchHostCut(db,executionId,selected);
 const e=selected.execution![0]!,branch=db.prepare('SELECT enabled,deleting,active_version_id,binding_revision_id,configuration_json FROM branches WHERE id=?').get(e.branch_id) as Row;
 const config=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(executionId) as Row;
 if(!branch?.enabled||branch.deleting||branch.active_version_id!==e.version_id||branch.binding_revision_id!==e.binding_revision_id||branch.configuration_json!==config.configuration_json)throw Error('Current group sealing pins changed');
 for(const memberSource of v.sources)for(const id of memberSource.agentIds)if(!db.prepare('SELECT 1 FROM agents WHERE id=? AND conversation_id=? AND deleted_at IS NULL').get(id,memberSource.sourceChatId)
  ||db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? LIMIT 1").get(id,id,id))throw Error('Group sealing participant drain changed');
 if(resourceCaptureFrontierHash(selected)!==source.intent.frontierSha256||payloadHash(host)!==source.intent.hostCutSha256
  ||stableJson(encodeIssuedResourceContinuation(db,executionId,selected,host!,true))!==stableJson(v.snapshot.issuedContinuation))throw Error('Group capture frontier changed');
 v.receipts.push(receipt);
 if(v.receipts.length===2){
  const snapshot={...v.snapshot,issuedGroupCustody:v.sources.map((s:Row)=>v.receipts.find((r:Row)=>r.checkpointId===s.checkpointId))},bytes=stableJson(snapshot);
  const saved=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(executionId,bytes,payloadHash(snapshot));
  v.state='retained';v.checkpointId=Number(saved.lastInsertRowid);v.checkpointHash=payloadHash(snapshot);
 }
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(v),executionId,key(commandKey));
}
