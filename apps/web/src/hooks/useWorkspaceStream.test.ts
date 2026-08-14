import { QueryClient } from "@tanstack/react-query";
import type { WorkspaceEventEnvelope, WorkspaceNotificationDto } from "@ponderosa/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  notificationsForAvailableProjects,
  notificationSummary,
} from "../attention";
import { queryKeys } from "../queryKeys";
import {
  createWorkspaceRecencyInvalidator,
  reconcileDeletedProjectClientState,
  reconcileDeletedProjectEvent,
} from "./useWorkspaceStream";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("workspace recency live invalidation", () => {
  test("coalesces sustained events into one refetch per fixed window", () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const invalidator = createWorkspaceRecencyInvalidator(
      { invalidateQueries },
      350,
    );

    for (let index = 0; index < 1_000; index += 1) invalidator.schedule();
    vi.advanceTimersByTime(349);
    expect(invalidateQueries).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 1_000; index += 1) invalidator.schedule();
    vi.advanceTimersByTime(350);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  test("cancels a pending refetch when a full reconciliation supersedes it", () => {
    vi.useFakeTimers();
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const invalidator = createWorkspaceRecencyInvalidator(
      { invalidateQueries },
      350,
    );

    invalidator.schedule();
    invalidator.dispose();
    vi.advanceTimersByTime(350);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("external Project deletion reconciliation", () => {
  test("excludes orphaned notifications from badge and filter input", () => {
    const orphaned = {
      id: "orphaned-notification",
      projectId: "deleted-project",
      kind: "direct_responses",
      title: "Deleted Project reply",
      body: "This route no longer exists.",
      createdAt: "2026-08-14T00:00:00.000Z",
    } satisfies WorkspaceNotificationDto;

    const presented = notificationsForAvailableProjects(
      [orphaned],
      new Set(["available-project"]),
    );
    expect(presented).toEqual([]);
    expect(notificationSummary(presented)).toEqual({
      attentionCount: 0,
      unreadUpdateCount: 0,
    });
  });

  test.each([false, true])(
    "reconciles %s replayed deletion events before refetch",
    replayed => {
      const queryClient = new QueryClient();
      const deleted = {
        id: "deleted-notification",
        projectId: "project-1",
        kind: "direct_responses",
        title: "Deleted Project reply",
        body: "This route no longer exists.",
        createdAt: "2026-08-14T00:00:00.000Z",
      } satisfies WorkspaceNotificationDto;
      const unaffected = {
        ...deleted,
        id: "unaffected-notification",
        projectId: "project-2",
      } satisfies WorkspaceNotificationDto;
      queryClient.setQueryData(queryKeys.notifications.all, [deleted, unaffected]);
      const onProjectDeleted = vi.fn();
      const envelope = {
        id: 42,
        ts: "2026-08-14T01:00:00.000Z",
        ...(replayed ? { replayed: true } : {}),
        event: {
          type: "project_changed",
          projectId: "project-1",
          action: "deleted",
        },
      } satisfies WorkspaceEventEnvelope;

      expect(reconcileDeletedProjectEvent(
        envelope,
        (projectId, at) => {
          reconcileDeletedProjectClientState(queryClient, projectId, at);
          onProjectDeleted(projectId, at);
        },
      )).toBe("project-1");
      expect(onProjectDeleted).toHaveBeenCalledWith("project-1", envelope.ts);
      const notifications = queryClient.getQueryData<WorkspaceNotificationDto[]>(
        queryKeys.notifications.all,
      )!;
      expect(notifications[0]).toMatchObject({
        id: "deleted-notification",
        status: "resolved",
        readAt: envelope.ts,
      });
      expect(notifications[1]).toEqual(unaffected);
      expect(notificationSummary(notifications)).toEqual({
        attentionCount: 0,
        unreadUpdateCount: 1,
      });
    },
  );

  test("same-client reconciliation resolves cache state without an SSE delivery", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all, [{
      id: "local-deletion",
      projectId: "project-1",
      kind: "direct_responses",
      title: "Deleted Project reply",
      body: "No dead navigation remains.",
      createdAt: "2026-08-14T00:00:00.000Z",
    }]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    reconcileDeletedProjectClientState(
      queryClient,
      "project-1",
      "2026-08-14T02:00:00.000Z",
    );

    expect(queryClient.getQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all)?.[0])
      .toMatchObject({ status: "resolved", readAt: "2026-08-14T02:00:00.000Z" });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.projects.all });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.globalSearch.all });
  });
});
