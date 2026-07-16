import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent, WorkspaceEventEnvelope } from "@ponderosa/core";
import { api } from "../api";

const CURSOR_KEY = "ponderosa.workspace.cursor.v2";
const INSTANCE_KEY = "ponderosa.workspace.instance.v1";

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
    };
    const apply = (envelope: WorkspaceEventEnvelope) => {
      const reconciliation = reconcileWorkspaceCursor(cursor.current, envelope);
      if (reconciliation.duplicate) return;
      if (reconciliation.gap) invalidateAll();
      cursor.current = reconciliation.cursor;
      window.localStorage.setItem(CURSOR_KEY, String(envelope.id));
      const event = envelope.event;
      if (event.type === "preferences_updated") queryClient.setQueryData(["workspace-preferences"], event.preferences);
      else if (event.type === "project_changed") void queryClient.invalidateQueries({ queryKey: ["projects"] });
      else if (event.type === "conversation_changed") {
        for (const queryKey of conversationChangedQueryKeys(event)) {
          void queryClient.invalidateQueries({ queryKey });
        }
        void queryClient.invalidateQueries({ queryKey: ["global-search"] });
      } else if (event.type === "draft_changed" || event.type === "draft_conflict") void queryClient.invalidateQueries({ queryKey: ["conversation-draft", event.conversationId] });
      else if (event.type === "queued_message_changed") {
        void queryClient.invalidateQueries({ queryKey: ["queued-messages", event.conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
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
        void queryClient.invalidateQueries({ queryKey: ["global-search"] });
      }
    };
    const subscription = api.subscribeWorkspace(cursor.current, {
      onEvent: apply,
      onStatus: (status) => {
        // Reconnect is a capability boundary: skills/plugins/connectors can
        // change while a phone is backgrounded or the server is unavailable.
        void invalidateWorkspaceCapabilities(queryClient, { kind: "reconnect" });
        const previousInstance = window.localStorage.getItem(INSTANCE_KEY);
        if (status.reset || (previousInstance && previousInstance !== status.instanceId) || cursor.current > status.cursor) {
          cursor.current = 0;
          window.localStorage.setItem(CURSOR_KEY, "0");
          invalidateAll();
        }
        window.localStorage.setItem(INSTANCE_KEY, status.instanceId);
      },
      onError: () => undefined,
    });
    const onVisible = () => { if (document.visibilityState === "visible") invalidateAll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { subscription.close(); document.removeEventListener("visibilitychange", onVisible); };
  }, [queryClient]);
}
