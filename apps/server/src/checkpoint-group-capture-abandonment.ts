import path from 'node:path';
import {createHash} from 'node:crypto';
import fs from '@ponderosa/native-host/fs';
import type Database from 'better-sqlite3';
import {stableJson,type BranchCustodyLifecycle} from '@ponderosa/agents';
import type {CheckpointPackageSource,CheckpointPackageReceipt,CheckpointCustodyReconcileReceipt,CheckpointGroupCaptureAbandonmentReviewInput,CheckpointGroupCaptureAbandonmentInput,CheckpointGroupCaptureAbandonmentReviewDto,CheckpointGroupCaptureAbandonmentReceipt} from '@ponderosa/core';
import {checkpointCustodyLifecycle} from './checkpoint-custody-lifecycle.js';
import {custodyLifecycleProof} from './custody-lifecycle-proof.js';
import {lifecycleHash,lifecycleJournal} from './lifecycle-journal.js';

/** One owner disposition; filesystem progress never releases a subset of Branch cleanup pins. */
export function checkpointGroupCaptureAbandonment(dataDir:string,db:Database.Database,owner:()=>BranchCustodyLifecycle){
 const directory=path.join(dataDir,'checkpoint-package-custody');
 const journal=lifecycleJournal(path.join(dataDir,'checkpoint-group-abandonment-journal'),db);
 const identity=(input:CheckpointGroupCaptureAbandonmentReviewInput)=>{
  if(typeof input.executionId!=='string'||!input.executionId||input.executionId.length>512||typeof input.captureKey!=='string'||!/^issued-group-capture:[a-f0-9]{64}$/.test(input.captureKey))throw Error('Exact retained group capture identity required');
  return lifecycleHash({executionId:input.executionId,captureKey:input.captureKey});
 };
 const service=(source:CheckpointPackageSource,input:CheckpointGroupCaptureAbandonmentReviewInput)=>checkpointCustodyLifecycle(directory,(actual,id)=>{
  if(!actual||stableJson({checkpointId:actual.checkpointId,sourceChatId:actual.sourceChatId,agentIds:actual.agentIds,intent:actual.intent})!==stableJson(source))throw Error('Group package source differs');
  const current=owner().inspectGroupCapture(input.executionId,input.captureKey),other=custodyLifecycleProof(db,source,id);
  return {references:[...current.references.map(ref=>`${ref.kind}:${ref.ownerId}:${ref.key}`),...other.references.filter(ref=>ref.startsWith('coordination_cut_restorations.'))],blockers:current.blockers};
 },source);
 const review=(input:CheckpointGroupCaptureAbandonmentReviewInput)=>{
  const groupId=identity(input),branch=owner().inspectGroupCapture(input.executionId,input.captureKey);
  const packages=branch.sources.map(source=>{
   const custodyId=lifecycleHashCheckpoint(source.checkpointId),pkg=service(source,input).review(custodyId);
   if(pkg.state==='reconciled'||pkg.state==='released')throw Error('Group package already has a separate disposition');
   const receipt=branch.receipts.find(receipt=>receipt.checkpointId===source.checkpointId);
   // A published package whose SQL seal failed still belongs to this exact original source.
   const metadata=pkg.files.find(file=>file.name===`${custodyId}.json`);
   if(receipt&&!metadata)throw Error('Captured group package receipt unavailable');
   if(metadata){
    if(metadata.byteLength>65536)throw Error('Group package receipt exceeds bound');
    const bytes=fs.readFileSync(path.join(directory,metadata.name));
    if(bytes.length!==metadata.byteLength||createHash('sha256').update(bytes).digest('hex')!==metadata.sha256)throw Error('Group package metadata changed during review');
    const stored=JSON.parse(bytes.toString('utf8')) as CheckpointPackageReceipt;
    const {version,custodyId:storedId,boundaryId,sha256,byteLength,...original}=stored;
    const payload=pkg.files.find(file=>file.name===`${custodyId}.payload`);
    if(version!==1||storedId!==custodyId||!boundaryId||stableJson(original)!==stableJson(source)||!payload||payload.sha256!==sha256||payload.byteLength!==byteLength||receipt&&stableJson(stored)!==stableJson(receipt))throw Error('Group package receipt or original bytes differ');
   }
   return {source,...pkg};
  });
  const value={groupId,executionId:input.executionId,captureKey:input.captureKey,captureSha256:branch.captureSha256,branchRevision:branch.revision,packages,references:branch.references.map(ref=>`${ref.kind}:${ref.ownerId}:${ref.key}`),blockers:[...new Set([...branch.blockers,...packages.flatMap(pkg=>pkg.blockers)])]};
  return {publicReview:{...value,reviewSha256:lifecycleHash({input,branch,packages})} satisfies CheckpointGroupCaptureAbandonmentReviewDto,branch};
 };
 return {
  review(input:CheckpointGroupCaptureAbandonmentReviewInput){return db.transaction(()=>review(input).publicReview)();},
  abandon(input:CheckpointGroupCaptureAbandonmentInput):CheckpointGroupCaptureAbandonmentReceipt{
   const groupId=identity(input);
   if(typeof input.commandKey!=='string'||!input.commandKey.trim()||input.commandKey.length>200||!/^([a-f0-9]{64})$/.test(input.reviewSha256)||input.preserveEvidence!==true)throw Error('Exact evidence-preserving group abandonment approval required');
   return db.transaction(()=>{
    const key=`group:${groupId}`,prior=journal.read(key);
    const committed=db.prepare("SELECT * FROM host_lifecycle_commits WHERE kind='checkpoint_group_abandonment' AND identity=?").get(groupId) as {input_json:string;receipt_json:string;receipt_sha256:string}|undefined;
    if(committed&&committed.input_json!==stableJson(input)||prior&&stableJson(prior.input)!==stableJson(input))throw Error('Group abandonment command conflict');
    if(committed&&!prior)throw Error('Committed group prepare evidence missing');
    let prepared=prior;
    if(!prepared){
     const current=review({executionId:input.executionId,captureKey:input.captureKey});
     if(current.publicReview.reviewSha256!==input.reviewSha256||current.publicReview.references.length||current.publicReview.blockers.length||current.publicReview.packages.some(pkg=>pkg.references.length))throw Error('Group abandonment review changed or remains held');
     prepared={schema:'checkpoint-group-abandonment-prepare.v1',input,review:current.publicReview,captureEvidence:current.branch.captureEvidence};
     if(lifecycleHash(JSON.parse(prepared.captureEvidence.result_json))!==prepared.review.captureSha256)throw Error('Original group capture archive differs');
     // Archive the COMPLETE inventory before the first package tombstone or move.
     journal.write(key,prepared);
    }
    const finishPackages=()=>{
     const proofs:Array<{custodyId:string;sourceSha256:string;revision:string;receipt:CheckpointCustodyReconcileReceipt}>=prepared.review.packages.map((pkg:CheckpointGroupCaptureAbandonmentReviewDto['packages'][number])=>{
      const receipt=service(pkg.source,input).reconcile(pkg.custodyId,{commandKey:input.commandKey,reviewSha256:pkg.reviewSha256,preserveEvidence:true});
      if(receipt.filesSha256!==lifecycleHash(pkg.files)||receipt.preservedBytes!==pkg.files.reduce((sum,file)=>sum+file.byteLength,0))throw Error('Group package archive differs from prepared inventory');
      return {custodyId:pkg.custodyId,sourceSha256:lifecycleHash(pkg.source),revision:lifecycleHash({prepared,receipt}),receipt};
     });
     journal.write(`packages:${groupId}`,{prepared,proofs});return proofs;
    };
    const branch=committed?JSON.parse(committed.receipt_json).branch:owner().abandonGroupCapture({executionId:input.executionId,captureKey:input.captureKey,commandKey:input.commandKey,captureSha256:prepared.review.captureSha256,expectedRevision:prepared.review.branchRevision},()=>finishPackages().map(({receipt,...proof})=>proof));
    // Re-read every original byte/hash/length even on lost-response or owner-removed replay.
    const proofs=finishPackages(),packageEvidence=journal.read(`packages:${groupId}`);
    if(!packageEvidence||stableJson(packageEvidence)!==stableJson({prepared,proofs})||stableJson(branch.packageRetirements)!==stableJson(proofs.map(({receipt,...proof})=>proof)))throw Error('Group Branch and package proofs differ');
    const result:CheckpointGroupCaptureAbandonmentReceipt={state:'abandoned',groupId,commandKey:input.commandKey,reviewSha256:input.reviewSha256,captureArchiveSha256:lifecycleHash(prepared.captureEvidence),branch,packages:proofs.map(proof=>proof.receipt)};
    if(committed){if(lifecycleHash(result)!==committed.receipt_sha256||stableJson(result)!==committed.receipt_json)throw Error('Durable group abandonment result differs');}
    else db.prepare("INSERT INTO host_lifecycle_commits VALUES('checkpoint_group_abandonment',?,?,?,?)").run(groupId,stableJson(input),stableJson(result),lifecycleHash(result));
    return result;
   }).immediate();
  },
 };
}
// Custody identity hashes the original checkpoint string, not canonical JSON.
const lifecycleHashCheckpoint=(checkpointId:string)=>createHash('sha256').update(checkpointId).digest('hex');
