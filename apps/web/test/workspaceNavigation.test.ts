import type { AgentDto, AgentHealthDto, ConversationDto, ProjectDto, WorkspaceNotificationDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RAIL_WIDTH } from "../src/components/WorkspaceSidebar";
import { hasUnreadConversationNotifications, projectContextLabel, workspaceAgents, workspaceChats, workspaceCounts, type WorkspaceProjectSnapshot } from "../src/workspaceNavigation";

const project = (id: string, label: string): ProjectDto => ({
  id, label, hostPath: `/repos/${id}`, createdAt: "2026-07-01T00:00:00.000Z", defaultEngine: "codex",
});
const chat = (projectId: string, id: string, title: string, updatedAt: string): ConversationDto => ({
  id, projectId, title, updatedAt, createdAt: updatedAt, archived: false,
});
const agent = (projectId: string, id: string, title: string, updatedAt: string): AgentDto => ({
  id, projectId, title, conversationIds: [], activeEngine: "codex", state: {}, createdAt: updatedAt, updatedAt, archived: false,
});
const health = (agentId: string, status: AgentHealthDto["status"]): AgentHealthDto => ({
  agentId, status, statusTimestamp: "2026-07-16T00:00:00.000Z", reason: status === "running" ? "active_run" : "no_active_work", childAgentIds: [],
});

describe("multi-project workspace navigation model", () => {
  const alpha = project("alpha", "Website");
  const beta = project("beta", "Website");
  const snapshots: WorkspaceProjectSnapshot[] = [
    { project: alpha, conversations: [chat(alpha.id, "planning", "Planning", "2026-07-15T10:00:00.000Z")], agents: [agent(alpha.id, "one", "Reviewer", "2026-07-15T09:00:00.000Z")], health: [health("one", "idle")] },
    { project: beta, conversations: [chat(beta.id, "release", "Planning", "2026-07-16T10:00:00.000Z")], agents: [agent(beta.id, "two", "Reviewer", "2026-07-16T09:00:00.000Z")], health: [health("two", "running")] },
  ];
  const notifications: WorkspaceNotificationDto[] = [
    { id: "n1", projectId: beta.id, conversationId: "release", kind: "mentions", title: "Mention", body: "Body", createdAt: "2026-07-16T10:01:00.000Z" },
    { id: "n2", projectId: alpha.id, conversationId: "planning", kind: "mentions", title: "Read", body: "Body", createdAt: "2026-07-15T10:01:00.000Z", readAt: "2026-07-15T11:00:00.000Z" },
  ];

  it("orders recent chats across projects and preserves project context for duplicate names", () => {
    const rows = workspaceChats(snapshots, notifications);
    expect(rows.map((row) => [row.conversation.id, row.project.id, row.unread])).toEqual([
      ["release", "beta", 1], ["planning", "alpha", 0],
    ]);
    expect(projectContextLabel(rows[0]!.project, rows[0]!.conversation.title, [alpha, beta])).toBe("Planning · Website · /repos/beta");
  });

  it("puts running agents first while keeping every duplicate title project-qualified", () => {
    const rows = workspaceAgents(snapshots);
    expect(rows.map((row) => [row.agent.id, row.project.id, row.status])).toEqual([
      ["two", "beta", "running"], ["one", "alpha", "idle"],
    ]);
    expect(rows.every((row) => projectContextLabel(row.project, row.agent.title, [alpha, beta]).includes(row.project.hostPath))).toBe(true);
    expect(workspaceCounts(snapshots, notifications)).toEqual({ running: 1, unread: 1 });
  });

  it("uses a useful persistent rail and bounded device-local widths", () => {
    expect(SIDEBAR_RAIL_WIDTH).toBeGreaterThanOrEqual(56);
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(311.6)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("detects unread notifications for the currently open Project chat", () => {
    expect(hasUnreadConversationNotifications(notifications, "release")).toBe(true);
    expect(hasUnreadConversationNotifications(notifications, "planning")).toBe(false);
    expect(hasUnreadConversationNotifications(notifications, undefined)).toBe(false);
  });
});
