import type {BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,BranchIssuedDestinationDto} from '@ponderosa/core';

export function disclosureReviewMatches(review:BranchDisclosureReviewDto,target:BranchIssuedDestinationDto,branchId:string,executionId:string):boolean {
 const source=review.review.reservation,destination=source.destination;
 return review.admissionId===target.admissionId&&review.review.admissionId===target.admissionId&&source.branchId===branchId&&source.sourceExecutionId===executionId&&source.checkpointId===target.checkpointId&&source.checkpointHash===target.checkpointHash&&Boolean(review.reviewHash)&&['projectId','conversationId','executionId','resourceStepId','resourceGeneration'].every(key=>destination[key as keyof typeof destination]===target.destination[key as keyof typeof destination]);
}
export function disclosureReceiptMatches(receipt:BranchDisclosureReceipt,admissionId:string,input:BranchDisclosureChoice):boolean {
 return receipt.admissionId===admissionId&&receipt.commandKey===input.commandKey&&receipt.action===input.action&&receipt.reviewHash===input.reviewHash&&receipt.revision===input.expectedRevision+1&&receipt.state===(input.action==='approve'?'approved':'revoked');
}
export function disclosureCanRevoke(target:BranchIssuedDestinationDto|undefined):boolean {
 return Boolean(target?.disclosure.state==='approved'&&target.disclosure.reviewHash);
}
