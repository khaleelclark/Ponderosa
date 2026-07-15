import type { AgentActivityDto, AgentEvent, AgentRunDto, ArtifactDto, ChangedFileDto, SseEventEnvelope, WorkItemDto, RunOutputDto, AgentDetailDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { compactDefined } from "../collections";

export interface ExecutionItem {
  id: string;
  seq: number;
  ts: string;
  event: Extract<AgentEvent, { type: "command" | "file_change" | "test_result" | "tool_call" | "tool_result" | "error" }>;
}

export interface StreamState {
  connected: boolean;
  running: boolean;
  lastSeq?: number;
  timeline: ExecutionItem[];
}

const initialStreamState: StreamState = {
  connected: false,
  running: false,
  timeline: [],
};

const executionTypes: ReadonlySet<string> = new Set([
  "command",
  "file_change",
  "test_result",
  "tool_call",
  "tool_result",
  "error",
]);

export function runningAfterAgentEvent(current: boolean, event: SseEventEnvelope["event"]): boolean {
  if (event.type === "turn_done" || event.type === "error") return false;
  if (event.type === "agent_lifecycle") return event.status === "running" || event.status === "compacting";
  return current || event.type === "session" || event.type === "work_item_update" || executionTypes.has(event.type);
}

const streamCursors = new Map<string, { lastSeq?: number; seenSeqs: Set<number> }>();

function projectedArtifactId(agentId: string, seq: number): string {
  return `${agentId}:a:${seq}:0`;
}

function projectedWorkItemId(agentId: string, workItemId: string): string {
  return `${agentId}:work-item:${workItemId}`;
}

export function updateAgentDetail(agentId: string, envelope: SseEventEnvelope, detail: AgentDetailDto): AgentDetailDto {
  const { event, seq, ts } = envelope;

  if (event.type === "agent_wait_changed") {
    return { ...detail, activeWait: event.activeWait ?? undefined };
  }

  if (event.type === "coordination_v3_changed") {
    return { ...detail, coordinationV3: event.coordination };
  }

  if (executionTypes.has(event.type)) {
    const activity = detail.activity ?? [];
    const id = `${agentId}:activity:${seq}`;
    if (!activity.some((item) => item.id === id)) {
      const entry: AgentActivityDto = {
        id, agentId, seq, createdAt: ts,
        event: event as AgentActivityDto["event"],
      };
      detail = { ...detail, activity: [...activity, entry].sort((a, b) => a.seq - b.seq) };
    }
    if (event.type === "file_change") {
      const changedFiles = detail.changedFiles ?? [];
      const previous = changedFiles.find((item) => item.path === event.path);
      const changed: ChangedFileDto = {
        path: event.path,
        kind: event.kind,
        lastSeq: seq,
        lastChangedAt: ts,
        executionIds: previous?.executionIds ?? [],
        ...(event.diff ? { diff: event.diff } : {}),
      };
      detail = {
        ...detail,
        changedFiles: previous
          ? changedFiles.map((item) => item.path === event.path ? changed : item)
          : [...changedFiles, changed],
      };
    }
  }

  if (event.type === "text" || event.type === "reasoning") {
    if (envelope.replayed) return detail;
    const runOutput = compactDefined(detail.runOutput ?? []);
    const executionId = event.executionId ?? `live:${seq}`;
    const kind = event.type === "reasoning" ? "reasoning" : "response";
    const id = `live-runOutput:${executionId}:${kind}`;
    const existing = runOutput.find((entry) => entry.id === id);
    const next: RunOutputDto = existing ? {
      ...existing,
      text: `${existing.text}${event.delta}`,
      seq,
      sourceSeqEnd: seq,
    } : {
      id,
      agentId,
      executionId,
      kind,
      text: event.delta,
      completed: false,
      seq,
      sourceSeqStart: seq,
      sourceSeqEnd: seq,
      createdAt: ts,
    };
    return {
      ...detail,
      runOutput: existing
        ? runOutput.map((entry) => entry.id === id ? next : entry)
        : [...runOutput, next],
    };
  }

  if (event.type === "agent_output") {
    const runOutput = compactDefined(detail.runOutput ?? []);
    const entry: RunOutputDto = {
      id: `${agentId}:runOutput:${seq}`,
      agentId,
      executionId: event.executionId,
      kind: "response",
      text: event.text,
      completed: true,
      seq,
      sourceSeqStart: event.sourceSeqStart,
      sourceSeqEnd: event.sourceSeqEnd,
      createdAt: ts,
    };
    if (runOutput.some((item) => item.id === entry.id)) return detail;
    return {
      ...detail,
      runOutput: [...runOutput.filter((item) => !(item.executionId === event.executionId && item.kind === "response" && !item.completed)), entry]
        .sort((a, b) => a.seq - b.seq),
    };
  }

  if (event.type === "agent_lifecycle") {
    const runs = compactDefined(detail.runs);
    const existing = runs.find((run) => run.id === event.executionId);
    const sourceMessage = [...detail.messages].reverse().find((message) => message.role === "user");
    const terminal = ["cancelled", "completed", "failed", "interrupted"].includes(event.status);
    const nextRun: AgentRunDto = {
      id: event.executionId,
      agentId,
      title: existing?.title ?? sourceMessage?.text.slice(0, 80) ?? "Run",
      status: event.status,
      reason: event.reason,
      engine: detail.agent.activeEngine,
      communicationEventId: existing?.communicationEventId ?? sourceMessage?.communicationEventId,
      wakeCause: event.wakeCause ?? existing?.wakeCause,
      startedAt: existing?.startedAt ?? ts,
      updatedAt: ts,
      completedAt: terminal ? ts : existing?.completedAt,
    };
    return {
      ...detail,
      ...(event.status === "running" ? { activeWait: undefined } : {}),
      runs: existing ? runs.map((run) => run.id === event.executionId ? nextRun : run) : [...runs, nextRun],
    };
  }

  if (event.type === "work_item_update") {
    const workItems = compactDefined(detail.workItems);
    const canonicalId = projectedWorkItemId(agentId, event.workItemId);
    const existing = workItems.find((item) => item.id === canonicalId || item.id === event.workItemId);
    const nextWorkItem: WorkItemDto = {
      id: existing?.id ?? canonicalId,
      agentId,
      executionId: event.executionId ?? existing?.executionId,
      title: event.title ?? existing?.title ?? "Work item",
      status: event.status,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    const nextWorkItems = existing
      ? workItems.map((item) => (item.id === canonicalId || item.id === event.workItemId ? nextWorkItem : item))
      : [...workItems, nextWorkItem];
    return { ...detail, workItems: nextWorkItems };
  }

  if (event.type === "file_change") {
    const artifacts = compactDefined(detail.artifacts);
    if (
      artifacts.some(
        (artifact) => artifact.id === projectedArtifactId(agentId, seq) || artifact.id === `live-artifact-${seq}`,
      )
    ) {
      return detail;
    }
    const isPdf = event.path.toLowerCase().endsWith(".pdf");
    const artifact: ArtifactDto = {
      id: `live-artifact-${seq}`,
      agentId,
      executionId: [...(detail.runs ?? [])].reverse().find((run) => run.status === "running")?.id,
      kind: isPdf ? "document" : "diff",
      path: event.path,
      summary: `${event.kind} ${event.path}`,
      createdAt: ts,
      ...(isPdf ? { mediaType: "application/pdf" as const } : {}),
    };
    return { ...detail, artifacts: [...artifacts, artifact] };
  }

  if (event.type === "test_result") {
    const artifacts = compactDefined(detail.artifacts);
    if (
      artifacts.some(
        (artifact) => artifact.id === projectedArtifactId(agentId, seq) || artifact.id === `live-artifact-${seq}`,
      )
    ) {
      return detail;
    }
    const artifact: ArtifactDto = {
      id: `live-artifact-${seq}`,
      agentId,
      executionId: [...(detail.runs ?? [])].reverse().find((run) => run.status === "running")?.id,
      kind: "test_report",
      path: `test-result-${seq}.md`,
      summary: event.summary,
      createdAt: ts,
    };
    return { ...detail, artifacts: [...artifacts, artifact] };
  }

  return detail;
}

export function useAgentStream(agentId: string | undefined): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>(initialStreamState);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const seenSeqRef = useRef(new Set<number>());

  useEffect(() => {
    if (!agentId) {
      lastSeqRef.current = undefined;
      seenSeqRef.current = new Set<number>();
      setState(initialStreamState);
      return undefined;
    }

    const cursor = streamCursors.get(agentId) ?? { seenSeqs: new Set<number>() };
    streamCursors.set(agentId, cursor);
    lastSeqRef.current = cursor.lastSeq;
    seenSeqRef.current = new Set(cursor.seenSeqs);
    setState({ ...initialStreamState, lastSeq: cursor.lastSeq });

    const subscription = api.subscribeAgent(agentId, lastSeqRef.current, {
      onOpen() {
        setState((current) => ({ ...current, connected: true }));
      },
      onError() {
        setState((current) => ({ ...current, connected: false }));
      },
      onEvent(envelope) {
        if (seenSeqRef.current.has(envelope.seq)) {
          return;
        }
        seenSeqRef.current.add(envelope.seq);
        lastSeqRef.current = envelope.seq;
        cursor.seenSeqs.add(envelope.seq);
        cursor.lastSeq = envelope.seq;

        setState((current) => ({
          ...current,
          connected: true,
          running: runningAfterAgentEvent(current.running, envelope.event),
          lastSeq: envelope.seq,
          timeline: executionTypes.has(envelope.event.type)
            ? [
                ...current.timeline,
                {
                  id: `event-${envelope.seq}`,
                  seq: envelope.seq,
                  ts: envelope.ts,
                  event: envelope.event as ExecutionItem["event"],
                },
              ]
            : current.timeline,
        }));

        queryClient.setQueryData<AgentDetailDto>(["agent", agentId], (detail) =>
          detail ? updateAgentDetail(agentId, envelope, detail) : detail,
        );

        if (envelope.event.type === "turn_done") {
          void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
          void queryClient.invalidateQueries({ queryKey: ["agents"] });
          void queryClient.invalidateQueries({ queryKey: ["token-usage"] });
        }
        if (envelope.event.type === "agent_lifecycle" || envelope.event.type === "turn_done" || envelope.event.type === "error") {
          void queryClient.invalidateQueries({ queryKey: ["agent-health"] });
        }
      },
    });

    return () => subscription.close();
  }, [queryClient, agentId]);

  return useMemo(() => state, [state]);
}
