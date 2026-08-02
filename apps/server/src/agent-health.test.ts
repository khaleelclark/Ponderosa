import { describe, expect, it } from "vitest";
import type { AgentDto, ProviderBlockedWorkDto } from "@ponderosa/core";
import { projectAgentHealth } from "./agent-health.js";

describe("projectAgentHealth provider recovery", () => {
  it("projects retained quota work as provider-blocked instead of idle", () => {
    const agent = {
      id: "manager",
      projectId: "project",
      conversationIds: [],
      title: "Manager",
      activeEngine: "codex",
      state: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      archived: false,
      managementPermissions: {
        allowAutomaticDescendantDeletion: false,
        allowAutomaticDescendantReorganization: false,
      },
    } satisfies AgentDto;
    const providerBlocked: ProviderBlockedWorkDto = {
      classification: "rate_limit",
      activationIds: ["activation-1"],
      retryEligible: true,
      blockedAt: "2026-08-01T00:01:00.000Z",
      nextRetryAt: "2026-08-01T00:03:00.000Z",
      deliveryFailures: 3,
    };
    expect(projectAgentHealth({
      scope: { type: "project", id: "project" },
      agents: [agent],
      activeRuns: new Map(),
      availability: () => "runnable",
      providerBlocked: () => providerBlocked,
      latestEvent: () => undefined,
      now: "2026-08-01T00:02:00.000Z",
    }).agents[0]).toMatchObject({
      agentId: "manager",
      status: "blocked",
      reason: "provider_capacity_unavailable",
      statusTimestamp: providerBlocked.blockedAt,
      providerBlocked,
    });
  });
});
