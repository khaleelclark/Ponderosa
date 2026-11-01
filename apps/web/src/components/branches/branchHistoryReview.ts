import type {BranchHistoricalCheckpointDto,BranchHostGraphReviewDto,BranchHostRequestReviewDto} from '@ponderosa/core';
export function historyReviewMatches(review:{kind:'request';value:BranchHostRequestReviewDto}|{kind:'graph';value:BranchHostGraphReviewDto},branchId:string,executionId:string,checkpoint:BranchHistoricalCheckpointDto,requestId:string):boolean {
 if(checkpoint.branchId!==branchId||checkpoint.executionId!==executionId||!review.value.reviewHash)return false;
 if(review.kind==='graph'&&(review.value.checkpointId!==checkpoint.id||review.value.checkpointHash!==checkpoint.contentHash))return false;
 const requests=review.kind==='request'?[review.value]:review.value.requests;
 return requests.every(item=>item.source.branchId===branchId&&item.source.executionId===executionId&&item.source.checkpointId===checkpoint.id&&item.source.expectedHash===checkpoint.contentHash&&(review.kind==='graph'||item.source.requestId===requestId));
}

export function historyActionAvailable(action:'adopt'|'restore'|'rewind',checkpoint:BranchHistoricalCheckpointDto|undefined):boolean {
 return Boolean(checkpoint&&(action==='adopt'||checkpoint.restoreSupported&&checkpoint.eligibility==='script_control_frontier'));
}
