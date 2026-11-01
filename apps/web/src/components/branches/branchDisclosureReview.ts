import type {BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,BranchIssuedDestinationDto} from '@ponderosa/core';

export function disclosureReviewMatches(review:BranchDisclosureReviewDto,target:BranchIssuedDestinationDto,branchId:string,executionId:string):boolean {
 const source=review.review.reservation,destination=source.destination;
 const historical=source.historicalPartition;
 if(JSON.stringify(historical)!==JSON.stringify(target.historicalPartition))return false;
 if(historical?.length&&(historical.length!==1||historical.some(s=>s.generation!==0||s.executionId!==executionId||s.discloseTo.length!==Object.keys(review.review.stage.agentMap).length||s.discloseTo.some(ref=>!review.review.stage.agentMap[ref]))||!review.facts.some(f=>f.kind==='historical_generation')))return false;
 if(review.facts.length!==review.review.facts.length||review.review.facts.some(f=>!review.facts.some(v=>v.kind===f.kind&&v.id===f.id&&v.sha256===f.sha256&&JSON.stringify(v.originalAgentIds)===JSON.stringify(f.originalAgentIds)&&JSON.stringify(v.destinationAgentIds)===JSON.stringify(f.destinationAgentIds)&&JSON.stringify(v.originalActor)===JSON.stringify(f.originalActor)&&JSON.stringify(v.originalAudience)===JSON.stringify(f.originalAudience))))return false;
 return review.admissionId===target.admissionId&&review.review.admissionId===target.admissionId&&source.branchId===branchId&&source.sourceExecutionId===executionId&&source.checkpointId===target.checkpointId&&source.checkpointHash===target.checkpointHash&&Boolean(review.reviewHash)&&['projectId','conversationId','executionId','resourceStepId','resourceGeneration'].every(key=>destination[key as keyof typeof destination]===target.destination[key as keyof typeof destination]);
}
export function disclosureReceiptMatches(receipt:BranchDisclosureReceipt,admissionId:string,input:BranchDisclosureChoice):boolean {
 return receipt.admissionId===admissionId&&receipt.commandKey===input.commandKey&&receipt.action===input.action&&receipt.reviewHash===input.reviewHash&&receipt.revision===input.expectedRevision+1&&receipt.state===(input.action==='approve'?'approved':'revoked');
}
export function disclosureCanRevoke(target:BranchIssuedDestinationDto|undefined):boolean {
 return Boolean(target?.disclosure.state==='approved'&&target.disclosure.reviewHash);
}
