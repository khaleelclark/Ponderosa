import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { isOrdinaryMessageNotification } from "../workspaceNavigation";

export function useConversationNotificationVisibility(
  notificationsQuery: { data?: WorkspaceNotificationDto[] },
  queryClient: QueryClient,
): (communicationEventId: string | undefined) => void {
  const markedVisibleNotificationIds = useRef(new Set<string>());
  const markCommunicationVisible = useCallback((communicationEventId: string | undefined) => {
    if (!communicationEventId || document.visibilityState === "hidden") return;
    const notifications = (notificationsQuery.data ?? []).filter((item) =>
      item.communicationEventId === communicationEventId &&
      !item.readAt &&
      (item.status ?? "open") === "open" &&
      isOrdinaryMessageNotification(item) &&
      !markedVisibleNotificationIds.current.has(item.id));
    if (!notifications.length) return;
    const ids = new Set(notifications.map((item) => item.id));
    ids.forEach((id) => markedVisibleNotificationIds.current.add(id));
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all, (current = []) =>
      current.map((item) => ids.has(item.id) ? { ...item, readAt } : item));
    void Promise.all(notifications.map((item) => api.markNotificationRead(item.id)))
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }))
      .catch(() => {
        ids.forEach((id) => markedVisibleNotificationIds.current.delete(id));
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      });
  }, [notificationsQuery.data, queryClient]);
  return markCommunicationVisible;
}
