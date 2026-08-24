import type { WorkspaceNotificationPageDto } from "@ponderosa/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { isUnacknowledgedAction } from "../attention";
import { queryKeys } from "../queryKeys";

const ACKNOWLEDGEMENT_BATCH_LIMIT = 100;

export interface NotificationAcknowledgementOptimisticTarget {
  apply(notificationIds: readonly string[], acknowledgedAt: string): void;
  rollback(notificationIds: readonly string[], acknowledgedAt: string): void;
}

export type AcknowledgeNotifications = (
  notificationIds: readonly string[],
  optimisticTarget?: NotificationAcknowledgementOptimisticTarget,
) => void;

/** Queue exact action IDs briefly so one viewport can acknowledge many cards
 * without a request per card. Optimistic changes never remove an open action. */
export function useNotificationAcknowledgement(
  onError?: (reason: unknown) => void,
): AcknowledgeNotifications {
  const queryClient = useQueryClient();
  const pending = useRef(new Set<string>());
  const optimisticAt = useRef(new Map<string, string>());
  const optimisticCountedAt = useRef(new Map<string, string>());
  const rollbackTargets = useRef(new Map<
    string,
    Set<NotificationAcknowledgementOptimisticTarget["rollback"]>
  >());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const flush = useRef<() => void>(() => undefined);

  flush.current = () => {
    timer.current = undefined;
    const notificationIds = [...pending.current].slice(0, ACKNOWLEDGEMENT_BATCH_LIMIT);
    notificationIds.forEach((id) => pending.current.delete(id));
    if (!notificationIds.length) return;
    void api.acknowledgeNotifications(notificationIds).then(() => {
      notificationIds.forEach((id) => {
        optimisticAt.current.delete(id);
        optimisticCountedAt.current.delete(id);
        rollbackTargets.current.delete(id);
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).catch((reason) => {
      const failedIds = new Set(notificationIds);
      const rollbackIds = notificationIds.filter((id) => optimisticAt.current.has(id));
      const rollbackCount = notificationIds.filter((id) =>
        optimisticCountedAt.current.get(id) === optimisticAt.current.get(id)).length;
      queryClient.setQueryData<WorkspaceNotificationPageDto>(
        queryKeys.notifications.all,
        (current) => {
          if (!current) return current;
          const items = current.items.map((item) => {
            const expected = optimisticAt.current.get(item.id);
            if (!failedIds.has(item.id) || !expected || item.acknowledgedAt !== expected) return item;
            const { acknowledgedAt: _acknowledgedAt, ...unacknowledged } = item;
            return unacknowledged;
          });
          return {
            ...current,
            items,
            unacknowledgedActionCount: current.unacknowledgedActionCount + rollbackCount,
          };
        },
      );
      const groupedRollbacks = new Map<
        NotificationAcknowledgementOptimisticTarget["rollback"],
        Map<string, string[]>
      >();
      for (const id of rollbackIds) {
        const acknowledgedAt = optimisticAt.current.get(id);
        if (!acknowledgedAt) continue;
        for (const rollback of rollbackTargets.current.get(id) ?? []) {
          const byTimestamp = groupedRollbacks.get(rollback) ?? new Map<string, string[]>();
          const ids = byTimestamp.get(acknowledgedAt) ?? [];
          ids.push(id);
          byTimestamp.set(acknowledgedAt, ids);
          groupedRollbacks.set(rollback, byTimestamp);
        }
      }
      groupedRollbacks.forEach((byTimestamp, rollback) => {
        byTimestamp.forEach((ids, acknowledgedAt) => rollback(ids, acknowledgedAt));
      });
      notificationIds.forEach((id) => {
        optimisticAt.current.delete(id);
        optimisticCountedAt.current.delete(id);
        rollbackTargets.current.delete(id);
      });
      if (mounted.current) onErrorRef.current?.(reason);
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
    }).finally(() => {
      if (pending.current.size && !timer.current) {
        timer.current = setTimeout(() => flush.current(), 50);
      }
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      flush.current();
    };
  }, []);

  return useCallback((
    notificationIds: readonly string[],
    optimisticTarget?: NotificationAcknowledgementOptimisticTarget,
  ) => {
    const exactIds = [...new Set(notificationIds)]
      .filter((id) => !optimisticAt.current.has(id));
    if (!exactIds.length) return;
    const acknowledgedAt = new Date().toISOString();
    exactIds.forEach((id) => {
      pending.current.add(id);
      optimisticAt.current.set(id, acknowledgedAt);
      if (optimisticTarget) {
        const rollbacks = rollbackTargets.current.get(id) ?? new Set();
        rollbacks.add(optimisticTarget.rollback);
        rollbackTargets.current.set(id, rollbacks);
      }
    });
    optimisticTarget?.apply(exactIds, acknowledgedAt);
    queryClient.setQueryData<WorkspaceNotificationPageDto>(
      queryKeys.notifications.all,
      (current) => {
        if (!current) return current;
        const optimisticCount = Math.min(current.unacknowledgedActionCount, exactIds.length);
        exactIds.slice(0, optimisticCount)
          .forEach((id) => optimisticCountedAt.current.set(id, acknowledgedAt));
        const exactIdSet = new Set(exactIds);
        const items = current.items.map((item) => {
          if (!exactIdSet.has(item.id) || !isUnacknowledgedAction(item)) return item;
          return { ...item, acknowledgedAt };
        });
        return {
          ...current,
          items,
          unacknowledgedActionCount: Math.max(
            0,
            current.unacknowledgedActionCount - optimisticCount,
          ),
        };
      },
    );
    if (pending.current.size && !timer.current) {
      timer.current = setTimeout(() => flush.current(), 50);
    }
  }, [queryClient]);
}
