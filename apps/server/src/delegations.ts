import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CancelSubagentResponse,
  AgentDelegationRequest,
  SubagentEventEnvelope,
  SubagentRunDto,
} from "@ponderosa/core";

interface LegacyRegistrationRecord {
  id: string;
  credentialHash: string;
  expiresAt: string;
  consumedAt?: string;
  invalidatedAt?: string;
  runtime: string;
}

interface RunRecord extends SubagentRunDto {
  delegationPrompt: string;
  model?: string;
  contextSnapshot: {
    id: string;
    masterChatId: string;
    parentRunId: string;
    createdAt: string;
    messages: Array<{ id: string; role: string; text: string; authorThreadId?: string }>;
  };
  requestHash: string;
  idempotencyKey: string;
  /** Read only for backward compatibility with pre-bridge audit records. */
  registration?: LegacyRegistrationRecord;
}

type PersistedRecord =
  | { type: "run"; run: RunRecord }
  | { type: "replace"; run: RunRecord | SubagentRunDto }
  | { type: "cancel"; key: string; response: CancelSubagentResponse }
  | { type: "event"; envelope: SubagentEventEnvelope };

export class DelegationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const publicRun = ({ delegationPrompt: _prompt, model: _model, contextSnapshot: _snapshot, requestHash: _hash, idempotencyKey: _key, registration: _reg, ...run }: RunRecord): SubagentRunDto => run;

interface SpawnResult {
  run: SubagentRunDto;
  replayed: boolean;
}

export class DelegationStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly cancellations = new Map<string, CancelSubagentResponse>();
  private readonly events: SubagentEventEnvelope[] = [];
  private readonly listeners = new Set<(event: SubagentEventEnvelope) => void>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "delegations.jsonl");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as PersistedRecord;
      if (record.type === "cancel") {
        this.cancellations.set(record.key, record.response);
        continue;
      }
      if (record.type === "event") {
        this.events.push(record.envelope);
        continue;
      }
      const run = record.type === "replace"
        ? { ...this.runs.get(record.run.id), ...record.run } as RunRecord
        : record.run;
      this.runs.set(run.id, run);
      this.idempotency.set(`${run.masterChatId}:${run.parentRunId}:${run.idempotencyKey}`, run.id);
    }
  }

  private persist(run: RunRecord, type: "run" | "replace"): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const stored = type === "replace" ? publicRun(run) : run;
    appendFileSync(this.file, `${JSON.stringify({ type, run: stored })}\n`, "utf8");
    this.runs.set(run.id, run);
  }

  private persistCancellation(key: string, response: CancelSubagentResponse): void {
    appendFileSync(this.file, `${JSON.stringify({ type: "cancel", key, response })}\n`, "utf8");
    this.cancellations.set(key, response);
  }

  private emit(masterChatId: string, event: SubagentEventEnvelope["event"]): void {
    const envelope: SubagentEventEnvelope = {
      masterChatId,
      seq: (this.events.at(-1)?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      event,
    };
    appendFileSync(this.file, `${JSON.stringify({ type: "event", envelope })}\n`, "utf8");
    this.events.push(envelope);
    for (const listener of this.listeners) listener(envelope);
  }

  eventsSince(masterChatId: string, seq: number): SubagentEventEnvelope[] {
    return this.events.filter((event) => event.masterChatId === masterChatId && event.seq > seq);
  }

  subscribe(listener: (event: SubagentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(masterChatId: string): SubagentRunDto[] {
    return [...this.runs.values()].filter((run) => run.masterChatId === masterChatId).map(publicRun);
  }

  all(): SubagentRunDto[] {
    return [...this.runs.values()].map(publicRun);
  }

  get(runId: string): SubagentRunDto | undefined {
    const run = this.runs.get(runId);
    return run ? publicRun(run) : undefined;
  }

  queued(): SubagentRunDto[] {
    return [...this.runs.values()].filter((run) => run.status === "queued").map(publicRun);
  }

  findByChildThread(childThreadId: string): SubagentRunDto | undefined {
    const run = [...this.runs.values()].find((candidate) => candidate.childThreadId === childThreadId);
    return run ? publicRun(run) : undefined;
  }

  reconcileInterrupted(): SubagentRunDto[] {
    const recovered: SubagentRunDto[] = [];
    for (const run of [...this.runs.values()]) {
      if (run.status !== "running") continue;
      const now = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "failed",
        canCancel: false,
        finishedAt: now,
        updatedAt: now,
        version: run.version + 1,
        failure: {
          code: "runtime_interrupted",
          message: "delegated runtime was interrupted by a server restart",
          retryable: true,
          occurredAt: now,
        },
      };
      this.persist(updated, "replace");
      this.emit(updated.masterChatId, { type: "subagent_updated", run: publicRun(updated) });
      recovered.push(publicRun(updated));
    }
    return recovered;
  }

  bindChildThread(runId: string, childThreadId: string): SubagentRunDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    if (run.childThreadId && run.childThreadId !== childThreadId) {
      throw new DelegationError("lifecycle_conflict", "delegated child is already bound to another thread", 409);
    }
    if (run.childThreadId === childThreadId) return publicRun(run);
    const updated = { ...run, childThreadId, version: run.version + 1, updatedAt: new Date().toISOString() };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "subagent_updated", run: publicRun(updated) });
    return publicRun(updated);
  }

  rawPrompt(runId: string): string | undefined {
    return this.runs.get(runId)?.delegationPrompt;
  }

  launchContext(runId: string): {
    prompt: string;
    runtime: string;
    model?: string;
    history: Array<{ role: "user" | "assistant"; text: string }>;
  } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      prompt: run.delegationPrompt,
      runtime: run.runtime,
      model: run.model,
      history: run.contextSnapshot.messages.flatMap((message) =>
        message.role === "user" || message.role === "assistant"
          ? [{ role: message.role, text: message.text }]
          : [],
      ),
    };
  }

  settle(runId: string, status: "completed" | "failed", message?: string): SubagentRunDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") return publicRun(run);
    const now = new Date().toISOString();
    const updated: RunRecord = {
      ...run,
      status,
      canCancel: false,
      finishedAt: now,
      updatedAt: now,
      version: run.version + 1,
      ...(status === "failed"
        ? { failure: { code: "runtime_error", message: message ?? "delegated runtime failed", retryable: false, occurredAt: now } }
        : {}),
    };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "subagent_updated", run: publicRun(updated) });
    return publicRun(updated);
  }

  setCompletionDelivery(
    runId: string,
    delivery: NonNullable<SubagentRunDto["completionDelivery"]>,
  ): SubagentRunDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    const unchanged = JSON.stringify(run.completionDelivery) === JSON.stringify(delivery);
    if (unchanged) return publicRun(run);
    const updated: RunRecord = {
      ...run,
      completionDelivery: delivery,
      updatedAt: new Date().toISOString(),
      version: run.version + 1,
    };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "subagent_updated", run: publicRun(updated) });
    return publicRun(updated);
  }

  spawn(
    masterChatId: string,
    input: AgentDelegationRequest & { parentRunId: string },
    parentIsRunning: boolean,
    contextMessages: Array<{ id: string; role: string; text: string; authorThreadId?: string }>,
    parentThreadId?: string,
  ): SpawnResult {
    const parent = this.runs.get(input.parentRunId);
    if (parent && parent.masterChatId !== masterChatId) throw new DelegationError("unauthorized_parent", "parent run belongs to another master chat", 403);
    if (!parent && !parentIsRunning) throw new DelegationError("parent_not_running", "parent run is not active", 409, true);
    if (parent && parent.status !== "running") throw new DelegationError("parent_not_running", "parent run is not running", 409, true);

    const requestHash = digest(JSON.stringify(input));
    const key = `${masterChatId}:${input.parentRunId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      const run = this.runs.get(existing)!;
      if (run.requestHash !== requestHash) throw new DelegationError("idempotency_conflict", "idempotency key was used with another request", 409);
      return { run: publicRun(run), replayed: true };
    }

    const depth = parent ? parent.depth + 1 : 1;
    if (depth > 3) throw new DelegationError("depth_limit_exceeded", "delegation depth limit exceeded", 409);
    const rootRunId = parent?.rootRunId ?? input.parentRunId;
    const descendants = [...this.runs.values()].filter((run) => run.rootRunId === rootRunId);
    if (descendants.length >= 12) throw new DelegationError("descendant_limit_exceeded", "descendant limit exceeded", 409);
    if (descendants.filter((run) => run.status === "queued" || run.status === "running").length >= 4) {
      throw new DelegationError("concurrency_limit_exceeded", "delegation concurrency limit exceeded", 409, true);
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      masterChatId,
      ...(parentThreadId || parent?.childThreadId
        ? { parentThreadId: parentThreadId ?? parent?.childThreadId }
        : {}),
      parentRunId: input.parentRunId,
      rootRunId,
      contextSnapshotId: randomUUID(),
      depth,
      version: 1,
      displayLabel: input.displayLabel.trim().slice(0, 100),
      delegationSummary: input.displayLabel.trim().slice(0, 100),
      delegationPrompt: input.delegationPrompt,
      model: input.model,
      runtime: input.runtime,
      status: "queued",
      canCancel: true,
      createdAt: now,
      updatedAt: now,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      contextSnapshot: {
        id: "",
        masterChatId,
        parentRunId: input.parentRunId,
        createdAt: now,
        messages: contextMessages,
      },
    };
    run.contextSnapshot.id = run.contextSnapshotId;
    this.idempotency.set(key, runId);
    this.persist(run, "run");
    this.emit(masterChatId, { type: "subagent_spawned", run: publicRun(run) });
    return { run: publicRun(run), replayed: false };
  }

  claim(runId: string): SubagentRunDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    if (run.contextSnapshot.id !== run.contextSnapshotId || run.contextSnapshot.masterChatId !== run.masterChatId || run.contextSnapshot.parentRunId !== run.parentRunId) {
      throw new DelegationError("lifecycle_integrity", "server context snapshot ownership is invalid", 403);
    }
    if (run.status !== "queued") throw new DelegationError("parent_not_running", "delegated run is not queued", 409);
    const now = new Date().toISOString();
    const updated: RunRecord = { ...run, status: "running", startedAt: now, updatedAt: now, version: run.version + 1 };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "subagent_updated", run: publicRun(updated) });
    return publicRun(updated);
  }

  cancel(runId: string, idempotencyKey: string): CancelSubagentResponse {
    if (!this.runs.has(runId)) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    const cancellationKey = `${runId}:${idempotencyKey}`;
    const replay = this.cancellations.get(cancellationKey);
    if (replay) return replay;
    const affected = [...this.runs.values()].filter((run) => run.id === runId || this.isDescendant(run, runId));
    const now = new Date().toISOString();
    const results = affected.map((run) => {
      const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
      const updated: RunRecord = terminal ? run : { ...run, status: "cancelled", canCancel: false, finishedAt: now, updatedAt: now, version: run.version + 1 };
      if (!terminal) this.persist(updated, "replace");
      if (!terminal) this.emit(updated.masterChatId, { type: "subagent_updated", run: publicRun(updated) });
      return { runId: updated.id, status: updated.status, version: updated.version, updatedAt: updated.updatedAt };
    });
    const response: CancelSubagentResponse = { requestedRunId: runId, scope: "branch", affected: results, completed: true };
    this.persistCancellation(cancellationKey, response);
    return response;
  }

  private isDescendant(run: RunRecord, ancestorId: string): boolean {
    let parent = this.runs.get(run.parentRunId);
    while (parent) {
      if (parent.id === ancestorId) return true;
      parent = this.runs.get(parent.parentRunId);
    }
    return false;
  }
}
