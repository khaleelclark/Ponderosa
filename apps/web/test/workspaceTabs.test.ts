import { describe, expect, it } from "vitest";
import {
  adjacentWorkspaceTab,
  closeWorkspaceTab,
  initializeWorkspaceTabSession,
  navigateWorkspaceTab,
  openWorkspaceTab,
  openWorkspaceTabInBackground,
  removeProjectWorkspaceTabs,
  reusableWorkspaceTab,
  renameWorkspaceTab,
  reorderWorkspaceTabs,
  restoreWorkspaceTabSession,
  serializeWorkspaceTabs,
} from "../src/workspaceTabs";

describe("persistent user-owned workspace tabs", () => {
  it("opens the neutral Home destination without overriding explicit deep links", () => {
    const restored = {
      tabs: [
        { key: "agent", route: { kind: "agent", projectId: "alpha", agentId: "worker" } as const, lastActivatedAt: 2 },
        { key: "home", route: { kind: "home" } as const, lastActivatedAt: 1 },
      ],
      activeKey: "agent",
    };
    expect(initializeWorkspaceTabSession(restored, { kind: "home" }, 3)).toEqual({
      tabs: [
        restored.tabs[0],
        { ...restored.tabs[1], lastActivatedAt: 3 },
      ],
      activeKey: "home",
    });
    expect(initializeWorkspaceTabSession(restored, { kind: "agent", projectId: "alpha", agentId: "worker" }, 3)).toEqual({
      tabs: [
        { ...restored.tabs[0], lastActivatedAt: 3 },
        restored.tabs[1],
      ],
      activeKey: "agent",
    });

    const withoutHome = initializeWorkspaceTabSession({ tabs: [restored.tabs[0]!] }, { kind: "home" }, 3);
    expect(withoutHome.activeKey).toBe(withoutHome.tabs[0]?.key);
    expect(withoutHome.tabs.map((tab) => tab.route.kind)).toEqual(["home", "agent"]);
  });

  it("creates duplicate routes only through explicit new tab instances", () => {
    const route = { kind: "conversation", projectId: "alpha", conversationId: "chat" } as const;
    const tabs = openWorkspaceTab(openWorkspaceTab([], route, 1, "first"), route, 2, "second");
    expect(tabs.map((tab) => tab.key)).toEqual(["first", "second"]);

    const focused = { ...route, focusMessageId: "message-2" };
    const navigated = navigateWorkspaceTab(tabs, "first", focused, 3);
    expect(navigated).toHaveLength(2);
    expect(navigated[0]?.route).toEqual(focused);
    expect(navigated[1]?.route).toEqual(route);
  });

  it("opens desktop resource actions in a new background tab without changing active identity", () => {
    const activeKey = "current-work";
    const current = openWorkspaceTab(
      [],
      { kind: "agent", projectId: "alpha", agentId: "worker", view: "activity" },
      1,
      activeKey,
    );
    const next = openWorkspaceTabInBackground(
      current,
      { kind: "conversation", projectId: "alpha", conversationId: "release" },
      2,
      "release-chat",
    );

    expect(activeKey).toBe("current-work");
    expect(next.map((tab) => tab.key)).toEqual(["current-work", "release-chat"]);
    expect(next[0]).toBe(current[0]);
    expect(next[1]?.route).toEqual({ kind: "conversation", projectId: "alpha", conversationId: "release" });
  });

  it("keeps one tab open and selects the browser-adjacent tab on close", () => {
    const alpha = { kind: "conversation", projectId: "alpha", conversationId: "one" } as const;
    const beta = { kind: "conversation", projectId: "beta", conversationId: "two" } as const;
    const agent = { kind: "agent", projectId: "alpha", agentId: "worker" } as const;
    const tabs = openWorkspaceTab(openWorkspaceTab(openWorkspaceTab([], alpha, 10, "a"), beta, 20, "b"), agent, 30, "c");
    expect(adjacentWorkspaceTab(tabs, "b")?.key).toBe("c");
    const remaining = closeWorkspaceTab(tabs, "b");
    expect(remaining.map((tab) => tab.key)).toEqual(["a", "c"]);
    expect(closeWorkspaceTab([remaining[0]!], "a")).toEqual([remaining[0]]);
  });

  it("persists active identity and user titles while rejecting corrupt records", () => {
    const route = { kind: "agent", projectId: "alpha", agentId: "worker" } as const;
    const tabs = renameWorkspaceTab(openWorkspaceTab([], route, 42, "worker-tab"), "worker-tab", "Release reviewer");
    expect(restoreWorkspaceTabSession(serializeWorkspaceTabs(tabs, "worker-tab"))).toEqual({ tabs, activeKey: "worker-tab" });
    expect(restoreWorkspaceTabSession("not-json")).toEqual({ tabs: [] });
    expect(restoreWorkspaceTabSession(JSON.stringify({ version: 2, tabs: [...tabs, ...tabs], activeKey: "worker-tab" }))).toEqual({ tabs, activeKey: "worker-tab" });
  });

  it("removes deleted projects but preserves global tabs and a required first tab", () => {
    const tabs = openWorkspaceTab(
      openWorkspaceTab([], { kind: "allChat" }, 1, "all-chat"),
      { kind: "agent", projectId: "beta", agentId: "two" }, 2, "beta",
    );
    expect(removeProjectWorkspaceTabs(tabs, new Set()).map((tab) => tab.key)).toEqual(["all-chat"]);
    expect(removeProjectWorkspaceTabs([tabs[1]!], new Set())).toHaveLength(1);
    expect(removeProjectWorkspaceTabs([tabs[1]!], new Set())[0]?.route).toEqual({ kind: "home" });
  });

  it("reorders tabs without changing their identities, routes, or custom titles", () => {
    const tabs = renameWorkspaceTab([
      { key: "a", route: { kind: "allChat" }, lastActivatedAt: 1 },
      { key: "b", route: { kind: "agent", projectId: "beta", agentId: "two" }, lastActivatedAt: 2 },
      { key: "c", route: { kind: "project", projectId: "gamma" }, lastActivatedAt: 3 },
    ], "a", "My start page");
    const reordered = reorderWorkspaceTabs(tabs, "a", "c");
    expect(reordered.map((tab) => tab.key)).toEqual(["b", "c", "a"]);
    expect(reordered.find((tab) => tab.key === "a")?.title).toBe("My start page");
    expect(reorderWorkspaceTabs(reordered, "missing", "b")).toBe(reordered);
    expect(restoreWorkspaceTabSession(serializeWorkspaceTabs(reordered, "a"))).toEqual({ tabs: reordered, activeKey: "a" });
  });

  it("restores saved Home tabs without changing tab identity or user titles", () => {
    const restored = restoreWorkspaceTabSession(JSON.stringify({
      version: 2,
      activeKey: "legacy-home",
      tabs: [{ key: "legacy-home", route: { kind: "home" }, lastActivatedAt: 7, title: "My start page" }],
    }));
    expect(restored).toEqual({
      activeKey: "legacy-home",
      tabs: [{ key: "legacy-home", route: { kind: "home" }, lastActivatedAt: 7, title: "My start page" }],
    });
  });
});
