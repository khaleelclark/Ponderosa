import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CancelSubagentResponse,
  ClaimSubagentRegistrationRequest,
  SpawnSubagentRequest,
  SpawnSubagentResponse,
  SubagentEventEnvelope,
  SubagentRunDto,
  SubagentTranscriptPageDto,
} from "@ponderosa/core";

interface RegistrationRecord {
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
  registration: RegistrationRecord;
}

type PersistedRecord =
  | { type: "run"; run: RunRecord }
  | { type: "replace"; run: RunRecord }
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
      const { run } = record;
      this.runs.set(run.id, run);
      this.idempotency.set(`${run.masterChatId}:${run.parentRunId}:${run.idempotencyKey}`, run.id);
    }
  }

  private persist(run: RunRecord, type: PersistedRecord["type"]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ type, run })}\n`, "utf8");
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

  appendOutput(runId: string, text: string): SubagentEventEnvelope {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    const chunkSeq = this.events.filter((item) => item.event.type === "subagent_output" && item.event.runId === runId).length + 1;
    this.emit(run.masterChatId, { type: "subagent_output", runId, runVersion: run.version, chunkSeq, cursor: String(chunkSeq), delta: text });
    return this.events.at(-1)!;
  }

  transcript(runId: string, after: string | undefined, limit: number): SubagentTranscriptPageDto {
    if (!this.runs.has(runId)) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    const start = after ? Number(after) : 0;
    const all = this.events.flatMap((item) => item.event.type === "subagent_output" && item.event.runId === runId
      ? [{ chunkSeq: item.event.chunkSeq, cursor: item.event.cursor, ts: item.ts, text: item.event.delta }]
      : []).filter((item) => item.chunkSeq > start);
    const items = all.slice(0, limit);
    return { runId, items, nextCursor: items.at(-1)?.cursor, hasMore: all.length > items.length };
  }

  list(masterChatId: string): SubagentRunDto[] {
    return [...this.runs.values()].filter((run) => run.masterChatId === masterChatId).map(publicRun);
  }

  get(runId: string): SubagentRunDto | undefined {
    const run = this.runs.get(runId);
    return run ? publicRun(run) : undefined;
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

  spawn(
    masterChatId: string,
    input: SpawnSubagentRequest,
    parentIsRunning: boolean,
    contextMessages: Array<{ id: string; role: string; text: string; authorThreadId?: string }>,
    parentThreadId?: string,
  ): SpawnSubagentResponse {
    const parent = this.runs.get(input.parentRunId);
    if (parent && parent.masterChatId !== masterChatId) throw new DelegationError("unauthorized_parent", "parent run belongs to another master chat", 403);
    if (!parent && !parentIsRunning) throw new DelegationError("parent_not_running", "parent run is not active", 409, true);
    if (parent && parent.status !== "running") throw new DelegationError("parent_not_running", "parent run is not running", 409, true);
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > 3) throw new DelegationError("depth_limit_exceeded", "delegation depth limit exceeded", 409);
    const rootRunId = parent?.rootRunId ?? input.parentRunId;
    const descendants = [...this.runs.values()].filter((run) => run.rootRunId === rootRunId);
    if (descendants.length >= 12) throw new DelegationError("descendant_limit_exceeded", "descendant limit exceeded", 409);
    if (descendants.filter((run) => run.status === "queued" || run.status === "running").length >= 4) {
      throw new DelegationError("concurrency_limit_exceeded", "delegation concurrency limit exceeded", 409, true);
    }

    const requestHash = digest(JSON.stringify(input));
    const key = `${masterChatId}:${input.parentRunId}:${input.idempotencyKey}`;
    const existing = this.idempotency.get(key);
    if (existing) {
      const run = this.runs.get(existing)!;
      if (run.requestHash !== requestHash) throw new DelegationError("idempotency_conflict", "idempotency key was used with another request", 409);
      if (run.registration.consumedAt || run.registration.invalidatedAt || Date.parse(run.registration.expiresAt) <= Date.now()) {
        throw new DelegationError("idempotency_conflict", "the original registration can no longer be replayed", 409);
      }
      const credential = randomBytes(32).toString("base64url");
      const registration = {
        id: randomUUID(),
        credentialHash: digest(credential),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        runtime: run.runtime,
      };
      const rotated = { ...run, registration };
      this.persist(rotated, "replace");
      return {
        run: publicRun(rotated),
        registration: { id: registration.id, credential, expiresAt: registration.expiresAt, runtime: run.runtime },
        replayed: true,
      };
    }

    const now = new Date().toISOString();
    const credential = randomBytes(32).toString("base64url");
    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      masterChatId,
      ...(parent?.parentThreadId || parentThreadId
        ? { parentThreadId: parent?.parentThreadId ?? parentThreadId }
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
      registration: {
        id: randomUUID(),
        credentialHash: digest(credential),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        runtime: input.runtime,
      },
    };
    run.contextSnapshot.id = run.contextSnapshotId;
    this.idempotency.set(key, runId);
    this.persist(run, "run");
    this.emit(masterChatId, { type: "subagent_spawned", run: publicRun(run) });
    return {
      run: publicRun(run),
      registration: { id: run.registration.id, credential, expiresAt: run.registration.expiresAt, runtime: run.runtime },
      replayed: false,
    };
  }

  claim(runId: string, input: ClaimSubagentRegistrationRequest): SubagentRunDto {
    const run = this.runs.get(runId);
    if (!run) throw new DelegationError("registration_not_found", "registration was not found", 404);
    const reg = run.registration;
    if (run.contextSnapshot.id !== run.contextSnapshotId || run.contextSnapshot.masterChatId !== run.masterChatId || run.contextSnapshot.parentRunId !== run.parentRunId) {
      throw new DelegationError("registration_mismatch", "server context snapshot ownership is invalid", 403);
    }
    const actual = Buffer.from(digest(input.credential));
    const expected = Buffer.from(reg.credentialHash);
    const mismatch = input.registrationId !== reg.id || input.parentRunId !== run.parentRunId || input.masterChatId !== run.masterChatId || input.runtime !== run.runtime || actual.length !== expected.length || !timingSafeEqual(actual, expected);
    if (mismatch) throw new DelegationError("registration_mismatch", "registration proof does not match the registered child", 403);
    if (reg.consumedAt) throw new DelegationError("registration_consumed", "registration was already consumed", 409);
    if (reg.invalidatedAt) throw new DelegationError("registration_mismatch", "registration was invalidated", 403);
    if (Date.parse(reg.expiresAt) <= Date.now()) throw new DelegationError("registration_expired", "registration expired", 401);
    const now = new Date().toISOString();
    const updated: RunRecord = { ...run, status: "running", startedAt: now, updatedAt: now, version: run.version + 1, registration: { ...reg, consumedAt: now } };
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
      const updated: RunRecord = terminal ? run : { ...run, status: "cancelled", canCancel: false, finishedAt: now, updatedAt: now, version: run.version + 1, registration: { ...run.registration, invalidatedAt: now } };
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
