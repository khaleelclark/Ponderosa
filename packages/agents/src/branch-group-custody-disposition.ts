import {readGroupAuditJournal} from './branch-group-journal-retention.js';
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {CheckpointPackageSource,CheckpointPackageReceipt} from '@ponderosa/core';
import {payloadHash,stableJson} from './coordination-v3-canonical-json.js';
type Row=Record<string,any>;
export interface BranchGroupPackageRetirementProof {custodyId:string;sourceSha256:string;revision:string}
export interface BranchGroupCaptureAbandonInput {executionId:string;captureKey:string;commandKey:string;captureSha256:string;expectedRevision:string}
export interface BranchGroupPackageInventory {sources:CheckpointPackageSource[];receipts:CheckpointPackageReceipt[]}
export const groupAbandonKey=(key:string)=>`group-custody-abandoned:${payloadHash(key)}`;
export function exactGroupPackageProofs(sources:CheckpointPackageSource[],proofs:BranchGroupPackageRetirementProof[]):BranchGroupPackageRetirementProof[]{
 if(!Array.isArray(proofs)||proofs.length!==sources.length||new Set(proofs.map(p=>p.custodyId)).size!==sources.length)throw Error('Exhaustive durable group package proofs required');
 return sources.map(source=>{
  const id=createHash('sha256').update(source.checkpointId).digest('hex'),proof=proofs.find(p=>p.custodyId===id);
  if(!proof||stableJson(Object.keys(proof).sort())!==stableJson(['custodyId','revision','sourceSha256'])||proof.sourceSha256!==payloadHash(source)||typeof proof.revision!=='string'||!proof.revision||proof.revision.length>4096)throw Error('Exact group package retirement proof differs');
  return proof;
 });
}
/** Only a verified immutable disposition may remove a raw journal's executable pins. */
export function readGroupCaptureDisposition(db:Database.Database,executionId:string,captureKey:string,bytes:string,audit=false):Row|undefined {
 const row=audit?readGroupAuditJournal(db,executionId,groupAbandonKey(captureKey)):db.prepare('SELECT input_hash,result_json FROM branch_commands WHERE execution_id=? AND command_key=?').get(executionId,groupAbandonKey(captureKey)) as Row|undefined;
 if(!row)return;
 const v=JSON.parse(row.result_json),capture=JSON.parse(bytes);
 if(stableJson(v)!==row.result_json||stableJson(capture)!==bytes||v.schema!=='branch-group-custody-abandon.v1'||v.state!=='abandoned'||row.input_hash!==payloadHash(v.input)
  ||v.input.executionId!==executionId||v.input.captureKey!==captureKey||v.input.captureSha256!==payloadHash(capture)||v.originalCaptureRaw!==bytes||capture.state!=='capturing'
  ||!Array.isArray(capture.sources)||capture.sources.length<2||capture.sources.length>32||stableJson(v.sources)!==stableJson(capture.sources)||stableJson(v.receipts)!==stableJson(capture.receipts)
  ||stableJson(exactGroupPackageProofs(v.sources,v.packageRetirements))!==stableJson(v.packageRetirements))throw Error('Group capture disposition integrity differs');
 return v;
}
