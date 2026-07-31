import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent, WorkspaceEventEnvelope } from "@ponderosa/core";
import { api } from "../api";
import type { StreamSubscription } from "../api/types";
import { queryKeys } from "../queryKeys";
import { hasLiveAgentStream } from "./agentStreamRegistry";
import { reconcileCursor } from "./streamCursor";

const CURSOR_KEY = "ponderosa.workspace.cursor.v2";
const INSTANCE_KEY = "ponderosa.workspace.instance.v1";
const INSTANCE_MISMATCH_INITIAL_DELAY_MS = 50;
const INSTANCE_MISMATCH_MAX_DELAY_MS = 2_000;

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

function persistWorkspaceCursor(cursor: number, instanceId?: string): void {
  try {
    window.sessionStorage.setItem(CURSOR_KEY, String(cursor));
    if (instanceId) window.sessionStorage.setItem(INSTANCE_KEY, instanceId);
  } catch {
    // Persistence improves reconnection behavior but must not block live updates.
  }
}

function invalidateActiveQueries(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
    if (query.getObserversCount() > 0) {
      void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
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
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detailPrefix(agentId),
      });
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
export function useWorkspaceStream(): void {
  const queryClient = useQueryClient();
  const cursor = useRef(initialCursor());
  const instanceId = useRef(initialInstanceId());

  useEffect(() => {
    const agentWorkInvalidator = createAgentWorkInvalidator(queryClient);
    const agentDetailInvalidator = createAgentDetailInvalidator(queryClient);
    const agentStateInvalidator = createAgentStateInvalidator(queryClient);
    const collaborationChatInvalidator = createCollaborationChatInvalidator(queryClient);
    const decisionConversationInvalidator =
      createDecisionConversationInvalidator(queryClient);
    let replayReconcileTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidateAll = () => {
      agentWorkInvalidator.dispose();
      agentDetailInvalidator.dispose();
      agentStateInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      decisionConversationInvalidator.dispose();
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      invalidateActiveQueries(queryClient, queryKeys.agents.all);
      invalidateActiveQueries(queryClient, queryKeys.agents.healthAll);
      invalidateActiveQueries(queryClient, queryKeys.agents.detailAll);
      void queryClient.invalidateQueries({ queryKey: queryKeys.collaborationAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceStatus.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFile.all });
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
      if (event.type === "preferences_updated") {
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
      if (workspaceEventChangesResourceRecency(event)) void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceResourceRecency.all });
      if (event.type === "preferences_updated") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.all });
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
      if (event.type === "project_changed") void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(event.agentId) });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.queuedMessages.agent(event.agentId),
        });
        if (event.conversationIds) {
          for (const conversationId of event.conversationIds) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detailPrefix(conversationId) });
            void queryClient.invalidateQueries({
              queryKey: queryKeys.queuedMessages.conversation(conversationId),
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
        agentWorkInvalidator.schedule(event.projectId);
        collaborationChatInvalidator.schedule(event.conversationIds);
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
        if (event.conversationId) {
          decisionConversationInvalidator.schedule(event.conversationId);
        }
        agentWorkInvalidator.schedule();
      }
    };
    let stopped = false;
    let subscription: StreamSubscription | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
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
          instanceMismatchDelay = INSTANCE_MISMATCH_INITIAL_DELAY_MS;
          if (status.reset || cursor.current > status.cursor) {
            cursor.current = 0;
            invalidateAll();
          }
          instanceId.current = status.instanceId;
          persistWorkspaceCursor(cursor.current, status.instanceId);
        },
        onError: () => undefined,
      });
      subscription = nextSubscription;
    };
    connect(cursor.current);
    return () => {
      stopped = true;
      subscription?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (replayReconcileTimer) clearTimeout(replayReconcileTimer);
      agentWorkInvalidator.dispose();
      agentDetailInvalidator.dispose();
      agentStateInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      decisionConversationInvalidator.dispose();
    };
  }, [queryClient]);
}
