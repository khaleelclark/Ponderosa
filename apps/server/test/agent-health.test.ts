import { describe, expect, it } from "vitest";
import type { AgentDto } from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/agents";
import { projectAgentHealth } from "../src/agent-health.js";

const t0 = "2026-07-12T00:00:00.000Z";
const t1 = "2026-07-12T00:01:00.000Z";
const agent = (id: string): AgentDto => ({
  id, projectId: "project", conversationId: "master", conversationIds: ["master"],
  title: id, activeEngine: "codex", state: {}, createdAt: t0, updatedAt: t0, archived: false,
});
const event = (value: StoredLogEvent["event"], ts = t1): StoredLogEvent => ({ seq: 1, ts, event: value });

function project(options: {
  agents?: AgentDto[];
  active?: Map<string, { startedAt: string; executionId?: string; leaseExpiresAt?: string; ownershipState?: "running" | "stalled" | "cancelling" | "interrupted" }>;
  compacting?: Map<string, string>;
  waiting?: Map<string, string>;
  queued?: Record<string, Array<{ createdAt: string }>>;
  events?: Record<string, StoredLogEvent[]>;
} = {}) {
  return projectAgentHealth({
    scope: { type: "conversation", id: "master" },
    agents: options.agents ?? [agent("agent")],
    activeRuns: options.active ?? new Map(),
    compactingAgents: options.compacting ?? new Map(),
    activeWaits: options.waiting ?? new Map(),
    queuedDeliveries: (id) => options.queued?.[id] ?? [],
    events: (id) => options.events?.[id] ?? [],
    now: t1,
  });
}

describe("agent health projection", () => {
  it("projects idle", () => expect(project().agents[0]).toMatchObject({ status: "idle", statusTimestamp: t0, reason: "no_active_work" }));

  it("projects running from an active server run", () => {
    expect(project({ active: new Map([["agent", { startedAt: t1, executionId: "execution-1" }]]) }).agents[0])
      .toMatchObject({
        status: "running", statusTimestamp: t1, reason: "active_run",
        runtimeActivity: { state: "responding", executionId: "execution-1", startedAt: t1 },
      });
  });

  it("projects stalled and interrupted runtime ownership without calling either orphaned", () => {
    expect(project({ active: new Map([["agent", { startedAt: t1, ownershipState: "stalled" }]]) }).agents[0])
      .toMatchObject({ status: "stalled", reason: "runtime_event_consumer_stalled", runtimeOwnership: "stalled" });
    expect(project({ active: new Map([["agent", { startedAt: t1, executionId: "stalled", ownershipState: "stalled" }]]) }).agents[0]?.runtimeActivity)
      .toBeUndefined();
    expect(project({ active: new Map([["agent", { startedAt: t1, ownershipState: "interrupted" }]]) }).agents[0])
      .toMatchObject({ status: "interrupted", reason: "execution_interrupted", runtimeOwnership: "interrupted" });
    expect(project({ active: new Map([["agent", { startedAt: t1, executionId: "old", ownershipState: "interrupted" }]]) }).agents[0]?.runtimeActivity)
      .toBeUndefined();
  });

  it("surfaces execution identity and marks an expired lease blocked", () => {
    expect(project({ active: new Map([[
      "agent", { startedAt: t0, executionId: "execution-1", leaseExpiresAt: "2026-07-12T00:00:30.000Z" },
    ]]) }).agents[0]).toMatchObject({
      status: "blocked", reason: "execution_lease_expired", executionId: "execution-1",
      leaseExpiresAt: "2026-07-12T00:00:30.000Z",
    });
  });

  it("projects waiting from task approval and durable delivery", () => {
    expect(project({ active: new Map([["agent", { startedAt: t0 }]]), events: { agent: [event({ type: "work_item_update", workItemId: "item", status: "waiting_approval" })] } }).agents[0]?.reason).toBe("work_item_waiting_approval");
    expect(project({ waiting: new Map([["agent", t1]]) }).agents[0]).toMatchObject({ status: "waiting", statusTimestamp: t1, reason: "awaiting_reports" });
    expect(project({ queued: { agent: [{ createdAt: t1 }] } }).agents[0]?.reason).toBe("queued_delivery");
  });

  it("returns completed work to idle and preserves failures", () => {
    expect(project({ events: { agent: [event({ type: "turn_done" })] } }).agents[0]).toMatchObject({ status: "idle", reason: "turn_completed" });
    expect(project({ events: { agent: [event({ type: "agent_lifecycle", status: "completed", reason: "turn_completed", executionId: "run" })] } }).agents[0]).toMatchObject({ status: "idle", reason: "turn_completed" });
    expect(project({ events: { agent: [event({ type: "error", message: "boom" })] } }).agents[0]?.status).toBe("failed");
  });

  it("reports stable direct parent and child IDs within scope", () => {
    const result = project({ agents: [agent("parent"), { ...agent("child"), managerAgentId: "parent" }] });
    expect(result.agents.find((agent) => agent.agentId === "parent")?.childAgentIds).toEqual(["child"]);
    expect(result.agents.find((agent) => agent.agentId === "child")?.managerAgentId).toBe("parent");
  });

  it("projects compacting only during an observed scheduled rollover", () => {
    expect(project({ active: new Map([["agent", { startedAt: t0 }]]), compacting: new Map([["agent", t1]]) }).agents[0])
      .toMatchObject({ status: "compacting", statusTimestamp: t1, reason: "session_rollover_scheduled" });
    expect(project().agents.map((agent) => agent.status)).not.toContain("compacting");
  });

  it("preserves ordinary cancellation from a durable lifecycle event", () => {
    expect(project({ events: { agent: [event({ type: "agent_lifecycle", status: "cancelled", reason: "agent_cancelled", executionId: "run" })] } }).agents[0])
      .toMatchObject({ status: "cancelled", reason: "agent_cancelled" });
  });

  it("projects a thousand-agent organization without per-agent polling", () => {
    const agents = Array.from({ length: 1_000 }, (_, index) => agent(`agent-${String(index).padStart(4, "0")}`));
    const result = project({ agents });
    expect(result.agents).toHaveLength(1_000);
    expect(result.agents.every((agent) => agent.status === "idle")).toBe(true);
    expect(result.agents[0]?.agentId).toBe("agent-0000");
    expect(result.agents.at(-1)?.agentId).toBe("agent-0999");
  });
});
