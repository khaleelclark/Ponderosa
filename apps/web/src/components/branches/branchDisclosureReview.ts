import {generationHistorySelectionsMatch} from './branchGenerationOne';
import type {BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,BranchIssuedDestinationDto} from '@ponderosa/core';

export function disclosureReviewMatches(review:BranchDisclosureReviewDto,target:BranchIssuedDestinationDto,branchId:string,executionId:string):boolean {
 const source=review.review.reservation,destination=source.destination;
 const historical=source.historicalPartition;
 if(JSON.stringify(historical)!==JSON.stringify(target.historicalPartition))return false;
 if(historical!==undefined){
  const intent=source.custody?.intent,stage=review.review.stage.agentMap,facts=review.facts.filter(f=>f.kind==='historical_generation');
  if(!intent||!generationHistorySelectionsMatch(historical,intent.resourceGeneration,executionId,intent.resourceStepId)||facts.length!==historical.length)return false;
  if(historical.some((selection,index)=>{
   const fact=facts[index],seal=historicalFactSeal(fact),identity=seal?.identity as Record<string,unknown>|undefined;
   return !seal||!identity||identity.executionId!==selection.executionId||identity.stepId!==selection.stepId||identity.generation!==selection.generation||seal.checkpointId!==selection.checkpointId||seal.checkpointHash!==selection.checkpointHash||seal.envelopeSha256!==selection.envelopeSha256||JSON.stringify(seal.intakeFence)!==JSON.stringify(selection.intakeFence)||JSON.stringify(identity.agentIds)!==JSON.stringify(fact.originalAgentIds)||selection.discloseTo.length!==Object.keys(stage).length||selection.discloseTo.some(ref=>!stage[ref])||JSON.stringify(selection.discloseTo.map(ref=>stage[ref]).sort())!==JSON.stringify([...fact.destinationAgentIds].sort())||fact.originalAgentIds.some(id=>id in stage||Object.values(stage).includes(id));
  }))return false;
 }

 if(review.facts.length!==review.review.facts.length||review.review.facts.some(f=>!review.facts.some(v=>v.kind===f.kind&&v.id===f.id&&v.sha256===f.sha256&&JSON.stringify(v.originalAgentIds)===JSON.stringify(f.originalAgentIds)&&JSON.stringify(v.destinationAgentIds)===JSON.stringify(f.destinationAgentIds)&&JSON.stringify(v.originalActor)===JSON.stringify(f.originalActor)&&JSON.stringify(v.originalAudience)===JSON.stringify(f.originalAudience))))return false;
 return review.admissionId===target.admissionId&&review.review.admissionId===target.admissionId&&source.branchId===branchId&&source.sourceExecutionId===executionId&&source.checkpointId===target.checkpointId&&source.checkpointHash===target.checkpointHash&&Boolean(review.reviewHash)&&['projectId','conversationId','executionId','resourceStepId','resourceGeneration'].every(key=>destination[key as keyof typeof destination]===target.destination[key as keyof typeof destination]);
}
export function disclosureReceiptMatches(receipt:BranchDisclosureReceipt,admissionId:string,input:BranchDisclosureChoice):boolean {
 return receipt.admissionId===admissionId&&receipt.commandKey===input.commandKey&&receipt.action===input.action&&receipt.reviewHash===input.reviewHash&&receipt.revision===input.expectedRevision+1&&receipt.state===(input.action==='approve'?'approved':'revoked');
}
export function disclosureCanRevoke(target:BranchIssuedDestinationDto|undefined):boolean {
 return Boolean(target?.disclosure.state==='approved'&&target.disclosure.reviewHash);
}

function historicalFactSeal(fact:BranchDisclosureReviewDto['facts'][number]):Record<string,unknown>|undefined {
 if(fact.kind!=='historical_generation'||!fact.content||typeof fact.content!=='object')return;
 const seal=(fact.content as Record<string,unknown>).seal;return seal&&typeof seal==='object'?seal as Record<string,unknown>:undefined;
}
export function historicalFactGeneration(fact:BranchDisclosureReviewDto['facts'][number]):number|undefined {
 const identity=historicalFactSeal(fact)?.identity as Record<string,unknown>|undefined;
 return typeof identity?.generation==='number'?identity.generation:undefined;
}
