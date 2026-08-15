import { useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { isOpenAttention, isUnreadNotificationUpdate } from "../attention";
import {
  browserPageIsVisible,
  invalidateForBrowserPage,
} from "../queryVisibility";
import {
  changedWorkspaceDirectoryKinds,
  workspaceResourceStarsChanged,
} from "../resourcePreferences";
import { hasLiveAgentStream } from "./agentStreamRegistry";
import { reconcileCursor } from "./streamCursor";

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
  status: WorkspaceConnectionStatus;
  lastSuccessfulSyncAt?: string;
  prolongedDisconnect: boolean;
  announcement?: string;
}

export interface WorkspaceStreamOptions {
  onProjectDeleted?(projectId: string, at: string): void;
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
      let removedAttention = 0;
      let removedUpdates = 0;
      const items = current.items.map(notification => {
        if (notification.projectId !== projectId) return notification;
        if (notification.dedupeKey?.startsWith("project-deletion:")) {
          const { projectId: _deletedProjectId, ...workspaceNotification } = notification;
          return workspaceNotification;
        }
        if (isOpenAttention(notification)) removedAttention += 1;
        else if (isUnreadNotificationUpdate(notification)) removedUpdates += 1;
        return {
          ...notification,
          status: "resolved" as const,
          readAt: notification.readAt ?? at,
          resolvedAt: notification.resolvedAt ?? at,
        };
      });
      return {
        ...current,
        items,
        attentionCount: Math.max(0, current.attentionCount - removedAttention),
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
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.engines.capabilities(projectId),
  });
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

/** Chat mutations (including passive edits) and unread changes refresh search. */
function workspaceEventInvalidatesGlobalSearch(event: WorkspaceEvent): boolean {
  return event.type === "conversation_changed" || event.type === "notification_changed";
}

/** Messages is a canonical communication projection. Refresh it only for
 * workspace events that can add or change one of its communication rows. */
function workspaceEventInvalidatesAllChat(event: WorkspaceEvent): boolean {
  return event.type === "conversation_changed"
    || event.type === "message_delivery_changed"
    || (event.type === "agent_event" && event.category === "message");
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
  delayMs = 350,
): { schedule(): void; flush(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workspaceResourceRecency.all,
    });
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
  delayMs = 350,
): { schedule(projectId?: string): void; flush(): void; dispose(): void } {
  const projectIds = new Set<string>();
  let invalidateAll = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (invalidateAll) void queryClient.invalidateQueries({ queryKey: queryKeys.agentWork.all });
    else for (const projectId of projectIds) void queryClient.invalidateQueries({ queryKey: queryKeys.agentWork.project(projectId) });
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

/** Coalesces workspace fallbacks for Agent-detail surfaces that do not mount
 * their own Agent stream, such as Project review. */
function createAgentDetailInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 350,
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

/** Coalesces repeated lifecycle notifications before refreshing Project rosters.
 * Agent detail remains event-driven; this only prevents the shared list from
 * refetching once for every event in a short lifecycle burst. */
function createAgentStateInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 350,
): { schedule(projectId: string): void; flush(): void; dispose(): void } {
  const projectIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const projectId of projectIds) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(projectId) });
    }
    projectIds.clear();
  };
  return {
    schedule(projectId) {
      projectIds.add(projectId);
      // A fixed window keeps lifecycle state visible even under sustained load.
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      projectIds.clear();
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
    if (invalidateAll) void queryClient.invalidateQueries({ queryKey: queryKeys.collaborationAll });
    else for (const conversationId of conversationIds) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.collaborationPrefix(conversationId) });
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
    void queryClient.invalidateQueries({ queryKey: queryKeys.decisions.all });
    for (const conversationId of conversationIds) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.detailPrefix(conversationId),
      });
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
  const onProjectDeleted = useRef(options.onProjectDeleted);
  onProjectDeleted.current = options.onProjectDeleted;
  const cursor = useRef(initialCursor());
  const instanceId = useRef(initialInstanceId());
  const [connection, setConnection] = useState<WorkspaceConnectionState>({
    status: "connecting",
    prolongedDisconnect: false,
  });

  useEffect(() => {
    const agentWorkInvalidator = createAgentWorkInvalidator(queryClient);
    const agentDetailInvalidator = createAgentDetailInvalidator(queryClient);
    const agentStateInvalidator = createAgentStateInvalidator(queryClient);
    const workspaceRecencyInvalidator =
      createWorkspaceRecencyInvalidator(queryClient);
    const collaborationChatInvalidator = createCollaborationChatInvalidator(queryClient);
    const decisionConversationInvalidator =
      createDecisionConversationInvalidator(queryClient);
    let replayReconcileTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidateAll = () => {
      agentWorkInvalidator.dispose();
      agentDetailInvalidator.dispose();
      agentStateInvalidator.dispose();
      workspaceRecencyInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      decisionConversationInvalidator.dispose();
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      void queryClient.invalidateQueries({ queryKey: ["targeted-next-run"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      invalidateActiveQueries(queryClient, queryKeys.agents.all);
      invalidateActiveQueries(queryClient, queryKeys.agents.healthAll);
      invalidateActiveQueries(queryClient, queryKeys.agents.detailAll);
      void queryClient.invalidateQueries({ queryKey: queryKeys.collaborationAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStatus.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectArtifacts.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tokenUsage.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerUsage.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.globalSearch.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceResourceRecency.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.occurrencesAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWork.all });
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
      const deletedProjectId = reconcileDeletedProjectEvent(
        envelope,
        (projectId, at) => onProjectDeleted.current?.(projectId, at),
      );
      let preferenceDirectoryKinds: ReturnType<
        typeof changedWorkspaceDirectoryKinds
      > = [];
      let preferenceStarsChanged = false;
      if (event.type === "preferences_updated") {
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
        queryClient.setQueryData(queryKeys.workspacePreferences.all, event.preferences);
      }
      if (reconciliation.gap) {
        invalidateAll();
        return;
      }
      // Replayed workspace events are historical catch-up. The canonical
      // queries already include them, so applying live invalidations here
      // would multiply one reconnect into hundreds of network requests. Reset
      // one quiet-period timer instead, then reconcile mounted views once.
      if (envelope.replayed) {
        if (replayReconcileTimer) clearTimeout(replayReconcileTimer);
        replayReconcileTimer = setTimeout(() => {
          replayReconcileTimer = undefined;
          invalidateAll();
        }, 250);
        return;
      }
      if (workspaceEventInvalidatesGlobalSearch(event)) void queryClient.invalidateQueries({ queryKey: queryKeys.globalSearch.all });
      if (workspaceEventInvalidatesAllChat(event)) void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
      if (workspaceEventChangesResourceRecency(event) || preferenceStarsChanged) {
        workspaceRecencyInvalidator.schedule();
      }
      if (event.type === "preferences_updated") {
        for (const kind of preferenceDirectoryKinds) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.workspaceDirectory.kind(kind),
          });
        }
      } else if (event.type === "project_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("project") });
      } else if (event.type === "conversation_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("conversation") });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("project") });
      } else if (event.type === "trigger_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("trigger") });
      } else if (event.type === "agent_event" && event.category === "lifecycle") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("agent") });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("project") });
      }
      if (event.type === "preferences_updated") return;
      if (event.type === "project_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
        if (deletedProjectId) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
          void queryClient.invalidateQueries({ queryKey: queryKeys.globalSearch.all });
        }
      }
      else if (event.type === "conversation_changed") {
        for (const queryKey of conversationChangedQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      } else if (event.type === "draft_changed" || event.type === "draft_conflict") void queryClient.invalidateQueries({ queryKey: queryKeys.conversationDraft.prefix(event.conversationId) });
      else if (event.type === "queued_message_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.queuedMessages.conversation(event.conversationId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.queuedMessages.agentsAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(event.conversationId) });
      }
      else if (event.type === "message_delivery_changed") {
        invalidateForBrowserPage(
          queryClient,
          queryKeys.agents.detailPrefix(event.agentId),
        );
        void queryClient.invalidateQueries({
          queryKey: queryKeys.queuedMessages.agent(event.agentId),
        });
        if (event.conversationIds) {
          for (const conversationId of event.conversationIds) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(conversationId) });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.queuedMessages.conversation(conversationId),
            });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.conversations.targetedNextRun(conversationId),
            });
          }
          collaborationChatInvalidator.schedule(event.conversationIds);
        } else {
          void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailAll });
          collaborationChatInvalidator.schedule();
        }
        agentWorkInvalidator.schedule(event.projectId);
      }
      else if (event.type === "coordination_changed") {
        agentStateInvalidator.schedule(event.projectId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("agent") });
        agentWorkInvalidator.schedule(event.projectId);
        collaborationChatInvalidator.schedule(event.conversationIds);
        for (const conversationId of event.conversationIds ?? []) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.conversations.targetedNextRun(conversationId),
          });
        }
      }
      else if (event.type === "trigger_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.agent(event.agentId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.occurrence(event.triggerId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.agentOccurrences(event.agentId) });
        agentWorkInvalidator.schedule(event.projectId);
      }
      else if (event.type === "agent_event") {
        if (!hasLiveAgentStream(event.agentId)) {
          agentDetailInvalidator.schedule(event.agentId);
        }
        for (const queryKey of fileActivityConversationQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
        if (event.category === "lifecycle") {
          agentStateInvalidator.schedule(event.projectId);
          collaborationChatInvalidator.schedule(event.conversationIds);
          agentWorkInvalidator.schedule(event.projectId);
        }
        if (event.category === "file" || event.category === "artifact" || event.category === "task") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStatus.project(event.projectId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile.project(event.projectId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.projectArtifacts.project(event.projectId) });
        }
        if (event.category === "usage") void queryClient.invalidateQueries({ queryKey: queryKeys.tokenUsage.all });
      }
      else if (event.type === "usage_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tokenUsage.all });
        void queryClient.invalidateQueries({ queryKey: queryKeys.providerUsage.all });
      }
      else if (event.type === "runtime_capabilities_changed") {
        void invalidateWorkspaceCapabilities(queryClient, event.projectId);
      }
      else if (event.type === "notification_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
        invalidateActiveQueries(queryClient, queryKeys.agents.healthAll);
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("agent") });
        if (event.conversationId) {
          decisionConversationInvalidator.schedule(event.conversationId);
        }
        agentWorkInvalidator.schedule();
      }
    };
    let stopped = false;
    let subscription: StreamSubscription | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectingNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    let staleNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    let disconnected = false;
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
      const wasDisconnected = disconnected;
      disconnected = false;
      clearConnectionTimers();
      setConnection(current => ({
        status: "live",
        lastSuccessfulSyncAt: new Date().toISOString(),
        prolongedDisconnect: false,
        announcement: current.prolongedDisconnect
          ? "Live workspace updates have resumed."
          : undefined,
      }));
      if (connectedOnce && wasDisconnected) invalidateAll();
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
          noteConnected();
          instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
          if (status.reset || cursor.current > status.cursor) {
            cursor.current = 0;
            invalidateAll();
          }
          instanceId.current = status.instanceId;
          persistWorkspaceCursor(cursor.current, status.instanceId);
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
      agentWorkInvalidator.dispose();
      agentDetailInvalidator.dispose();
      agentStateInvalidator.dispose();
      workspaceRecencyInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      decisionConversationInvalidator.dispose();
    };
  }, [queryClient]);
  return connection;
}

export { createWorkspaceRecencyInvalidator, workspaceEventChangesResourceRecency };
