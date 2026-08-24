import type { WorkspaceNotificationPageDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { isUnacknowledgedAction } from "../attention";
import { queryKeys } from "../queryKeys";

const ACKNOWLEDGEMENT_BATCH_LIMIT = 100;

/** Queue exact action IDs briefly so one viewport can acknowledge many cards
 * without a request per card. Optimistic changes never remove an open action. */
export function useNotificationAcknowledgement(
  onError?: (reason: unknown) => void,
): (notificationIds: readonly string[]) => void {
  const queryClient = useQueryClient();
  const pending = useRef(new Set<string>());
  const optimisticAt = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  const flush = useRef<() => void>(() => undefined);

  flush.current = () => {
    timer.current = undefined;
    const notificationIds = [...pending.current].slice(0, ACKNOWLEDGEMENT_BATCH_LIMIT);
    notificationIds.forEach((id) => pending.current.delete(id));
    if (!notificationIds.length) return;
    void api.acknowledgeNotifications(notificationIds).then(() => {
      notificationIds.forEach((id) => optimisticAt.current.delete(id));
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).catch((reason) => {
      const failedIds = new Set(notificationIds);
      queryClient.setQueryData<WorkspaceNotificationPageDto>(
        queryKeys.notifications.all,
        (current) => {
          if (!current) return current;
          let restored = 0;
          const items = current.items.map((item) => {
            const expected = optimisticAt.current.get(item.id);
            if (!failedIds.has(item.id) || !expected || item.acknowledgedAt !== expected) return item;
            restored += 1;
            const { acknowledgedAt: _acknowledgedAt, ...unacknowledged } = item;
            return unacknowledged;
          });
          return {
            ...current,
            items,
            unacknowledgedActionCount: current.unacknowledgedActionCount + restored,
          };
        },
      );
      notificationIds.forEach((id) => optimisticAt.current.delete(id));
      if (mounted.current) onError?.(reason);
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).finally(() => {
      if (mounted.current && pending.current.size && !timer.current) {
        timer.current = setTimeout(() => flush.current(), 50);
      }
    });
  };

  useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    flush.current();
  }, []);

  return useCallback((notificationIds: readonly string[]) => {
    const exactIds = new Set(notificationIds);
    if (!exactIds.size) return;
    const acknowledgedAt = new Date().toISOString();
    queryClient.setQueryData<WorkspaceNotificationPageDto>(
      queryKeys.notifications.all,
      (current) => {
        if (!current) return current;
        let acknowledged = 0;
        const items = current.items.map((item) => {
          if (!exactIds.has(item.id) || !isUnacknowledgedAction(item)) return item;
          acknowledged += 1;
          pending.current.add(item.id);
          optimisticAt.current.set(item.id, acknowledgedAt);
          return { ...item, acknowledgedAt };
        });
        return {
          ...current,
          items,
          unacknowledgedActionCount: Math.max(
            0,
            current.unacknowledgedActionCount - acknowledged,
          ),
        };
      },
    );
    if (pending.current.size && !timer.current) {
      timer.current = setTimeout(() => flush.current(), 50);
    }
  }, [queryClient]);
}
