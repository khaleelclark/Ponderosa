import { describe, expect, it } from "vitest";
import type { AssignmentDto, ThreadDto } from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/threads";
import { projectAgentHealth } from "../src/agent-health.js";

const t0 = "2026-07-12T00:00:00.000Z";
const t1 = "2026-07-12T00:01:00.000Z";
const thread = (id: string): ThreadDto => ({
  id, projectId: "project", masterChatId: "master", masterChatIds: ["master"],
  title: id, activeEngine: "codex", state: {}, createdAt: t0, updatedAt: t0, archived: false,
});
const delegation = (childAgentId: string, status: AssignmentDto["status"], parentAgentId = "parent"): AssignmentDto => ({
  id: `assignment-${childAgentId}`, projectId: "project", masterChatId: "master", parentAgentId, childAgentId,
  parentExecutionId: "parent-execution", childExecutionId: `execution-${childAgentId}`, rootAssignmentId: `assignment-${childAgentId}`,
  depth: 1, version: 1, title: childAgentId, taskBriefMarkdown: `# ${childAgentId}`,
  runtime: "codex", status, canCancel: status === "queued" || status === "running",
  createdAt: t0, updatedAt: t1, ...(status === "running" ? { startedAt: t1 } : {}),
  ...(["blocked", "cancelled", "completed", "failed"].includes(status) ? { finishedAt: t1 } : {}),
  ...(status === "failed" ? { failure: { code: "runtime_error", message: "boom", retryable: false, occurredAt: t1 } } : {}),
});
const event = (value: StoredLogEvent["event"], ts = t1): StoredLogEvent => ({ seq: 1, ts, event: value });

function project(options: {
  threads?: ThreadDto[];
  runs?: AssignmentDto[];
  active?: Map<string, { startedAt: string; executionId?: string; leaseExpiresAt?: string; ownershipState?: "running" | "stalled" | "cancelling" | "interrupted" }>;
  compacting?: Map<string, string>;
  queued?: Record<string, Array<{ createdAt: string }>>;
  events?: Record<string, StoredLogEvent[]>;
} = {}) {
  return projectAgentHealth({
    scope: { type: "master_chat", id: "master" },
    threads: options.threads ?? [thread("agent")],
    delegations: options.runs ?? [],
    activeRuns: options.active ?? new Map(),
    compactingAgents: options.compacting ?? new Map(),
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

  it("projects waiting from task approval, durable delivery, and delegation states", () => {
    expect(project({ active: new Map([["agent", { startedAt: t0 }]]), events: { agent: [event({ type: "task_update", taskId: "task", status: "waiting_approval" })] } }).agents[0]?.reason).toBe("task_waiting_approval");
    expect(project({ queued: { agent: [{ createdAt: t1 }] } }).agents[0]?.reason).toBe("queued_delivery");
    expect(project({ runs: [delegation("agent", "queued")] }).agents[0]?.reason).toBe("delegation_queued");
    expect(project({ runs: [delegation("agent", "awaiting_disposition")] }).agents[0]?.reason).toBe("delegation_awaiting_disposition");
  });

  it.each([
    ["blocked", "delegation_blocked"],
    ["cancelled", "delegation_cancelled"],
    ["failed", "delegation_failed"],
  ] as const)("projects %s from the delegation ledger", (status, reason) => {
    expect(project({ runs: [delegation("agent", status)] }).agents[0]).toMatchObject({ status, reason, statusTimestamp: t1 });
  });

  it("returns completed work to idle and preserves failures", () => {
    expect(project({ runs: [delegation("agent", "completed")] }).agents[0]).toMatchObject({ status: "idle", reason: "delegation_completed" });
    expect(project({ events: { agent: [event({ type: "turn_done" })] } }).agents[0]).toMatchObject({ status: "idle", reason: "turn_completed" });
    expect(project({ events: { agent: [event({ type: "agent_lifecycle", status: "completed", reason: "turn_completed" })] } }).agents[0]).toMatchObject({ status: "idle", reason: "turn_completed" });
    expect(project({ events: { agent: [event({ type: "error", message: "boom" })] } }).agents[0]?.status).toBe("failed");
  });

  it("reports stable direct parent and child IDs within scope", () => {
    const result = project({ threads: [thread("parent"), thread("child")], runs: [delegation("child", "completed")] });
    expect(result.agents.find((agent) => agent.agentId === "parent")?.childAgentIds).toEqual(["child"]);
    expect(result.agents.find((agent) => agent.agentId === "child")?.parentAgentId).toBe("parent");
  });

  it("projects compacting only during an observed scheduled rollover", () => {
    expect(project({ active: new Map([["agent", { startedAt: t0 }]]), compacting: new Map([["agent", t1]]) }).agents[0])
      .toMatchObject({ status: "compacting", statusTimestamp: t1, reason: "session_rollover_scheduled" });
    expect(project().agents.map((agent) => agent.status)).not.toContain("compacting");
  });

  it("preserves ordinary cancellation from a durable lifecycle event", () => {
    expect(project({ events: { agent: [event({ type: "agent_lifecycle", status: "cancelled", reason: "thread_cancelled" })] } }).agents[0])
      .toMatchObject({ status: "cancelled", reason: "thread_cancelled" });
  });

  it("projects a thousand-agent organization without per-agent polling", () => {
    const threads = Array.from({ length: 1_000 }, (_, index) => thread(`agent-${String(index).padStart(4, "0")}`));
    const result = project({ threads });
    expect(result.agents).toHaveLength(1_000);
    expect(result.agents.every((agent) => agent.status === "idle")).toBe(true);
    expect(result.agents[0]?.agentId).toBe("agent-0000");
    expect(result.agents.at(-1)?.agentId).toBe("agent-0999");
  });
});
