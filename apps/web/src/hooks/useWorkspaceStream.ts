import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent, WorkspaceEventEnvelope } from "@ponderosa/core";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { reconcileCursor } from "./streamCursor";

const CURSOR_KEY = "ponderosa.workspace.cursor.v2";
const INSTANCE_KEY = "ponderosa.workspace.instance.v1";

function initialCursor(): number {
  const value = Number(window.sessionStorage.getItem(CURSOR_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function initialInstanceId(): string | null {
  return window.sessionStorage.getItem(INSTANCE_KEY);
}

type WorkspaceCapabilityBoundary =
  | { kind: "runtime-change"; projectId: string }
  | { kind: "reconnect" };

/** Apply the same adapter-discovery cache boundary in every mounted tab. */
function invalidateWorkspaceCapabilities(
  queryClient: QueryClient,
  boundary: WorkspaceCapabilityBoundary,
): Promise<void> {
  if (boundary.kind === "reconnect") return Promise.resolve();
  return queryClient.invalidateQueries({
    queryKey: queryKeys.engines.capabilities(boundary.projectId),
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

function workspaceReconnectRequiresRefresh(
  cursor: number,
  previousInstance: string | null,
  status: { cursor: number; instanceId: string; reset: boolean },
): boolean {
  return status.reset || Boolean(previousInstance && previousInstance !== status.instanceId) || cursor > status.cursor;
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

/** Coalesces repeated lifecycle notifications before refreshing Project rosters.
 * Agent detail remains event-driven; this only prevents the shared list from
 * refetching once for every event in a short lifecycle burst. */
function createAgentListInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 350,
): { schedule(projectId: string): void; flush(): void; dispose(): void } {
  const projectIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const projectId of projectIds) void queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(projectId) });
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

/** One authoritative live stream invalidates only caches affected by each event. */
export function useWorkspaceStream(): void {
  const queryClient = useQueryClient();
  const cursor = useRef(initialCursor());
  const instanceId = useRef(initialInstanceId());

  useEffect(() => {
    const agentWorkInvalidator = createAgentWorkInvalidator(queryClient);
    const agentListInvalidator = createAgentListInvalidator(queryClient);
    const collaborationChatInvalidator = createCollaborationChatInvalidator(queryClient);
    const invalidateAll = () => {
      agentWorkInvalidator.dispose();
      agentListInvalidator.dispose();
      collaborationChatInvalidator.dispose();
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.healthAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailAll });
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
      if (reconciliation.gap) invalidateAll();
      cursor.current = reconciliation.cursor;
      window.sessionStorage.setItem(CURSOR_KEY, String(envelope.id));
      const event = envelope.event;
      if (workspaceEventInvalidatesGlobalSearch(event)) void queryClient.invalidateQueries({ queryKey: queryKeys.globalSearch.all });
      if (workspaceEventInvalidatesAllChat(event)) void queryClient.invalidateQueries({ queryKey: queryKeys.allChatAll });
      if (workspaceEventChangesResourceRecency(event)) void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceResourceRecency.all });
      if (event.type === "preferences_updated") queryClient.setQueryData(queryKeys.workspacePreferences.all, event.preferences);
      else if (event.type === "project_changed") void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
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
      else if (event.type === "coordination_changed") agentWorkInvalidator.schedule(event.projectId);
      else if (event.type === "trigger_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.agent(event.agentId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.occurrence(event.triggerId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.triggers.agentOccurrences(event.agentId) });
        agentWorkInvalidator.schedule(event.projectId);
      }
      else if (event.type === "agent_event") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detailPrefix(event.agentId) });
        for (const queryKey of fileActivityConversationQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
        if (event.category === "lifecycle") {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.health(event.projectId) });
          agentListInvalidator.schedule(event.projectId);
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
        void invalidateWorkspaceCapabilities(queryClient, { kind: "runtime-change", projectId: event.projectId });
      }
      else if (event.type === "notification_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
        agentWorkInvalidator.schedule();
      }
    };
    const subscription = api.subscribeWorkspace(cursor.current, {
      onEvent: apply,
      onStatus: (status) => {
        const previousInstance = instanceId.current;
        if (workspaceReconnectRequiresRefresh(cursor.current, previousInstance, status)) {
          cursor.current = 0;
          window.sessionStorage.setItem(CURSOR_KEY, "0");
          invalidateAll();
        }
        instanceId.current = status.instanceId;
        window.sessionStorage.setItem(INSTANCE_KEY, status.instanceId);
      },
      onError: () => undefined,
    });
    return () => {
      subscription.close();
      agentWorkInvalidator.dispose();
      agentListInvalidator.dispose();
      collaborationChatInvalidator.dispose();
    };
  }, [queryClient]);
}
