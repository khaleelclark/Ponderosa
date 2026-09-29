import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  AllChatPageDto,
  GlobalChatSearchResponseDto,
  ProjectDto,
  WorkspaceEvent,
  WorkspaceEventEnvelope,
  WorkspaceNotificationPageDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { api } from "../api";
import type { StreamSubscription } from "../api/types";
import { queryKeys } from "../queryKeys";
import {
  workspaceEventInvalidatesAllChat,
  workspaceEventInvalidatesGlobalSearch,
} from "../workspaceEventInvalidation";
import { isOpenAttention, isUnreadNotificationUpdate, isUnacknowledgedAction } from "../attention";
import {
  browserPageIsVisible,
  invalidateForBrowserPage,
} from "../queryVisibility";
import {
  changedWorkspaceDirectoryKinds,
  workspaceResourceStarsChanged,
} from "../resourcePreferences";
import {
  capturePhaseQueryBoundaries,
  reconcilePhaseQueriesAfterBoundary,
  type PhaseQueryBoundary,
} from "../phaseEvidenceReconciliation";
import { hasLiveAgentStream } from "./agentStreamRegistry";
import { reconcileCursor } from "./streamCursor";
import { phaseQueryMatchesProject } from "../workspaceDirectoryScope";
import { createBoundedRefresh, createRateLimitedRefresh } from "../boundedRefresh";

const CURSOR_KEY = "ponderosa.workspace.cursor.v2";
const INSTANCE_KEY = "ponderosa.workspace.instance.v1";
const INSTANCE_MISMATCH_INITIAL_DELAY_MS = 50;
const INSTANCE_MISMATCH_MAX_DELAY_MS = 2_000;
const RECONNECTING_NOTICE_DELAY_MS = 1_000;
const STALE_NOTICE_DELAY_MS = 8_000;
const DIRECTLY_PROJECT_SCOPED_QUERY_ROOTS = new Set([
  "project",
  "conversations",
  "agents",
  "agent-organization",
  "agent-health",
  "agent-presets",
  "decisions",
  "engine-models",
  "engine-capabilities",
  "workspace-status",
  "workspace-file",
  "workspace",
  "workspace-file-view",
  "agent-work",
  "token-usage",
  "project-browser",
  "agent-browsers",
  "agent-browser",
  "project-artifacts",
  "agent-deletion-preview",
]);

export type WorkspaceConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "stale"
  | "unavailable";

export interface WorkspaceConnectionState {
  retry?(): void;
  status: WorkspaceConnectionStatus;
  /** Canonical phase-bearing queries have reconciled after stream catch-up. */
  phaseEvidenceFresh: boolean;
  lastSuccessfulSyncAt?: string;
  prolongedDisconnect: boolean;
  announcement?: string;
}

export interface WorkspaceStreamOptions {
  onProjectDeleted?(projectId: string, at: string): void;
  projectPreferences?(preferences: WorkspacePreferencesDto): WorkspacePreferencesDto;
}

export function reconcileDeletedProjectClientState(
  queryClient: Pick<
    QueryClient,
    "setQueryData" | "setQueriesData" | "removeQueries" | "invalidateQueries"
  >,
  projectId: string,
  at: string,
): void {
  queryClient.setQueryData<ProjectDto[]>(
    queryKeys.projects.all,
    current => current?.filter(project => project.id !== projectId),
  );
  queryClient.setQueryData<WorkspaceNotificationPageDto>(
    queryKeys.notifications.all,
    current => {
      if (!current) return current;
      let removedOpenActions = 0;
      let removedUnacknowledgedActions = 0;
      let removedUpdates = 0;
      const items = current.items.map(notification => {
        if (notification.projectId !== projectId) return notification;
        if (notification.dedupeKey?.startsWith("project-deletion:")) {
          const { projectId: _deletedProjectId, ...workspaceNotification } = notification;
          return workspaceNotification;
        }
        if (isOpenAttention(notification)) removedOpenActions += 1;
        if (isUnacknowledgedAction(notification)) removedUnacknowledgedActions += 1;
        else if (isUnreadNotificationUpdate(notification)) removedUpdates += 1;
        return {
          ...notification,
          status: "resolved" as const,
          resolvedAt: notification.resolvedAt ?? at,
        };
      });
      return {
        ...current,
        items,
        openActionCount: Math.max(0, current.openActionCount - removedOpenActions),
        unacknowledgedActionCount: Math.max(0, current.unacknowledgedActionCount - removedUnacknowledgedActions),
        unreadUpdateCount: Math.max(0, current.unreadUpdateCount - removedUpdates),
      };
    },
  );
  queryClient.setQueriesData<GlobalChatSearchResponseDto>(
    { queryKey: queryKeys.globalSearch.all },
    current => current
      ? {
          ...current,
          results: current.results.filter(item => item.project.id !== projectId),
          recentChats: current.recentChats.filter(item => item.project.id !== projectId),
        }
      : current,
  );
  queryClient.setQueriesData<AllChatPageDto>(
    { queryKey: queryKeys.allChatAll },
    current => current
      ? {
          ...current,
          items: current.items.filter(item => item.project.id !== projectId),
          ...(current.decisions
            ? {
                decisions: current.decisions.filter(
                  item => item.project.id !== projectId,
                ),
              }
            : {}),
        }
      : current,
  );
  queryClient.removeQueries({
    predicate: query =>
      DIRECTLY_PROJECT_SCOPED_QUERY_ROOTS.has(String(query.queryKey[0]))
      && query.queryKey.includes(projectId),
  });
  queryClient.removeQueries({ queryKey: queryKeys.workspaceDirectory.all });
  queryClient.removeQueries({ queryKey: queryKeys.workspaceResourceRecency.all });
  for (const queryKey of [
    queryKeys.projects.all,
    queryKeys.notifications.all,
    queryKeys.globalSearch.all,
    queryKeys.allChatAll,
    queryKeys.workspaceDirectory.all,
    queryKeys.workspaceResourceRecency.all,
  ]) void queryClient.invalidateQueries({ queryKey });
}

/** Reconcile presentation state immediately from the canonical lifecycle event;
 * the subsequent refetch confirms the durable server projection. */
export function reconcileDeletedProjectEvent(
  envelope: WorkspaceEventEnvelope,
  onProjectDeleted?: (projectId: string, at: string) => void,
): string | undefined {
  const event = envelope.event;
  if (event.type !== "project_changed" || event.action !== "deleted") {
    return undefined;
  }
  onProjectDeleted?.(event.projectId, envelope.ts);
  return event.projectId;
}

function initialCursor(): number {
  try {
    const value = Number(window.sessionStorage.getItem(CURSOR_KEY) ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function initialInstanceId(): string | null {
  try {
    const value = window.sessionStorage.getItem(INSTANCE_KEY);
    return value && value.length <= 256 ? value : null;
  } catch {
    return null;
  }
}

/** Apply the same adapter-discovery cache boundary in every mounted tab. */
function invalidateWorkspaceCapabilities(
  queryClient: QueryClient,
  projectId: string,
): void {
  invalidateForBrowserPage(queryClient, queryKeys.engines.capabilities(projectId));
}

/** Conversation caches whose canonical response file summaries changed. */
function fileActivityConversationQueryKeys(event: WorkspaceEvent): Array<readonly ["conversation", string]> {
  if (
    event.type !== "agent_event"
    || (event.category !== "file" && event.category !== "artifact" && event.category !== "lifecycle")
  ) return [];
  return event.conversationIds.map((conversationId) => queryKeys.conversations.detailPrefix(conversationId));
}

/** Every tab invalidates both chat projections from the same canonical change. */
function conversationChangedQueryKeys(
  event: Extract<WorkspaceEvent, { type: "conversation_changed" }>,
): ReadonlyArray<readonly unknown[]> {
  return [
    queryKeys.conversations.project(event.projectId),
    queryKeys.conversations.detailPrefix(event.conversationId),
    queryKeys.collaborationPrefix(event.conversationId),
  ];
}

function workspaceAgentEventChangesPhase(
  event: WorkspaceEvent,
): event is Extract<WorkspaceEvent, { type: "agent_event" }> {
  return event.type === "agent_event" && (
    event.category === "lifecycle"
    || event.eventType === "command"
    || event.eventType === "tool_call"
    || event.eventType === "tool_result"
  );
}

function workspaceEventChangesResourceRecency(event: WorkspaceEvent): boolean {
  return event.type === "resource_used"
    || event.type === "agent_event"
    || event.type === "coordination_changed"
    || (
      event.type === "project_changed"
      && ["created", "deleted", "used"].includes(event.action)
    )
    || (
      event.type === "conversation_changed"
      && ["created", "deleted", "used", "message"].includes(event.action)
    )
    || (
      event.type === "trigger_changed"
      && ["created", "deleted", "occurrence"].includes(event.action)
    );
}

/** A fixed window bounds recency refetches during sustained Agent output while
 * still guaranteeing periodic refreshes rather than waiting for a quiet gap. */
function createWorkspaceRecencyInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 5_000,
): { schedule(): void; flush(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    invalidateForBrowserPage(queryClient, queryKeys.workspaceResourceRecency.all);
  };
  return {
    schedule() {
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function persistWorkspaceCursor(cursor: number, instanceId?: string): void {
  try {
    window.sessionStorage.setItem(CURSOR_KEY, String(cursor));
    if (instanceId) window.sessionStorage.setItem(INSTANCE_KEY, instanceId);
  } catch {
    // Persistence improves reconnection behavior but must not block live updates.
  }
}

function invalidateActiveQueries(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  const visible = browserPageIsVisible();
  for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
    if (query.getObserversCount() > 0) {
      void queryClient.invalidateQueries({
        queryKey: query.queryKey,
        exact: true,
        ...(visible ? {} : { refetchType: "none" as const }),
      });
    }
  }
}

/** Coalesces a burst of coordination events into one refetch per affected
 * Project. A global invalidation supersedes narrower pending work. */
function createAgentWorkInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 5_000,
): { schedule(projectId?: string): void; flush(): void; dispose(): void } {
  const projectIds = new Set<string>();
  let invalidateAll = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (invalidateAll) invalidateForBrowserPage(queryClient, queryKeys.agentWork.all);
    else for (const projectId of projectIds) invalidateForBrowserPage(queryClient, queryKeys.agentWork.project(projectId));
    invalidateAll = false;
    projectIds.clear();
  };
  return {
    schedule(projectId) {
      if (projectId) projectIds.add(projectId);
      else invalidateAll = true;
      // A fixed window prevents sustained coordination traffic from pushing
      // refresh forever into the future.
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      invalidateAll = false;
      projectIds.clear();
    },
  };
}

/** Coalesce each directory kind independently. Terminal Agent rows refresh
 * promptly; high-volume Project/Chat recency cannot refetch every 250 ms. */
function createDirectoryInvalidator(queryClient: QueryClient) {
  type Kind = "project" | "conversation" | "agent" | "trigger";
  const pending = new Map<Kind, Map<string, boolean>>();
  const refreshes = new Map<Kind, ReturnType<typeof createRateLimitedRefresh>>();
  for (const kind of ["project", "conversation", "agent", "trigger"] as const) {
    refreshes.set(kind, createRateLimitedRefresh(() => {
      const scopes = pending.get(kind);
      pending.delete(kind);
      if (!scopes?.size) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceDirectory.kind(kind),
        predicate: query => [...scopes].some(([projectId, includeSummary]) =>
          (includeSummary || query.queryKey[10] !== "summary")
          && phaseQueryMatchesProject(query.queryKey, projectId || undefined)),
        refetchType: browserPageIsVisible() ? "active" : "none",
      });
    }, kind === "agent" ? 1_000 : 5_000));
  }
  return {
    schedule(kind: Kind, projectId?: string, nonSummaryOnly = false) {
      const scopes = pending.get(kind) ?? new Map<string, boolean>();
      const scope = projectId ?? "";
      scopes.set(scope, (scopes.get(scope) ?? false) || !nonSummaryOnly);
      pending.set(kind, scopes);
      refreshes.get(kind)!.schedule();
    },
    dispose() {
      for (const refresh of refreshes.values()) refresh.dispose();
      pending.clear();
    },
  };
}

/** Coalesces workspace fallbacks for Agent-detail surfaces that do not mount
 * their own Agent stream, such as Project review. */
function createAgentDetailInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 5_000,
): { schedule(agentId: string): void; flush(): void; dispose(): void } {
  const agentIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const agentId of agentIds) {
      invalidateForBrowserPage(
        queryClient,
        queryKeys.agents.detailPrefix(agentId),
      );
    }
    agentIds.clear();
  };
  return {
    schedule(agentId) {
      agentIds.add(agentId);
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      agentIds.clear();
    },
  };
}

/** Coalesces live operational changes by conversation. Team Chat can be costly
 * to project, so unrelated Projects and short event bursts must not multiply
 * full-page reads across every mounted browser tab. */
function createCollaborationChatInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 750,
): { schedule(conversationIds?: readonly string[]): void; flush(): void; dispose(): void } {
  const conversationIds = new Set<string>();
  let invalidateAll = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (invalidateAll) invalidateForBrowserPage(queryClient, queryKeys.collaborationAll);
    else for (const conversationId of conversationIds) {
      invalidateForBrowserPage(queryClient, queryKeys.collaborationPrefix(conversationId));
    }
    invalidateAll = false;
    conversationIds.clear();
  };
  return {
    schedule(ids) {
      if (ids === undefined) invalidateAll = true;
      else for (const conversationId of ids) {
        if (conversationId) conversationIds.add(conversationId);
      }
      if (!invalidateAll && conversationIds.size === 0) return;
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      invalidateAll = false;
      conversationIds.clear();
    },
  };
}

/** Decision events share the notification envelope. Reconcile only the
 * affected canonical Chat timeline and coalesce fan-out Decisions. */
function createDecisionConversationInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 150,
): { schedule(conversationId: string): void; flush(): void; dispose(): void } {
  const conversationIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    invalidateForBrowserPage(queryClient, queryKeys.decisions.all);
    for (const conversationId of conversationIds) {
      invalidateForBrowserPage(queryClient, queryKeys.conversations.detailPrefix(conversationId));
    }
    conversationIds.clear();
  };
  return {
    schedule(conversationId) {
      conversationIds.add(conversationId);
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      conversationIds.clear();
    },
  };
}

/** One authoritative live stream invalidates only caches affected by each event. */
export function useWorkspaceStream(
  options: WorkspaceStreamOptions = {},
): WorkspaceConnectionState {
  const queryClient = useQueryClient();
  const [retryGeneration, setRetryGeneration] = useState(0);
  const onProjectDeleted = useRef(options.onProjectDeleted);
  onProjectDeleted.current = options.onProjectDeleted;
  const cursor = useRef(initialCursor());
  const instanceId = useRef(initialInstanceId());
  const [connection, setConnection] = useState<WorkspaceConnectionState>({
    status: "connecting",
    phaseEvidenceFresh: false,
    prolongedDisconnect: false,
  });

  useEffect(() => {
    const invalidate = (queryKey: readonly unknown[]) => invalidateForBrowserPage(queryClient, queryKey);
    const agentWorkInvalidator = createAgentWorkInvalidator(queryClient);
    const agentDetailInvalidator = createAgentDetailInvalidator(queryClient);
    const directoryInvalidator = createDirectoryInvalidator(queryClient);
    const workspaceRecencyInvalidator =
      createWorkspaceRecencyInvalidator(queryClient);
    const collaborationChatInvalidator = createCollaborationChatInvalidator(queryClient);
    const decisionConversationInvalidator =
      createDecisionConversationInvalidator(queryClient);
    const notificationRefresh = createRateLimitedRefresh(() =>
      invalidate(queryKeys.notifications.all), 5_000);
    const providerUsageRefresh = createRateLimitedRefresh(() =>
      invalidate(queryKeys.providerUsage.all), 5_000);
    const pendingTaskProjects = new Set<string>();
    const taskProjectionRefresh = createBoundedRefresh(() => {
      invalidateForBrowserPage(queryClient, queryKeys.workspaceStatus.all);
      invalidateForBrowserPage(queryClient, queryKeys.workspaceFile.all);
      for (const projectId of pendingTaskProjects) {
        invalidateForBrowserPage(queryClient, queryKeys.projectArtifacts.project(projectId));
      }
      pendingTaskProjects.clear();
    }, 5_000);
    const pendingCapabilityProjects = new Set<string>();
    let nextCapabilityUrgentAt = 0;
    const capabilityRefresh = createBoundedRefresh(() => {
      for (const projectId of pendingCapabilityProjects) {
        invalidateWorkspaceCapabilities(queryClient, projectId);
      }
      pendingCapabilityProjects.clear();
    }, 5_000);
    let replayReconcileTimer: ReturnType<typeof setTimeout> | undefined;
    let lastReplayReconcileAt = 0;
    let replayChatTimer: ReturnType<typeof setTimeout> | undefined;
    let nextReplayChatAt = 0;
    const replayChatIds = new Set<string>();
    const replayReceiptIds = new Set<string>();
    let replayAllChats = false;
    let replayAllReceipts = false;
    const scheduleReplayChat = (conversationIds?: readonly string[], receipts = false) => {
      if (conversationIds) for (const id of conversationIds) replayChatIds.add(id);
      else replayAllChats = true;
      if (receipts) {
        if (conversationIds) for (const id of conversationIds) replayReceiptIds.add(id);
        else replayAllReceipts = true;
      }
      replayChatTimer ??= setTimeout(() => {
        replayChatTimer = undefined;
        nextReplayChatAt = Date.now() + 1_000;
        if (replayAllChats) {
          invalidate(queryKeys.conversations.detailAll);
          invalidate(queryKeys.collaborationAll);
        } else for (const id of replayChatIds) {
          invalidate(queryKeys.conversations.detailPrefix(id));
          invalidate(queryKeys.collaborationPrefix(id));
        }
        if (replayAllReceipts) invalidate(queryKeys.conversations.activeDeliveryReceiptsAll);
        else for (const id of replayReceiptIds) {
          invalidate(queryKeys.conversations.activeDeliveryReceiptsPrefix(id));
        }
        replayChatIds.clear();
        replayReceiptIds.clear();
        replayAllChats = false;
        replayAllReceipts = false;
      }, Math.max(250, nextReplayChatAt - Date.now()));
    };
    let phaseQuietTimer: ReturnType<typeof setTimeout> | undefined;
    let phaseReconcileGeneration = 0;
    let phaseReconcileInFlight = false;
    let urgentPhasePending = false;
    let nextCoordinationUrgentAt = 0;
    const pendingRosterProjects = new Set<string>();
    let phaseCatchUpCursor: number | undefined;
    let phaseQueryBoundaries: ReadonlyMap<Query, PhaseQueryBoundary> = new Map();
    let stopped = false;
    let disconnected = false;
    let connectedOnce = false;
    const phaseQueries = () => [
      ...queryClient.getQueryCache().findAll({
        queryKey: queryKeys.agents.healthAll,
      }),
      ...queryClient.getQueryCache().findAll({
        queryKey: queryKeys.workspaceDirectory.kind("agent"),
      }).filter(query => query.queryKey[10] === "summary"),
      ...queryClient.getQueryCache().findAll({
        queryKey: queryKeys.agents.organizationAll,
      }).filter(query => query.queryKey[2] !== "deleted"),
    ];
    const activePhaseQueries = () => phaseQueries().filter(query => query.isActive());
    let observedActivePhaseQueries = new Set(activePhaseQueries());
    const markPhaseEvidenceStale = (projectId?: string, hidePresentedPhase = true) => {
      phaseReconcileGeneration += 1;
      if (phaseQuietTimer) clearTimeout(phaseQuietTimer);
      // Sustained output gets periodic data refreshes; the stricter proof of
      // a fully caught-up boundary uses the same bounded window after quiet.
      phaseQuietTimer = setTimeout(() => {
        phaseQuietTimer = undefined;
        urgentPhasePending = true;
        phaseRefresh.schedule();
      }, 750);
      const matches = (query: Query) => phaseQueryMatchesProject(query.queryKey, projectId);
      // Keep unrelated pending boundaries until they reconcile; later events
      // replace only affected boundaries, never certify older in-flight data.
      phaseQueryBoundaries = new Map([
        ...phaseQueryBoundaries,
        ...capturePhaseQueryBoundaries(activePhaseQueries().filter(matches)),
      ]);
      for (const query of phaseQueries().filter(matches)) {
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "none" });
      }
      // A continuous live stream has not lost its last verified phase. Keep
      // that label visible while the bounded refresh obtains newer evidence;
      // only a gap, replay, or disconnect must hide it immediately.
      if (hidePresentedPhase) setConnection(current => current.phaseEvidenceFresh
        ? { ...current, phaseEvidenceFresh: false }
        : current);
    };
    const runPhaseRefresh = () => {
      if (stopped || disconnected || !connectedOnce || !browserPageIsVisible()) return;
      if (phaseCatchUpCursor !== undefined && cursor.current < phaseCatchUpCursor) return;
      if (phaseReconcileInFlight) return;
      const urgent = urgentPhasePending;
      urgentPhasePending = false;
      for (const projectId of pendingRosterProjects) {
        invalidateForBrowserPage(queryClient, queryKeys.agents.project(projectId));
      }
      pendingRosterProjects.clear();
      const generation = phaseReconcileGeneration;
      const boundaries = phaseQueryBoundaries;
      let deferredStrictRetry = false;
      const scheduleStrictRetry = () => {
        if (urgentPhasePending || stopped || disconnected) return;
        urgentPhasePending = true;
        deferredStrictRetry = true;
        phaseRefresh.schedule();
      };
      phaseReconcileInFlight = true;
      if (!urgent) {
        // Continuous command/tool output changes the generation while a fetch
        // is in flight. Refresh boundedly anyway; only the strict boundary
        // reconciler below may certify that all phase evidence is current.
        void queryClient.refetchQueries({
          predicate: query => query.isActive() && boundaries.has(query),
          type: "active",
        }, { cancelRefetch: false })
          .catch(() => {
            scheduleStrictRetry();
          })
          .finally(() => {
            phaseReconcileInFlight = false;
            if (urgentPhasePending && !deferredStrictRetry && !stopped && !disconnected) phaseRefresh.schedule(true);
          });
        return;
      }
      void reconcilePhaseQueriesAfterBoundary(
        queryClient,
        activePhaseQueries().filter(query => boundaries.has(query)),
        boundaries,
        () => !stopped && !disconnected && generation === phaseReconcileGeneration,
      )
        .then(reconciled => {
          if (stopped || disconnected) return;
          if (generation !== phaseReconcileGeneration) {
            phaseRefresh.schedule();
            return;
          }
          if (!reconciled) {
            scheduleStrictRetry();
            return;
          }
          phaseQueryBoundaries = new Map();
          setConnection(current => ({ ...current, phaseEvidenceFresh: true }));
        })
        .catch(() => {
          scheduleStrictRetry();
        })
        .finally(() => {
          phaseReconcileInFlight = false;
          if (urgentPhasePending && !deferredStrictRetry && !stopped && !disconnected) phaseRefresh.schedule(true);
        });
    };
    const phaseRefresh = createBoundedRefresh(runPhaseRefresh, 5_000);
    const schedulePhaseReconciliation = (urgent = false) => {
      if (stopped || disconnected || !connectedOnce) return;
      if (phaseCatchUpCursor !== undefined && cursor.current < phaseCatchUpCursor) return;
      urgentPhasePending ||= urgent;
      phaseRefresh.schedule(urgent);
    };
    const queueAgentRoster = (projectId: string) => {
      if (pendingRosterProjects.has(projectId)) return;
      pendingRosterProjects.add(projectId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId), refetchType: "none" });
    };
    const onVisibilityChange = () => {
      if (browserPageIsVisible() && (pendingRosterProjects.size || phaseQueryBoundaries.size)) {
        schedulePhaseReconciliation(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribePhaseQueryCache = queryClient.getQueryCache().subscribe(event => {
      if (
        event.type !== "observerAdded"
        && event.type !== "observerRemoved"
        && event.type !== "observerOptionsUpdated"
        && event.type !== "removed"
      ) return;
      const [root, kind] = event.query.queryKey;
      if (
        root !== queryKeys.agents.healthAll[0]
        && root !== queryKeys.agents.organizationAll[0]
        && !(root === queryKeys.workspaceDirectory.all[0] && kind === "agent")
      ) return;
      const nextActivePhaseQueries = new Set(activePhaseQueries());
      if (
        nextActivePhaseQueries.size === observedActivePhaseQueries.size
        && [...nextActivePhaseQueries].every(query => observedActivePhaseQueries.has(query))
      ) return;
      observedActivePhaseQueries = nextActivePhaseQueries;
      markPhaseEvidenceStale();
      schedulePhaseReconciliation(true);
    });
    const invalidateAll = () => {
      directoryInvalidator.dispose();
      agentWorkInvalidator.dispose();
      agentDetailInvalidator.dispose();
      pendingRosterProjects.clear();
      workspaceRecencyInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      decisionConversationInvalidator.dispose();
      notificationRefresh.dispose();
      providerUsageRefresh.dispose();
      taskProjectionRefresh.dispose();
      pendingTaskProjects.clear();
      capabilityRefresh.dispose();
      pendingCapabilityProjects.clear();
      invalidate(queryKeys.projects.all);
      invalidate(queryKeys.conversations.all);
      // Replayed conversation and delivery events skip their per-event paths.
      // The list prefix above does not match the singular Chat/detail prefix.
      invalidate(queryKeys.conversations.detailAll);
      invalidate(queryKeys.conversations.activeDeliveryReceiptsAll);
      invalidate(["queued-messages"]);
      invalidate(queryKeys.queuedMessages.agentsAll);
      invalidate(["targeted-next-run"]);
      invalidate(queryKeys.workspaceDirectory.all);
      invalidate(["engine-capabilities"]);
      invalidate(queryKeys.notifications.all);
      invalidateActiveQueries(queryClient, queryKeys.agents.all);
      invalidateActiveQueries(queryClient, queryKeys.agents.organizationAll);
      invalidateActiveQueries(queryClient, queryKeys.agents.healthAll);
      invalidateActiveQueries(queryClient, queryKeys.agents.detailAll);
      invalidate(queryKeys.collaborationAll);
      invalidate(queryKeys.workspaceStatus.all);
      invalidate(queryKeys.workspaceFile.all);
      invalidate(queryKeys.projectArtifacts.all);
      invalidate(queryKeys.tokenUsage.all);
      invalidate(queryKeys.providerUsage.all);
      invalidate(queryKeys.globalSearch.all);
      invalidate(queryKeys.allChatAll);
      invalidate(queryKeys.workspaceResourceRecency.all);
      invalidate(queryKeys.triggers.all);
      invalidate(queryKeys.triggers.occurrencesAll);
      invalidate(queryKeys.agentWork.all);
    };
    const apply = (envelope: WorkspaceEventEnvelope) => {
      const reconciliation = reconcileCursor(
        cursor.current,
        envelope,
        item => item.id,
      );
      if (reconciliation.duplicate) return;
      cursor.current = reconciliation.cursor;
      persistWorkspaceCursor(reconciliation.cursor, instanceId.current ?? undefined);
      const event = envelope.event;
      const changesPhaseEvidence = workspaceAgentEventChangesPhase(event)
        || event.type === "coordination_changed"
        || (event.type === "notification_changed" && Boolean(event.decisionId));
      if (reconciliation.gap || envelope.replayed || changesPhaseEvidence) {
        const interruptedContinuity = Boolean(reconciliation.gap || envelope.replayed);
        markPhaseEvidenceStale(interruptedContinuity
          ? undefined : "projectId" in event ? event.projectId : undefined,
          interruptedContinuity);
      }
      const deletedProjectId = reconcileDeletedProjectEvent(
        envelope,
        (projectId, at) => onProjectDeleted.current?.(projectId, at),
      );
      let preferenceDirectoryKinds: ReturnType<
        typeof changedWorkspaceDirectoryKinds
      > = [];
      let preferenceStarsChanged = false;
      if (event.type === "preferences_updated") {
        invalidate(queryKeys.notifications.all);
        const previousPreferences = queryClient.getQueryData<
          WorkspacePreferencesDto
        >(queryKeys.workspacePreferences.all);
        preferenceDirectoryKinds = changedWorkspaceDirectoryKinds(
          previousPreferences,
          event.preferences,
        );
        preferenceStarsChanged = workspaceResourceStarsChanged(
          previousPreferences,
          event.preferences,
        );
        queryClient.setQueryData(
          queryKeys.workspacePreferences.all,
          options.projectPreferences?.(event.preferences) ?? event.preferences,
        );
      }
      if (reconciliation.gap) {
        invalidateAll();
        schedulePhaseReconciliation(true);
        return;
      }
      // Replayed workspace events are historical catch-up. Reconcile on a
      // fixed window: a quiet-period debounce can postpone an open Chat
      // indefinitely while a busy Agent keeps producing replay events. After
      // the first prompt refresh, cap global reconciliation to one per five
      // seconds so a long replay cannot recreate the request storm.
      if (envelope.replayed) {
        if (event.type === "conversation_changed") scheduleReplayChat([event.conversationId]);
        else if (event.type === "message_delivery_changed") scheduleReplayChat(event.conversationIds, true);
        replayReconcileTimer ??= setTimeout(() => {
          replayReconcileTimer = undefined;
          lastReplayReconcileAt = Date.now();
          invalidateAll();
          schedulePhaseReconciliation(true);
        }, Math.max(500, lastReplayReconcileAt + 5_000 - Date.now()));
        return;
      }
      if (workspaceEventInvalidatesGlobalSearch(event)) invalidate(queryKeys.globalSearch.all);
      if (workspaceEventInvalidatesAllChat(event)) invalidate(queryKeys.allChatAll);
      if (workspaceEventChangesResourceRecency(event) || preferenceStarsChanged) {
        workspaceRecencyInvalidator.schedule();
        // User navigation, authored Chat changes, and terminal lifecycle
        // changes stay responsive; only sustained operational output waits for
        // the bounded refresh window.
        if (event.type !== "agent_event" && event.type !== "coordination_changed"
            || (event.type === "agent_event" && event.category === "lifecycle")) {
          workspaceRecencyInvalidator.flush();
        }
      }
      if (event.type === "preferences_updated") {
        for (const kind of preferenceDirectoryKinds) {
          directoryInvalidator.schedule(kind);
        }
      } else if (event.type === "project_changed") {
        directoryInvalidator.schedule("project", event.projectId);
        if (event.action !== "used") directoryInvalidator.schedule("agent", event.projectId);
      } else if (event.type === "conversation_changed") {
        directoryInvalidator.schedule("conversation", event.projectId);
        directoryInvalidator.schedule("project", event.projectId);
      } else if (event.type === "trigger_changed") {
        directoryInvalidator.schedule("trigger", event.projectId);
      } else if (workspaceAgentEventChangesPhase(event)) {
        if (event.category === "lifecycle") {
          directoryInvalidator.schedule("agent", event.projectId, true);
          directoryInvalidator.schedule("project", event.projectId);
          directoryInvalidator.schedule("conversation", event.projectId);
        }
      }
      if (event.type === "preferences_updated") return;
      if (event.type === "project_changed") {
        invalidate(queryKeys.projects.all);
        if (event.action !== "used") {
          invalidate(queryKeys.agents.project(event.projectId));
          invalidate(queryKeys.agents.allChat);
        }
        // Mark collapsed sibling pages stale as ownership may have changed,
        // while refetching only pages that are currently visible.
        invalidate(queryKeys.agents.organizationProject(event.projectId));
        if (deletedProjectId) {
          invalidate(queryKeys.notifications.all);
          invalidate(queryKeys.globalSearch.all);
        }
      }
      else if (event.type === "conversation_changed") {
        for (const queryKey of conversationChangedQueryKeys(event)) {
          invalidate(queryKey);
        }
      } else if (event.type === "draft_changed" || event.type === "draft_conflict") invalidate(queryKeys.conversationDraft.prefix(event.conversationId));
      else if (event.type === "queued_message_changed") {
        invalidate(queryKeys.queuedMessages.conversation(event.conversationId));
        invalidate(queryKeys.queuedMessages.agentsAll);
        invalidate(queryKeys.conversations.detailPrefix(event.conversationId));
      }
      else if (event.type === "message_delivery_changed") {
        invalidateForBrowserPage(
          queryClient,
          queryKeys.agents.detailPrefix(event.agentId),
        );
        invalidate(queryKeys.queuedMessages.agent(event.agentId));
        if (event.conversationIds) {
          for (const conversationId of event.conversationIds) {
            invalidate(queryKeys.conversations.detailPrefix(conversationId));
            invalidate(queryKeys.conversations.activeDeliveryReceiptsPrefix(conversationId));
            invalidate(queryKeys.queuedMessages.conversation(conversationId));
            invalidate(queryKeys.conversations.targetedNextRun(conversationId));
          }
          collaborationChatInvalidator.schedule(event.conversationIds);
        } else {
          invalidate(queryKeys.conversations.detailAll);
          invalidate(queryKeys.conversations.activeDeliveryReceiptsAll);
          collaborationChatInvalidator.schedule();
        }
        agentWorkInvalidator.schedule(event.projectId);
        agentWorkInvalidator.flush();
      }
      else if (event.type === "coordination_changed") {
        queueAgentRoster(event.projectId);
        agentWorkInvalidator.schedule(event.projectId);
        collaborationChatInvalidator.schedule(event.conversationIds);
        for (const conversationId of event.conversationIds ?? []) {
          invalidate(queryKeys.conversations.targetedNextRun(conversationId));
        }
      }
      else if (event.type === "trigger_changed") {
        invalidate(queryKeys.triggers.project(event.projectId));
        invalidate(queryKeys.triggers.occurrence(event.triggerId));
        invalidate(queryKeys.triggers.agentOccurrences(event.agentId));
        invalidate(queryKeys.triggers.projectOccurrences(event.projectId));
        agentWorkInvalidator.schedule(event.projectId);
      }
      else if (event.type === "agent_event") {
        if (!hasLiveAgentStream(event.agentId)) {
          agentDetailInvalidator.schedule(event.agentId);
        }
        for (const queryKey of fileActivityConversationQueryKeys(event)) {
          invalidate(queryKey);
        }
        if (workspaceAgentEventChangesPhase(event)) {
          queueAgentRoster(event.projectId);
        }
        if (event.category === "lifecycle") {
          collaborationChatInvalidator.schedule(event.conversationIds);
          agentWorkInvalidator.schedule(event.projectId);
          agentWorkInvalidator.flush();
          agentDetailInvalidator.flush();
        }
        if (event.category === "file" || event.category === "artifact" || event.category === "task") {
          pendingTaskProjects.add(event.projectId);
          taskProjectionRefresh.schedule(event.category !== "task");
        }
        if (event.category === "usage") invalidate(queryKeys.tokenUsage.all);
      }
      else if (event.type === "usage_changed") {
        invalidate(queryKeys.tokenUsage.all);
        providerUsageRefresh.schedule();
      }
      else if (event.type === "runtime_capabilities_changed") {
        pendingCapabilityProjects.add(event.projectId);
        const urgent = Date.now() >= nextCapabilityUrgentAt;
        if (urgent) nextCapabilityUrgentAt = Date.now() + 5_000;
        capabilityRefresh.schedule(urgent);
      }
      else if (event.type === "notification_changed") {
        if (event.decisionId) {
          // Needs Action is interactive; its rare Decision transitions should
          // not wait behind routine unread-update traffic.
          notificationRefresh.dispose();
          invalidate(queryKeys.notifications.all);
        } else notificationRefresh.schedule();
        if (event.conversationId) {
          decisionConversationInvalidator.schedule(event.conversationId);
        }
        if (event.decisionId) agentWorkInvalidator.schedule(event.projectId);
      }
      if (changesPhaseEvidence) {
        // Coordination may arrive continuously across many Agents. Give the
        // first change prompt feedback, then use the bounded trailing refresh
        // until the next window; terminal lifecycle changes stay prompt.
        const coordinationUrgent = event.type === "coordination_changed"
          && Date.now() >= nextCoordinationUrgentAt;
        if (coordinationUrgent) nextCoordinationUrgentAt = Date.now() + 5_000;
        schedulePhaseReconciliation(coordinationUrgent
          || (event.type === "agent_event" && event.category === "lifecycle"));
      }
    };
    let subscription: StreamSubscription | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectingNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    let staleNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    let instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
    const clearConnectionTimers = () => {
      if (reconnectingNoticeTimer) clearTimeout(reconnectingNoticeTimer);
      if (staleNoticeTimer) clearTimeout(staleNoticeTimer);
      reconnectingNoticeTimer = undefined;
      staleNoticeTimer = undefined;
    };
    const noteDisconnect = () => {
      if (stopped || disconnected) return;
      disconnected = true;
      markPhaseEvidenceStale();
      reconnectingNoticeTimer = setTimeout(() => {
        reconnectingNoticeTimer = undefined;
        if (!stopped && disconnected) {
          setConnection(current => ({
            ...current,
            status: connectedOnce ? "reconnecting" : "connecting",
          }));
        }
      }, RECONNECTING_NOTICE_DELAY_MS);
      staleNoticeTimer = setTimeout(() => {
        staleNoticeTimer = undefined;
        if (!stopped && disconnected) {
          setConnection(current => ({
            ...current,
            status: connectedOnce ? "stale" : "unavailable",
            prolongedDisconnect: true,
            announcement: "Live workspace updates are unavailable.",
          }));
        }
      }, STALE_NOTICE_DELAY_MS);
    };
    const noteConnected = () => {
      disconnected = false;
      clearConnectionTimers();
      setConnection(current => ({
        status: "live",
        phaseEvidenceFresh: false,
        lastSuccessfulSyncAt: new Date().toISOString(),
        prolongedDisconnect: false,
        announcement: current.prolongedDisconnect
          ? "Live workspace updates have resumed."
          : undefined,
      }));
      // A contiguous cursor replay applies targeted invalidations. Only a
      // reset/gap below requires a full cache refresh after reconnect.
      connectedOnce = true;
    };
    const connect = (lastSeenId: number) => {
      if (stopped) return;
      const nextSubscription = api.subscribeWorkspace(lastSeenId, {
        onEvent: apply,
        onStatus: (status) => {
          const changedInstance = Boolean(
            instanceId.current && instanceId.current !== status.instanceId,
          );
          if (changedInstance) {
            markPhaseEvidenceStale();
            phaseCatchUpCursor = undefined;
            cursor.current = 0;
            instanceId.current = status.instanceId;
            persistWorkspaceCursor(0, status.instanceId);
            invalidateAll();
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
          markPhaseEvidenceStale();
          phaseCatchUpCursor = status.cursor;
          noteConnected();
          instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
          if (status.snapshot) {
            cursor.current = status.cursor;
            // A pre-baseline HTTP request may still be in flight. Cancel it
            // before refreshing, so an older response cannot win the bootstrap.
            void queryClient.cancelQueries().then(() => {
              if (stopped) return;
              // Include bootstrap queries such as preferences, not just the
              // event-specific projections covered by invalidateAll.
              void queryClient.invalidateQueries({ refetchType: browserPageIsVisible() ? "active" : "none" });
              schedulePhaseReconciliation(true);
            });
          } else if (status.reset || cursor.current > status.cursor) {
            cursor.current = 0;
            invalidateAll();
          }
          instanceId.current = status.instanceId;
          persistWorkspaceCursor(cursor.current, status.instanceId);
          schedulePhaseReconciliation(true);
        },
        onError: noteDisconnect,
      });
      subscription = nextSubscription;
    };
    connect(cursor.current);
    return () => {
      stopped = true;
      subscription?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearConnectionTimers();
      if (replayReconcileTimer) clearTimeout(replayReconcileTimer);
      if (replayChatTimer) clearTimeout(replayChatTimer);
      if (phaseQuietTimer) clearTimeout(phaseQuietTimer);
      phaseRefresh.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribePhaseQueryCache();
      directoryInvalidator.dispose();
      agentWorkInvalidator.dispose();
      agentDetailInvalidator.dispose();
      pendingRosterProjects.clear();
      workspaceRecencyInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      decisionConversationInvalidator.dispose();
      notificationRefresh.dispose();
      providerUsageRefresh.dispose();
      taskProjectionRefresh.dispose();
      pendingTaskProjects.clear();
      capabilityRefresh.dispose();
      pendingCapabilityProjects.clear();
    };
  }, [queryClient, retryGeneration]);
  return { ...connection, retry: () => setRetryGeneration(value => value + 1) };
}

export { createWorkspaceRecencyInvalidator, workspaceEventChangesResourceRecency };
