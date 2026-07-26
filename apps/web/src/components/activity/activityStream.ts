import type {
  AgentActivityDto,
  AgentEvent,
  AgentRunDto,
  FileChangeKind,
  RunOutputDto,
} from "@ponderosa/core";
import { unifiedDiffLineTotals } from "@ponderosa/core";

export interface ActivityStreamInput {
  activity: AgentActivityDto[];
  runOutput: RunOutputDto[];
  runs: AgentRunDto[];
  activeExecutionId?: string;
}

export interface ActivityStreamResult {
  activityId: string;
  agentId: string;
  seq: number;
  output: string;
  isError: boolean;
  outputPreview?: AgentActivityDto["outputPreview"];
}

interface ActivityStreamBase {
  id: string;
  seq: number;
  createdAt: string;
}

export type ActivityStreamEntry =
  | (ActivityStreamBase & {
      kind: "run_header";
      run?: AgentRunDto;
      executionId?: string;
      active: boolean;
    })
  | (ActivityStreamBase & { kind: "thinking"; segment: RunOutputDto })
  | (ActivityStreamBase & { kind: "response"; segment: RunOutputDto })
  | (ActivityStreamBase & {
      kind: "command";
      command: string;
      cwd: string;
      internal: boolean;
      result?: ActivityStreamResult;
    })
  | (ActivityStreamBase & {
      kind: "tool";
      name: string;
      input: unknown;
      result?: ActivityStreamResult;
    })
  | (ActivityStreamBase & {
      kind: "file";
      agentId: string;
      path: string;
      changeKind: FileChangeKind;
      artifactId: string;
      additions?: number;
      deletions?: number;
      result?: ActivityStreamResult;
    })
  | (ActivityStreamBase & {
      kind: "test";
      passed: boolean;
      summary: string;
    })
  | (ActivityStreamBase & {
      kind: "error";
      message: string;
    })
  | (ActivityStreamBase & {
      kind: "browser";
      event: Extract<AgentActivityDto["event"], {
        type: "browser_session" | "browser_action" | "browser_console" | "browser_screenshot";
      }>;
    })
  | (ActivityStreamBase & {
      kind: "notice";
      title: string;
      detail?: string;
      result?: ActivityStreamResult;
    });

interface Candidate {
  executionId?: string;
  entry: ActivityStreamEntry;
  callId?: string;
}

const INTERNAL_COMMUNICATION_COMMAND =
  /PONDEROSA_(?:AGENT_MESSAGE|AGENT_SPAWN)|\/api\/agent-(?:messages|spawns)/u;

function activityResult(item: AgentActivityDto): ActivityStreamResult | undefined {
  if (item.event.type !== "tool_result") return undefined;
  return {
    activityId: item.id,
    agentId: item.agentId,
    seq: item.seq,
    output: item.event.output,
    isError: item.event.isError === true,
    ...(item.outputPreview ? { outputPreview: item.outputPreview } : {}),
  };
}

function activityCandidate(item: AgentActivityDto): Candidate | undefined {
  const base = { id: item.id, seq: item.seq, createdAt: item.createdAt };
  const event = item.event;
  switch (event.type) {
    case "command":
      return {
        executionId: item.executionId,
        callId: event.callId,
        entry: {
          ...base,
          kind: "command",
          command: event.command,
          cwd: event.cwd,
          internal: INTERNAL_COMMUNICATION_COMMAND.test(event.command),
        },
      };
    case "tool_call":
      return {
        executionId: item.executionId,
        callId: event.id,
        entry: { ...base, kind: "tool", name: event.name, input: event.input },
      };
    case "file_change": {
      const totals = unifiedDiffLineTotals(event.diff);
      return {
        executionId: item.executionId,
        callId: event.callId,
        entry: {
          ...base,
          kind: "file",
          agentId: item.agentId,
          path: event.path,
          changeKind: event.kind,
          artifactId: `${item.agentId}:a:${item.seq}:0`,
          ...(totals ?? {}),
        },
      };
    }
    case "test_result":
      return {
        executionId: item.executionId,
        entry: { ...base, kind: "test", passed: event.passed, summary: event.summary },
      };
    case "error":
      return {
        executionId: item.executionId,
        entry: { ...base, kind: "error", message: event.message },
      };
    case "browser_session":
    case "browser_action":
    case "browser_console":
    case "browser_screenshot":
      return {
        executionId: item.executionId,
        entry: { ...base, kind: "browser", event },
      };
    case "context_rollover_triggered":
      return {
        executionId: item.executionId,
        entry: {
          ...base,
          kind: "notice",
          title: "Context rollover scheduled",
          detail: `${event.usedTokens.toLocaleString()} context tokens used · threshold ${event.threshold.toLocaleString()}`,
        },
      };
    case "tool_result":
      return undefined;
  }
}

function withResult(entry: ActivityStreamEntry, result: ActivityStreamResult): ActivityStreamEntry {
  if (entry.kind !== "command" && entry.kind !== "tool" && entry.kind !== "file") return entry;
  return { ...entry, result };
}

function pairResults(activity: AgentActivityDto[], candidates: Candidate[]): Candidate[] {
  const results = activity
    .filter((item): item is AgentActivityDto & {
      event: Extract<AgentEvent, { type: "tool_result" }>;
    } => item.event.type === "tool_result")
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const resultByCallId = new Map<string, typeof results[number]>();
  for (const result of results) {
    if (result.event.id && !resultByCallId.has(result.event.id)) {
      resultByCallId.set(result.event.id, result);
    }
  }
  const consumed = new Set<string>();
  const exactPaired = candidates.map((candidate) => {
    if (!candidate.callId) return candidate;
    const result = resultByCallId.get(candidate.callId);
    if (!result || consumed.has(result.id)) return candidate;
    const paired = activityResult(result);
    if (!paired) return candidate;
    consumed.add(result.id);
    return { ...candidate, entry: withResult(candidate.entry, paired) };
  });

  const bySeq = [
    ...exactPaired.map((candidate) => ({ type: "candidate" as const, seq: candidate.entry.seq, candidate })),
    ...results
      .filter((result) => !consumed.has(result.id))
      .map((result) => ({ type: "result" as const, seq: result.seq, result })),
  ].sort((a, b) => a.seq - b.seq ||
    (a.type === "candidate" ? a.candidate.entry.id : a.result.id)
      .localeCompare(b.type === "candidate" ? b.candidate.entry.id : b.result.id));
  const openByExecution = new Map<string, Candidate[]>();
  const replacements = new Map<string, Candidate>();
  for (const item of bySeq) {
    if (item.type === "candidate") {
      const candidate = replacements.get(item.candidate.entry.id) ?? item.candidate;
      const alreadyPaired = (candidate.entry.kind === "command" ||
        candidate.entry.kind === "tool" || candidate.entry.kind === "file") &&
        candidate.entry.result !== undefined;
      if (!alreadyPaired) {
        const executionKey = candidate.executionId ?? "unscoped";
        const open = openByExecution.get(executionKey) ?? [];
        open.push(candidate);
        openByExecution.set(executionKey, open);
      }
      continue;
    }
    const executionKey = item.result.executionId ?? "unscoped";
    const open = openByExecution.get(executionKey) ?? [];
    if (open.length !== 1) continue;
    const candidate = open[0]!;
    const paired = activityResult(item.result);
    if (!paired || item.result.seq <= candidate.entry.seq) continue;
    replacements.set(candidate.entry.id, {
      ...candidate,
      entry: withResult(candidate.entry, paired),
    });
    consumed.add(item.result.id);
    openByExecution.delete(executionKey);
  }

  const pairedCandidates = exactPaired.map((candidate) =>
    replacements.get(candidate.entry.id) ?? candidate);
  for (const result of results) {
    if (consumed.has(result.id)) continue;
    const paired = activityResult(result);
    if (!paired) continue;
    pairedCandidates.push({
      executionId: result.executionId,
      entry: {
        id: result.id,
        seq: result.seq,
        createdAt: result.createdAt,
        kind: "notice",
        title: result.event.isError ? "Unmatched tool error" : "Unmatched tool result",
        detail: result.event.id ? `Call ${result.event.id}` : undefined,
        result: paired,
      },
    });
  }
  return pairedCandidates;
}

/** Pure chronological projection for the read-only Agent Activity inspection surface. */
export function buildActivityStream(input: ActivityStreamInput): ActivityStreamEntry[] {
  const activityCandidates = input.activity.flatMap((item) => {
    const candidate = activityCandidate(item);
    return candidate ? [candidate] : [];
  });
  const candidates: Candidate[] = [
    ...pairResults(input.activity, activityCandidates),
    ...input.runOutput.map((segment): Candidate => ({
      executionId: segment.executionId,
      entry: {
        id: segment.id,
        seq: segment.seq,
        createdAt: segment.createdAt,
        kind: segment.kind === "reasoning" ? "thinking" : "response",
        segment,
      },
    })),
  ].sort((a, b) => a.entry.seq - b.entry.seq || a.entry.id.localeCompare(b.entry.id));

  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const emittedHeaders = new Set<string>();
  const entries: ActivityStreamEntry[] = [];
  for (const candidate of candidates) {
    const headerKey = candidate.executionId ?? "unscoped";
    if (!emittedHeaders.has(headerKey)) {
      const run = candidate.executionId ? runById.get(candidate.executionId) : undefined;
      entries.push({
        kind: "run_header",
        id: candidate.executionId ? `run:${candidate.executionId}` : "run:unscoped",
        seq: candidate.entry.seq,
        createdAt: run?.startedAt ?? candidate.entry.createdAt,
        ...(run ? { run } : {}),
        ...(candidate.executionId ? { executionId: candidate.executionId } : {}),
        active: candidate.executionId !== undefined &&
          candidate.executionId === input.activeExecutionId,
      });
      emittedHeaders.add(headerKey);
    }
    entries.push(candidate.entry);
  }

  const emptyRuns = input.runs
    .filter((run) => !emittedHeaders.has(run.id))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  for (const [index, run] of emptyRuns.entries()) {
    entries.push({
      kind: "run_header",
      id: `run:${run.id}`,
      seq: Number.MAX_SAFE_INTEGER - emptyRuns.length + index,
      createdAt: run.startedAt,
      run,
      executionId: run.id,
      active: run.id === input.activeExecutionId,
    });
  }
  return entries;
}
