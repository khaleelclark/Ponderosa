import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent, WorkspaceEventEnvelope } from "@ponderosa/core";
import { api } from "../api";

const CURSOR_KEY = "ponderosa.workspace.cursor.v2";
const INSTANCE_KEY = "ponderosa.workspace.instance.v1";
const REFRESH_KEY = "ponderosa.workspace.refresh.v1";
const REFRESH_CHANNEL = "ponderosa.workspace.refresh.v1";

export function workspaceRefreshStorageKey(key: string | null): boolean {
  return key === REFRESH_KEY;
}

/** Notify sibling tabs after this tab commits a canonical workspace mutation. */
export function announceWorkspaceRefresh(): void {
  if (typeof window === "undefined") return;
  const stamp = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  window.localStorage.setItem(REFRESH_KEY, stamp);
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(REFRESH_CHANNEL);
    channel.postMessage(stamp);
    channel.close();
  }
}

export function workspaceStorageCursor(key: string | null, value: string | null, current: number): number | undefined {
  if (key !== CURSOR_KEY) return undefined;
  const next = Number(value);
  return Number.isSafeInteger(next) && next > current ? next : undefined;
}

function initialCursor(): number {
  const value = Number(window.localStorage.getItem(CURSOR_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
  return queryClient.invalidateQueries({
    queryKey: boundary.kind === "runtime-change"
      ? ["engine-capabilities", boundary.projectId]
      : ["engine-capabilities"],
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

export function workspaceReconnectRequiresRefresh(
  cursor: number,
  previousInstance: string | null,
  status: { cursor: number; instanceId: string; reset: boolean },
): boolean {
  return status.reset || Boolean(previousInstance && previousInstance !== status.instanceId) || cursor > status.cursor;
}

/** One authoritative live stream invalidates only caches affected by each event. */
export function useWorkspaceStream(): void {
  const queryClient = useQueryClient();
  const cursor = useRef(initialCursor());

  useEffect(() => {
    const invalidateAll = () => {
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
      void queryClient.invalidateQueries({ queryKey: ["engine-capabilities"] });
      void queryClient.invalidateQueries({ queryKey: ["global-search"] });
      void queryClient.invalidateQueries({ queryKey: ["triggers"] });
      void queryClient.invalidateQueries({ queryKey: ["trigger-occurrences"] });
    };
    const apply = (envelope: WorkspaceEventEnvelope) => {
      const reconciliation = reconcileWorkspaceCursor(cursor.current, envelope);
      if (reconciliation.duplicate) return;
      if (reconciliation.gap) invalidateAll();
      cursor.current = reconciliation.cursor;
      window.localStorage.setItem(CURSOR_KEY, String(envelope.id));
      const event = envelope.event;
      if (workspaceEventInvalidatesGlobalSearch(event)) void queryClient.invalidateQueries({ queryKey: ["global-search"] });
      if (event.type === "preferences_updated") queryClient.setQueryData(["workspace-preferences"], event.preferences);
      else if (event.type === "project_changed") void queryClient.invalidateQueries({ queryKey: ["projects"] });
      else if (event.type === "conversation_changed") {
        for (const queryKey of conversationChangedQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      } else if (event.type === "draft_changed" || event.type === "draft_conflict") void queryClient.invalidateQueries({ queryKey: ["conversation-draft", event.conversationId] });
      else if (event.type === "queued_message_changed") {
        void queryClient.invalidateQueries({ queryKey: ["queued-messages", event.conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
      }
      else if (event.type === "message_delivery_changed") {
        void queryClient.invalidateQueries({ queryKey: ["agent", event.agentId] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
      }
      else if (event.type === "trigger_changed") {
        void queryClient.invalidateQueries({ queryKey: ["triggers", event.agentId] });
        void queryClient.invalidateQueries({ queryKey: ["trigger-occurrences", event.triggerId] });
        void queryClient.invalidateQueries({ queryKey: ["agent-trigger-occurrences", event.agentId] });
      }
      else if (event.type === "agent_event") {
        void queryClient.invalidateQueries({ queryKey: ["agent", event.agentId] });
        for (const queryKey of fileActivityConversationQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
        if (event.category === "lifecycle") {
          void queryClient.invalidateQueries({ queryKey: ["agent-health", event.projectId] });
          void queryClient.invalidateQueries({ queryKey: ["agents", event.projectId] });
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
      }
    };
    const subscription = api.subscribeWorkspace(cursor.current, {
      onEvent: apply,
      onStatus: (status) => {
        // Reconnect is a capability boundary: skills/plugins/connectors can
        // change while a phone is backgrounded or the server is unavailable.
        void invalidateWorkspaceCapabilities(queryClient, { kind: "reconnect" });
        const previousInstance = window.localStorage.getItem(INSTANCE_KEY);
        if (workspaceReconnectRequiresRefresh(cursor.current, previousInstance, status)) {
          cursor.current = 0;
          window.localStorage.setItem(CURSOR_KEY, "0");
          invalidateAll();
        }
        window.localStorage.setItem(INSTANCE_KEY, status.instanceId);
      },
      onError: () => undefined,
    });
    const onVisible = () => { if (document.visibilityState === "visible") invalidateAll(); };
    const refreshChannel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(REFRESH_CHANNEL);
    if (refreshChannel) refreshChannel.onmessage = () => invalidateAll();
    const onStorage = (event: StorageEvent) => {
      if (workspaceRefreshStorageKey(event.key)) {
        invalidateAll();
        return;
      }
      const next = workspaceStorageCursor(event.key, event.newValue, cursor.current);
      if (next === undefined) return;
      // Background tabs can receive the shared localStorage cursor before
      // their SSE callback is scheduled. Refresh now, then treat the later
      // stream event as a harmless duplicate.
      cursor.current = next;
      invalidateAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      subscription.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      refreshChannel?.close();
    };
  }, [queryClient]);
}
