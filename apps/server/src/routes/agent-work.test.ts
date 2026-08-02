import { describe, expect, it } from "vitest";
import type { AgentDto, AgentWorkItemDto } from "@ponderosa/core";
import { AgentWorkProjection } from "./agent-work.js";

const at = "2026-08-01T00:00:00.000Z";

function record(input: Partial<AgentWorkItemDto> & Pick<AgentWorkItemDto, "id" | "recordId" | "kind" | "state">): AgentWorkItemDto {
  return {
    referenceIds: [input.recordId],
    title: input.kind,
    summary: input.kind,
    agentIds: [],
    relatedItemIds: [],
    createdAt: at,
    updatedAt: at,
    ...input,
  };
}

describe("AgentWorkProjection recovery summaries", () => {
  it("shows completed child results with manager synthesis pending", () => {
    const requestIds = Array.from({ length: 5 }, (_, index) => `request-${index + 1}`);
    const items: AgentWorkItemDto[] = [
      record({
        id: "activation:wake", recordId: "wake", kind: "activation", state: "retry_pending",
        agentIds: ["manager"], relatedItemIds: ["join:all"],
        providerRecovery: {
          classification: "capacity", activationIds: ["wake"], retryEligible: true,
          blockedAt: at, nextRetryAt: "2026-08-01T00:02:00.000Z", deliveryFailures: 2,
        },
      }),
      record({
        id: "join:all", recordId: "all", kind: "join", state: "satisfied",
        agentIds: ["manager"], relatedItemIds: ["activation:wake", ...requestIds.map((id) => `request:${id}`)],
        joinMemberRequestIds: requestIds,
      }),
      ...requestIds.map((id, index) => record({
        id: `request:${id}`, recordId: id, kind: "request", state: "completed",
        requesterAgentId: "manager", recipientAgentId: `child-${index + 1}`,
        agentIds: ["manager", `child-${index + 1}`],
        relatedItemIds: ["join:all", ...(index === 0 ? ["request:historical"] : [])],
      })),
      record({
        id: "request:historical", recordId: "historical", kind: "request", state: "completed",
        requesterAgentId: "manager", recipientAgentId: "child-1",
        agentIds: ["manager", "child-1"], relatedItemIds: ["request:request-1"],
      }),
    ];
    const agents = [
      { id: "manager", title: "Manager" },
      ...requestIds.map((_, index) => ({ id: `child-${index + 1}`, title: `Child ${index + 1}` })),
    ] as unknown as AgentDto[];
    const projection = new AgentWorkProjection(
      {
        listAgents: () => agents,
        getProjectArtifact: () => undefined,
        operatorCanReadProjectArtifact: () => false,
      },
      {
        agentWorkItems: () => ({ items, truncated: false }),
        agentWorkItemDetails: () => undefined,
        requestLifecycleDetails: () => undefined,
      },
      {
        listDecisionPage: () => ({ decisions: [], hasMore: false }),
        getDecision: () => undefined,
        decisionsForRuns: () => [],
      },
    );
    const result = projection.inspect({ projectId: "project" });
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({
      state: "active",
      summary: "5 child results are ready. Manager synthesis is pending because the provider is unavailable.",
      coordinationRecovery: {
        state: "synthesis_pending",
        classification: "capacity",
        retryEligible: true,
        activationIds: ["wake"],
        requestIds,
        joinIds: ["all"],
        completedChildResults: 5,
      },
    });
  });
});
