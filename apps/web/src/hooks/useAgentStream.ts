import { unifiedDiffLineTotals } from "@ponderosa/core";
import type { AgentActivityDto, AgentEvent, AgentRunDto, ArtifactDto, ChangedFileDto, ResponseFileActivityDto, SseEventEnvelope, WorkItemDto, RunOutputDto, AgentDetailDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { compactDefined } from "../collections";
import { queryKeys } from "../queryKeys";

export interface ExecutionItem {
  id: string;
  seq: number;
  ts: string;
  event: Extract<AgentEvent, { type: "command" | "file_change" | "test_result" | "tool_call" | "tool_result" | "error" |
    "browser_session" | "browser_action" | "browser_console" | "browser_screenshot" }>;
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
  "browser_session",
  "browser_action",
  "browser_console",
  "browser_screenshot",
]);

function runningAfterAgentEvent(current: boolean, event: SseEventEnvelope["event"]): boolean {
  if (event.type === "turn_done" || event.type === "error") return false;
  if (event.type === "agent_lifecycle") return event.status === "running" || event.status === "compacting";
  return current || event.type === "session" || event.type === "work_item_update" || executionTypes.has(event.type);
}

const MAX_CACHED_AGENT_CURSORS = 100;
const streamCursors = new Map<string, { lastSeq?: number; instanceId?: string }>();

interface AgentCursorReconciliation {
  cursor: number;
  duplicate: boolean;
  gap: boolean;
}

/** Agent events are strictly ordered, so one cursor replaces an unbounded set
 * of every sequence number ever observed. */
function reconcileAgentCursor(current: number, envelope: Pick<SseEventEnvelope, "seq">): AgentCursorReconciliation {
  if (envelope.seq <= current) return { cursor: current, duplicate: true, gap: false };
  return { cursor: envelope.seq, duplicate: false, gap: envelope.seq !== current + 1 };
}

function rememberCursor(agentId: string, cursor: { lastSeq?: number; instanceId?: string }): void {
  streamCursors.delete(agentId);
  streamCursors.set(agentId, cursor);
  while (streamCursors.size > MAX_CACHED_AGENT_CURSORS) {
    const oldest = streamCursors.keys().next().value as string | undefined;
    if (!oldest) break;
    streamCursors.delete(oldest);
  }
}

function projectedArtifactId(agentId: string, seq: number): string {
  return `${agentId}:a:${seq}:0`;
}

function projectedWorkItemId(agentId: string, workItemId: string): string {
  return `${agentId}:work-item:${workItemId}`;
}

function mergeLiveResponseFileActivity(
  current: ResponseFileActivityDto[] | undefined,
  event: Extract<AgentEvent, { type: "file_change" }>,
  seq: number,
  artifactId: string,
): ResponseFileActivityDto[] {
  const totals = unifiedDiffLineTotals(event.diff);
  const next: ResponseFileActivityDto = {
    path: event.path,
    kind: event.kind,
    status: "in_progress",
    sourceSeq: seq,
    artifactId,
    previewable: Boolean(event.diff),
    ...(totals ? totals : {}),
  };
  const files = current ?? [];
  return files.some((file) => file.path === event.path)
    ? files.map((file) => file.path === event.path ? next : file)
    : [...files, next];
}

function updateAgentDetail(agentId: string, envelope: SseEventEnvelope, detail: AgentDetailDto): AgentDetailDto {
  const { event, seq, ts } = envelope;


  if (event.type === "coordination_v3_changed") {
    return { ...detail, coordinationV3: event.coordination };
  }

  if (executionTypes.has(event.type)) {
    const activity = detail.activity ?? [];
    const id = `${agentId}:activity:${seq}`;
    const activeExecutionId = [...(detail.runs ?? [])].reverse()
      .find((run) => run.status === "running" || run.status === "compacting")?.id;
    const activeExecutionAlreadyChangedPath = event.type === "file_change" && Boolean(activeExecutionId)
      && activity.some((item) => item.executionId === activeExecutionId
        && item.event.type === "file_change"
        && item.event.path === event.path);
    if (!activity.some((item) => item.id === id)) {
      const entry: AgentActivityDto = {
        id, agentId, seq, createdAt: ts,
        ...(activeExecutionId ? { executionId: activeExecutionId } : {}),
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
        executionCount: previous
          ? previous.executionCount + (activeExecutionId && !activeExecutionAlreadyChangedPath ? 1 : 0)
          : activeExecutionId ? 1 : 0,
        diffAvailable: Boolean(event.diff),
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
    const canonicalFileActivity = (detail.activity ?? [])
      .filter((item) => item.executionId === executionId && item.event.type === "file_change")
      .reduce<ResponseFileActivityDto[]>((files, item) => mergeLiveResponseFileActivity(
        files,
        item.event as Extract<AgentEvent, { type: "file_change" }>,
        item.seq,
        projectedArtifactId(agentId, item.seq),
      ), []);
    const next: RunOutputDto = existing ? {
      ...existing,
      text: `${existing.text}${event.delta}`,
      seq,
      sourceSeqEnd: seq,
      ...(kind === "response" && canonicalFileActivity.length ? { fileActivity: canonicalFileActivity } : {}),
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
      ...(kind === "response" && canonicalFileActivity.length ? { fileActivity: canonicalFileActivity } : {}),
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
    const liveEntry = runOutput.find((item) =>
      item.executionId === event.executionId && item.kind === "response" && !item.completed
    );
    const canonicalFileActivity = (detail.activity ?? [])
      .filter((item) => item.executionId === event.executionId && item.event.type === "file_change")
      .reduce<ResponseFileActivityDto[]>((files, item) => mergeLiveResponseFileActivity(
        files,
        item.event as Extract<AgentEvent, { type: "file_change" }>,
        item.seq,
        projectedArtifactId(agentId, item.seq),
      ), [])
      .map((file) => ({ ...file, status: "completed" as const }));
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
      ...(canonicalFileActivity.length
        ? { fileActivity: canonicalFileActivity }
        : liveEntry?.fileActivity?.length
          ? { fileActivity: liveEntry.fileActivity.map((file) => ({ ...file, status: "completed" as const })) }
          : {}),
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
    const canonicalArtifactId = projectedArtifactId(agentId, seq);
    const artifact: ArtifactDto = {
      id: canonicalArtifactId,
      agentId,
      executionId: [...(detail.runs ?? [])].reverse()
        .find((run) => run.status === "running" || run.status === "compacting")?.id,
      kind: isPdf ? "document" : "diff",
      path: event.path,
      summary: `${event.kind} ${event.path}`,
      createdAt: ts,
      ...(isPdf ? { mediaType: "application/pdf" as const } : {}),
    };
    const runOutput = compactDefined(detail.runOutput ?? []).map((entry) =>
      entry.kind === "response" && !entry.completed && entry.executionId === artifact.executionId
        ? { ...entry, fileActivity: mergeLiveResponseFileActivity(entry.fileActivity, event, seq, canonicalArtifactId) }
        : entry
    );
    return { ...detail, artifacts: [...artifacts, artifact], runOutput };
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

  if (event.type === "browser_screenshot") {
    const artifacts = compactDefined(detail.artifacts);
    const id = projectedArtifactId(agentId, seq);
    if (artifacts.some((artifact) => artifact.id === id)) return detail;
    const root = `/api/projects/${encodeURIComponent(detail.agent.projectId)}/agents/${encodeURIComponent(agentId)}/browser-artifacts/${encodeURIComponent(id)}`;
    const artifact: ArtifactDto = {
      id, agentId, executionId: event.executionId, kind: "screenshot", path: event.path,
      summary: `Browser screenshot (${event.width}×${event.height})`, createdAt: ts,
      mediaType: "image/png", previewUrl: root, downloadUrl: `${root}?download=1`,
    };
    return { ...detail, artifacts: [...artifacts, artifact] };
  }

  return detail;
}

export function useAgentStream(agentId: string | undefined): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>(initialStreamState);
  const lastSeqRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!agentId) {
      lastSeqRef.current = undefined;
      setState(initialStreamState);
      return undefined;
    }

    const cursor = streamCursors.get(agentId) ?? {};
    rememberCursor(agentId, cursor);
    lastSeqRef.current = cursor.lastSeq;
    setState({ ...initialStreamState, lastSeq: cursor.lastSeq });

    const invalidateAgent = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.healthAll });
    };

    const subscription = api.subscribeAgent(agentId, lastSeqRef.current, {
      onOpen() {
        setState((current) => ({ ...current, connected: true }));
      },
      onError() {
        setState((current) => ({ ...current, connected: false }));
      },
      onStatus(status) {
        const changedInstance = Boolean(cursor.instanceId && cursor.instanceId !== status.instanceId);
        if (status.reset || changedInstance || (lastSeqRef.current ?? 0) > status.cursor) {
          lastSeqRef.current = 0;
          cursor.lastSeq = 0;
          setState({ ...initialStreamState, connected: true, lastSeq: 0 });
          invalidateAgent();
        }
        cursor.instanceId = status.instanceId;
        rememberCursor(agentId, cursor);
      },
      onEvent(envelope) {
        const reconciliation = reconcileAgentCursor(lastSeqRef.current ?? 0, envelope);
        if (reconciliation.duplicate) return;
        if (reconciliation.gap) invalidateAgent();
        lastSeqRef.current = reconciliation.cursor;
        cursor.lastSeq = reconciliation.cursor;
        rememberCursor(agentId, cursor);

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

        queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (detail) =>
          detail ? updateAgentDetail(agentId, envelope, detail) : detail,
        );

        if (envelope.event.type === "turn_done") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(agentId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
          void queryClient.invalidateQueries({ queryKey: queryKeys.tokenUsage.all });
        }
        if (envelope.event.type === "agent_lifecycle" || envelope.event.type === "turn_done" || envelope.event.type === "error") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.healthAll });
        }
      },
    });

    return () => subscription.close();
  }, [queryClient, agentId]);

  return useMemo(() => state, [state]);
}
