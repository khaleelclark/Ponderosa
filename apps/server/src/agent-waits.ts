import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentRunWakeCause, AgentWaitDto, AgentWaitMode } from "@ponderosa/core";
import type { CollaborationDelivery, CollaborationDeliveryStore } from "./handoffs.js";

export type AgentWaitStatus = "active" | "satisfied" | "cancelled" | "expired";

export interface AgentWaitCondition {
  id: string;
  agentId: string;
  executionId: string;
  mode: AgentWaitMode;
  expectedAgentIds: string[];
  quorum: number;
  deliveryWatermark: number;
  deadline?: string;
  status: AgentWaitStatus;
  createdAt: string;
  completedAt?: string;
  reason?: string;
}

type WaitRecord = { type: "wait" | "replace"; wait: AgentWaitCondition };

/** Append-only, restart-safe wait latches. Only one active latch may exist per agent. */
export class AgentWaitStore {
  private readonly file: string;
  private readonly waits = new Map<string, AgentWaitCondition>();
  private readonly activeByAgent = new Map<string, string>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "agent-waits.jsonl");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as WaitRecord;
      this.replaceInMemory(record.wait);
    }
  }

  private replaceInMemory(wait: AgentWaitCondition): void {
    const previous = this.waits.get(wait.id);
    if (previous?.status === "active" && this.activeByAgent.get(previous.agentId) === previous.id) {
      this.activeByAgent.delete(previous.agentId);
    }
    this.waits.set(wait.id, wait);
    if (wait.status === "active") this.activeByAgent.set(wait.agentId, wait.id);
  }

  private persist(wait: AgentWaitCondition, type: WaitRecord["type"]): AgentWaitCondition {
    appendFileSync(this.file, `${JSON.stringify({ type, wait } satisfies WaitRecord)}\n`, "utf8");
    this.replaceInMemory(wait);
    return wait;
  }

  active(agentId: string): AgentWaitCondition | undefined {
    const id = this.activeByAgent.get(agentId);
    return id ? this.waits.get(id) : undefined;
  }

  allActive(): AgentWaitCondition[] {
    return [...this.activeByAgent.values()].flatMap((id) => {
      const wait = this.waits.get(id);
      return wait ? [wait] : [];
    });
  }

  register(input: Omit<AgentWaitCondition, "id" | "status" | "createdAt" | "completedAt" | "reason">): { wait: AgentWaitCondition; replayed: boolean } {
    const existing = this.active(input.agentId);
    if (existing && existing.executionId === input.executionId && existing.mode === input.mode &&
      existing.quorum === input.quorum && existing.deadline === input.deadline &&
      JSON.stringify(existing.expectedAgentIds) === JSON.stringify(input.expectedAgentIds)) {
      return { wait: existing, replayed: true };
    }
    if (existing) this.finish(existing, "cancelled", "replaced by a newer wait condition");
    const wait: AgentWaitCondition = {
      ...input,
      id: randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
    };
    return { wait: this.persist(wait, "wait"), replayed: false };
  }

  finish(wait: AgentWaitCondition, status: Exclude<AgentWaitStatus, "active">, reason: string): AgentWaitCondition {
    if (wait.status !== "active") return wait;
    return this.persist({ ...wait, status, reason, completedAt: new Date().toISOString() }, "replace");
  }

  cancel(agentId: string, reason: string): AgentWaitCondition | undefined {
    const wait = this.active(agentId);
    return wait ? this.finish(wait, "cancelled", reason) : undefined;
  }

  progress(
    wait: AgentWaitCondition,
    pending: readonly CollaborationDelivery[],
    deliveries: CollaborationDeliveryStore,
  ): AgentWaitDto {
    const expected = new Set(wait.expectedAgentIds);
    const receivedAgentIds = [...new Set(pending.flatMap((delivery) =>
      deliveries.position(delivery.id) >= wait.deliveryWatermark &&
      (delivery.waitBehavior ?? "report") === "report" &&
      delivery.authorAgentId && expected.has(delivery.authorAgentId)
        ? [delivery.authorAgentId]
        : []))].sort();
    return {
      waitId: wait.id,
      mode: wait.mode,
      expectedAgentIds: wait.expectedAgentIds,
      receivedAgentIds,
      quorum: wait.quorum,
      ...(wait.deadline ? { deadline: wait.deadline } : {}),
      createdAt: wait.createdAt,
    };
  }

  /**
   * Decide whether queued deliveries must remain parked. Direct/user signals and
   * managed-agent failures override the latch. Expected authors are counted once.
   */
  evaluate(
    agentId: string,
    pending: readonly CollaborationDelivery[],
    deliveries: CollaborationDeliveryStore,
    now = Date.now(),
  ): { hold: boolean; wait?: AgentWaitCondition; wakeCause?: AgentRunWakeCause } {
    const wait = this.active(agentId);
    if (!wait) return { hold: false };
    if (wait.deadline && Date.parse(wait.deadline) <= now) {
      return { hold: false, wait: this.finish(wait, "expired", "deadline reached"), wakeCause: "wait_deadline" };
    }
    if (pending.some((delivery) => deliveries.position(delivery.id) < wait.deliveryWatermark)) {
      return {
        hold: false,
        wait: this.finish(wait, "cancelled", "delivery was already pending when the wait was registered"),
        wakeCause: "wait_interrupted",
      };
    }
    const newDeliveries = pending.filter((delivery) => deliveries.position(delivery.id) >= wait.deliveryWatermark);
    const priority = newDeliveries.find((delivery) =>
      delivery.kind === "direct" || delivery.kind === "manager_notification" || delivery.waitBehavior === "interrupt");
    if (priority) {
      return {
        hold: false,
        wait: this.finish(wait, "cancelled", "priority delivery override"),
        wakeCause: priority.kind === "direct"
          ? "direct_message"
          : priority.kind === "manager_notification"
            ? "managed_failure"
            : "wait_interrupted",
      };
    }
    const expected = new Set(wait.expectedAgentIds);
    const reporters = new Set(newDeliveries.flatMap((delivery) =>
      (delivery.waitBehavior ?? "report") === "report" &&
      delivery.authorAgentId && expected.has(delivery.authorAgentId) ? [delivery.authorAgentId] : []));
    const satisfied = wait.mode === "any"
      ? reporters.size >= 1
      : wait.mode === "all"
        ? reporters.size >= expected.size
        : reporters.size >= wait.quorum;
    if (satisfied) {
      return {
        hold: false,
        wait: this.finish(wait, "satisfied", `${reporters.size} expected reporters delivered`),
        wakeCause: "wait_satisfied",
      };
    }
    return { hold: true, wait };
  }

  deleteAgents(agentIds: ReadonlySet<string>): void {
    for (const [id, wait] of this.waits) {
      if (agentIds.has(wait.agentId)) {
        this.waits.delete(id);
        if (this.activeByAgent.get(wait.agentId) === id) this.activeByAgent.delete(wait.agentId);
      }
    }
    const records = readFileSync(this.file, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as WaitRecord)
      .filter((record) => !agentIds.has(record.wait.agentId));
    writeFileSync(this.file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  }
}
