import type { WorkspaceNotificationDto, WorkspaceNotificationPageDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { isOrdinaryMessageNotification } from "../workspaceNavigation";
import {
  notificationMatchesActiveView,
  useActiveNotificationView,
} from "../notificationActiveView";

export function useConversationNotificationVisibility(
  notificationsQuery: { data?: WorkspaceNotificationPageDto | WorkspaceNotificationDto[] },
  queryClient: QueryClient,
): (
  communicationEventId: string | undefined,
  visible: boolean,
) => void {
  const markedVisibleNotificationIds = useRef(new Set<string>());
  const activeView = useActiveNotificationView();
  const visibleCommunicationEventIds = useRef(new Set<string>());
  const observedNotificationIds = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const notificationItems = useMemo(() => Array.isArray(notificationsQuery.data)
    ? notificationsQuery.data
    : notificationsQuery.data?.items ?? [], [notificationsQuery.data]);
  const notifications = useRef(notificationItems);
  notifications.current = notificationItems;
  const attemptVisible = useRef<(communicationEventId: string) => void>(() => undefined);

  attemptVisible.current = (communicationEventId: string) => {
    if (document.visibilityState === "hidden") return;
    const matchingNotifications = notifications.current.filter((item) =>
      item.communicationEventId === communicationEventId &&
      !item.readAt &&
      (item.status ?? "open") === "open" &&
      isOrdinaryMessageNotification(item) &&
      !markedVisibleNotificationIds.current.has(item.id) &&
      (visibleCommunicationEventIds.current.has(communicationEventId) ||
        notificationMatchesActiveView(item, activeView)));
    if (!matchingNotifications.length) return;
    const ids = new Set(matchingNotifications.map((item) => item.id));
    ids.forEach((id) => markedVisibleNotificationIds.current.add(id));
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => current ? ({
      ...current,
      items: current.items.map((item) => ids.has(item.id) ? { ...item, readAt } : item),
      unreadUpdateCount: Math.max(0, current.unreadUpdateCount - ids.size),
    }) : current);
    void api.markNotificationsRead([...ids])
      .then(() => {
        retryAttempts.current.delete(communicationEventId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      })
      .catch(() => {
        ids.forEach((id) => markedVisibleNotificationIds.current.delete(id));
        queryClient.setQueryData<WorkspaceNotificationPageDto>(
          queryKeys.notifications.all,
          (current) => current ? ({
            ...current,
            items: current.items.map((item) =>
              ids.has(item.id) ? { ...item, readAt: undefined } : item),
            unreadUpdateCount: current.unreadUpdateCount + ids.size,
          }) : current,
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

  useEffect(() => {
    const newlyArrivedCommunicationEventIds = new Set<string>();
    for (const item of notificationItems) {
      if (observedNotificationIds.current.has(item.id)) continue;
      observedNotificationIds.current.add(item.id);
      if (
        item.communicationEventId &&
        !item.readAt &&
        (item.status ?? "open") === "open" &&
        isOrdinaryMessageNotification(item)
      ) newlyArrivedCommunicationEventIds.add(item.communicationEventId);
    }
    newlyArrivedCommunicationEventIds.forEach((communicationEventId) => {
      const matchingNotification = notificationItems.find(item =>
        item.communicationEventId === communicationEventId,
      );
      if (
        visibleCommunicationEventIds.current.has(communicationEventId) ||
        (matchingNotification && notificationMatchesActiveView(matchingNotification, activeView))
      ) {
        attemptVisible.current(communicationEventId);
      }
    });
  }, [activeView, notificationItems]);

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
