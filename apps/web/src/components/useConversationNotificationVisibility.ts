import type { WorkspaceNotificationDto, WorkspaceNotificationPageDto } from "@ponderosa/core";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import {
  requeueFailedVisibleNotificationRead,
  requeueVisibleNotificationReads,
} from "../notificationVisibility";
import { useWorkspaceConnection } from "./WorkspaceConnectionContext";

const VISIBLE_COMMUNICATION_BATCH_SIZE = 100;

export function useConversationNotificationVisibility(
  _notificationsQuery: { data?: WorkspaceNotificationPageDto | WorkspaceNotificationDto[] },
  queryClient: QueryClient,
): (
  communicationEventId: string | undefined,
  visible: boolean,
) => void {
  const workspaceConnection = useWorkspaceConnection();
  const visibleCommunicationEventIds = useRef(new Set<string>());
  const completedCommunicationEventIds = useRef(new Set<string>());
  const pendingCommunicationEventIds = useRef(new Set<string>());
  const inFlightCommunicationEventIds = useRef(new Set<string>());
  const deferredRequeueCommunicationEventIds = useRef(new Set<string>());
  const retryAttempts = useRef(new Map<string, number>());
  const flushTimer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(false);
  const flushPending = useRef<() => void>(() => undefined);
  const schedule = useRef<(delay?: number) => void>(() => undefined);

  schedule.current = (delay = 40) => {
    if (flushTimer.current || !mounted.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = undefined;
      flushPending.current();
    }, delay);
  };

  flushPending.current = () => {
    if (!mounted.current || document.visibilityState === "hidden") return;
    const communicationEventIds = [...pendingCommunicationEventIds.current]
      .filter((id) => visibleCommunicationEventIds.current.has(id))
      .slice(0, VISIBLE_COMMUNICATION_BATCH_SIZE);
    if (!communicationEventIds.length) return;
    communicationEventIds.forEach((id) => {
      pendingCommunicationEventIds.current.delete(id);
      inFlightCommunicationEventIds.current.add(id);
    });
    void api.markNotificationCommunicationsRead(communicationEventIds)
      .then(() => {
        communicationEventIds.forEach((id) => {
          completedCommunicationEventIds.current.add(id);
          retryAttempts.current.delete(id);
          deferredRequeueCommunicationEventIds.current.delete(id);
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      })
      .catch(() => {
        let retryDelay = 0;
        for (const id of communicationEventIds) {
          const delay = requeueFailedVisibleNotificationRead(
            id,
            mounted.current,
            visibleCommunicationEventIds.current,
            pendingCommunicationEventIds.current,
            retryAttempts.current,
            deferredRequeueCommunicationEventIds.current,
          );
          retryDelay = Math.max(retryDelay, delay ?? 0);
        }
        if (retryDelay) schedule.current(retryDelay);
      })
      .finally(() => {
        communicationEventIds.forEach((id) => inFlightCommunicationEventIds.current.delete(id));
        if (pendingCommunicationEventIds.current.size) schedule.current();
      });
    if (pendingCommunicationEventIds.current.size) schedule.current();
  };

  useEffect(() => {
    mounted.current = true;
    const requeueVisible = () => {
      if (document.visibilityState === "hidden") return;
      requeueVisibleNotificationReads(
        visibleCommunicationEventIds.current,
        completedCommunicationEventIds.current,
        pendingCommunicationEventIds.current,
        retryAttempts.current,
        inFlightCommunicationEventIds.current,
        deferredRequeueCommunicationEventIds.current,
      );
      schedule.current();
    };
    const onVisibilityChange = () => requeueVisible();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", requeueVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", requeueVisible);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
    };
  }, []);

  const previousWorkspaceStatus = useRef(workspaceConnection.status);
  useEffect(() => {
    const reconnected = workspaceConnection.status === "live" &&
      previousWorkspaceStatus.current !== "live";
    previousWorkspaceStatus.current = workspaceConnection.status;
    if (!reconnected || document.visibilityState === "hidden") return;
    requeueVisibleNotificationReads(
      visibleCommunicationEventIds.current,
      completedCommunicationEventIds.current,
      pendingCommunicationEventIds.current,
      retryAttempts.current,
      inFlightCommunicationEventIds.current,
      deferredRequeueCommunicationEventIds.current,
    );
    schedule.current();
  }, [workspaceConnection.status]);

  return useCallback((communicationEventId: string | undefined, visible: boolean) => {
    if (!communicationEventId) return;
    if (!visible) {
      visibleCommunicationEventIds.current.delete(communicationEventId);
      pendingCommunicationEventIds.current.delete(communicationEventId);
      retryAttempts.current.delete(communicationEventId);
      deferredRequeueCommunicationEventIds.current.delete(communicationEventId);
      return;
    }
    visibleCommunicationEventIds.current.add(communicationEventId);
    if (!completedCommunicationEventIds.current.has(communicationEventId) &&
        !inFlightCommunicationEventIds.current.has(communicationEventId)) {
      pendingCommunicationEventIds.current.add(communicationEventId);
      schedule.current();
    }
  }, []);
}
