import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  CancelSubagentResponse,
  ClaimSubagentRegistrationRequest,
  SpawnSubagentRequest,
  SpawnSubagentResponse,
  SubagentRunDto,
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
  requestHash: string;
  idempotencyKey: string;
  registration: RegistrationRecord;
}

type PersistedRecord = { type: "run"; run: RunRecord } | { type: "replace"; run: RunRecord };

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
const publicRun = ({ delegationPrompt: _prompt, requestHash: _hash, idempotencyKey: _key, registration: _reg, ...run }: RunRecord): SubagentRunDto => run;

export class DelegationStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "delegations.jsonl");
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      const { run } = JSON.parse(line) as PersistedRecord;
      this.runs.set(run.id, run);
      this.idempotency.set(`${run.masterChatId}:${run.parentRunId}:${run.idempotencyKey}`, run.id);
    }
  }

  private persist(run: RunRecord, type: PersistedRecord["type"]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ type, run })}\n`, "utf8");
    this.runs.set(run.id, run);
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

  spawn(masterChatId: string, input: SpawnSubagentRequest, parentIsRunning: boolean): SpawnSubagentResponse {
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
      throw new DelegationError("registration_required", "idempotent replay cannot disclose the credential again", 409);
    }

    const now = new Date().toISOString();
    const credential = randomBytes(32).toString("base64url");
    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      masterChatId,
      parentRunId: input.parentRunId,
      rootRunId,
      contextSnapshotId: randomUUID(),
      depth,
      version: 1,
      displayLabel: input.displayLabel.trim().slice(0, 100),
      delegationSummary: input.delegationPrompt.trim().replace(/\s+/g, " ").slice(0, 240),
      delegationPrompt: input.delegationPrompt,
      runtime: input.runtime,
      status: "queued",
      canCancel: true,
      createdAt: now,
      updatedAt: now,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      registration: {
        id: randomUUID(),
        credentialHash: digest(credential),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        runtime: input.runtime,
      },
    };
    this.idempotency.set(key, runId);
    this.persist(run, "run");
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
    if (reg.consumedAt) throw new DelegationError("registration_consumed", "registration was already consumed", 409);
    if (reg.invalidatedAt) throw new DelegationError("registration_mismatch", "registration was invalidated", 403);
    if (Date.parse(reg.expiresAt) <= Date.now()) throw new DelegationError("registration_expired", "registration expired", 401);
    const actual = Buffer.from(digest(input.credential));
    const expected = Buffer.from(reg.credentialHash);
    const mismatch = input.registrationId !== reg.id || input.parentRunId !== run.parentRunId || input.masterChatId !== run.masterChatId || input.runtime !== run.runtime || actual.length !== expected.length || !timingSafeEqual(actual, expected);
    if (mismatch) throw new DelegationError("registration_mismatch", "registration proof does not match the registered child", 403);
    const now = new Date().toISOString();
    const updated: RunRecord = { ...run, status: "running", startedAt: now, updatedAt: now, version: run.version + 1, registration: { ...reg, consumedAt: now } };
    this.persist(updated, "replace");
    return publicRun(updated);
  }

  cancel(runId: string): CancelSubagentResponse {
    if (!this.runs.has(runId)) throw new DelegationError("subagent_not_found", "subagent was not found", 404);
    const affected = [...this.runs.values()].filter((run) => run.id === runId || this.isDescendant(run, runId));
    const now = new Date().toISOString();
    const results = affected.map((run) => {
      const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
      const updated: RunRecord = terminal ? run : { ...run, status: "cancelled", canCancel: false, finishedAt: now, updatedAt: now, version: run.version + 1, registration: { ...run.registration, invalidatedAt: now } };
      if (!terminal) this.persist(updated, "replace");
      return { id: updated.id, status: updated.status, version: updated.version, updatedAt: updated.updatedAt };
    });
    return { requestedRunId: runId, scope: "branch", affected: results, completed: true };
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
