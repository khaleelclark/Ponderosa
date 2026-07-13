import { describe, expect, it } from "vitest";
import { deriveCommunicationBehavior, type CommunicationEvent } from "@ponderosa/core";

const base = {
  schemaVersion: 2 as const,
  projectId: "project-1",
  conversationId: "conversation-1",
  createdAt: "2026-07-13T00:00:00.000Z",
  text: "Hello",
};

describe("V1 communication behavior matrix", () => {
  it("keeps broadcast durable and organizational without triggering agents", () => {
    const event: CommunicationEvent = {
      ...base,
      eventId: "broadcast",
      sender: { kind: "agent", agentId: "agent-a", executionId: "run-a" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: base.projectId },
    };

    expect(deriveCommunicationBehavior(event)).toEqual({
      contextPolicy: "organizational",
      projectionTargets: [
        { surface: "conversation", projectionKey: base.conversationId },
        { surface: "direct_agent_audit", projectionKey: "agent-a" },
      ],
      deliveryRecipients: [],
      runTriggerAgentIds: [],
      permitsLegacyUserBroadcastRunAudit: false,
    });
  });

  it("keeps the pre-RunTrigger user-broadcast audit bridge explicit and non-delivering", () => {
    const event: CommunicationEvent = {
      ...base,
      eventId: "user-broadcast",
      sender: { kind: "user", userId: "user-1" },
      intent: "broadcast",
      audience: { kind: "organization", organizationId: base.projectId },
    };

    expect(deriveCommunicationBehavior(event)).toEqual({
      contextPolicy: "organizational",
      projectionTargets: [{ surface: "conversation", projectionKey: base.conversationId }],
      deliveryRecipients: [],
      runTriggerAgentIds: [],
      permitsLegacyUserBroadcastRunAudit: true,
    });
  });

  it("routes a user DM only to its explicit agent and the local user audit", () => {
    const event: CommunicationEvent = {
      ...base,
      eventId: "user-dm",
      sender: { kind: "user", userId: "user-1" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "user-1", agentId: "agent-a" },
    };

    expect(deriveCommunicationBehavior(event)).toEqual({
      contextPolicy: "local_only",
      projectionTargets: [
        { surface: "conversation", projectionKey: base.conversationId },
        { surface: "direct_agent_audit", projectionKey: "agent-a" },
        { surface: "agent_inbox", projectionKey: "agent-a" },
        { surface: "user_inbox", projectionKey: "user-1" },
      ],
      deliveryRecipients: [{ kind: "agent", agentId: "agent-a" }],
      runTriggerAgentIds: ["agent-a"],
      permitsLegacyUserBroadcastRunAudit: false,
    });
  });

  it("does not turn an agent reply to the user into a self-delivery or run", () => {
    const event: CommunicationEvent = {
      ...base,
      eventId: "agent-dm",
      sender: { kind: "agent", agentId: "agent-a", executionId: "run-a" },
      intent: "user_dm",
      audience: { kind: "user_agent", userId: "user-1", agentId: "agent-a" },
    };

    expect(deriveCommunicationBehavior(event)).toEqual({
      contextPolicy: "local_only",
      projectionTargets: [
        { surface: "conversation", projectionKey: base.conversationId },
        { surface: "direct_agent_audit", projectionKey: "agent-a" },
        { surface: "user_inbox", projectionKey: "user-1" },
      ],
      deliveryRecipients: [{ kind: "user", userId: "user-1" }],
      runTriggerAgentIds: [],
      permitsLegacyUserBroadcastRunAudit: false,
    });
  });

  it("projects collaboration to the team and participant audits, then triggers recipients only", () => {
    const event: CommunicationEvent = {
      ...base,
      eventId: "collaboration",
      sender: { kind: "agent", agentId: "agent-a", executionId: "run-a" },
      intent: "collaboration",
      audience: { kind: "agents", agentIds: ["agent-c", "agent-b", "agent-c"] },
    };

    expect(deriveCommunicationBehavior(event)).toEqual({
      contextPolicy: "local_only",
      projectionTargets: [
        { surface: "collaboration_view", projectionKey: base.conversationId },
        { surface: "direct_agent_audit", projectionKey: "agent-a" },
        { surface: "direct_agent_audit", projectionKey: "agent-b" },
        { surface: "agent_inbox", projectionKey: "agent-b" },
        { surface: "direct_agent_audit", projectionKey: "agent-c" },
        { surface: "agent_inbox", projectionKey: "agent-c" },
      ],
      deliveryRecipients: [
        { kind: "agent", agentId: "agent-b" },
        { kind: "agent", agentId: "agent-c" },
      ],
      runTriggerAgentIds: ["agent-b", "agent-c"],
      permitsLegacyUserBroadcastRunAudit: false,
    });
  });

  it("replays V1 direct-to-user placement without widening its context", () => {
    const event: CommunicationEvent = {
      ...base,
      schemaVersion: 1,
      eventId: "legacy-direct",
      sender: { kind: "agent", agentId: "agent-a" },
      intent: "direct_to_user",
      audience: { kind: "user", userId: "user-1" },
    };

    expect(deriveCommunicationBehavior(event)).toEqual({
      contextPolicy: "local_only",
      projectionTargets: [
        { surface: "conversation", projectionKey: base.conversationId },
        { surface: "collaboration_view", projectionKey: base.conversationId },
        { surface: "direct_agent_audit", projectionKey: "agent-a" },
        { surface: "user_inbox", projectionKey: "user-1" },
      ],
      deliveryRecipients: [{ kind: "user", userId: "user-1" }],
      runTriggerAgentIds: [],
      permitsLegacyUserBroadcastRunAudit: false,
    });
  });
});
