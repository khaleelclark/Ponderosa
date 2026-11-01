import {verifyHostProvenance} from './branch-host-provenance.js';
import {readGroupCaptureDisposition} from './branch-group-custody-disposition.js';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {CheckpointPackageSource,CheckpointPackageReceipt} from '@ponderosa/core';
import {selectBranchUnit} from './branch-unit-selection.js';
import {captureBranchHostCut,verifyBranchHostCut} from './branch-host-cut.js';
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
  ||s.selected.resources!.length<2||s.selected.resources!.length>32||e?.id!==executionId||!Array.isArray(s.issuedGroupCustody)||s.issuedGroupCustody.length!==s.selected.resources.length
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
/** Read retained intent without recapturing a changed live frontier. Partial custody stays pinned. */
function readGroupCapture(db:Database.Database,executionId:string,commandKey:string,raw=false,audit=false):Row|undefined {
 if(typeof commandKey!=='string'||!commandKey.trim()||commandKey.length>200)throw Error('Exact group capture command required');
 if(raw&&!/^issued-group-capture:[a-f0-9]{64}$/.test(commandKey))throw Error('Exact raw group capture key required');
 const row=db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,raw?commandKey:key(commandKey)) as Row|undefined;
 if(!row)return;
 const v=JSON.parse(row.result_json),snapshot=v.snapshot,resources=snapshot?.selected?.resources;
 if(v.commandKey!==undefined&&((raw?key(v.commandKey)!==commandKey:v.commandKey!==commandKey)||v.reviewHash!==payloadHash(snapshot)||v.versionId!==snapshot?.selected?.execution?.[0]?.version_id))throw Error('Group capture retained preview differs');
 if(stableJson(v)!==row.result_json||(raw?v.commandKey!==undefined&&row.input_hash!==payloadHash({commandKey:v.commandKey}):row.input_hash!==payloadHash({commandKey}))||!['capturing','retained'].includes(v.state)
  ||snapshot?.schema!=='branch-unit-selected.v2'||snapshot.captureKind!=='issued_group'||snapshot.issuedContinuation?.group!==true
  ||snapshot.selected.execution[0]?.id!==executionId||!verifyBranchHostCut(snapshot.hostDependencies,executionId)||!Array.isArray(resources)||resources.length<2||resources.length>32
  ||!Array.isArray(v.sources)||v.sources.length!==resources.length||!Array.isArray(v.receipts)||v.receipts.length>v.sources.length
  ||v.state==='capturing'&&v.receipts.length===v.sources.length
  ||new Set(v.sources.map((source:Row)=>source.checkpointId)).size!==resources.length
  ||new Set(v.sources.map((source:Row)=>source.intent.resourceStepId)).size!==resources.length
  ||new Set(v.sources.map((source:Row)=>source.sourceChatId)).size!==resources.length
  ||new Set(v.sources.flatMap((source:Row)=>source.agentIds)).size!==v.sources.reduce((count:number,source:Row)=>count+source.agentIds.length,0)
  ||new Set(v.receipts.map((receipt:Row)=>receipt.checkpointId)).size!==v.receipts.length)throw Error('Group capture journal integrity failure');
 for(const source of v.sources){
  const r=resources.find((r:Row)=>r.step_execution_id===source.intent.resourceStepId);
  if(!r||source.intent.executionId!==executionId||source.intent.resourceGeneration!==0||source.sourceChatId!==r.chat_id
   ||source.intent.frontierSha256!==resourceCaptureFrontierHash(snapshot.selected)||source.intent.hostCutSha256!==payloadHash(snapshot.hostDependencies)
   ||source.intent.bindingSha256!==snapshot.issuedContinuation.bindingHash||source.intent.configurationSha256!==payloadHash(snapshot.issuedContinuation.configuration)
   ||stableJson(source.agentIds)!==stableJson(JSON.parse(r.import_operation_json).result.agentIds))throw Error('Group capture source differs');
 }
 if(v.receipts.some((receipt:CheckpointPackageReceipt)=>!v.sources.some((source:CheckpointPackageSource)=>receiptMatchesSource(receipt,source))))throw Error('Group capture partial receipt differs');
 if(v.state==='retained'){
  const saved=audit?{...snapshot,issuedGroupCustody:v.sources.map((source:Row)=>v.receipts.find((receipt:Row)=>receipt.checkpointId===source.checkpointId))}:readIssuedGroup(db,executionId,v.checkpointId,v.checkpointHash);
  if(audit){
   if(!Number.isSafeInteger(v.checkpointId)||v.checkpointId<1||payloadHash(saved)!==v.checkpointHash)throw Error('Group audit sealed checkpoint hash differs');
   const cp=db.prepare('SELECT execution_id,snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(v.checkpointId) as Row|undefined;
   if(cp&&(cp.execution_id!==executionId||cp.snapshot_json!==stableJson(saved)||cp.content_hash!==v.checkpointHash))throw Error('Group audit current checkpoint differs');
  }
  if(v.receipts.length!==v.sources.length||stableJson(saved)!==stableJson({...snapshot,issuedGroupCustody:v.sources.map((source:Row)=>v.receipts.find((receipt:Row)=>receipt.checkpointId===source.checkpointId))}))throw Error('Group capture retained seal differs');
 }
 if(audit){
  verifyHostProvenance(snapshot.hostDependencies);
  const c=snapshot.issuedContinuation,e=snapshot.selected.execution[0];
  if(c.schema!=='ponderosa.branch.issued-resource-continuation.v1'||c.versionId!==e.version_id||c.bindingRevisionId!==e.binding_revision_id||c.auditSha256!==payloadHash(c.audit)
   ||c.frontierSha256!==resourceCaptureFrontierHash(snapshot.selected)||c.hostCutSha256!==payloadHash(snapshot.hostDependencies)||snapshot.hostDependencies.bindingPin.sha256!==c.bindingHash)throw Error('Group audit continuation binding differs');
  for(const [table,column,id,expected]of [['branch_versions','definition_json',c.versionId,c.versionHash],['branch_bindings','bindings_json',c.bindingRevisionId,c.bindingHash]]){
   const pin=db.prepare(`SELECT branch_id,${column} bytes,content_hash FROM ${table} WHERE id=?`).get(id) as Row|undefined;
   if(pin&&(pin.branch_id!==e.branch_id||pin.content_hash!==expected||payloadHash(JSON.parse(pin.bytes))!==expected))throw Error('Group audit retained owner pins differ');
  }
 }
 return v;
}
export function readIssuedGroupCapture(db:Database.Database,executionId:string,commandKey:string,raw=false):Row|undefined {return readGroupCapture(db,executionId,commandKey,raw);}
/** Retained audit integrity only, never executable continuation or live owner eligibility. */
export function readIssuedGroupCaptureAudit(db:Database.Database,executionId:string,rawCaptureKey:string):Row|undefined {return readGroupCapture(db,executionId,rawCaptureKey,true,true);}
export function previewIssuedGroupCapture(db:Database.Database,executionId:string){
 const selected=selectBranchUnit(db,executionId),host=captureBranchHostCut(db,executionId,selected),e=selected.execution![0]!;
 if(selected.resources!.length<2||selected.resources!.length>32||!host?.coverage.complete||host.artifactRefs.length||e.parent_execution_id
  ||selected.resources!.some(r=>r.generation!==0||r.retry_draining||!['active','draining'].includes(r.state)))throw Error('Two to thirty-two generation-zero issued resources required');
 const branch=db.prepare('SELECT enabled,deleting,active_version_id,binding_revision_id,configuration_json FROM branches WHERE id=?').get(e.branch_id) as Row;
 const configuration=db.prepare('SELECT configuration_json FROM branch_executions WHERE id=?').get(executionId) as Row;
 if(!branch?.enabled||branch.deleting||branch.active_version_id!==e.version_id||branch.binding_revision_id!==e.binding_revision_id||branch.configuration_json!==configuration.configuration_json)throw Error('Current group owner pins unavailable');
 const issuedContinuation=encodeIssuedResourceContinuation(db,executionId,selected,host,true);
 const sources=selected.resources!.map(r=>{
  const ids=JSON.parse(r.import_operation_json).result.agentIds as string[];
  for(const id of ids)if(!db.prepare('SELECT 1 FROM agents WHERE id=? AND conversation_id=? AND deleted_at IS NULL').get(id,r.chat_id)
   ||db.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running','outcome_unknown') UNION ALL SELECT 1 FROM provider_process_authority WHERE agent_id=? UNION ALL SELECT 1 FROM agent_deletion_pending WHERE agent_id=? LIMIT 1").get(id,id,id))throw Error('Group participants must survive with observed runtime drain');
  return {resourceStepId:r.step_execution_id,sourceChatId:r.chat_id,generation:r.generation,agentIds:ids};
 });
 const snapshot={schema:'branch-unit-selected.v2',captureKind:'issued_group',restore_supported:false,selected,hostDependencies:host,issuedContinuation};
 return {snapshot,resources:sources,reviewHash:payloadHash(snapshot),versionId:e.version_id,bindingRevisionId:e.binding_revision_id};
}
export function reserveIssuedGroupCapture(db:Database.Database,executionId:string,commandKey:string,expectedReview?:{reviewHash:string;versionId:string}):Row {
 if(!db.inTransaction||typeof commandKey!=='string'||!commandKey.trim()||commandKey.length>200)throw Error('Group capture owner transaction/command required');
 const original=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key(commandKey)) as Row|undefined;
 if(original&&readGroupCaptureDisposition(db,executionId,key(commandKey),original.result_json))throw Error('Group capture abandoned; revival refused');
 const old=readIssuedGroupCapture(db,executionId,commandKey);
 if(old){if(expectedReview&&(old.reviewHash!==expectedReview.reviewHash||old.versionId!==expectedReview.versionId))throw Error('Group capture command preview conflict');return old;}
 if(!expectedReview||expectedReview.versionId===undefined)throw Error('Exact capture preview required');
 const preview=previewIssuedGroupCapture(db,executionId);
 if(preview.reviewHash!==expectedReview.reviewHash||preview.versionId!==expectedReview.versionId)throw Error('Group capture preview changed');
 const {snapshot}=preview,{selected,hostDependencies:host,issuedContinuation}=snapshot;
 const sources:CheckpointPackageSource[]=preview.resources.map(r=>({checkpointId:randomUUID(),sourceChatId:r.sourceChatId,agentIds:r.agentIds,intent:{executionId,resourceStepId:r.resourceStepId,resourceGeneration:0,frontierSha256:resourceCaptureFrontierHash(selected),hostCutSha256:payloadHash(host),bindingSha256:issuedContinuation.bindingHash,configurationSha256:payloadHash(issuedContinuation.configuration)}}));
 const value={commandKey,reviewHash:preview.reviewHash,versionId:preview.versionId,state:'capturing',sources,receipts:[],snapshot:{schema:'branch-unit-selected.v2',captureKind:'issued_group',restore_supported:false,selected,hostDependencies:host,issuedContinuation}};
 db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(executionId,key(commandKey),payloadHash({commandKey}),stableJson(value),new Date().toISOString());return value;
}
export function sealIssuedGroupMember(db:Database.Database,executionId:string,commandKey:string,receipt:CheckpointPackageReceipt):void {
 if(!db.inTransaction)throw Error('Group seal requires capture owner transaction');
 const original=db.prepare('SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,key(commandKey)) as Row|undefined;
 if(original&&readGroupCaptureDisposition(db,executionId,key(commandKey),original.result_json))throw Error('Group capture abandoned; seal refused');
 const v=readIssuedGroupCapture(db,executionId,commandKey);
 if(!v)throw Error('Group capture intent unavailable');const source=v.sources.find((s:Row)=>s.checkpointId===receipt.checkpointId);
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
 if(v.receipts.length===v.sources.length){
  const snapshot={...v.snapshot,issuedGroupCustody:v.sources.map((s:Row)=>v.receipts.find((r:Row)=>r.checkpointId===s.checkpointId))},bytes=stableJson(snapshot);
  const saved=db.prepare('INSERT INTO branch_unit_snapshots(execution_id,snapshot_json,content_hash) VALUES(?,?,?)').run(executionId,bytes,payloadHash(snapshot));
  v.state='retained';v.checkpointId=Number(saved.lastInsertRowid);v.checkpointHash=payloadHash(snapshot);
 }
 db.prepare('UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key=?').run(stableJson(v),executionId,key(commandKey));
}
