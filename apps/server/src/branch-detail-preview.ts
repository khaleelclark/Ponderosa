import type { BranchAttemptDto, BranchExecutionActionsDto, BranchExecutionDetailDto, BranchResult, BranchStepExecutionDto } from '@ponderosa/core';

const INLINE_CODE_POINTS = 128;
const previewText=(value:string):string=>{const points=Array.from(value);return points.length>INLINE_CODE_POINTS?points.slice(0,INLINE_CODE_POINTS).join('')+'…':value};
type TextPreview=(value:string)=>string;
const previewResult=(value:BranchResult|undefined,text:TextPreview):BranchResult|undefined=>value?.output===undefined?value:{...value,output:text(value.output)};
function previewStep(row:BranchStepExecutionDto,text:TextPreview):BranchStepExecutionDto {
  return {...row,input:text(row.input),...(row.result?{result:previewResult(row.result,text)}:{})};
}
function previewAttempt(row:BranchAttemptDto,text:TextPreview):BranchAttemptDto {
  return {...row,...(row.result?{result:previewResult(row.result,text)}:{}),...(row.error?{error:text(row.error)}:{}),
    ...(row.retryBlockedReason?{retryBlockedReason:text(row.retryBlockedReason)}:{}),
    ...(row.scriptEvidence?{scriptEvidence:{...row.scriptEvidence,
      ...(row.scriptEvidence.stdout!==undefined?{stdout:text(row.scriptEvidence.stdout)}:{}),
      ...(row.scriptEvidence.stderr!==undefined?{stderr:text(row.scriptEvidence.stderr)}:{})}}:{})};
}

export function previewBranchExecutionActions(page:BranchExecutionActionsDto):BranchExecutionActionsDto {
  let omitted=false;
  const text:TextPreview=value=>{const next=previewText(value);if(next!==value)omitted=true;return next};
  const items=page.items.map(item=>item.kind==='gate'?{...item,step:previewStep(item.step,text)}:
    {...item,step:previewStep(item.step,text),attempt:previewAttempt(item.attempt,text)});
  return {...page,items,...(omitted?{largeEvidenceOmitted:true}:{})};
}

/** The ordinary history view carries bounded previews. Canonical rows remain untouched. */
export function previewBranchExecutionDetail(detail: BranchExecutionDetailDto): BranchExecutionDetailDto {
  let omitted = false;
  const text = (value: string): string => {
    const next=previewText(value);
    if(next!==value)omitted=true;
    return next;
  };
  const result = (value: BranchResult | undefined): BranchResult | undefined =>
    previewResult(value,text);
  const executionOutputTruncated = detail.execution.output !== undefined && Array.from(detail.execution.output).length > INLINE_CODE_POINTS;
  const executionInputTruncated = Array.from(detail.execution.input).length > INLINE_CODE_POINTS;
  const projected: BranchExecutionDetailDto = {
    ...detail,
    execution: { ...detail.execution, ...(executionInputTruncated ? { input: text(detail.execution.input) } : {}), ...(executionOutputTruncated ? { output: text(detail.execution.output!) } : {}), ...(detail.execution.waitReason ? { waitReason: text(detail.execution.waitReason) } : {}) },
    ...(executionOutputTruncated ? { executionOutputTruncated: true } : {}),
    ...(executionInputTruncated ? { executionInputTruncated: true } : {}),
    waits: detail.waits?.map(wait => ({ ...wait, message: text(wait.message) })),
    decisions: detail.decisions?.map(decision => ({ ...decision, message: text(decision.message) })),
    gates: detail.gates.map(gate => gate.state==='waiting' ? gate : { ...gate, prompt: text(gate.prompt), proposal: text(gate.proposal), ...(gate.resolution?.output!==undefined?{resolution:{...gate.resolution,output:text(gate.resolution.output)}}:{}) }),
    sealedResults: detail.sealedResults?.map(row => ({ ...row, result: result(row.result)! })),
    mapItems: detail.mapItems?.map(row => ({ ...row, input: text(row.input), ...(row.result ? { result: result(row.result) } : {}) })),
    steps: detail.steps.map(row=>previewStep(row,text)),
    attempts: detail.attempts.map(row=>previewAttempt(row,text)),
    paths: detail.paths.map(row => ({ ...row, input: text(row.input), ...(row.result ? { result: result(row.result) } : {}) })),
  };
  return omitted ? { ...projected, largeEvidenceOmitted: true } : projected;
}
