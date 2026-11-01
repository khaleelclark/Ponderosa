import type {BranchResourceInspectionDto,BranchResourceCustodyReleaseInput,BranchResourceCustodyReleaseStatus} from '@ponderosa/core';

export function resourceInspectionMatches(value:BranchResourceInspectionDto,branchId:string,executionId:string,stepId:string):boolean {
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
