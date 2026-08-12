import { describe, expect, it, vi } from "vitest";
import type {
  AgentStore,
  CoordinationV3Store,
  WorkspaceStore,
} from "@ponderosa/agents";
import type {
  AgentWorkItemDto,
  WorkspaceNotificationDto,
} from "@ponderosa/core";
import { createOperationalNotifications } from "./operational-notifications.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "project-1";
const AGENT_ID = "agent-1";
const COMMUNICATION_ACTIVATION_ID = "communication-activation";

describe("operational notification classification", () => {
  it("uses the message recovery notice and suppresses generic coordination for unassigned Runs", () => {
    const notifications: WorkspaceNotificationDto[] = [];
    const activation = (id: string, relatedRunId: string): AgentWorkItemDto => ({
      id: `activation:${id}`,
      recordId: id,
      referenceIds: [id],
      kind: "activation",
      state: "outcome_unknown",
      title: "Queued wake-up",
      summary: "The wake-up ended outcome unknown.",
      agentIds: [AGENT_ID],
      relatedItemIds: [`run:${relatedRunId}`],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const run = (id: string, relatedActivationId: string): AgentWorkItemDto => ({
      id: `run:${id}`,
      recordId: id,
      referenceIds: [id],
      kind: "run",
      state: "outcome_unknown",
      title: "Agent Run",
      summary: "The Run ended outcome unknown.",
      agentIds: [AGENT_ID],
      relatedItemIds: [`activation:${relatedActivationId}`],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const coordination = {
      coordinationAttentionCandidates: vi.fn(() => []),
      communicationAttentionActivations: vi.fn(() => [{
        id: COMMUNICATION_ACTIVATION_ID,
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        kind: "human_message",
        state: "outcome_unknown",
        communicationEventId: "communication-1",
        communicationIntent: "user_dm",
        deliveryFailures: 0,
        updatedAt: NOW,
      }]),
      terminalActivationDisposition: vi.fn(() => ({
        id: COMMUNICATION_ACTIVATION_ID,
        state: "outcome_unknown",
        supersededByRetry: false,
      })),
      agentWorkItems: vi.fn(() => ({
        items: [
          activation(COMMUNICATION_ACTIVATION_ID, "message-run"),
          run("message-run", COMMUNICATION_ACTIVATION_ID),
          activation("context-rollover-activation", "rollover-run"),
          run("rollover-run", "context-rollover-activation"),
        ],
        truncated: false,
      })),
      agentWorkItemDetails: vi.fn(() => undefined),
      requestLifecycleDetails: vi.fn(() => undefined),
      getRequest: vi.fn(() => undefined),
    } as unknown as CoordinationV3Store;
    const workspace = {
      cursor: vi.fn(() => 0),
      listNotifications: vi.fn(() => notifications),
      listDecisionPage: vi.fn(() => ({ decisions: [], hasMore: false })),
      decisionsForRuns: vi.fn(() => []),
      getDecision: vi.fn(() => undefined),
      createNotification: vi.fn((input: WorkspaceNotificationDto) => {
        const notification = {
          ...input,
          id: input.id ?? `notification-${notifications.length + 1}`,
          createdAt: input.createdAt ?? NOW,
        };
        notifications.push(notification);
        return notification;
      }),
      setNotificationStatus: vi.fn(),
    } as unknown as WorkspaceStore;
    const store = {
      listProjects: vi.fn(() => [{
        id: PROJECT_ID,
        label: "Project",
        hostPath: "/tmp/project",
        createdAt: NOW,
        defaultEngine: "codex",
      }]),
      listAgents: vi.fn(() => [{
        id: AGENT_ID,
        projectId: PROJECT_ID,
        title: "Agent",
        activeEngine: "codex",
        conversationIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      }]),
      getAgent: vi.fn(() => ({
        id: AGENT_ID,
        projectId: PROJECT_ID,
        title: "Agent",
        activeEngine: "codex",
        conversationIds: [],
        createdAt: NOW,
        updatedAt: NOW,
      })),
      getProjectArtifact: vi.fn(() => undefined),
      operatorCanReadProjectArtifact: vi.fn(() => false),
    } as unknown as AgentStore;
    const operational = createOperationalNotifications({
      store,
      coordinationV3: coordination,
      workspace,
      publishWorkspaceSince: vi.fn(),
    });

    operational.reconcileCommunicationFailureNotifications();
    operational.reconcileCoordinationAttentionNotifications();

    expect(notifications.map((notification) => notification.title)).toEqual([
      "Message outcome needs your review",
    ]);
    expect(notifications[0]?.body).toContain("Retrying may duplicate work");
  });

  it("reconciles every communication failure across bounded pages", () => {
    const failures = Array.from({ length: 501 }, (_, index) => ({
      id: `activation-${index.toString().padStart(3, "0")}`,
      projectId: PROJECT_ID,
      agentId: AGENT_ID,
      kind: "human_message",
      state: "failed" as const,
      communicationEventId: `communication-${index}`,
      communicationIntent: "user_dm",
      deliveryFailures: 1,
      updatedAt: NOW,
    })).reverse();
    const notifications: WorkspaceNotificationDto[] = [];
    const communicationAttentionActivations = vi.fn((
      _projectId: string | undefined,
      limit: number,
      cursor?: { updatedAt: string; id: string },
    ) => {
      const start = cursor
        ? failures.findIndex((failure) => failure.id === cursor.id) + 1
        : 0;
      return failures.slice(start, start + limit);
    });
    const coordination = {
      communicationAttentionActivations,
      terminalActivationDisposition: vi.fn(() => undefined),
    } as unknown as CoordinationV3Store;
    const workspace = {
      cursor: vi.fn(() => 0),
      listNotifications: vi.fn(() => notifications),
      createNotification: vi.fn((input: WorkspaceNotificationDto) => {
        const notification = {
          ...input,
          id: input.id ?? `notification-${notifications.length + 1}`,
          createdAt: input.createdAt ?? NOW,
        };
        notifications.push(notification);
        return notification;
      }),
      setNotificationStatus: vi.fn(),
    } as unknown as WorkspaceStore;
    const operational = createOperationalNotifications({
      store: { getConversation: vi.fn(() => undefined) } as unknown as AgentStore,
      coordinationV3: coordination,
      workspace,
      publishWorkspaceSince: vi.fn(),
    });

    operational.reconcileCommunicationFailureNotifications();

    expect(communicationAttentionActivations).toHaveBeenCalledTimes(2);
    expect(communicationAttentionActivations).toHaveBeenLastCalledWith(
      undefined,
      500,
      { updatedAt: NOW, id: "activation-001" },
    );
    expect(notifications).toHaveLength(501);
    expect(notifications.at(-1)?.dedupeKey).toBe(
      "communication-delivery:activation-000:failed",
    );
  });
});
