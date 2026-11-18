import path from 'node:path';
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {stableJson,type BranchCustodyLifecycle} from '@ponderosa/agents';
import type {CheckpointPackageSource,CheckpointCaptureAbandonmentInput,CheckpointCaptureAbandonmentReviewInput,CheckpointCaptureAbandonmentReviewDto,CheckpointCaptureAbandonmentReceipt} from '@ponderosa/core';
import {checkpointCustodyLifecycle} from './checkpoint-custody-lifecycle.js';
import {custodyLifecycleProof} from './custody-lifecycle-proof.js';
import {lifecycleHash,lifecycleJournal} from './lifecycle-journal.js';

/** SQLite owns the disposition; an fsynced package tombstone fences retry across either commit failure. */
export function checkpointCaptureAbandonment(dataDir:string,db:Database.Database,owner:()=>BranchCustodyLifecycle){
 const journal=lifecycleJournal(path.join(dataDir,'checkpoint-abandonment-journal'),db);
 const identity=(source:CheckpointPackageSource)=>owner().inspect(source).custodyId;
 const service=(source:CheckpointPackageSource,captureKey:string)=>checkpointCustodyLifecycle(path.join(dataDir,'checkpoint-package-custody'),(actual,id)=>{
  if(!actual)throw Error('Exact abandoned source evidence required');
  const exact={checkpointId:actual.checkpointId,sourceChatId:actual.sourceChatId,agentIds:actual.agentIds,intent:actual.intent};
  if(stableJson(exact)!==stableJson(source))throw Error('Package and Branch source differ');
  const current=owner().inspect(source),other=custodyLifecycleProof(db,source,id);
  return {references:[...current.references.filter(ref=>ref.kind!=='command'||ref.ownerId!==source.intent.executionId||ref.key!==captureKey).map(ref=>`${ref.kind}:${ref.ownerId}:${ref.key}`),...other.references.filter(ref=>ref.startsWith('coordination_cut_restorations.'))],blockers:current.abandonmentBlockers};
 },source);
 const review=(input:CheckpointCaptureAbandonmentReviewInput):CheckpointCaptureAbandonmentReviewDto=>{
  if(typeof input.captureKey!=='string'||!input.captureKey||input.captureKey.length>256)throw Error('Exact capture key required');
  const custodyId=identity(input.source),branch=owner().inspect(input.source),pkg=service(input.source,input.captureKey).review(custodyId);
  const capture=branch.references.find(ref=>ref.kind==='command'&&ref.ownerId===input.source.intent.executionId&&ref.key===input.captureKey);
  if(!capture)throw Error('Current unsealed capture reference required');
  return {custodyId,branchRevision:branch.revision,captureSha256:capture.sha256,packageReviewSha256:pkg.reviewSha256,references:pkg.references,blockers:pkg.blockers,reviewSha256:lifecycleHash({input,branch,pkg})};
 };
 return {review(input:CheckpointCaptureAbandonmentReviewInput){return db.transaction(()=>review(input))();},
  abandon(input:CheckpointCaptureAbandonmentInput):CheckpointCaptureAbandonmentReceipt{
   if(!input.commandKey||input.commandKey.length>200||!/^[a-f0-9]{64}$/.test(input.reviewSha256)||input.preserveEvidence!==true)throw Error('Exact evidence-preserving abandonment approval required');
   return db.transaction(()=>{
    if(typeof input.source?.checkpointId!=='string')throw Error('Exact checkpoint source required');
    const custodyId=createHash('sha256').update(input.source.checkpointId).digest('hex'),key=`abandon:${custodyId}`,prior=journal.read(key);
    const committed=db.prepare("SELECT * FROM host_lifecycle_commits WHERE kind='checkpoint_abandonment' AND identity=?").get(custodyId) as {input_json:string;receipt_json:string;receipt_sha256:string}|undefined;
    if(committed&&committed.input_json!==stableJson(input))throw Error('Committed abandonment input conflict');
    let prepared=prior;
    if(prior){if(stableJson(prior.input)!==stableJson(input))throw Error('Abandonment command conflict');}
    else{
     const current=review({source:input.source,captureKey:input.captureKey});
     if(current.reviewSha256!==input.reviewSha256||current.references.length||current.blockers.length)throw Error('Abandonment review changed or remains held');
     const captureEvidence=db.prepare('SELECT * FROM branch_commands WHERE execution_id=? AND command_key=?').get(input.source.intent.executionId,input.captureKey) as {result_json:string}|undefined;
     if(!captureEvidence||lifecycleHash(JSON.parse(captureEvidence.result_json))!==current.captureSha256)throw Error('Original capture archive differs');
     prepared={schema:'checkpoint-abandonment-prepare.v1',input,review:current,captureEvidence};
     // This is a recovery intent, not permission to release an unvalidated capture.
     journal.write(key,prepared);
    }
    const pkg=service(input.source,input.captureKey),packageInput={commandKey:input.commandKey,reviewSha256:prepared.review.packageReviewSha256,preserveEvidence:true as const};
    const finishPackage=()=>{
     const receipt=pkg.reconcile(custodyId,packageInput);
     const proof={custodyId,sourceSha256:lifecycleHash(input.source),revision:lifecycleHash({prepared,receipt})};
     journal.write(`package:${custodyId}`,{prepared,receipt,proof});
     return proof;
    };
    const receipt=committed?JSON.parse(committed.receipt_json).branch:owner().abandonCapture(input.source,{commandKey:input.commandKey,captureKey:input.captureKey,captureSha256:prepared.review.captureSha256,expectedRevision:prepared.review.branchRevision},finishPackage);
    // Exact Branch replay does not call its callback: still verify/recover the retained package journal.
    const packageEvidence=journal.read(`package:${custodyId}`);
    if(!packageEvidence||stableJson(packageEvidence.prepared)!==stableJson(prepared))throw Error('Committed abandonment package proof missing');
    const packageProof=finishPackage();
    if(stableJson(receipt.packageRetirement)!==stableJson(packageProof))throw Error('Branch and package retirement proofs differ');
    const result={state:'abandoned' as const,custodyId,commandKey:input.commandKey,reviewSha256:input.reviewSha256,captureArchiveSha256:lifecycleHash(prepared.captureEvidence),branch:receipt,package:packageEvidence.receipt};
    if(committed){if(lifecycleHash(result)!==committed.receipt_sha256||stableJson(result)!==committed.receipt_json)throw Error('Durable abandonment result differs');}
    else db.prepare("INSERT INTO host_lifecycle_commits VALUES('checkpoint_abandonment',?,?,?,?)").run(custodyId,stableJson(input),stableJson(result),lifecycleHash(result));
    return result;
   }).immediate();
  },
 };
}
