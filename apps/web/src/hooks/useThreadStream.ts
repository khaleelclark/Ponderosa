import type { AgentEvent, ArtifactDto, SseEventEnvelope, TaskDto, ThinkingEntryDto, ThreadDetailDto } from "@ponderosa/core";
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
  return current || event.type === "session" || event.type === "task_update" || executionTypes.has(event.type);
}

const streamCursors = new Map<string, { lastSeq?: number; seenSeqs: Set<number> }>();

function projectedArtifactId(threadId: string, seq: number): string {
  return `${threadId}:a:${seq}:0`;
}

function projectedTaskUpdateId(threadId: string, taskId: string): string {
  return `${threadId}:t:${taskId}`;
}

export function updateThreadDetail(threadId: string, envelope: SseEventEnvelope, detail: ThreadDetailDto): ThreadDetailDto {
  const { event, seq, ts } = envelope;

  if (event.type === "text" || event.type === "reasoning") {
    if (envelope.replayed) return detail;
    const thinking = compactDefined(detail.thinking ?? []);
    const executionId = event.executionId ?? `live:${seq}`;
    const kind = event.type === "reasoning" ? "reasoning" : "response";
    const id = `live-thinking:${executionId}:${kind}`;
    const existing = thinking.find((entry) => entry.id === id);
    const next: ThinkingEntryDto = existing ? {
      ...existing,
      text: `${existing.text}${event.delta}`,
      seq,
      sourceSeqEnd: seq,
    } : {
      id,
      threadId,
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
      thinking: existing
        ? thinking.map((entry) => entry.id === id ? next : entry)
        : [...thinking, next],
    };
  }

  if (event.type === "agent_output") {
    const thinking = compactDefined(detail.thinking ?? []);
    const entry: ThinkingEntryDto = {
      id: `${threadId}:thinking:${seq}`,
      threadId,
      executionId: event.executionId,
      kind: "response",
      text: event.text,
      completed: true,
      seq,
      sourceSeqStart: event.sourceSeqStart,
      sourceSeqEnd: event.sourceSeqEnd,
      createdAt: ts,
    };
    if (thinking.some((item) => item.id === entry.id)) return detail;
    return {
      ...detail,
      thinking: [...thinking.filter((item) => !(item.executionId === event.executionId && item.kind === "response" && !item.completed)), entry]
        .sort((a, b) => a.seq - b.seq),
    };
  }

  if (event.type === "task_update") {
    const tasks = compactDefined(detail.tasks);
    const canonicalId = projectedTaskUpdateId(threadId, event.taskId);
    const existing = tasks.find((task) => task.id === canonicalId || task.id === event.taskId);
    const nextTask: TaskDto = {
      id: existing?.id ?? canonicalId,
      threadId,
      title: event.title ?? existing?.title ?? "Agent task",
      status: event.status,
      engine: detail.thread.activeEngine,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    const nextTasks = existing
      ? tasks.map((task) => (task.id === canonicalId || task.id === event.taskId ? nextTask : task))
      : [...tasks, nextTask];
    return { ...detail, tasks: nextTasks };
  }

  if (event.type === "file_change") {
    const artifacts = compactDefined(detail.artifacts);
    if (
      artifacts.some(
        (artifact) => artifact.id === projectedArtifactId(threadId, seq) || artifact.id === `live-artifact-${seq}`,
      )
    ) {
      return detail;
    }
    const artifact: ArtifactDto = {
      id: `live-artifact-${seq}`,
      threadId,
      kind: "diff",
      path: event.path,
      summary: `${event.kind} ${event.path}`,
      createdAt: ts,
    };
    return { ...detail, artifacts: [...artifacts, artifact] };
  }

  if (event.type === "test_result") {
    const artifacts = compactDefined(detail.artifacts);
    if (
      artifacts.some(
        (artifact) => artifact.id === projectedArtifactId(threadId, seq) || artifact.id === `live-artifact-${seq}`,
      )
    ) {
      return detail;
    }
    const artifact: ArtifactDto = {
      id: `live-artifact-${seq}`,
      threadId,
      kind: "test_report",
      path: `test-result-${seq}.md`,
      summary: event.summary,
      createdAt: ts,
    };
    return { ...detail, artifacts: [...artifacts, artifact] };
  }

  return detail;
}

export function useThreadStream(threadId: string | undefined): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>(initialStreamState);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const seenSeqRef = useRef(new Set<number>());

  useEffect(() => {
    if (!threadId) {
      lastSeqRef.current = undefined;
      seenSeqRef.current = new Set<number>();
      setState(initialStreamState);
      return undefined;
    }

    const cursor = streamCursors.get(threadId) ?? { seenSeqs: new Set<number>() };
    streamCursors.set(threadId, cursor);
    lastSeqRef.current = cursor.lastSeq;
    seenSeqRef.current = new Set(cursor.seenSeqs);
    setState({ ...initialStreamState, lastSeq: cursor.lastSeq });

    const subscription = api.subscribeThread(threadId, lastSeqRef.current, {
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

        queryClient.setQueryData<ThreadDetailDto>(["thread", threadId], (detail) =>
          detail ? updateThreadDetail(threadId, envelope, detail) : detail,
        );

        if (envelope.event.type === "turn_done") {
          void queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
          void queryClient.invalidateQueries({ queryKey: ["threads"] });
        }
        if (envelope.event.type === "agent_lifecycle" || envelope.event.type === "turn_done" || envelope.event.type === "error") {
          void queryClient.invalidateQueries({ queryKey: ["agent-health"] });
        }
      },
    });

    return () => subscription.close();
  }, [queryClient, threadId]);

  return useMemo(() => state, [state]);
}
