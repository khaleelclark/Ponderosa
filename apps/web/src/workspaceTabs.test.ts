import { describe, expect, it } from "vitest";
import {
  removeProjectWorkspaceTabsWithFallback,
  removeWorkspaceRouteWithFallback,
  type WorkspaceTabState,
} from "./workspaceTabs";

const tabs: WorkspaceTabState[] = [
  {
    key: "home",
    route: { kind: "home" },
    lastActivatedAt: 1,
  },
  {
    key: "project",
    route: { kind: "project", projectId: "project-1" },
    lastActivatedAt: 2,
  },
  {
    key: "chat",
    route: {
      kind: "conversation",
      projectId: "project-1",
      conversationId: "conversation-1",
    },
    lastActivatedAt: 3,
  },
  {
    key: "agent",
    route: { kind: "agent", projectId: "project-1", agentId: "agent-1" },
    lastActivatedAt: 4,
  },
];

describe("workspace tab deletion cleanup", () => {
  it("removes inactive deleted resources instead of persisting stale tabs", () => {
    const next = removeWorkspaceRouteWithFallback(
      tabs,
      "home",
      {
        kind: "conversation",
        projectId: "project-1",
        conversationId: "conversation-1",
      },
      { kind: "project", projectId: "project-1" },
      10,
    );

    expect(next.map(tab => tab.key)).toEqual(["home", "project", "agent"]);
  });

  it("replaces an active deleted Agent with its safe parent route", () => {
    const next = removeWorkspaceRouteWithFallback(
      tabs,
      "agent",
      { kind: "agent", projectId: "project-1", agentId: "agent-1" },
      { kind: "agents", projectId: "project-1" },
      10,
    );

    expect(next.find(tab => tab.key === "agent")?.route).toEqual({
      kind: "agents",
      projectId: "project-1",
    });
  });

  it("removes every child tab when a Project is deleted", () => {
    const next = removeProjectWorkspaceTabsWithFallback(
      tabs,
      "chat",
      "project-1",
      { kind: "projects" },
      10,
    );

    expect(next).toEqual([
      tabs[0],
      expect.objectContaining({
        key: "chat",
        route: { kind: "projects" },
      }),
    ]);
  });
});
