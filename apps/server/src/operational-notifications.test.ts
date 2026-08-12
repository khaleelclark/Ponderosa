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
  it("focuses exact candidate records and resolves notices absent from the full scan", () => {
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
    const inspectedInputs: Array<{
      projectId: string;
      agentId?: string;
      focusId?: string;
      limit?: number;
    }> = [];
    const coordination = {
      communicationAttentionActivations: vi.fn(() => []),
      coordinationAttentionCandidates: vi.fn(() => [{
        kind: "request",
        recordId: "failed-request",
        projectId: "project-42",
        agentId: "agent-42",
        updatedAt: NOW,
      }]),
      agentWorkItems: vi.fn((input: {
        projectId: string;
        agentId?: string;
        focusId?: string;
        limit?: number;
      }) => {
        inspectedInputs.push(input);
        return { items: [{
          id: "request:failed-request",
          recordId: "failed-request",
          referenceIds: ["failed-request"],
          kind: "request",
          state: "failed",
          title: "Assigned work",
          summary: "The assignment failed.",
          agentIds: ["agent-42"],
          recipientAgentId: "agent-42",
          relatedItemIds: [],
          createdAt: NOW,
          updatedAt: NOW,
        }], truncated: false };
      }),
      getRequest: vi.fn(() => ({ payload: { text: "Review the release" } })),
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
      listAgents: vi.fn((projectId: string) => projectId === "project-42" ? [{
        id: "agent-42",
        projectId,
        title: "Reviewer",
        activeEngine: "codex",
        conversationIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      }] : []),
      getAgent: vi.fn((agentId: string) => agentId === "agent-42" ? ({
        id: agentId,
        projectId: "project-42",
        title: "Reviewer",
        activeEngine: "codex",
        conversationIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      }) : undefined),
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

    expect(inspectedInputs).toEqual([{
      projectId: "project-42",
      agentId: "agent-42",
      focusId: "request:failed-request",
      limit: 200,
    }]);
    expect(workspace.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "coordination-attention:trace:request:failed-request:failed-request",
        resolution: expect.objectContaining({ requestId: "failed-request" }),
      }),
      true,
    );
    expect(workspace.setNotificationStatus).toHaveBeenCalledWith(
      existing.id,
      "resolved",
    );
  });

  it("consumes more than 200 exact candidates through keyset pages", () => {
    const candidates = Array.from({ length: 201 }, (_, index) => ({
      kind: "request" as const,
      recordId: `failed-${index.toString().padStart(3, "0")}`,
      projectId: "project-1",
      agentId: "agent-1",
      updatedAt: NOW,
    })).reverse();
    const coordinationAttentionCandidates = vi.fn((
      limit: number,
      cursor?: { recordId: string },
    ) => {
      const start = cursor
        ? candidates.findIndex((candidate) => candidate.recordId === cursor.recordId) + 1
        : 0;
      return candidates.slice(start, start + limit);
    });
    const agentWorkItems = vi.fn(() => ({ items: [], truncated: false }));
    const coordination = {
      communicationAttentionActivations: vi.fn(() => []),
      coordinationAttentionCandidates,
      agentWorkItems,
    } as unknown as CoordinationV3Store;
    const workspace = {
      cursor: vi.fn(() => 0),
      listNotifications: vi.fn(() => []),
      listDecisionPage: vi.fn(() => ({ decisions: [], hasMore: false })),
      decisionsForRuns: vi.fn(() => []),
      getDecision: vi.fn(() => undefined),
      createNotification: vi.fn(),
      setNotificationStatus: vi.fn(),
    } as unknown as WorkspaceStore;
    const store = {
      listProjects: vi.fn(() => [{
        id: "project-1",
        label: "Project",
        hostPath: "/tmp/project-1",
        createdAt: NOW,
        defaultEngine: "codex",
      }]),
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

    expect(coordinationAttentionCandidates).toHaveBeenCalledTimes(2);
    expect(coordinationAttentionCandidates).toHaveBeenLastCalledWith(200, {
      updatedAt: NOW,
      kind: "request",
      recordId: "failed-001",
    });
    expect(agentWorkItems).toHaveBeenCalledTimes(201);
    expect(agentWorkItems).toHaveBeenLastCalledWith({
      projectId: "project-1",
      agentId: "agent-1",
      focusId: "request:failed-000",
      limit: 200,
    });
  });
});
