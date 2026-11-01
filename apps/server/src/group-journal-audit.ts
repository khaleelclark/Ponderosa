import type Database from 'better-sqlite3';
import {stableJson,readIssuedGroupCaptureAudit,readGroupCaptureDisposition,type CoordinationV3Store} from '@ponderosa/agents';
import type {GroupJournalAuditSelection,GroupJournalAuditReadback} from '@ponderosa/core';
import {lifecycleHash} from './lifecycle-journal.js';
type Row=Record<string,any>;
export const groupJournalDigest=(row:Row)=>lifecycleHash({executionId:row.execution_id,journalKey:row.command_key,inputHash:row.input_hash,resultJson:row.result_json});
/** Operator audit boundary only; no live-owner authorizer, package engine or mutation-capable reader. */
export function groupJournalAudit(db:Database.Database,coordination:Pick<CoordinationV3Store,'inspectCoordinationDestinationGroupAudit'>){
 return {read(selection:GroupJournalAuditSelection):GroupJournalAuditReadback{return db.transaction(()=>{
  const text=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=512;
  if(!['captures','admissions'].includes(selection.kind)||!text(selection.branchId)||!text(selection.executionId)||!text(selection.journalKey)
   ||![selection.journalSha256,selection.custodySha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('Exact discovered group audit selection required');
  const row=db.prepare('SELECT execution_id,command_key,input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(selection.executionId,selection.journalKey) as Row|undefined;
  if(!row||Buffer.byteLength(row.result_json)>16*1024*1024||groupJournalDigest(row)!==selection.journalSha256)throw Error('Original group journal unavailable or changed; rediscover');
  const value=JSON.parse(row.result_json);if(stableJson(value)!==row.result_json)throw Error('Original group journal is not canonical');
  const live=db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(selection.executionId) as Row|undefined;
  if(live&&live.branch_id!==selection.branchId)throw Error('Current source owner conflicts with original audit identity');
  const base={historical:true as const,currentAuthority:false as const,actionEligible:false as const,held:true as const,selection,sourceOwnerPresent:!!live,journalSha256:selection.journalSha256};
  if(selection.kind==='captures'){
   if(selection.admissionId!==undefined||selection.reservationHash!==undefined||!/^issued-group-capture:[a-f0-9]{64}$/.test(selection.journalKey))throw Error('Exact capture audit identity required');
   const capture=readIssuedGroupCaptureAudit(db,selection.executionId,selection.journalKey);
   if(!capture||capture.snapshot.selected.execution[0].branch_id!==selection.branchId||capture.commandKey!==selection.commandKey
    ||lifecycleHash({sources:capture.sources,receipts:capture.receipts})!==selection.custodySha256)throw Error('Original group capture custody/command differs');
   const disposition=readGroupCaptureDisposition(db,selection.executionId,selection.journalKey,row.result_json);
   const evidence={...base,state:disposition?'abandoned':capture.state,capture:{sources:capture.sources,receipts:capture.receipts,checkpointId:capture.checkpointId,checkpointHash:capture.checkpointHash,disposition:disposition?{state:disposition.state,commandKey:disposition.input.commandKey,packageRetirements:disposition.packageRetirements}:undefined}};
   return {...evidence,evidenceSha256:lifecycleHash(evidence)};
  }
  const r=value.reservation;
  if(value.schema!=='ponderosa.branch.issued-group-destination.v1'||!text(selection.commandKey)||selection.journalKey!==`issued-group-destination:${lifecycleHash(selection.commandKey)}`
   ||value.input?.commandKey!==selection.commandKey||row.input_hash!==lifecycleHash(value.input)||value.admissionId!==selection.admissionId||value.reservationHash!==selection.reservationHash
   ||r?.branchId!==selection.branchId||r?.sourceExecutionId!==selection.executionId||lifecycleHash(r)!==selection.reservationHash
   ||value.input.checkpointId!==r.checkpointId||value.input.expectedHash!==r.checkpointHash||lifecycleHash(r.resources?.map((resource:Row)=>resource.custody))!==selection.custodySha256)throw Error('Original group command/reservation/custody differs');
  const audit=coordination.inspectCoordinationDestinationGroupAudit(value.admissionId);
  if(audit.reservationHash!==selection.reservationHash||stableJson(audit.reservation)!==stableJson(r))throw Error('Canonical group audit reservation differs');
  if(!value.idMap||stableJson(Object.keys(value.idMap).sort())!==stableJson([...audit.sourceIds].sort())||typeof value.idMap!=='object'||Array.isArray(value.idMap)||new Set(Object.values(value.idMap)).size!==Object.keys(value.idMap).length
   ||Object.values(value.idMap).some(id=>!text(id)||id===selection.executionId||r.resources.some((resource:Row)=>id===resource.destination.executionId)||audit.sourceIds.includes(id as string))||r.resources.some((resource:Row)=>value.idMap[resource.custody.intent.resourceStepId]!==resource.destination.resourceStepId))throw Error('Original group full owner map differs');
  const owners=[];
  for(const resource of r.resources){
   const d=resource.destination,owner=audit.receipt?.owners.find(owner=>owner.resourceStepId===d.resourceStepId);
   const liveOwner=db.prepare('SELECT branch_id FROM branch_executions WHERE id=?').get(d.executionId) as Row|undefined;
   if(liveOwner&&liveOwner.branch_id!==selection.branchId)throw Error('Group destination owner identity differs');
   const command=owner?db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(d.executionId,owner.receiptId) as Row|undefined:undefined;
   if(command){
    const original=JSON.parse(command.result_json),readiness=original.readiness;
    if(stableJson(original)!==command.result_json||command.input_hash!==lifecycleHash(value)||stableJson(original.idMap)!==stableJson(value.idMap)
     ||stableJson(original.sourceCheckpoint)!==stableJson({executionId:selection.executionId,checkpointId:r.checkpointId,expectedHash:r.checkpointHash})||!readiness)throw Error('Retained group owner command map differs');
    const checkpoint=db.prepare('SELECT execution_id,snapshot_json,content_hash FROM branch_unit_snapshots WHERE id=?').get(readiness.checkpointId) as Row|undefined;
    if(checkpoint&&(checkpoint.execution_id!==d.executionId||checkpoint.content_hash!==readiness.checkpointHash||lifecycleHash(JSON.parse(checkpoint.snapshot_json))!==checkpoint.content_hash||stableJson(JSON.parse(checkpoint.snapshot_json))!==checkpoint.snapshot_json))throw Error('Retained group owner checkpoint differs');
   }
   owners.push({executionId:d.executionId,resourceStepId:d.resourceStepId,present:!!liveOwner,commandPresent:!!command});
  }
  if(audit.receipt?.historicalPartition&&audit.receipt.historicalPartition.length>32)throw Error('Historical audit partition exceeds bound');
  // Canonical readers validate full private seals; transport exposes only bounded metadata.
  const receipt=audit.receipt?{...audit.receipt,historicalPartition:audit.receipt.historicalPartition?.map(entry=>{
   const seal=entry.seal as Row,cut=seal.envelope.hostDependencies;
   return {historical:true as const,dispatchable:false as const,sha256:entry.sha256,
    executionId:entry.selection.executionId,stepId:entry.selection.stepId,generation:entry.selection.generation,
    checkpointId:entry.selection.checkpointId,checkpointHash:entry.selection.checkpointHash,envelopeSha256:entry.selection.envelopeSha256,
    originalAgentCount:seal.identity.agentIds.length,destinationAgentCount:entry.destinationAgentIds.length,
    requestCount:cut.requests.length,updateCount:cut.updates.length,communicationCount:cut.communications.length};
  })}:null;
  const evidence={...base,state:audit.state,reservationHash:audit.reservationHash,resources:r.resources,idMap:value.idMap,agentMap:audit.agentMap,imports:audit.imports,owners,receipt,retirement:audit.retirement};
  return {...evidence,evidenceSha256:lifecycleHash({evidence,canonical:audit.evidenceSha256})};
 })();}};
}
