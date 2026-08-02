import type { AgentDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { projectAgentHealth } from "../src/agent-health.js";

const agent: AgentDto = {
  id: "apostle-islands",
  projectId: "project-1",
  conversationIds: [],
  title: "Apostle Islands",
  activeEngine: "codex",
  state: {},
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
};

function health(input: {
  availability?: "running" | "runnable" | "waiting" | "idle";
  pendingDecisionAt?: string;
  active?: boolean;
  latestStatus?: "waiting" | "completed" | "failed" | "cancelled";
}) {
  return projectAgentHealth({
    scope: { type: "project", id: agent.projectId },
    agents: [agent],
    activeRuns: input.active
      ? new Map([[agent.id, { startedAt: "2026-08-01T11:00:00.000Z", executionId: "run-1" }]])
      : new Map(),
    availability: () => input.availability ?? "idle",
    pendingDecisionAt: () => input.pendingDecisionAt,
    latestEvent: () => input.latestStatus ? {
      status: input.latestStatus,
      statusTimestamp: "2026-08-01T10:30:00.000Z",
      reason: input.latestStatus === "waiting"
        ? "work_item_waiting_approval"
        : input.latestStatus === "completed"
          ? "turn_completed"
          : input.latestStatus === "cancelled"
            ? "agent_cancelled"
            : "runtime_error",
    } : undefined,
    now: "2026-08-01T12:00:00.000Z",
  }).agents[0];
}

describe("canonical Agent operational health", () => {
  it("does not resurrect stale waiting or completed lifecycle events", () => {
    expect(health({ latestStatus: "waiting" })).toMatchObject({ status: "idle", reason: "no_active_work" });
    expect(health({ latestStatus: "completed" })).toMatchObject({ status: "idle", reason: "no_active_work" });
  });

  it("distinguishes an open dependency from an actionable Activation", () => {
    expect(health({ availability: "waiting" })).toMatchObject({ status: "waiting", reason: "awaiting_reports" });
    expect(health({ availability: "runnable" })).toMatchObject({ status: "idle", reason: "queued_delivery" });
  });

  it("shows only currently pending Decisions as needing a decision", () => {
    expect(health({ active: true, pendingDecisionAt: "2026-08-01T11:30:00.000Z" })).toMatchObject({
      status: "needs_decision",
      statusTimestamp: "2026-08-01T11:30:00.000Z",
      reason: "pending_user_decision",
      runtimeActivity: { executionId: "run-1" },
    });
    expect(health({ active: true })).toMatchObject({ status: "running", reason: "active_run" });
  });

  it("retains legitimate terminal failure and cancellation presentation", () => {
    expect(health({ latestStatus: "failed" })).toMatchObject({ status: "failed", reason: "runtime_error" });
    expect(health({ latestStatus: "cancelled" })).toMatchObject({ status: "cancelled", reason: "agent_cancelled" });
  });
});
