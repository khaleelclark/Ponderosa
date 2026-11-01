import type {BranchGenerationOnePreview,BranchIssuedResourceCaptureDto} from '@ponderosa/core';
export function generationOnePreviewMatches(value:BranchGenerationOnePreview,executionId:string,stepId:string):boolean {
 const s=value?.historicalPartition;
 return value?.generation===1&&/^[a-f0-9]{64}$/.test(value.reviewHash)&&/^[a-f0-9]{64}$/.test(value.historicalReviewHash)&&Array.isArray(s)&&s.length===1&&s.every(x=>x.executionId===executionId&&x.stepId===stepId&&x.generation===0&&Number.isSafeInteger(x.checkpointId)&&x.checkpointId>0&&/^[a-f0-9]{64}$/.test(x.checkpointHash)&&/^[a-f0-9]{64}$/.test(x.envelopeSha256)&&Boolean(x.intakeFence?.identity)&&/^[a-f0-9]{64}$/.test(x.intakeFence.sha256)&&Array.isArray(x.discloseTo)&&x.discloseTo.length>0&&new Set(x.discloseTo).size===x.discloseTo.length&&x.discloseTo.every(id=>typeof id==='string'&&id.length>0));
}
export function generationOneCaptureMatches(value:BranchIssuedResourceCaptureDto,preview:BranchGenerationOnePreview,key:string):boolean {
 return value.commandKey===key&&value.restoreSupported===false&&value.reviewHash===preview.reviewHash&&value.historicalReviewHash===preview.historicalReviewHash&&JSON.stringify(value.historicalPartition)===JSON.stringify(preview.historicalPartition)&&['capturing','retained'].includes(value.state)&&(value.state!=='retained'||Number.isSafeInteger(value.checkpointId)&&value.checkpointId!>0&&/^[a-f0-9]{64}$/.test(value.checkpointHash??''));
}
export type GenerationOneSelection={preview:BranchGenerationOnePreview;capture:BranchIssuedResourceCaptureDto};
/** Retired native seal/retirement bytes are not an additional UI payload surface. */
export function generationOneReceiptProjection(value:import('@ponderosa/core').BranchIssuedDestinationDto):unknown {
 if(!value.receipt?.historicalPartition)return value;
 return {...value,receipt:{...value.receipt,historicalPartition:value.receipt.historicalPartition.map(p=>({sha256:p.sha256,selection:p.selection,destinationAgentIds:p.destinationAgentIds,historical:p.historical,dispatchable:p.dispatchable}))}};
}
