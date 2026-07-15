import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeOwnershipState = "running" | "stalled" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunClaim {
  agentId: string;
  runId: string;
  generation: number;
  state: RuntimeOwnershipState;
  createdAt: string;
  updatedAt: string;
  lastEventReceivedAt?: string;
  lastEventPersistedAt?: string;
  deliveryIds?: string[];
  /** Reserved for the Phase 2 supervisor; absent claims make no process-liveness assertion. */
  pid?: number;
  pgid?: number;
  processStartTime?: string;
}

type StopReceipt = { agentId: string; idempotencyKey: string; cancelled: boolean; createdAt: string };
type RunRecord = { type: "claim" | "transition"; claim: RunClaim } | { type: "stop"; receipt: StopReceipt };
export type RunFence = Pick<RunClaim, "agentId" | "runId" | "generation">;

/** Append-only evidence backing the server's authoritative ActiveRun CAS. */
export class RunLedger {
  private readonly file: string;
  private readonly claims = new Map<string, RunClaim>();
  private readonly stopReceipts = new Map<string, StopReceipt>();

  constructor(dataDir: string, now: () => string = () => new Date().toISOString()) {
    this.file = path.join(dataDir, "runtime-runs.jsonl");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    const contents = readFileSync(this.file, "utf8");
    const lines = contents.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      let record: RunRecord;
      try {
        record = JSON.parse(line) as RunRecord;
      } catch (error) {
        const isTornTail = index === lines.length - 1 && !contents.endsWith("\n");
        if (!isTornTail) throw error;
        const completeLength = contents.lastIndexOf("\n") + 1;
        writeFileSync(this.file, contents.slice(0, completeLength), { encoding: "utf8", mode: 0o600 });
        break;
      }
      if (record.type === "stop") this.stopReceipts.set(`${record.receipt.agentId}\0${record.receipt.idempotencyKey}`, record.receipt);
      else this.claims.set(record.claim.agentId, record.claim);
    }
    for (const claim of [...this.claims.values()]) {
      if (["running", "stalled", "cancelling"].includes(claim.state)) {
        this.persist({ ...claim, state: "interrupted", updatedAt: now() }, "transition");
      }
    }
  }

  current(agentId: string): RunClaim | undefined { return this.claims.get(agentId); }
  all(): RunClaim[] { return [...this.claims.values()]; }

  stopReceipt(agentId: string, idempotencyKey: string): StopReceipt | undefined {
    return this.stopReceipts.get(`${agentId}\0${idempotencyKey}`);
  }

  rememberStop(agentId: string, idempotencyKey: string, cancelled: boolean, createdAt = new Date().toISOString()): StopReceipt {
    const receipt: StopReceipt = { agentId, idempotencyKey, cancelled, createdAt };
    appendFileSync(this.file, `${JSON.stringify({ type: "stop", receipt } satisfies RunRecord)}\n`, "utf8");
    this.stopReceipts.set(`${agentId}\0${idempotencyKey}`, receipt);
    return receipt;
  }

  claim(agentId: string, runId: string, deliveryIds?: string[], now = new Date().toISOString()): RunClaim {
    const current = this.claims.get(agentId);
    if (current && ["running", "stalled", "cancelling"].includes(current.state)) throw new Error("agent already has durable runtime ownership");
    return this.persist({
      agentId, runId, generation: (current?.generation ?? 0) + 1,
      state: "running", createdAt: now, updatedAt: now,
      ...(deliveryIds?.length ? { deliveryIds: [...deliveryIds] } : {}),
    }, "claim");
  }

  owns(fence: RunFence): boolean {
    const current = this.claims.get(fence.agentId);
    return current?.runId === fence.runId && current.generation === fence.generation &&
      ["running", "stalled", "cancelling"].includes(current.state);
  }

  transition(fence: RunFence, state: RuntimeOwnershipState, patch: Partial<RunClaim> = {}): RunClaim | undefined {
    if (!this.owns(fence)) return undefined;
    const current = this.claims.get(fence.agentId)!;
    return this.persist({ ...current, ...patch, ...fence, state, updatedAt: patch.updatedAt ?? new Date().toISOString() }, "transition");
  }

  deleteAgents(agentIds: ReadonlySet<string>): void {
    for (const agentId of agentIds) this.claims.delete(agentId);
    for (const key of this.stopReceipts.keys()) if (agentIds.has(key.split("\0", 1)[0]!)) this.stopReceipts.delete(key);
    const records = readFileSync(this.file, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as RunRecord)
      .filter((record) => record.type === "stop" ? !agentIds.has(record.receipt.agentId) : !agentIds.has(record.claim.agentId));
    writeFileSync(this.file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  }

  private persist(claim: RunClaim, type: "claim" | "transition"): RunClaim {
    appendFileSync(this.file, `${JSON.stringify({ type, claim } satisfies RunRecord)}\n`, "utf8");
    this.claims.set(claim.agentId, claim);
    return claim;
  }
}
