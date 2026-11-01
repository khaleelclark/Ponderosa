import type {BranchGenerationOnePreview,BranchGenerationHistoryPreview,BranchIssuedResourceCaptureDto,CoordinationHistoricalGenerationSelection} from '@ponderosa/core';
/** Status has no budget fields; do not manufacture a preview or retry budget on recovery. */
export type GenerationPreviewEvidence=Pick<BranchGenerationHistoryPreview,'generation'|'reviewHash'|'historicalReviewHash'|'historicalPartition'>&Partial<Pick<BranchGenerationHistoryPreview,'consumedAttempts'|'maxAttempts'>>;
export function generationHistorySelectionsMatch(selections:CoordinationHistoricalGenerationSelection[],generation:number,executionId:string,stepId:string):boolean {
 return Number.isSafeInteger(generation)&&generation>=1&&generation<=32&&Array.isArray(selections)&&selections.length===generation&&new Set(selections.map(s=>s?.checkpointId)).size===generation&&new Set(selections.map(s=>s?.envelopeSha256)).size===generation&&new Set(selections.map(s=>s?.intakeFence?.identity)).size===generation&&selections.every((x,index)=>x?.executionId===executionId&&x.stepId===stepId&&x.generation===index&&Number.isSafeInteger(x.checkpointId)&&x.checkpointId>0&&/^[a-f0-9]{64}$/.test(x.checkpointHash)&&/^[a-f0-9]{64}$/.test(x.envelopeSha256)&&Boolean(x.intakeFence?.identity)&&/^[a-f0-9]{64}$/.test(x.intakeFence.sha256)&&Array.isArray(x.discloseTo)&&x.discloseTo.length>0&&new Set(x.discloseTo).size===x.discloseTo.length&&x.discloseTo.every(id=>typeof id==='string'&&id.length>0)&&JSON.stringify(x.discloseTo)===JSON.stringify(selections[0].discloseTo));
}
export function generationSelectionMatches(value:GenerationPreviewEvidence,executionId:string,stepId:string):boolean {
 return Boolean(value)&&(value.consumedAttempts===undefined&&value.maxAttempts===undefined||value.consumedAttempts===value.generation+1&&Number.isSafeInteger(value.maxAttempts)&&value.maxAttempts!>=value.consumedAttempts&&value.maxAttempts!<=33)&&/^[a-f0-9]{64}$/.test(value.reviewHash)&&/^[a-f0-9]{64}$/.test(value.historicalReviewHash)&&generationHistorySelectionsMatch(value.historicalPartition,value.generation,executionId,stepId);
}
export function generationHistoryPreviewMatches(value:BranchGenerationHistoryPreview,executionId:string,stepId:string):boolean {
 return generationSelectionMatches(value,executionId,stepId)&&value.consumedAttempts===value.generation+1&&Number.isSafeInteger(value.maxAttempts)&&value.maxAttempts>=value.consumedAttempts&&value.maxAttempts<=33;
}
/** Compatibility validator for original saved generation-one commands. */
export function generationOnePreviewMatches(value:BranchGenerationOnePreview,executionId:string,stepId:string):boolean {
 return value?.generation===1&&generationSelectionMatches(value,executionId,stepId);
}
export function generationOneCaptureMatches(value:BranchIssuedResourceCaptureDto,preview:GenerationPreviewEvidence,key:string):boolean {
 return value.commandKey===key&&value.restoreSupported===false&&(value.generation===preview.generation||value.generation===undefined&&preview.generation===1)&&value.reviewHash===preview.reviewHash&&value.historicalReviewHash===preview.historicalReviewHash&&JSON.stringify(value.historicalPartition)===JSON.stringify(preview.historicalPartition)&&['capturing','retained'].includes(value.state)&&(value.state!=='retained'||Number.isSafeInteger(value.checkpointId)&&value.checkpointId!>0&&!preview.historicalPartition.some(s=>s.checkpointId===value.checkpointId)&&/^[a-f0-9]{64}$/.test(value.checkpointHash??''));
}
export type GenerationOneSelection={preview:GenerationPreviewEvidence;capture:BranchIssuedResourceCaptureDto};
/** Retired native seal/retirement bytes are not an additional UI payload surface. */
export function generationOneReceiptProjection(value:import('@ponderosa/core').BranchIssuedDestinationDto):unknown {
 if(!value.receipt?.historicalPartition)return value;
 return {...value,receipt:{...value.receipt,historicalPartition:value.receipt.historicalPartition.map(p=>({sha256:p.sha256,selection:p.selection,destinationAgentIds:p.destinationAgentIds,historical:p.historical,dispatchable:p.dispatchable}))}};
}
