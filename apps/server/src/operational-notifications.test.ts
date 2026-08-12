import { describe, expect, it, vi } from "vitest";
import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { createOperationalNotifications } from "./operational-notifications.js";

const NOW = "2026-01-01T00:00:00.000Z";

describe("coordination attention notification reconciliation", () => {
  it("inspects only canonical candidates and projects with open notices", () => {
    const projects = Array.from({ length: 100 }, (_, index) => ({
      id: `project-${index}`,
      label: `Project ${index}`,
      hostPath: `/tmp/project-${index}`,
      createdAt: NOW,
      defaultEngine: "codex",
    }));
    const existing: WorkspaceNotificationDto = {
      id: "existing-notification",
      projectId: "project-99",
      kind: "operational",
      category: "coordination",
      severity: "attention",
      status: "open",
      dedupeKey: "coordination-attention:old-trace:trace",
      title: "Old coordination issue",
      body: "Old coordination issue",
      createdAt: NOW,
    };
    const notifications = [existing];
    const inspectedProjectIds: string[] = [];
    const coordination = {
      terminalActivations: vi.fn(() => []),
      coordinationAttentionProjectIds: vi.fn(() => ["project-42"]),
      agentWorkItems: vi.fn((input: { projectId: string }) => {
        inspectedProjectIds.push(input.projectId);
        return { items: [], truncated: false };
      }),
      getRequest: vi.fn(() => undefined),
    } as unknown as CoordinationV3Store;
    const workspace = {
      cursor: vi.fn(() => 0),
      listNotifications: vi.fn(() => notifications),
      listDecisionPage: vi.fn(() => ({ decisions: [], hasMore: false })),
      decisionsForRuns: vi.fn(() => []),
      getDecision: vi.fn(() => undefined),
      createNotification: vi.fn(),
      setNotificationStatus: vi.fn((id: string, status: "resolved") => {
        const notification = notifications.find((item) => item.id === id);
        if (!notification) return undefined;
        notification.status = status;
        return notification;
      }),
    } as unknown as WorkspaceStore;
    const store = {
      listProjects: vi.fn(() => projects),
      listAgents: vi.fn(() => []),
      getAgent: vi.fn(() => undefined),
      getProjectArtifact: vi.fn(() => undefined),
      operatorCanReadProjectArtifact: vi.fn(() => false),
    } as unknown as AgentStore;

    const operational = createOperationalNotifications({
      store,
      coordinationV3: coordination,
      workspace,
      publishWorkspaceSince: vi.fn(),
    });
    operational.reconcileCoordinationAttentionNotifications();

    expect(inspectedProjectIds).toEqual(["project-42", "project-99"]);
    expect(workspace.setNotificationStatus).toHaveBeenCalledWith(
      existing.id,
      "resolved",
    );
  });
});
