import type { WorkspaceNotificationDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { scopedAttention } from "../src/attention";

function issue(overrides: Partial<WorkspaceNotificationDto> = {}): WorkspaceNotificationDto {
  return {
    id: "issue-1",
    projectId: "project-1",
    conversationId: "chat-a",
    conversationIds: ["chat-a", "chat-b"],
    agentId: "manager",
    agentIds: ["manager", "worker"],
    kind: "operational",
    category: "coordination",
    severity: "attention",
    status: "open",
    title: "Worker's assignment needs a decision",
    body: "Ponderosa could not confirm the result.",
    createdAt: "2026-07-23T00:00:00.000Z",
    resolution: {
      kind: "coordination_request",
      traceId: "trace-1",
      requestId: "request-1",
      recipientAgentId: "worker",
      recipientTitle: "Worker",
      assignment: "Verify the release",
      outcome: "outcome_unknown",
      retryAvailable: true,
    },
    ...overrides,
  };
}

describe("current issue scoping", () => {
  it("shows one issue in every Project chat containing an affected Agent", () => {
    const notification = issue();

    expect(scopedAttention([notification], {
      projectId: "project-1",
      conversationId: "chat-b",
      conversationAgentIds: ["worker"],
    })).toEqual([notification]);
    expect(scopedAttention([notification], {
      projectId: "project-1",
      conversationId: "chat-c",
      conversationAgentIds: ["manager"],
    })).toEqual([notification]);
    expect(scopedAttention([notification], { projectId: "project-1", agentId: "worker" })).toEqual([notification]);
  });

  it("excludes resolved issues and unrelated conversations", () => {
    expect(scopedAttention([issue()], {
      projectId: "project-1",
      conversationId: "chat-c",
      conversationAgentIds: ["other-agent"],
    })).toEqual([]);
    expect(scopedAttention([issue({ status: "resolved" })], {
      projectId: "project-1",
      conversationId: "chat-a",
      conversationAgentIds: ["worker"],
    })).toEqual([]);
  });
});
