import type {BranchForeignContinuationInput,BranchForeignContinuationReceipt,BranchForeignContinuationReview,BranchForeignContinuationSelection,BranchPortableRuntimeFact,BranchPortableRuntimeOwner} from '@ponderosa/core';
export const foreignCommandStorageKey=(origin:string,product:string,branchId:string,ownerId:string)=>`branch-foreign-command:${JSON.stringify([origin,product,branchId,ownerId])}`;
/** This is only a choice to ask the server, not proof that source work never ran. */
export function beforeEntryFrontier(owner:BranchPortableRuntimeOwner|undefined):BranchPortableRuntimeFact|undefined {
 if(!owner)return;
 try {
  const origins=owner.facts.filter(f=>f.kind==='provenance'),frontiers=owner.facts.filter(f=>f.kind==='frontier'&&f.key==='current');
  if(origins.length!==1||frontiers.length!==1||JSON.parse(origins[0]!.json).source!=='manual')return;
  const fact=frontiers[0]!;if(! /^[a-f0-9]{64}$/.test(fact.sha256))return;
  const frontier=JSON.parse(fact.json),execution=frontier.execution;
  if(!Array.isArray(execution)||execution.length!==1||execution[0]?.id!==owner.sourceExecutionId||execution[0]?.branch_id!==owner.sourceBranchId||execution[0]?.state!=='canceled'||execution[0]?.admission_source!=='manual'||!Array.isArray(frontier.paths)||frontier.paths.length||!Array.isArray(frontier.steps)||frontier.steps.length)return;
  return fact;
 }catch{return;}
}
/** The server must independently verify the live source; this checks the returned review's shape and selection. */
export function isBeforeEntryReview(review:BranchForeignContinuationReview):boolean {
 const value=review as unknown as {engine?:unknown;beforeEntry?:unknown;checkpoint?:unknown;selection?:BranchForeignContinuationSelection};
 if(value.engine!=='current_destination'||!value.beforeEntry||typeof value.beforeEntry!=='object'||Array.isArray(value.beforeEntry))return false;
 const before=value.beforeEntry as Record<string,unknown>,frontier=value.checkpoint as {execution?:unknown;paths?:unknown;steps?:unknown}|undefined;
 if(Object.keys(before).sort().join('|')!==['sourceBranchId','sourceExecutionId','sourceFrontierSha256'].sort().join('|')||typeof before.sourceBranchId!=='string'||!before.sourceBranchId||typeof before.sourceExecutionId!=='string'||!before.sourceExecutionId||before.sourceExecutionId!==value.selection?.sourceExecutionId||typeof before.sourceFrontierSha256!=='string'||! /^[a-f0-9]{64}$/.test(before.sourceFrontierSha256)||before.sourceFrontierSha256!==value.selection?.checkpointSha256||value.selection?.checkpointKey!=='current')return false;
 if(!frontier||!Array.isArray(frontier.execution)||frontier.execution.length!==1||!Array.isArray(frontier.paths)||frontier.paths.length||!Array.isArray(frontier.steps)||frontier.steps.length)return false;
 const source=frontier.execution[0] as Record<string,unknown>;
 return !!source&&source.id===before.sourceExecutionId&&source.branch_id===before.sourceBranchId&&source.state==='canceled'&&source.admission_source==='manual';
}
export function foreignReviewMatches(review:BranchForeignContinuationReview,branchId:string,ownerId:string,selection:BranchForeignContinuationSelection):boolean {
 if(!review||!review.selection)return false;
 const value=review as unknown as {beforeEntry?:unknown};
 const kind=selection.checkpointKey==='current'?isBeforeEntryReview(review):review.engine==='node'&&value.beforeEntry===undefined;
 return kind&&review.schema==='ponderosa.branch-foreign-review.v1'&&review.branchId===branchId&&review.importedExecutionId===ownerId&&(['planId','sourceExecutionId','checkpointKey','checkpointSha256'] as const).every(key=>review.selection[key as keyof BranchForeignContinuationSelection]===selection[key as keyof BranchForeignContinuationSelection])&&/^[a-f0-9]{64}$/.test(review.reviewSha256)&&review.custody==='not_applicable'&&review.secretChoice==='none'&&review.accessChoice==='current_destination';
}
export function readForeignCommand(raw:string|null,planId:string,sourceExecutionId:string):BranchForeignContinuationInput|undefined {
 if(raw===null)return;
 const value=JSON.parse(raw) as BranchForeignContinuationInput;
 if(!value||Object.keys(value).sort().join('|')!==['planId','sourceExecutionId','checkpointKey','checkpointSha256','commandKey','reviewSha256','acceptCurrentAuthority'].sort().join('|')||value.planId!==planId||value.sourceExecutionId!==sourceExecutionId||typeof value.checkpointKey!=='string'||!value.checkpointKey||typeof value.commandKey!=='string'||!value.commandKey||! /^[a-f0-9]{64}$/.test(value.checkpointSha256)||! /^[a-f0-9]{64}$/.test(value.reviewSha256)||value.acceptCurrentAuthority!==true)throw Error('Retained continuation command is invalid; held');
 return value;
}
export function foreignReceiptMatches(receipt:BranchForeignContinuationReceipt,branchId:string,ownerId:string,command:BranchForeignContinuationInput):boolean {
 return receipt.schema==='ponderosa.branch-foreign-continuation.v1'&&receipt.commandKey===command.commandKey&&receipt.executionId!==ownerId&&!!receipt.executionId&&receipt.review.reviewSha256===command.reviewSha256&&foreignReviewMatches(receipt.review,branchId,ownerId,command)&&receipt.branchId===branchId&&receipt.importedExecutionId===ownerId;
}
