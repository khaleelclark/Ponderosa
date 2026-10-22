import type { BranchExecutionDetailDto, BranchResult } from '@ponderosa/core';

const INLINE_CODE_POINTS = 128;

/** The ordinary history view carries bounded previews. Canonical rows remain untouched. */
export function previewBranchExecutionDetail(detail: BranchExecutionDetailDto): BranchExecutionDetailDto {
  let omitted = false;
  const text = (value: string): string => {
    const points = Array.from(value);
    if (points.length <= INLINE_CODE_POINTS) return value;
    omitted = true;
    return points.slice(0, INLINE_CODE_POINTS).join('') + '…';
  };
  const result = (value: BranchResult | undefined): BranchResult | undefined =>
    value?.output === undefined ? value : { ...value, output: text(value.output) };
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
    steps: detail.steps.map(row => ({ ...row, input: text(row.input), ...(row.result ? { result: result(row.result) } : {}) })),
    attempts: detail.attempts.map(row => ({ ...row,
      ...(row.result ? { result: result(row.result) } : {}),
      ...(row.error ? { error: text(row.error) } : {}),
      ...(row.retryBlockedReason ? { retryBlockedReason: text(row.retryBlockedReason) } : {}),
      ...(row.scriptEvidence ? { scriptEvidence: {
        ...row.scriptEvidence,
        ...(row.scriptEvidence.stdout !== undefined ? { stdout: text(row.scriptEvidence.stdout) } : {}),
        ...(row.scriptEvidence.stderr !== undefined ? { stderr: text(row.scriptEvidence.stderr) } : {}),
      } } : {}),
    })),
    paths: detail.paths.map(row => ({ ...row, input: text(row.input), ...(row.result ? { result: result(row.result) } : {}) })),
  };
  return omitted ? { ...projected, largeEvidenceOmitted: true } : projected;
}
