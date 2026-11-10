import type {BranchGenerationOnePreview,BranchGenerationHistoryPreview,BranchIssuedResourceCaptureDto,CoordinationHistoricalGenerationSelection} from '@ponderosa/core';
/** Recovery copies only the original canonical cut and verified saved budget. */
export type GenerationPreviewEvidence=Pick<BranchGenerationHistoryPreview,'generation'|'reviewHash'|'historicalReviewHash'|'historicalPartition'>&Partial<Pick<BranchGenerationHistoryPreview,'consumedAttempts'|'maxAttempts'>>&Pick<BranchIssuedResourceCaptureDto,'retryBudget'|'checkpointId'|'checkpointHash'|'historyKind'>;
export function generationHistoryKindMatches(value:unknown):boolean {return value===undefined||value==='serial'||value==='local_parallel';}
export function generationHistoryKindLabel(value:GenerationPreviewEvidence['historyKind']):string {return value===undefined?'History classification unavailable in legacy evidence; no workflow shape inferred':`Server History Classification: ${value}`;}
export function generationCaptureBudgetMatches(value:BranchIssuedResourceCaptureDto):boolean {
 if(!generationHistoryKindMatches(value.historyKind)||value.historyKind!==undefined&&value.retryBudget?.state!=='verified')return false;
 const b=value.retryBudget;
 if(b===undefined)return value.consumedAttempts===undefined&&value.maxAttempts===undefined;
 if(!b||typeof b!=='object')return false;
 if(b.state==='unavailable')return b.reason==='missing_saved_retry_proof'&&value.consumedAttempts===undefined&&value.maxAttempts===undefined;
 return b.state==='verified'&&Number.isSafeInteger(value.generation)&&b.consumedAttempts===value.generation!+1&&Number.isSafeInteger(b.maxAttempts)&&b.maxAttempts>=b.consumedAttempts&&b.maxAttempts<=100&&/^[a-f0-9]{64}$/.test(b.evidenceHash)&&value.consumedAttempts===b.consumedAttempts&&value.maxAttempts===b.maxAttempts;
}
export function generationCaptureEvidence(value:BranchIssuedResourceCaptureDto):GenerationPreviewEvidence {
 if(!generationCaptureBudgetMatches(value))throw Error('Malformed saved retry-budget evidence');
 return {historyKind:value.historyKind,generation:value.generation!,reviewHash:value.reviewHash!,historicalReviewHash:value.historicalReviewHash!,historicalPartition:value.historicalPartition!,checkpointId:value.checkpointId,checkpointHash:value.checkpointHash,retryBudget:value.retryBudget,...(value.retryBudget?.state==='verified'?{consumedAttempts:value.retryBudget.consumedAttempts,maxAttempts:value.retryBudget.maxAttempts}:{})};
}
export function generationCaptureBudgetLabel(value:BranchIssuedResourceCaptureDto):string {
 if(!generationCaptureBudgetMatches(value))return 'Malformed saved retry-budget evidence; held.';
 const b=value.retryBudget;
 return b?.state==='verified'?`Verified Saved Budget · Consumed Attempts ${b.consumedAttempts} · Pinned Maximum Attempts ${b.maxAttempts} · Evidence Hash ${b.evidenceHash}`:'Saved retry budget unavailable · missing original proof · no numbers/reset inferred';
}
export function generationHistorySelectionsMatch(selections:CoordinationHistoricalGenerationSelection[],generation:number,executionId:string,stepId:string):boolean {
 return Number.isSafeInteger(generation)&&generation>=1&&generation<=32&&Array.isArray(selections)&&selections.length===generation&&new Set(selections.map(s=>s?.checkpointId)).size===generation&&new Set(selections.map(s=>s?.envelopeSha256)).size===generation&&new Set(selections.map(s=>s?.intakeFence?.identity)).size===generation&&selections.every((x,index)=>x?.executionId===executionId&&x.stepId===stepId&&x.generation===index&&Number.isSafeInteger(x.checkpointId)&&x.checkpointId>0&&/^[a-f0-9]{64}$/.test(x.checkpointHash)&&/^[a-f0-9]{64}$/.test(x.envelopeSha256)&&Boolean(x.intakeFence?.identity)&&/^[a-f0-9]{64}$/.test(x.intakeFence.sha256)&&Array.isArray(x.discloseTo)&&x.discloseTo.length>0&&new Set(x.discloseTo).size===x.discloseTo.length&&x.discloseTo.every(id=>typeof id==='string'&&id.length>0)&&JSON.stringify(x.discloseTo)===JSON.stringify(selections[0]?.discloseTo));
}
export function generationSelectionMatches(value:GenerationPreviewEvidence,executionId:string,stepId:string):boolean {
 return Boolean(value)&&generationHistoryKindMatches(value.historyKind)&&(value.retryBudget===undefined||generationCaptureBudgetMatches(value as BranchIssuedResourceCaptureDto))&&(value.consumedAttempts===undefined&&value.maxAttempts===undefined||value.consumedAttempts===value.generation+1&&Number.isSafeInteger(value.maxAttempts)&&value.maxAttempts!>=value.consumedAttempts&&value.maxAttempts!<=100)&&/^[a-f0-9]{64}$/.test(value.reviewHash)&&/^[a-f0-9]{64}$/.test(value.historicalReviewHash)&&generationHistorySelectionsMatch(value.historicalPartition,value.generation,executionId,stepId);
}
export function generationHistoryPreviewMatches(value:BranchGenerationHistoryPreview,executionId:string,stepId:string):boolean {
 return (value?.historyKind==='serial'||value?.historyKind==='local_parallel')&&generationSelectionMatches(value,executionId,stepId)&&value.consumedAttempts===value.generation+1&&Number.isSafeInteger(value.maxAttempts)&&value.maxAttempts>=value.consumedAttempts&&value.maxAttempts<=100;
}
/** Compatibility validator for original saved generation-one commands. */
export function generationOnePreviewMatches(value:BranchGenerationOnePreview,executionId:string,stepId:string):boolean {
 return value?.generation===1&&generationSelectionMatches(value,executionId,stepId);
}
export function generationOneCaptureMatches(value:BranchIssuedResourceCaptureDto,preview:GenerationPreviewEvidence,key:string):boolean {
 return generationCaptureBudgetMatches(value)&&(preview.historyKind===undefined||value.historyKind===preview.historyKind)&&(preview.checkpointId===undefined||value.checkpointId===preview.checkpointId&&value.checkpointHash===preview.checkpointHash)&&(preview.retryBudget?.state!=='verified'||value.retryBudget?.state==='verified'&&value.retryBudget.evidenceHash===preview.retryBudget.evidenceHash)&&(value.retryBudget?.state!=='verified'||preview.consumedAttempts===undefined||value.retryBudget.consumedAttempts===preview.consumedAttempts&&value.retryBudget.maxAttempts===preview.maxAttempts)&&value.commandKey===key&&value.restoreSupported===false&&(value.generation===preview.generation||value.generation===undefined&&preview.generation===1)&&value.reviewHash===preview.reviewHash&&value.historicalReviewHash===preview.historicalReviewHash&&JSON.stringify(value.historicalPartition)===JSON.stringify(preview.historicalPartition)&&['capturing','retained'].includes(value.state)&&(value.state!=='retained'||Number.isSafeInteger(value.checkpointId)&&value.checkpointId!>0&&!preview.historicalPartition.some(s=>s.checkpointId===value.checkpointId)&&/^[a-f0-9]{64}$/.test(value.checkpointHash??''));
}
export function generationOneSelectionMatches(value:GenerationOneSelection,executionId:string):boolean {
 const stepId=value?.preview?.historicalPartition?.[0]?.stepId;
 return typeof stepId==='string'&&stepId.length>0&&generationSelectionMatches(value.preview,executionId,stepId)&&value.capture?.state==='retained'&&generationOneCaptureMatches(value.capture,value.preview,value.capture.commandKey);
}
export type GenerationOneSelection={preview:GenerationPreviewEvidence;capture:BranchIssuedResourceCaptureDto};
/** Retired native seal/retirement bytes are not an additional UI payload surface. */
export function generationOneReceiptProjection(value:import('@ponderosa/core').BranchIssuedDestinationDto):unknown {
 if(!value.receipt?.historicalPartition)return value;
 return {...value,receipt:{...value.receipt,historicalPartition:value.receipt.historicalPartition.map(p=>({sha256:p.sha256,selection:p.selection,destinationAgentIds:p.destinationAgentIds,historical:p.historical,dispatchable:p.dispatchable}))}};
}
