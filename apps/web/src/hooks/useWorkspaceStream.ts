import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent, WorkspaceEventEnvelope } from "@ponderosa/core";
import { api } from "../api";

const CURSOR_KEY = "ponderosa.workspace.cursor.v2";
const INSTANCE_KEY = "ponderosa.workspace.instance.v1";

function initialCursor(): number {
  const value = Number(window.sessionStorage.getItem(CURSOR_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function initialInstanceId(): string | null {
  return window.sessionStorage.getItem(INSTANCE_KEY);
}

export interface WorkspaceCursorReconciliation {
  cursor: number;
  duplicate: boolean;
  gap: boolean;
}

export type WorkspaceCapabilityBoundary =
  | { kind: "runtime-change"; projectId: string }
  | { kind: "reconnect" };

/** Apply the same adapter-discovery cache boundary in every mounted tab. */
export function invalidateWorkspaceCapabilities(
  queryClient: QueryClient,
  boundary: WorkspaceCapabilityBoundary,
): Promise<void> {
  if (boundary.kind === "reconnect") return Promise.resolve();
  return queryClient.invalidateQueries({
    queryKey: ["engine-capabilities", boundary.projectId],
  });
}

/** Conversation caches whose canonical response file summaries changed. */
export function fileActivityConversationQueryKeys(event: WorkspaceEvent): Array<readonly ["conversation", string]> {
  if (
    event.type !== "agent_event"
    || (event.category !== "file" && event.category !== "artifact" && event.category !== "lifecycle")
  ) return [];
  return event.conversationIds.map((conversationId) => ["conversation", conversationId] as const);
}

/** Pure ordered-cursor reducer shared by every tab's stream consumer. */
export function reconcileWorkspaceCursor(current: number, envelope: Pick<WorkspaceEventEnvelope, "id">): WorkspaceCursorReconciliation {
  if (envelope.id <= current) return { cursor: current, duplicate: true, gap: false };
  return { cursor: envelope.id, duplicate: false, gap: envelope.id !== current + 1 };
}

/** Every tab invalidates both chat projections from the same canonical change. */
export function conversationChangedQueryKeys(
  event: Extract<WorkspaceEvent, { type: "conversation_changed" }>,
): ReadonlyArray<readonly unknown[]> {
  return [
    ["conversations", event.projectId],
    ["conversation", event.conversationId],
    ["collaboration-chat", event.conversationId],
  ];
}

/** Chat mutations (including passive edits) and unread changes refresh search. */
export function workspaceEventInvalidatesGlobalSearch(event: WorkspaceEvent): boolean {
  return event.type === "conversation_changed" || event.type === "notification_changed";
}

/** Messages is a canonical communication projection. Refresh it only for
 * workspace events that can add or change one of its communication rows. */
export function workspaceEventInvalidatesAllChat(event: WorkspaceEvent): boolean {
  return event.type === "conversation_changed"
    || event.type === "message_delivery_changed"
    || (event.type === "agent_event" && event.category === "message");
}

export function workspaceReconnectRequiresRefresh(
  cursor: number,
  previousInstance: string | null,
  status: { cursor: number; instanceId: string; reset: boolean },
): boolean {
  return status.reset || Boolean(previousInstance && previousInstance !== status.instanceId) || cursor > status.cursor;
}

/** Coalesces a burst of coordination events into one refetch per affected
 * Project. A global invalidation supersedes narrower pending work. */
export function createAgentWorkInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 350,
): { schedule(projectId?: string): void; flush(): void; dispose(): void } {
  const projectIds = new Set<string>();
  let invalidateAll = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (invalidateAll) void queryClient.invalidateQueries({ queryKey: ["agent-work"] });
    else for (const projectId of projectIds) void queryClient.invalidateQueries({ queryKey: ["agent-work", projectId] });
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
export function createAgentListInvalidator(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 350,
): { schedule(projectId: string): void; flush(): void; dispose(): void } {
  const projectIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const projectId of projectIds) void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
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

/** One authoritative live stream invalidates only caches affected by each event. */
export function useWorkspaceStream(): void {
  const queryClient = useQueryClient();
  const cursor = useRef(initialCursor());
  const instanceId = useRef(initialInstanceId());

  useEffect(() => {
    const agentWorkInvalidator = createAgentWorkInvalidator(queryClient);
    const agentListInvalidator = createAgentListInvalidator(queryClient);
    const invalidateAll = () => {
      agentWorkInvalidator.dispose();
      agentListInvalidator.dispose();
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-health"] });
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
      void queryClient.invalidateQueries({ queryKey: ["collaboration-chat"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-status"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-file"] });
      void queryClient.invalidateQueries({ queryKey: ["token-usage"] });
      void queryClient.invalidateQueries({ queryKey: ["global-search"] });
      void queryClient.invalidateQueries({ queryKey: ["all-chat"] });
      void queryClient.invalidateQueries({ queryKey: ["triggers"] });
      void queryClient.invalidateQueries({ queryKey: ["trigger-occurrences"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-work"] });
    };
    const apply = (envelope: WorkspaceEventEnvelope) => {
      const reconciliation = reconcileWorkspaceCursor(cursor.current, envelope);
      if (reconciliation.duplicate) return;
      if (reconciliation.gap) invalidateAll();
      cursor.current = reconciliation.cursor;
      window.sessionStorage.setItem(CURSOR_KEY, String(envelope.id));
      const event = envelope.event;
      if (workspaceEventInvalidatesGlobalSearch(event)) void queryClient.invalidateQueries({ queryKey: ["global-search"] });
      if (workspaceEventInvalidatesAllChat(event)) void queryClient.invalidateQueries({ queryKey: ["all-chat"] });
      if (event.type === "preferences_updated") queryClient.setQueryData(["workspace-preferences"], event.preferences);
      else if (event.type === "project_changed") void queryClient.invalidateQueries({ queryKey: ["projects"] });
      else if (event.type === "conversation_changed") {
        for (const queryKey of conversationChangedQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      } else if (event.type === "draft_changed" || event.type === "draft_conflict") void queryClient.invalidateQueries({ queryKey: ["conversation-draft", event.conversationId] });
      else if (event.type === "queued_message_changed") {
        void queryClient.invalidateQueries({ queryKey: ["queued-messages", event.conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["queued-agent-messages"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
      }
      else if (event.type === "message_delivery_changed") {
        void queryClient.invalidateQueries({ queryKey: ["agent", event.agentId] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        void queryClient.invalidateQueries({ queryKey: ["collaboration-chat"] });
        agentWorkInvalidator.schedule(event.projectId);
      }
      else if (event.type === "coordination_changed") agentWorkInvalidator.schedule(event.projectId);
      else if (event.type === "trigger_changed") {
        void queryClient.invalidateQueries({ queryKey: ["triggers", event.agentId] });
        void queryClient.invalidateQueries({ queryKey: ["trigger-occurrences", event.triggerId] });
        void queryClient.invalidateQueries({ queryKey: ["agent-trigger-occurrences", event.agentId] });
        agentWorkInvalidator.schedule(event.projectId);
      }
      else if (event.type === "agent_event") {
        void queryClient.invalidateQueries({ queryKey: ["agent", event.agentId] });
        for (const queryKey of fileActivityConversationQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
        if (event.category === "lifecycle") {
          void queryClient.invalidateQueries({ queryKey: ["agent-health", event.projectId] });
          agentListInvalidator.schedule(event.projectId);
          void queryClient.invalidateQueries({ queryKey: ["collaboration-chat"] });
          agentWorkInvalidator.schedule(event.projectId);
        }
        if (event.category === "file" || event.category === "artifact" || event.category === "task") {
          void queryClient.invalidateQueries({ queryKey: ["workspace-status", event.projectId] });
          void queryClient.invalidateQueries({ queryKey: ["workspace-file", event.projectId] });
        }
        if (event.category === "usage") void queryClient.invalidateQueries({ queryKey: ["token-usage"] });
      }
      else if (event.type === "usage_changed") void queryClient.invalidateQueries({ queryKey: ["token-usage"] });
      else if (event.type === "runtime_capabilities_changed") {
        void invalidateWorkspaceCapabilities(queryClient, { kind: "runtime-change", projectId: event.projectId });
      }
      else if (event.type === "notification_changed") {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
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
    };
  }, [queryClient]);
}
