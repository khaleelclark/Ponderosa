import { describe, expect, it } from "vitest";
import type { SubagentRunDto, ThreadDto } from "@ponderosa/core";
import type { StoredLogEvent } from "@ponderosa/threads";
import { projectAgentHealth } from "../src/agent-health.js";

const t0 = "2026-07-12T00:00:00.000Z";
const t1 = "2026-07-12T00:01:00.000Z";
const thread = (id: string): ThreadDto => ({
  id, projectId: "project", masterChatId: "master", masterChatIds: ["master"],
  title: id, activeEngine: "codex", state: {}, createdAt: t0, updatedAt: t0, archived: false,
});
const delegation = (childThreadId: string, status: SubagentRunDto["status"], parentThreadId = "parent"): SubagentRunDto => ({
  id: `run-${childThreadId}`, masterChatId: "master", parentThreadId, childThreadId,
  parentRunId: "parent-run", rootRunId: "parent-run", contextSnapshotId: "snapshot",
  depth: 1, version: 1, displayLabel: childThreadId, delegationSummary: childThreadId,
  runtime: "codex", status, canCancel: status === "queued" || status === "running",
  createdAt: t0, updatedAt: t1, ...(status === "running" ? { startedAt: t1 } : {}),
  ...(["blocked", "cancelled", "completed", "failed"].includes(status) ? { finishedAt: t1 } : {}),
  ...(status === "failed" ? { failure: { code: "runtime_error", message: "boom", retryable: false, occurredAt: t1 } } : {}),
});
const event = (value: StoredLogEvent["event"], ts = t1): StoredLogEvent => ({ seq: 1, ts, event: value });

function project(options: {
  threads?: ThreadDto[];
  runs?: SubagentRunDto[];
  active?: Map<string, { startedAt: string }>;
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
    expect(project({ active: new Map([["agent", { startedAt: t1 }]]) }).agents[0])
      .toMatchObject({ status: "running", statusTimestamp: t1, reason: "active_run" });
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
    ["completed", "delegation_completed"],
    ["failed", "delegation_failed"],
  ] as const)("projects %s from the delegation ledger", (status, reason) => {
    expect(project({ runs: [delegation("agent", status)] }).agents[0]).toMatchObject({ status, reason, statusTimestamp: t1 });
  });

  it("projects completed and failed from canonical runtime events", () => {
    expect(project({ events: { agent: [event({ type: "turn_done" })] } }).agents[0]?.status).toBe("completed");
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
