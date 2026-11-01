import type { AgentDetailDto, AgentTelemetryStream, RunOutputDto } from "@ponderosa/core";

function recent<T>(items: T[], limit: number, compare: (left: T, right: T) => number): T[] {
  if (items.length <= limit) return items;
  return [...items].sort(compare).slice(-limit);
}

function limitFor(detail: AgentDetailDto, stream: AgentTelemetryStream): number {
  return Math.max(1, detail.telemetryHistory?.[stream]?.limit ?? 100);
}

/** Keep the live query cache at the same bounded window as its server page.
 * Explicitly loaded history is held separately by AgentDetail. */
export function boundLiveAgentTelemetry(detail: AgentDetailDto): AgentDetailDto {
  return {
    ...detail,
    runOutput: recent(detail.runOutput, limitFor(detail, "runOutput"), (a, b) => a.seq - b.seq),
    activity: recent(detail.activity, limitFor(detail, "activity"), (a, b) => a.seq - b.seq),
    changedFiles: recent(detail.changedFiles, limitFor(detail, "changedFiles"), (a, b) =>
      a.lastSeq - b.lastSeq || a.path.localeCompare(b.path)),
    runs: recent(detail.runs, limitFor(detail, "runs"), (a, b) =>
      a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)),
    workItems: recent(detail.workItems, limitFor(detail, "workItems"), (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    artifacts: recent(detail.artifacts, limitFor(detail, "artifacts"), (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  };
}

/** A concurrent canonical snapshot can already contain a queued SSE delta. */
export function appendLiveRunText(output:RunOutputDto[],input:{agentId:string;executionId:string;kind:RunOutputDto['kind'];seq:number;createdAt:string;delta:string}):RunOutputDto[] {
  if(output.some(entry=>entry.executionId===input.executionId&&entry.kind===input.kind&&entry.sourceSeqEnd>=input.seq))return output;
  const existing=[...output].reverse().find(entry=>!entry.completed&&entry.executionId===input.executionId&&entry.kind===input.kind);
  const next:RunOutputDto=existing?{...existing,text:existing.text+input.delta,sourceSeqEnd:input.seq}:{
    id:`${input.agentId}:runOutput:${input.seq}`,agentId:input.agentId,executionId:input.executionId,kind:input.kind,text:input.delta,
    completed:false,seq:input.seq,sourceSeqStart:input.seq,sourceSeqEnd:input.seq,createdAt:input.createdAt,
  };
  const closed=output.map(entry=>entry.completed||entry.id===existing?.id?entry:{...entry,completed:true});
  return existing?closed.map(entry=>entry.id===existing.id?next:entry):[...closed,next];
}

export function closeLiveRunText(output:RunOutputDto[],executionId:string):RunOutputDto[] {
  return output.map(entry=>entry.executionId===executionId&&!entry.completed?{...entry,completed:true}:entry);
}
