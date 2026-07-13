import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  CancelAssignmentResponse,
  AgentDelegationRequest,
  AgentDelegationDispositionRequest,
  AssignmentEventEnvelope,
  AssignmentDto,
} from "@ponderosa/core";

interface RunRecord extends AssignmentDto {
  /** Internal lineage/context keys; never exposed as assignment identity. */
  parentRunId: string;
  rootRunId: string;
  contextSnapshotId: string;
  model?: string;
  effort?: string;
  contextSnapshot: {
    id: string;
    masterChatId: string;
    parentRunId: string;
    createdAt: string;
    messages: Array<{ id: string; role: string; text: string; authorThreadId?: string }>;
  };
  requestHash: string;
  idempotencyKey: string;
  dispositionIdempotencyKey?: string;
  dispositionRequestHash?: string;
}

type PersistedRecord =
  | { type: "run"; run: RunRecord }
  | { type: "replace"; run: RunRecord | AssignmentDto }
  | { type: "cancel"; key: string; response: CancelAssignmentResponse }
  | { type: "event"; envelope: AssignmentEventEnvelope };

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
const publicRun = ({ model: _model, effort: _effort, contextSnapshot: _snapshot, requestHash: _hash, idempotencyKey: _key, dispositionIdempotencyKey: _dispositionKey, dispositionRequestHash: _dispositionHash, parentRunId: _parentRunId, rootRunId: _rootRunId, contextSnapshotId: _contextSnapshotId, ...assignment }: RunRecord): AssignmentDto => assignment;
export const MAX_DELEGATION_DESCENDANTS = 100;
export const MAX_CONCURRENT_DELEGATIONS = 100;

interface SpawnResult {
  run: AssignmentDto;
  replayed: boolean;
}

type SpawnInput = Omit<AgentDelegationRequest, "runtime"> & {
  parentRunId: string;
  runtime: string;
};

export class DelegationStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly cancellations = new Map<string, CancelAssignmentResponse>();
  private readonly events: AssignmentEventEnvelope[] = [];
  private readonly listeners = new Set<(event: AssignmentEventEnvelope) => void>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "assignments.jsonl");
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

  private persistCancellation(key: string, response: CancelAssignmentResponse): void {
    appendFileSync(this.file, `${JSON.stringify({ type: "cancel", key, response })}\n`, "utf8");
    this.cancellations.set(key, response);
  }

  private emit(masterChatId: string, event: AssignmentEventEnvelope["event"]): void {
    const envelope: AssignmentEventEnvelope = {
      masterChatId,
      seq: (this.events.at(-1)?.seq ?? 0) + 1,
      ts: new Date().toISOString(),
      event,
    };
    appendFileSync(this.file, `${JSON.stringify({ type: "event", envelope })}\n`, "utf8");
    this.events.push(envelope);
    for (const listener of this.listeners) listener(envelope);
  }

  eventsSince(masterChatId: string, seq: number): AssignmentEventEnvelope[] {
    return this.events.filter((event) => event.masterChatId === masterChatId && event.seq > seq);
  }

  subscribe(listener: (event: AssignmentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(masterChatId: string): AssignmentDto[] {
    return [...this.runs.values()].filter((run) => run.masterChatId === masterChatId).map(publicRun);
  }

  all(): AssignmentDto[] {
    return [...this.runs.values()].map(publicRun);
  }

  forAgent(agentId: string): AssignmentDto[] {
    return [...this.runs.values()]
      .filter((assignment) => assignment.parentAgentId === agentId || assignment.childAgentId === agentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(publicRun);
  }

  deleteProject(masterChatIds: ReadonlySet<string>, threadIds: ReadonlySet<string>): void {
    const removedRunIds = new Set([...this.runs.values()]
      .filter((run) => masterChatIds.has(run.masterChatId) || threadIds.has(run.parentAgentId) || threadIds.has(run.childAgentId))
      .map((run) => run.id));
    for (const runId of removedRunIds) this.runs.delete(runId);
    for (const [key, runId] of this.idempotency) if (removedRunIds.has(runId)) this.idempotency.delete(key);
    for (const [key, response] of this.cancellations) if (removedRunIds.has(response.requestedAssignmentId)) this.cancellations.delete(key);
    const keptEvents = this.events.filter((event) => !masterChatIds.has(event.masterChatId));
    this.events.length = 0;
    this.events.push(...keptEvents);
    const records = readFileSync(this.file, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as PersistedRecord)
      .filter((record) => {
        if (record.type === "event") return !masterChatIds.has(record.envelope.masterChatId);
        if (record.type === "cancel") return !removedRunIds.has(record.response.requestedAssignmentId);
        return !removedRunIds.has(record.run.id);
      });
    writeFileSync(this.file, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  }

  get(runId: string): AssignmentDto | undefined {
    const run = this.runs.get(runId);
    return run ? publicRun(run) : undefined;
  }

  queued(): AssignmentDto[] {
    return [...this.runs.values()].filter((run) => run.status === "queued").map(publicRun);
  }

  findByChildThread(childThreadId: string): AssignmentDto | undefined {
    const run = [...this.runs.values()].find((candidate) => candidate.childAgentId === childThreadId);
    return run ? publicRun(run) : undefined;
  }

  reconcileInterrupted(): AssignmentDto[] {
    const recovered: AssignmentDto[] = [];
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
      this.emit(updated.masterChatId, { type: "assignment_updated", assignment: publicRun(updated) });
      recovered.push(publicRun(updated));
    }
    return recovered;
  }

  launchContext(runId: string): {
    prompt: string;
    runtime: string;
    model?: string;
    effort?: string;
    history: Array<{ role: "user" | "assistant"; text: string }>;
  } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      prompt: run.taskBriefMarkdown,
      runtime: run.runtime,
      model: run.model,
      effort: run.effort,
      history: run.contextSnapshot.messages.flatMap((message) =>
        message.role === "user" || message.role === "assistant"
          ? [{ role: message.role, text: message.text }]
          : [],
      ),
    };
  }

  finishRuntime(runId: string, message?: string): AssignmentDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("assignment_not_found", "subagent was not found", 404);
    if (run.status !== "running" && !(message && run.status === "queued")) return publicRun(run);
    const now = new Date().toISOString();
    const updated: RunRecord = {
      ...run,
      status: message ? "failed" : "awaiting_disposition",
      canCancel: !message,
      ...(message ? { finishedAt: now } : {}),
      updatedAt: now,
      version: run.version + 1,
      ...(message
        ? { failure: { code: "runtime_error", message, retryable: false, occurredAt: now } }
        : {}),
    };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "assignment_updated", assignment: publicRun(updated) });
    return publicRun(updated);
  }

  declareDisposition(runId: string, input: AgentDelegationDispositionRequest): AssignmentDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("assignment_not_found", "subagent was not found", 404);
    const requestHash = digest(JSON.stringify(input));
    if (run.dispositionIdempotencyKey === input.idempotencyKey) {
      if (run.dispositionRequestHash !== requestHash) throw new DelegationError("idempotency_conflict", "idempotency key was used with another disposition", 409);
      return publicRun(run);
    }
    if (run.disposition) throw new DelegationError("lifecycle_conflict", "delegated objective already has a disposition", 409);
    if (run.status !== "running" && run.status !== "awaiting_disposition") {
      throw new DelegationError("lifecycle_conflict", "delegated objective cannot be disposed in its current state", 409);
    }
    const now = new Date().toISOString();
    const updated: RunRecord = {
      ...run,
      status: input.outcome,
      canCancel: false,
      finishedAt: now,
      updatedAt: now,
      version: run.version + 1,
      disposition: { outcome: input.outcome, ...(input.message?.trim() ? { message: input.message.trim() } : {}), declaredAt: now },
      dispositionIdempotencyKey: input.idempotencyKey,
      dispositionRequestHash: requestHash,
    };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "assignment_updated", assignment: publicRun(updated) });
    return publicRun(updated);
  }

  setCompletionDelivery(
    runId: string,
    delivery: NonNullable<AssignmentDto["parentWake"]>,
  ): AssignmentDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("assignment_not_found", "subagent was not found", 404);
    const unchanged = JSON.stringify(run.parentWake) === JSON.stringify(delivery);
    if (unchanged) return publicRun(run);
    const updated: RunRecord = {
      ...run,
      parentWake: delivery,
      updatedAt: new Date().toISOString(),
      version: run.version + 1,
    };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "assignment_updated", assignment: publicRun(updated) });
    return publicRun(updated);
  }

  replay(masterChatId: string, input: SpawnInput): SpawnResult | undefined {
    const key = `${masterChatId}:${input.parentRunId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (!existing) return undefined;
    const run = this.runs.get(existing)!;
    const requestHash = digest(JSON.stringify(input));
    if (run.requestHash !== requestHash) throw new DelegationError("idempotency_conflict", "idempotency key was used with another request", 409);
    return { run: publicRun(run), replayed: true };
  }

  spawn(
    masterChatId: string,
    input: SpawnInput,
    parentIsRunning: boolean,
    contextMessages: Array<{ id: string; role: string; text: string; authorThreadId?: string }>,
    ownership: { projectId: string; parentAgentId: string; childAgentId: string },
  ): SpawnResult {
    const parent = this.runs.get(input.parentRunId);
    if (parent && parent.masterChatId !== masterChatId) throw new DelegationError("unauthorized_parent", "parent run belongs to another master chat", 403);
    if (!parent && !parentIsRunning) throw new DelegationError("parent_not_running", "parent run is not active", 409, true);
    if (parent && parent.status !== "running") throw new DelegationError("parent_not_running", "parent run is not running", 409, true);

    const replay = this.replay(masterChatId, input);
    if (replay) return replay;
    const requestHash = digest(JSON.stringify(input));
    const key = `${masterChatId}:${input.parentRunId}:${input.idempotencyKey}`;

    const depth = parent ? parent.depth + 1 : 1;
    if (depth > 3) throw new DelegationError("depth_limit_exceeded", "delegation depth limit exceeded", 409);
    const rootRunId = parent?.rootRunId ?? input.parentRunId;
    const descendants = [...this.runs.values()].filter((run) => run.rootRunId === rootRunId);
    const activeDescendants = descendants.filter((run) => run.status === "queued" || run.status === "running" || run.status === "awaiting_disposition");
    if (activeDescendants.length >= MAX_CONCURRENT_DELEGATIONS) {
      throw new DelegationError("concurrency_limit_exceeded", "delegation concurrency limit exceeded", 409, true);
    }
    if (descendants.length >= MAX_DELEGATION_DESCENDANTS) {
      throw new DelegationError("descendant_limit_exceeded", "descendant limit exceeded", 409);
    }

    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      projectId: ownership.projectId,
      masterChatId,
      parentAgentId: ownership.parentAgentId,
      childAgentId: ownership.childAgentId,
      parentExecutionId: input.parentRunId,
      childExecutionId: runId,
      ...(parent ? { parentAssignmentId: parent.id } : {}),
      rootAssignmentId: parent?.rootAssignmentId ?? runId,
      parentRunId: input.parentRunId,
      rootRunId,
      contextSnapshotId: randomUUID(),
      depth,
      version: 1,
      title: input.displayLabel.trim().slice(0, 100),
      taskBriefMarkdown: input.delegationPrompt,
      model: input.model,
      effort: input.effort,
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
    this.emit(masterChatId, { type: "assignment_created", assignment: publicRun(run) });
    return { run: publicRun(run), replayed: false };
  }

  claim(runId: string): AssignmentDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("assignment_not_found", "subagent was not found", 404);
    if (run.contextSnapshot.id !== run.contextSnapshotId || run.contextSnapshot.masterChatId !== run.masterChatId || run.contextSnapshot.parentRunId !== run.parentRunId) {
      throw new DelegationError("lifecycle_integrity", "server context snapshot ownership is invalid", 403);
    }
    if (run.status !== "queued") throw new DelegationError("parent_not_running", "delegated run is not queued", 409);
    const now = new Date().toISOString();
    const updated: RunRecord = { ...run, status: "running", startedAt: now, updatedAt: now, version: run.version + 1 };
    this.persist(updated, "replace");
    this.emit(updated.masterChatId, { type: "assignment_updated", assignment: publicRun(updated) });
    return publicRun(updated);
  }

  cancel(runId: string, idempotencyKey: string): CancelAssignmentResponse {
    if (!this.runs.has(runId)) throw new DelegationError("assignment_not_found", "subagent was not found", 404);
    const cancellationKey = `${runId}:${idempotencyKey}`;
    const replay = this.cancellations.get(cancellationKey);
    if (replay) return replay;
    const affected = [...this.runs.values()].filter((run) => run.id === runId || this.isDescendant(run, runId));
    const now = new Date().toISOString();
    const results = affected.map((run) => {
      const terminal = run.status === "completed" || run.status === "blocked" || run.status === "failed" || run.status === "cancelled";
      const updated: RunRecord = terminal ? run : { ...run, status: "cancelled", canCancel: false, finishedAt: now, updatedAt: now, version: run.version + 1 };
      if (!terminal) this.persist(updated, "replace");
      if (!terminal) this.emit(updated.masterChatId, { type: "assignment_updated", assignment: publicRun(updated) });
      return { assignmentId: updated.id, status: updated.status, version: updated.version, updatedAt: updated.updatedAt };
    });
    const response: CancelAssignmentResponse = { requestedAssignmentId: runId, scope: "branch", affected: results, completed: true };
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
