import { QueryClient } from "@tanstack/react-query";
import type {
  AllChatPageDto,
  GlobalChatSearchResponseDto,
  ProjectDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import { describe, expect, test, vi } from "vitest";
import { queryKeys } from "./queryKeys";
import { reconcileDeletedProjectWorkspace } from "./deletedProjectReconciliation";
import type { WorkspaceTabState } from "./workspaceTabs";

const deletedProject = {
  id: "project-deleted",
  label: "Deleted Project",
  hostPath: "/tmp/deleted",
  createdAt: "2026-08-14T00:00:00.000Z",
  defaultEngine: "codex",
} satisfies ProjectDto;

const availableProject = {
  ...deletedProject,
  id: "project-available",
  label: "Available Project",
  hostPath: "/tmp/available",
} satisfies ProjectDto;

function allChatPage(): AllChatPageDto {
  return {
    items: [deletedProject, availableProject].map((project, index) => ({
      communicationEventId: `communication-${index}`,
      messageId: `message-${index}`,
      communicationIntent: "broadcast",
      project: { id: project.id, label: project.label },
      source: {
        kind: "project",
        conversationId: `conversation-${index}`,
        title: `${project.label} Chat`,
      },
      author: { kind: "user", label: "Patrick" },
      text: `${project.label} message`,
      createdAt: `2026-08-14T00:0${index}:00.000Z`,
    })),
    decisions: [deletedProject, availableProject].map((project, index) => ({
      kind: "decision",
      id: `decision-${index}`,
      createdAt: `2026-08-14T00:1${index}:00.000Z`,
      decision: {
        id: `decision-${index}`,
        projectId: project.id,
        agentId: `agent-${index}`,
        runId: `run-${index}`,
        mode: "choice",
        question: `${project.label} decision`,
        allowOther: true,
        blocking: true,
        status: "pending",
        createdAt: `2026-08-14T00:1${index}:00.000Z`,
        updatedAt: `2026-08-14T00:1${index}:00.000Z`,
        options: [],
      },
      project: { id: project.id, label: project.label },
      source: {
        kind: "project",
        conversationId: `conversation-${index}`,
        title: `${project.label} Chat`,
      },
    })),
    history: { limit: 50, hasMore: false },
  };
}

describe("same-client deleted Project reconciliation", () => {
  test("cleans every active read model and route without a workspace stream", () => {
    const queryClient = new QueryClient();
    const at = "2026-08-14T03:00:00.000Z";
    queryClient.setQueryData(queryKeys.projects.all, [deletedProject, availableProject]);
    queryClient.setQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all, [
      {
        id: "deleted-notification",
        projectId: deletedProject.id,
        kind: "direct_responses",
        title: "Deleted reply",
        body: "Must stop navigating",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
      {
        id: "available-notification",
        projectId: availableProject.id,
        kind: "direct_responses",
        title: "Available reply",
        body: "Must remain",
        createdAt: "2026-08-14T00:00:00.000Z",
      },
    ]);
    queryClient.setQueryData<GlobalChatSearchResponseDto>(
      queryKeys.globalSearch.results("", 25),
      {
        query: "",
        results: [deletedProject, availableProject].map((project, index) => ({
          project: { id: project.id, label: project.label },
          chat: { kind: "conversation", id: `conversation-${index}`, title: project.label },
          messageId: `message-${index}`,
          author: { kind: "user", label: "Patrick" },
          timestamp: "2026-08-14T00:00:00.000Z",
          snippet: project.label,
          highlights: [],
          unread: true,
        })),
        recentChats: [deletedProject, availableProject].map((project, index) => ({
          project: { id: project.id, label: project.label },
          chat: { kind: "conversation", id: `conversation-${index}`, title: project.label },
          lastActivityAt: "2026-08-14T00:00:00.000Z",
          unreadCount: 1,
        })),
        scannedMessages: 2,
        truncated: false,
      },
    );
    queryClient.setQueryData(queryKeys.allChat(50), allChatPage());
    queryClient.setQueryData(queryKeys.projects.detail(deletedProject.id), deletedProject);
    queryClient.setQueryData(queryKeys.conversations.project(deletedProject.id), [{ id: "stale" }]);
    queryClient.setQueryData(queryKeys.conversations.project(availableProject.id), [{ id: "retained" }]);
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const tabs: WorkspaceTabState[] = [
      {
        key: "open-project",
        route: { kind: "project", projectId: deletedProject.id },
        lastActivatedAt: 1,
      },
      {
        key: "deleted-chat",
        route: {
          kind: "conversation",
          projectId: deletedProject.id,
          conversationId: "conversation-0",
        },
        lastActivatedAt: 2,
      },
      {
        key: "all-chat",
        route: { kind: "allChat" },
        lastActivatedAt: 3,
      },
    ];

    const reconciliation = reconcileDeletedProjectWorkspace(
      queryClient,
      tabs,
      "open-project",
      deletedProject.id,
      at,
    );

    expect(reconciliation.activeRouteDeleted).toBe(true);
    expect(reconciliation.fallback).toEqual({ kind: "projects" });
    expect(reconciliation.tabs).toEqual([
      expect.objectContaining({ key: "open-project", route: { kind: "projects" } }),
      tabs[2],
    ]);
    expect(queryClient.getQueryData<ProjectDto[]>(queryKeys.projects.all)).toEqual([
      availableProject,
    ]);
    expect(queryClient.getQueryData<WorkspaceNotificationDto[]>(queryKeys.notifications.all))
      .toEqual([
        expect.objectContaining({
          id: "deleted-notification",
          status: "resolved",
          readAt: at,
          resolvedAt: at,
        }),
        expect.objectContaining({ id: "available-notification" }),
      ]);
    const search = queryClient.getQueryData<GlobalChatSearchResponseDto>(
      queryKeys.globalSearch.results("", 25),
    )!;
    expect(search.results.map(item => item.project.id)).toEqual([availableProject.id]);
    expect(search.recentChats.map(item => item.project.id)).toEqual([availableProject.id]);
    const allChat = queryClient.getQueryData<AllChatPageDto>(queryKeys.allChat(50))!;
    expect(allChat.items.map(item => item.project.id)).toEqual([availableProject.id]);
    expect(allChat.decisions?.map(item => item.project.id)).toEqual([availableProject.id]);
    expect(queryClient.getQueryData(queryKeys.projects.detail(deletedProject.id))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.conversations.project(deletedProject.id))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.conversations.project(availableProject.id)))
      .toEqual([{ id: "retained" }]);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.allChatAll });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.workspaceDirectory.all });

    const replay = reconcileDeletedProjectWorkspace(
      queryClient,
      reconciliation.tabs,
      "open-project",
      deletedProject.id,
      at,
    );
    expect(replay).toMatchObject({
      tabs: reconciliation.tabs,
      activeRouteDeleted: false,
      fallback: { kind: "projects" },
    });
    expect(queryClient.getQueryData<AllChatPageDto>(queryKeys.allChat(50)))
      .toEqual(allChat);
  });
});
