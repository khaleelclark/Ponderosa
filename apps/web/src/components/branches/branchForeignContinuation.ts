import type {BranchForeignContinuationInput,BranchForeignContinuationReceipt,BranchForeignContinuationReview,BranchForeignContinuationSelection} from '@ponderosa/core';
export const foreignCommandStorageKey=(origin:string,product:string,branchId:string,ownerId:string)=>`branch-foreign-command:${JSON.stringify([origin,product,branchId,ownerId])}`;
export function foreignReviewMatches(review:BranchForeignContinuationReview,branchId:string,ownerId:string,selection:BranchForeignContinuationSelection):boolean {
 return review.schema==='ponderosa.branch-foreign-review.v1'&&review.branchId===branchId&&review.importedExecutionId===ownerId&&(['planId','sourceExecutionId','checkpointKey','checkpointSha256'] as const).every(key=>review.selection[key as keyof BranchForeignContinuationSelection]===selection[key as keyof BranchForeignContinuationSelection])&&/^[a-f0-9]{64}$/.test(review.reviewSha256)&&review.custody==='not_applicable'&&review.engine==='node'&&review.secretChoice==='none'&&review.accessChoice==='current_destination';
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
