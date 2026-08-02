import type { ProjectDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { NotificationPanel } from "../src/components/NotificationPanel";
import { queryKeys } from "../src/queryKeys";

const project: ProjectDto = {
  id: "project",
  label: "Project",
  hostPath: "/project",
  defaultEngine: "codex",
  createdAt: "2026-08-01T12:00:00.000Z",
};

function notification(overrides: Partial<WorkspaceNotificationDto> = {}): WorkspaceNotificationDto {
  return {
    id: "notification",
    projectId: project.id,
    conversationId: "conversation",
    communicationEventId: "event",
    kind: "mentions",
    title: "Spruce",
    body: "Finished the requested work.",
    createdAt: "2026-08-01T12:01:00.000Z",
    ...overrides,
  };
}

function renderPanel(notifications: WorkspaceNotificationDto[], onNavigate = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.notifications.all, notifications);
  client.setQueryData(queryKeys.conversations.project(project.id), []);
  const view = render(
    <QueryClientProvider client={client}>
      <NotificationPanel
        open
        projects={[project]}
        notifications={notifications}
        onClose={vi.fn()}
        onNavigate={onNavigate}
      />
    </QueryClientProvider>,
  );
  return { client, onNavigate, ...view };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationPanel read state", () => {
  it("keeps read notifications visible without an unread highlight", () => {
    renderPanel([notification({ readAt: "2026-08-01T12:02:00.000Z" })]);

    expect(screen.getByText("Finished the requested work.")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "All (1)" })).not.toBeNull();
    expect(screen.getByText("You’re all caught up")).not.toBeNull();
  });

  it("marks a clicked issue read, navigates, and keeps it in the list", async () => {
    const issue = notification({
      id: "issue",
      kind: "operational",
      category: "provider",
      severity: "attention",
      title: "Provider needs attention",
    });
    const markRead = vi.spyOn(api, "markNotificationRead").mockResolvedValue(undefined);
    const { onNavigate, rerender, client } = renderPanel([issue]);

    await userEvent.click(screen.getByText("Provider needs attention"));

    expect(markRead).toHaveBeenCalledWith(issue.id);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "conversation",
      projectId: project.id,
      conversationId: "conversation",
      focusMessageId: "event",
    });

    const readIssue = { ...issue, readAt: "2026-08-01T12:02:00.000Z" };
    rerender(
      <QueryClientProvider client={client}>
        <NotificationPanel
          open
          projects={[project]}
          notifications={[readIssue]}
          onClose={vi.fn()}
          onNavigate={onNavigate}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Provider needs attention")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "All (1)" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Issues (1)" })).not.toBeNull();
  });

  it("marks every unread notification read from the footer action", async () => {
    const markAll = vi.spyOn(api, "markAllNotificationsRead").mockResolvedValue(undefined);
    renderPanel([
      notification(),
      notification({ id: "issue", kind: "operational", severity: "attention", title: "Issue" }),
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Mark All Read" }));

    expect(markAll).toHaveBeenCalledOnce();
  });
});
