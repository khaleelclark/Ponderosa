import type { WorkspaceNotificationDto, WorkspaceNotificationPageDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { isOrdinaryMessageNotification } from "../workspaceNavigation";

export function useConversationNotificationVisibility(
  notificationsQuery: { data?: WorkspaceNotificationPageDto | WorkspaceNotificationDto[] },
  queryClient: QueryClient,
): (
  communicationEventId: string | undefined,
  visible: boolean,
) => void {
  const markedVisibleNotificationIds = useRef(new Set<string>());
  const optimisticReadAt = useRef(new Map<string, string>());
  const visibleCommunicationEventIds = useRef(new Set<string>());
  const observedNotificationIds = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(false);
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
      visibleCommunicationEventIds.current.has(communicationEventId));
    if (!matchingNotifications.length) return;
    const ids = new Set(matchingNotifications.map((item) => item.id));
    ids.forEach((id) => markedVisibleNotificationIds.current.add(id));
    const readAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationPageDto>(queryKeys.notifications.all, (current) => {
      if (!current) return current;
      let appliedCount = 0;
      const items = current.items.map((item) => {
        if (
          !ids.has(item.id) ||
          item.readAt ||
          (item.status ?? "open") !== "open" ||
          !isOrdinaryMessageNotification(item)
        ) return item;
        optimisticReadAt.current.set(item.id, readAt);
        appliedCount += 1;
        return { ...item, readAt };
      });
      return {
        ...current,
        items,
        unreadUpdateCount: Math.max(0, current.unreadUpdateCount - appliedCount),
      };
    });
    void api.markNotificationsRead([...ids])
      .then(() => {
        ids.forEach((id) => {
          if (optimisticReadAt.current.get(id) === readAt) {
            optimisticReadAt.current.delete(id);
          }
        });
        retryAttempts.current.delete(communicationEventId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      })
      .catch(() => {
        queryClient.setQueryData<WorkspaceNotificationPageDto>(
          queryKeys.notifications.all,
          (current) => {
            if (!current) return current;
            const revertedIds = new Set<string>();
            const items = current.items.map((item) => {
              if (
                !ids.has(item.id) ||
                optimisticReadAt.current.get(item.id) !== readAt ||
                item.readAt !== readAt ||
                (item.status ?? "open") !== "open" ||
                !isOrdinaryMessageNotification(item)
              ) return item;
              revertedIds.add(item.id);
              const { readAt: _readAt, ...unread } = item;
              return unread;
            });
            revertedIds.forEach((id) => markedVisibleNotificationIds.current.delete(id));
            return {
              ...current,
              items,
              unreadUpdateCount: current.unreadUpdateCount + revertedIds.size,
            };
          },
        );
        ids.forEach((id) => {
          if (optimisticReadAt.current.get(id) === readAt) {
            optimisticReadAt.current.delete(id);
          }
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
        if (!mounted.current) return;
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

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      retryTimers.current.forEach(clearTimeout);
      retryTimers.current.clear();
    };
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
      if (visibleCommunicationEventIds.current.has(communicationEventId)) {
        attemptVisible.current(communicationEventId);
      }
    });
  }, [notificationItems]);

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
