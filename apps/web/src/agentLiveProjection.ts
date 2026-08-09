import type { AgentDetailDto, AgentTelemetryStream } from "@ponderosa/core";

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
