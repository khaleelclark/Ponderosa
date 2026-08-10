import type { WorkspaceNotificationDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { isOrdinaryMessageNotification } from "../workspaceNavigation";

export function useConversationNotificationVisibility(
  notificationsQuery: { data?: WorkspaceNotificationDto[] },
  queryClient: QueryClient,
): (
  communicationEventId: string | undefined,
  visible: boolean,
) => void {
  const markedVisibleNotificationIds = useRef(new Set<string>());
  const visibleCommunicationEventIds = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const notifications = useRef(notificationsQuery.data ?? []);
  notifications.current = notificationsQuery.data ?? [];
  const attemptVisible = useRef<(communicationEventId: string) => void>(() => undefined);

  attemptVisible.current = (communicationEventId: string) => {
    if (
      document.visibilityState === "hidden" ||
      !visibleCommunicationEventIds.current.has(communicationEventId)
    ) return;
    const matchingNotifications = notifications.current.filter((item) =>
      item.communicationEventId === communicationEventId &&
      !item.readAt &&
      (item.status ?? "open") === "open" &&
      isOrdinaryMessageNotification(item) &&
      !markedVisibleNotificationIds.current.has(item.id));
    if (!matchingNotifications.length) return;
    const ids = new Set(matchingNotifications.map((item) => item.id));
    ids.forEach((id) => markedVisibleNotificationIds.current.add(id));
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all, (current = []) =>
      current.map((item) => ids.has(item.id) ? { ...item, readAt } : item));
    void Promise.all(matchingNotifications.map((item) => api.markNotificationRead(item.id)))
      .then(() => {
        retryAttempts.current.delete(communicationEventId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      })
      .catch(() => {
        ids.forEach((id) => markedVisibleNotificationIds.current.delete(id));
        queryClient.setQueryData<WorkspaceNotificationDto[]>(
          queryKeys.notifications.all,
          (current = []) => current.map((item) =>
            ids.has(item.id) ? { ...item, readAt: undefined } : item),
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
        const attempt = retryAttempts.current.get(communicationEventId) ?? 0;
        if (attempt >= 3) return;
        retryAttempts.current.set(communicationEventId, attempt + 1);
        const timer = setTimeout(() => {
          retryTimers.current.delete(communicationEventId);
          attemptVisible.current(communicationEventId);
        }, 250 * (attempt + 1));
        retryTimers.current.set(communicationEventId, timer);
      });
  };

  useEffect(() => () => {
    retryTimers.current.forEach(clearTimeout);
    retryTimers.current.clear();
  }, []);

  const markCommunicationVisible = useCallback((
    communicationEventId: string | undefined,
    visible: boolean,
  ) => {
    if (!communicationEventId) return;
    if (!visible) {
      visibleCommunicationEventIds.current.delete(communicationEventId);
      const timer = retryTimers.current.get(communicationEventId);
      if (timer) clearTimeout(timer);
      retryTimers.current.delete(communicationEventId);
      retryAttempts.current.delete(communicationEventId);
      return;
    }
    visibleCommunicationEventIds.current.add(communicationEventId);
    attemptVisible.current(communicationEventId);
  }, []);
  return markCommunicationVisible;
}
