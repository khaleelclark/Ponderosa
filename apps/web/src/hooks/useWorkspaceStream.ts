import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";
import { api } from "../api";

const CURSOR_KEY = "ponderosa.workspace.cursor.v1";

function initialCursor(): number {
  const value = Number(window.localStorage.getItem(CURSOR_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
    };
    const apply = (envelope: WorkspaceEventEnvelope) => {
      if (envelope.id <= cursor.current) return;
      if (envelope.id !== cursor.current + 1) invalidateAll();
      cursor.current = envelope.id;
      window.localStorage.setItem(CURSOR_KEY, String(envelope.id));
      const event = envelope.event;
      if (event.type === "preferences_updated") queryClient.setQueryData(["workspace-preferences"], event.preferences);
      else if (event.type === "project_changed") void queryClient.invalidateQueries({ queryKey: ["projects"] });
      else if (event.type === "conversation_changed") {
        void queryClient.invalidateQueries({ queryKey: ["conversations", event.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
      } else if (event.type === "draft_changed") void queryClient.invalidateQueries({ queryKey: ["conversation-draft", event.conversationId] });
      else if (event.type === "queued_message_changed") {
        void queryClient.invalidateQueries({ queryKey: ["queued-messages", event.conversationId] });
        void queryClient.invalidateQueries({ queryKey: ["conversation", event.conversationId] });
      }
      else if (event.type === "agent_event") {
        void queryClient.invalidateQueries({ queryKey: ["agent-health", event.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["agents", event.projectId] });
        void queryClient.invalidateQueries({ queryKey: ["agent", event.agentId] });
        for (const conversationId of event.conversationIds) {
          void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
          void queryClient.invalidateQueries({ queryKey: ["collaboration-chat", conversationId] });
        }
        if (event.category === "file" || event.category === "artifact" || event.category === "task") {
          void queryClient.invalidateQueries({ queryKey: ["workspace-status", event.projectId] });
          void queryClient.invalidateQueries({ queryKey: ["workspace-file", event.projectId] });
        }
      }
      else void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    };
    const subscription = api.subscribeWorkspace(cursor.current, { onEvent: apply, onError: () => undefined });
    const onVisible = () => { if (document.visibilityState === "visible") invalidateAll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { subscription.close(); document.removeEventListener("visibilitychange", onVisible); };
  }, [queryClient]);
}
