import { describe, expect, it } from "vitest";
import {
  closeWorkspaceTab,
  mostRecentWorkspaceTab,
  openWorkspaceTab,
  removeProjectWorkspaceTabs,
  restoreWorkspaceTabs,
  serializeWorkspaceTabs,
  workspaceTabKey,
} from "../src/workspaceTabs";

describe("persistent cross-project workspace tabs", () => {
  it("opens chats and agents from different projects without duplicating stable identities", () => {
    const first = { kind: "conversation", projectId: "alpha", conversationId: "chat" } as const;
    const focused = { ...first, focusMessageId: "message-2" };
    const agent = { kind: "agent", projectId: "beta", agentId: "worker" } as const;
    const tabs = openWorkspaceTab(openWorkspaceTab(openWorkspaceTab([], first, 1), agent, 2), focused, 3);
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.key)).toEqual(["conversation:alpha:chat", "agent:beta:worker"]);
    expect(tabs[0]?.route).toEqual(focused);
  });

  it("closes a tab and identifies the most recently active remaining view", () => {
    const alpha = { kind: "conversation", projectId: "alpha", conversationId: "one" } as const;
    const beta = { kind: "conversation", projectId: "beta", conversationId: "two" } as const;
    const agent = { kind: "agent", projectId: "alpha", agentId: "worker" } as const;
    const tabs = openWorkspaceTab(openWorkspaceTab(openWorkspaceTab([], alpha, 10), beta, 20), agent, 30);
    const remaining = closeWorkspaceTab(tabs, workspaceTabKey(agent)!);
    expect(mostRecentWorkspaceTab(remaining)?.route).toEqual(beta);
  });

  it("round-trips refresh state and rejects corrupt or duplicate records", () => {
    const route = { kind: "agent", projectId: "alpha", agentId: "worker" } as const;
    const tabs = openWorkspaceTab([], route, 42);
    expect(restoreWorkspaceTabs(serializeWorkspaceTabs(tabs))).toEqual(tabs);
    expect(restoreWorkspaceTabs("not-json")).toEqual([]);
    expect(restoreWorkspaceTabs(JSON.stringify({ version: 1, tabs: [...tabs, ...tabs] }))).toEqual(tabs);
  });

  it("removes tabs whose projects no longer exist", () => {
    const alpha = { kind: "conversation", projectId: "alpha", conversationId: "one" } as const;
    const beta = { kind: "agent", projectId: "beta", agentId: "two" } as const;
    const tabs = openWorkspaceTab(openWorkspaceTab([], alpha, 1), beta, 2);
    expect(removeProjectWorkspaceTabs(tabs, new Set(["beta"]))).toEqual([tabs[1]]);
  });
});
