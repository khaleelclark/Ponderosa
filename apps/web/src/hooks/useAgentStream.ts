import { unifiedDiffLineTotals } from "@ponderosa/core";
import type { AgentActivityDto, AgentEvent, AgentRunDto, ArtifactDto, ChangedFileDto, ResponseFileActivityDto, SseEventEnvelope, WorkItemDto, RunOutputDto, AgentDetailDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { boundLiveAgentTelemetry } from "../agentLiveProjection";
import type { StreamSubscription } from "../api/types";
import { compactDefined } from "../collections";
import { queryKeys } from "../queryKeys";
import { invalidateForBrowserPage } from "../queryVisibility";
import { registerLiveAgentStream } from "./agentStreamRegistry";
import { reconcileCursor } from "./streamCursor";

export interface StreamState {
  connected: boolean;
  running: boolean;
}

const initialStreamState: StreamState = {
  connected: false,
  running: false,
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
  "context_rollover_triggered",
  "context_rollover_seed_overflow",
  "context_rollover_completed",
]);

function runningAfterAgentEvent(current: boolean, event: SseEventEnvelope["event"]): boolean {
  if (event.type === "turn_done" || event.type === "error") return false;
  if (event.type === "agent_lifecycle") return event.status === "running" || event.status === "compacting";
  return current || event.type === "session" || event.type === "work_item_update" || executionTypes.has(event.type);
}

const AGENT_CURSOR_STORAGE_KEY = "ponderosa.agent.stream-cursors.v1";
const MAX_CACHED_AGENT_CURSORS = 100;
const MAX_AGENT_CURSOR_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const CURSOR_PERSIST_DEBOUNCE_MS = 250;
const INSTANCE_MISMATCH_INITIAL_DELAY_MS = 50;
const INSTANCE_MISMATCH_MAX_DELAY_MS = 2_000;

interface AgentStreamCursor {
  lastSeq?: number;
  instanceId?: string;
  updatedAt: number;
}

function validStoredCursor(value: unknown, now: number): value is [string, AgentStreamCursor] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [agentId, cursor] = value as [unknown, unknown];
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 256) return false;
  if (!cursor || typeof cursor !== "object") return false;
  const stored = cursor as Partial<AgentStreamCursor>;
  if (
    stored.lastSeq !== undefined
    && (!Number.isSafeInteger(stored.lastSeq) || (stored.lastSeq ?? -1) < 0)
  ) return false;
  if (
    stored.instanceId !== undefined
    && (typeof stored.instanceId !== "string" || stored.instanceId.length === 0 || stored.instanceId.length > 256)
  ) return false;
  return typeof stored.updatedAt === "number"
    && Number.isFinite(stored.updatedAt)
    && stored.updatedAt <= now + 60_000
    && now - stored.updatedAt <= MAX_AGENT_CURSOR_AGE_MS;
}

function loadStoredCursors(): Map<string, AgentStreamCursor> {
  if (typeof window === "undefined") return new Map();
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(AGENT_CURSOR_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) throw new Error("Stored Agent cursors are not an array");
    const now = Date.now();
    return new Map(parsed.filter((entry) => validStoredCursor(entry, now)).slice(-MAX_CACHED_AGENT_CURSORS));
  } catch {
    window.sessionStorage.removeItem(AGENT_CURSOR_STORAGE_KEY);
    return new Map();
  }
}

const streamCursors = loadStoredCursors();
let cursorPersistTimer: ReturnType<typeof setTimeout> | undefined;
let cursorPersistencePending = false;

function flushPendingCursors(): void {
  if (typeof window === "undefined") return;
  if (cursorPersistTimer) clearTimeout(cursorPersistTimer);
  cursorPersistTimer = undefined;
  if (!cursorPersistencePending) return;
  cursorPersistencePending = false;
  try {
    window.sessionStorage.setItem(
      AGENT_CURSOR_STORAGE_KEY,
      JSON.stringify([...streamCursors.entries()]),
    );
  } catch {
    // Cursor persistence is an optimization. A storage denial must not stop live updates.
  }
}

function scheduleCursorPersistence(): void {
  cursorPersistencePending = true;
  cursorPersistTimer ??= setTimeout(
    flushPendingCursors,
    CURSOR_PERSIST_DEBOUNCE_MS,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingCursors);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingCursors();
  });
}

function rememberCursor(agentId: string, cursor: AgentStreamCursor): void {
  streamCursors.delete(agentId);
  streamCursors.set(agentId, { ...cursor, updatedAt: Date.now() });
  while (streamCursors.size > MAX_CACHED_AGENT_CURSORS) {
    const oldest = streamCursors.keys().next().value as string | undefined;
    if (!oldest) break;
    streamCursors.delete(oldest);
  }
  scheduleCursorPersistence();
}

function projectedArtifactId(agentId: string, seq: number): string {
  return `${agentId}:a:${seq}:0`;
}

function activeExecutionId(runs: AgentRunDto[] | undefined): string | undefined {
  return [...(runs ?? [])].reverse()
    .find((run) => run.status === "running" || run.status === "compacting")?.id;
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

function attachFileActivityToLastResponse(
  runOutput: RunOutputDto[],
  executionId: string,
  files: ResponseFileActivityDto[],
): RunOutputDto[] {
  const lastResponse = [...runOutput].reverse().find(
    (entry) => entry.executionId === executionId && entry.kind === "response",
  );
  if (!lastResponse || files.length === 0) return runOutput;
  return runOutput.map((entry) => {
    if (entry.executionId !== executionId || entry.kind !== "response") return entry;
    if (entry.id === lastResponse.id) return { ...entry, fileActivity: files };
    const { fileActivity: _fileActivity, ...withoutFileActivity } = entry;
    return withoutFileActivity;
  });
}

function updateAgentDetail(agentId: string, envelope: SseEventEnvelope, detail: AgentDetailDto): AgentDetailDto {
  const { event, seq, ts } = envelope;


  if (event.type === "coordination_v3_changed") {
    return { ...detail, coordinationV3: event.coordination };
  }

  if (executionTypes.has(event.type)) {
    const activity = detail.activity ?? [];
    const id = `${agentId}:activity:${seq}`;
    const currentExecutionId = activeExecutionId(detail.runs);
    const activeExecutionAlreadyChangedPath = event.type === "file_change" && Boolean(currentExecutionId)
      && activity.some((item) => item.executionId === currentExecutionId
        && item.event.type === "file_change"
        && item.event.path === event.path);
    if (!activity.some((item) => item.id === id)) {
      const entry: AgentActivityDto = {
        id, agentId, seq, createdAt: ts,
        ...(currentExecutionId ? { executionId: currentExecutionId } : {}),
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
          ? previous.executionCount + (currentExecutionId && !activeExecutionAlreadyChangedPath ? 1 : 0)
          : currentExecutionId ? 1 : 0,
        diffAvailable: Boolean(event.diff),
      };
      detail = {
        ...detail,
        changedFiles: previous
          ? changedFiles.map((item) => item.path === event.path ? changed : item)
          : [...changedFiles, changed],
      };
    }
    if (currentExecutionId) {
      const runActivity = (detail.activity ?? []).filter(
        (item) => item.executionId === currentExecutionId,
      );
      const activityCounts = {
        commands: runActivity.filter((item) => item.event.type === "command").length,
        tools: runActivity.filter((item) => item.event.type === "tool_call").length,
        files: new Set(runActivity.flatMap((item) =>
          item.event.type === "file_change" ? [item.event.path] : [])).size,
        errors: runActivity.filter((item) => item.event.type === "error").length,
      };
      detail = {
        ...detail,
        runs: detail.runs.map((run) =>
          run.id === currentExecutionId ? { ...run, activityCounts } : run),
      };
    }
    detail = {
      ...detail,
      runOutput: compactDefined(detail.runOutput ?? []).map((entry) =>
        entry.completed ? entry : { ...entry, completed: true }),
    };
  }

  if (event.type === "text" || event.type === "reasoning") {
    if (envelope.replayed) return detail;
    const runOutput = compactDefined(detail.runOutput ?? []);
    const executionId = event.executionId ?? `live:${seq}`;
    const kind = event.type === "reasoning" ? "reasoning" : "response";
    const existing = [...runOutput].reverse().find((entry) =>
      !entry.completed && entry.executionId === executionId && entry.kind === kind);
    const id = existing?.id ?? `${agentId}:runOutput:${seq}`;
    const next: RunOutputDto = existing ? {
      ...existing,
      text: `${existing.text}${event.delta}`,
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
    const closed = runOutput.map((entry) =>
      entry.completed || entry.id === existing?.id ? entry : { ...entry, completed: true });
    const nextRunOutput = existing
        ? closed.map((entry) => entry.id === id ? next : entry)
        : [...closed, next];
    const priorFileActivity = kind === "response"
      ? [...runOutput].reverse().find((entry) =>
          entry.executionId === executionId && entry.kind === "response")?.fileActivity
      : undefined;
    return {
      ...detail,
      runOutput: priorFileActivity?.length
        ? attachFileActivityToLastResponse(nextRunOutput, executionId, priorFileActivity)
        : nextRunOutput,
    };
  }

  if (event.type === "agent_output") {
    const runOutput = compactDefined(detail.runOutput ?? []);
    const canonicalFileActivity = (detail.activity ?? [])
      .filter((item) => item.executionId === event.executionId && item.event.type === "file_change")
      .reduce<ResponseFileActivityDto[]>((files, item) => mergeLiveResponseFileActivity(
        files,
        item.event as Extract<AgentEvent, { type: "file_change" }>,
        item.seq,
        projectedArtifactId(agentId, item.seq),
      ), [])
      .map((file) => ({ ...file, status: "completed" as const }));
    return {
      ...detail,
      runOutput: attachFileActivityToLastResponse(
        runOutput,
        event.executionId,
        canonicalFileActivity,
      ),
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
      executionId: activeExecutionId(detail.runs),
      kind: isPdf ? "document" : "diff",
      path: event.path,
      summary: `${event.kind} ${event.path}`,
      createdAt: ts,
      ...(isPdf ? { mediaType: "application/pdf" as const } : {}),
    };
    const currentRunOutput = compactDefined(detail.runOutput ?? []);
    const existingFileActivity = [...currentRunOutput].reverse().find(
      (entry) => entry.kind === "response" && entry.executionId === artifact.executionId,
    )?.fileActivity;
    const runOutput = artifact.executionId
      ? attachFileActivityToLastResponse(
          currentRunOutput,
          artifact.executionId,
          mergeLiveResponseFileActivity(existingFileActivity, event, seq, canonicalArtifactId),
        )
      : currentRunOutput;
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
      id: projectedArtifactId(agentId, seq),
      agentId,
      executionId: activeExecutionId(detail.runs),
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

export function useAgentStream(
  agentId: string | undefined,
  knownProjectId?: string,
): StreamState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>(initialStreamState);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const projectIdRef = useRef(knownProjectId);
  const retryProjectReconciliationRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!agentId) {
      lastSeqRef.current = undefined;
      setState(initialStreamState);
      return undefined;
    }

    const cursor: AgentStreamCursor = streamCursors.get(agentId) ?? { updatedAt: Date.now() };
    rememberCursor(agentId, cursor);
    lastSeqRef.current = cursor.lastSeq;
    setState(initialStreamState);

    let stopped = false;
    let subscription: StreamSubscription | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
    let unregisterLiveStream: (() => void) | undefined;
    let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
    let reconcileDetail = false;
    let reconcileRoster = false;
    let reconcileHealth = false;
    let reconcileUsage = false;

    const projectIdFromCache = (): string | undefined => {
      if (projectIdRef.current) return projectIdRef.current;
      for (const [, detail] of queryClient.getQueriesData<AgentDetailDto>({
        queryKey: queryKeys.agents.detailPrefix(agentId),
      })) {
        if (detail?.agent.projectId) return detail.agent.projectId;
      }
      return undefined;
    };

    const flushReconciliation = () => {
      reconcileTimer = undefined;
      const projectId = projectIdFromCache();
      if (reconcileDetail) {
        invalidateForBrowserPage(
          queryClient,
          queryKeys.agents.detailPrefix(agentId),
        );
        reconcileDetail = false;
      }
      if (reconcileRoster && projectId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
        reconcileRoster = false;
      }
      if (reconcileHealth && projectId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(projectId) });
        reconcileHealth = false;
      }
      if (reconcileUsage) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tokenUsage.all });
        void queryClient.invalidateQueries({ queryKey: queryKeys.providerUsage.agent(agentId) });
        reconcileUsage = false;
      }
    };

    const scheduleReconciliation = (options: {
      detail?: boolean;
      roster?: boolean;
      health?: boolean;
      usage?: boolean;
    }, restartWindow = false) => {
      reconcileDetail ||= options.detail ?? false;
      reconcileRoster ||= options.roster ?? false;
      reconcileHealth ||= options.health ?? false;
      reconcileUsage ||= options.usage ?? false;
      if (restartWindow && reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = undefined;
      }
      // Live lifecycle bursts use one fixed window. Replay restarts the window
      // without fetching so reconciliation happens once after catch-up is quiet.
      reconcileTimer ??= setTimeout(flushReconciliation, 250);
    };

    retryProjectReconciliationRef.current = () => {
      if (
        stopped
        || reconcileTimer
        || (!reconcileRoster && !reconcileHealth)
        || !projectIdFromCache()
      ) return;
      reconcileTimer = setTimeout(flushReconciliation, 0);
    };

    const markStreamDisconnected = () => {
      unregisterLiveStream?.();
      unregisterLiveStream = undefined;
    };

    const connect = (lastSeenSeq: number | undefined) => {
      if (stopped) return;
      const nextSubscription = api.subscribeAgent(agentId, lastSeenSeq, {
        onOpen() {
          markStreamDisconnected();
          unregisterLiveStream = registerLiveAgentStream(agentId);
          setState((current) => ({ ...current, connected: true }));
        },
        onError() {
          markStreamDisconnected();
          setState((current) => ({ ...current, connected: false }));
        },
        onStatus(status) {
          const changedInstance = Boolean(cursor.instanceId && cursor.instanceId !== status.instanceId);
          if (changedInstance) {
            lastSeqRef.current = 0;
            cursor.lastSeq = 0;
            cursor.instanceId = status.instanceId;
            rememberCursor(agentId, cursor);
            setState({ ...initialStreamState, connected: true });
            scheduleReconciliation({ detail: true, roster: true, health: true, usage: true });
            markStreamDisconnected();
            nextSubscription.close();
            if (!reconnectTimer) {
              const delay = instanceMismatchDelay;
              instanceMismatchDelay = Math.min(
                instanceMismatchDelay * 2,
                INSTANCE_MISMATCH_MAX_DELAY_MS,
              );
              reconnectTimer = setTimeout(() => {
                reconnectTimer = undefined;
                connect(0);
              }, delay);
            }
            return;
          }
          instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
          if (status.reset || (lastSeqRef.current ?? 0) > status.cursor) {
            lastSeqRef.current = 0;
            cursor.lastSeq = 0;
            setState({ ...initialStreamState, connected: true });
            scheduleReconciliation({ detail: true, roster: true, health: true, usage: true });
          }
          cursor.instanceId = status.instanceId;
          rememberCursor(agentId, cursor);
        },
        onEvent(envelope) {
          const reconciliation = reconcileCursor(
            lastSeqRef.current ?? 0,
            envelope,
            item => item.seq,
          );
          if (reconciliation.duplicate) return;
          lastSeqRef.current = reconciliation.cursor;
          cursor.lastSeq = reconciliation.cursor;
          rememberCursor(agentId, cursor);

          if (reconciliation.gap) {
            scheduleReconciliation({ detail: true, roster: true, health: true, usage: true });
          }

          // Replay advances the durable cursor only. Canonical queries already
          // contain this history, so replay must not look like fresh live work.
          // A single reconciliation after replay goes quiet covers events missed
          // while disconnected without refetching once per historical envelope.
          if (envelope.replayed) {
            scheduleReconciliation(
              { detail: true, roster: true, health: true, usage: true },
              true,
            );
            return;
          }

          setState((current) => {
            const running = runningAfterAgentEvent(current.running, envelope.event);
            return current.connected && current.running === running
              ? current
              : { connected: true, running };
          });

          queryClient.setQueriesData<AgentDetailDto>({ queryKey: queryKeys.agents.detailPrefix(agentId) }, (detail) =>
            detail
              ? boundLiveAgentTelemetry(updateAgentDetail(agentId, envelope, detail))
              : detail,
          );

          if (envelope.event.type === "coordination_v3_changed") {
            // Request summaries are embedded in the canonical message
            // projection, not the compact coordination event. Reconcile after
            // the burst so Agent Chat cards reflect new and terminal Requests.
            scheduleReconciliation({ detail: true });
          } else if (envelope.event.type === "turn_done") {
            scheduleReconciliation({ detail: true, roster: true, health: true, usage: true });
          } else if (envelope.event.type === "agent_lifecycle" || envelope.event.type === "error") {
            scheduleReconciliation({ roster: true, health: true });
          }
        },
      });
      subscription = nextSubscription;
    };

    connect(lastSeqRef.current);

    return () => {
      stopped = true;
      subscription?.close();
      markStreamDisconnected();
      retryProjectReconciliationRef.current = () => undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (reconcileTimer) clearTimeout(reconcileTimer);
    };
  }, [queryClient, agentId]);

  useEffect(() => {
    projectIdRef.current = knownProjectId;
    retryProjectReconciliationRef.current();
  }, [knownProjectId]);

  return useMemo(() => state, [state]);
}
