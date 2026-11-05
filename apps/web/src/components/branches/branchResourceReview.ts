import type {BranchResourceInspectionDto,BranchResourceCustodyReleaseInput,BranchResourceCustodyReleaseStatus} from '@ponderosa/core';

export type ExpertCopyReview={sourceAgentId:string;sourceChatId:string;copyChatId:string;snapshotSha256:string;consentCurrent:boolean;copySourceMemory:boolean;allowFindingsWriteback:boolean};
export type ResourceReviewInspection=BranchResourceInspectionDto&{expertCopyReview?:ExpertCopyReview};

export function resourceInspectionMatches(value:ResourceReviewInspection,branchId:string,executionId:string,stepId:string):boolean {
 const copy=value.expertCopyReview;
 if(copy&&(typeof copy.sourceAgentId!=='string'||!copy.sourceAgentId||typeof copy.sourceChatId!=='string'||!copy.sourceChatId||copy.copyChatId!==value.destinationChatId||typeof copy.snapshotSha256!=='string'||!/^[a-f0-9]{64}$/.test(copy.snapshotSha256)||typeof copy.consentCurrent!=='boolean'||typeof copy.copySourceMemory!=='boolean'||typeof copy.allowFindingsWriteback!=='boolean'))return false;
 return value.branchId===branchId&&value.executionId===executionId&&value.stepExecutionId===stepId&&Number.isSafeInteger(value.generation)&&value.generation>=0;
}
export function resourceReleaseInput(value:BranchResourceInspectionDto,commandKey:string):BranchResourceCustodyReleaseInput|undefined {
 const custody=value.custody;
 if(!Number.isSafeInteger(value.generation)||value.generation<0||custody?.kind!=='capture'||custody.state!=='retained'||!custody.custodyId||!custody.receiptSha256)return;
 return {commandKey,expectedGeneration:value.generation,expectedCustodyId:custody.custodyId,expectedReceiptSha256:custody.receiptSha256};
}
export function resourceReleaseMatches(value:BranchResourceCustodyReleaseStatus,input:BranchResourceCustodyReleaseInput,stepId:string):boolean {
 return value.commandKey===input.commandKey&&(value.state==='not_found'||value.stepExecutionId===stepId&&value.generation===input.expectedGeneration&&value.custodyId===input.expectedCustodyId&&value.receiptSha256===input.expectedReceiptSha256);
}
