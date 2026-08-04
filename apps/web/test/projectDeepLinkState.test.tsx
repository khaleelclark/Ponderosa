import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRouteOutlet } from "../src/App.workspace-content";

const preferences = {
  projectSort: "last_used" as const,
  projectOrder: [],
  homeSort: "last_used" as const,
  homeOrder: [],
  chatSort: "last_used" as const,
  chatOrder: [],
  agentSort: "last_used" as const,
  agentOrder: [],
  triggerSort: "last_used" as const,
  triggerOrder: [],
  starredResourceIds: [],
  starredProjectIds: [],
  sidebarCollapsed: false,
  sidebarWidth: 288,
  notifications: {
    mentions: true,
    directReplies: true,
    projectChatMessages: true,
    broadcasts: true,
    allMessages: false,
  },
  fontFamily: "inter" as const,
  providerAvailability: {},
  engineDefaults: {},
  claudeModelOptions: [],
  globalInstructions: "",
  maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: false,
  contextRolloverTokens: 150_000,
  contextRolloverWindowFraction: 0.7,
  onboardingCompletedAt: "2026-08-04T00:00:00.000Z",
  profile: {
    displayName: "User",
    handle: "operator",
    avatarId: "default-user",
  },
  updatedAt: "2026-08-04T00:00:00.000Z",
};

function renderState(
  projectResolution: "loading" | "missing" | "unavailable",
  onNavigate = vi.fn(),
  onRetryProject = vi.fn(),
) {
  render(
    <WorkspaceRouteOutlet
      route={{ kind: "project", projectId: "missing-project" }}
      projectResolution={projectResolution}
      onRetryProject={onRetryProject}
      projects={[]}
      engines={[]}
      notifications={[]}
      preferences={preferences}
      colorMode="dark"
      loadError={false}
      onRetryLoad={vi.fn()}
      onNavigate={onNavigate}
      onPreferences={vi.fn()}
      onCreate={vi.fn()}
      onCancelCreate={vi.fn()}
      onOpenInbox={vi.fn()}
      onProjectDeleted={vi.fn()}
      onConversationAction={vi.fn()}
      onOpenEngineStatus={vi.fn()}
      onBrowserRequestHandled={vi.fn()}
      onResourceDeleted={vi.fn()}
      onToggleColorMode={vi.fn()}
    />,
  );
}

describe("safe Project deep-link states", () => {
  it("keeps loading and unavailable routes in place until an explicit action", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onRetry = vi.fn();
    renderState("unavailable", onNavigate, onRetry);
    expect(screen.getByText(/temporarily unavailable/)).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("distinguishes an authoritative missing Project and navigates only on request", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderState("missing", onNavigate);
    expect(screen.getByText(/could not be found/)).not.toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "View Projects" }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "projects" });
  });
});
