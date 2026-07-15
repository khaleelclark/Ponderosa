import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  REQUEST_UPDATE_AUTHORIZATION,
  TERMINAL_REQUEST_STATES,
  activationRetryDisposition,
  deriveAgentAvailability,
  evaluateCoordinationJoin,
  joinTransitionNeedsActivation,
  reduceCoordinationRequest,
  type CoordinationActorClass,
  type CoordinationJoinMode,
  type CoordinationJoinState,
  type CoordinationRequestState,
  type CoordinationRequestUpdateKind,
  type RequestLifetime,
  type DerivedAgentAvailability,
} from "@ponderosa/core";

type Actor = { kind: "agent" | "user" | "system" | "supervisor"; id?: string };

interface RequestRow {
  id: string;
  project_id: string;
  requester_agent_id: string | null;
  recipient_agent_id: string;
  state: CoordinationRequestState;
  version: number;
  lifetime_kind: RequestLifetime["kind"];
  deadline_at: string | null;
  open_question_update_id: string | null;
  created_at: string;
  updated_at: string;
}

interface JoinRow {
  id: string;
  project_id: string;
  owner_agent_id: string;
  mode: CoordinationJoinMode;
  quorum: number;
  satisfying_outcomes_json: string;
  state: CoordinationJoinState;
  deadline_at: string | null;
  continuation_request_ids_json: string;
}

interface ActivationRow {
  id: string;
  project_id: string;
  agent_id: string;
  kind: string;
  priority: number;
  dispatch_policy: ActivationDispatchPolicy;
  prompt_class: ActivationPromptClass;
  state: string;
  dedupe_key: string;
  payload_json: string;
  available_at: string;
  created_at: string;
  updated_at: string;
}

export interface CoordinateV3Input {
  projectId: string;
  requesterAgentId?: string;
  actorScope: string;
  idempotencyKey: string;
  requests: Array<{
    requestId?: string;
    recipientAgentId: string;
    lifetime: RequestLifetime;
    communicationEventId?: string;
    payload?: unknown;
  }>;
  join?: {
    id?: string;
    mode: CoordinationJoinMode;
    quorum?: number;
    satisfyingOutcomes?: CoordinationRequestState[];
    deadlineAt?: string;
    requestIds?: string[];
    /** Server-derived inbound requests that this join suspends and resumes. */
    continuationRequestIds?: string[];
  };
}

export interface CoordinateV3Result {
  requestIds: string[];
  joinId?: string;
  replayed: boolean;
}

export interface UpdateRequestV3Input {
  requestId: string;
  updateId: string;
  kind: CoordinationRequestUpdateKind;
  actor: Actor;
  inReplyToUpdateId?: string;
  payload?: unknown;
  now?: string;
}

export interface RequestUpdateV3Result {
  requestId: string;
  state: CoordinationRequestState;
  version: number;
  replayed: boolean;
}

export interface CoordinationRequestV3View {
  id: string;
  projectId: string;
  requesterAgentId?: string;
  recipientAgentId: string;
  state: CoordinationRequestState;
  version: number;
  payload: unknown;
}

export interface SchedulerLease {
  runId: string;
  projectId: string;
  agentId: string;
  fencingToken: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  injectionId: string;
  activationIds: string[];
  activations: Array<{
    id: string;
    kind: string;
    priority: number;
    dispatchPolicy: ActivationDispatchPolicy;
    promptClass: ActivationPromptClass;
    payload: unknown;
  }>;
}

export type ActivationDispatchPolicy = "steer_or_run" | "next_run";
export type ActivationPromptClass = "human" | "blocker" | "coordination" | "ordinary";

export interface RuntimeCommunicationV3Input {
  id: string;
  projectId: string;
  sender: unknown;
  intent: string;
  audience: unknown;
  payload: unknown;
  activation?: {
    agentId: string;
    kind: string;
    priority: number;
    dispatchPolicy: ActivationDispatchPolicy;
    promptClass: ActivationPromptClass;
    dedupeKey?: string;
  };
  activations?: Array<{
    agentId: string;
    kind: string;
    priority: number;
    dispatchPolicy: ActivationDispatchPolicy;
    promptClass: ActivationPromptClass;
    dedupeKey?: string;
  }>;
  now?: string;
}

export interface RuntimeCommunicationV3Result {
  id: string;
  activationId?: string;
  activationIds?: string[];
  replayed: boolean;
}

export interface RuntimeCommunicationV3View {
  id: string;
  projectId: string;
  payload: unknown;
  createdAt: string;
}

export interface SteeringLease {
  runId: string;
  projectId: string;
  agentId: string;
  fencingToken: number;
  injectionId: string;
  providerSessionId?: string;
  activationIds: string[];
  activations: SchedulerLease["activations"];
}

export interface CancellationResult {
  cancelled: boolean;
  replayed: boolean;
  runId?: string;
  fencingToken?: number;
  operationId?: number;
}

export interface ProviderOperation {
  id: number;
  runId: string;
  operation: "interrupt";
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

export interface OutboxItem {
  id: number;
  activationId: string;
  eventKind: string;
  payload: unknown;
  attempts: number;
}

export interface EnqueueMessageActivationInput {
  projectId: string;
  agentId: string;
  messageId: string;
  kind: "human" | "urgent" | "ordinary";
  dispatchPolicy?: ActivationDispatchPolicy;
  promptClass?: ActivationPromptClass;
  payload: unknown;
  now?: string;
}

const PRIORITY = {
  human: 100,
  urgent: 90,
  actionable: 80,
  satisfied: 70,
  request: 60,
  ordinary: 50,
} as const;

function activationDefaults(kind: string, priority: number): {
  dispatchPolicy: ActivationDispatchPolicy;
  promptClass: ActivationPromptClass;
} {
  if (kind === "human_message" || kind === "urgent_message" || kind.includes("question") || kind.includes("block")) {
    return {
      dispatchPolicy: "steer_or_run",
      promptClass: kind === "human_message" ? "human" : "blocker",
    };
  }
  return {
    dispatchPolicy: "next_run",
    promptClass: priority >= PRIORITY.actionable ? "blocker"
      : kind.startsWith("coordination_") ? "coordination"
        : "ordinary",
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function terminalAt(state: CoordinationRequestState, now: string): string | null {
  return TERMINAL_REQUEST_STATES.has(state) ? now : null;
}

/** Transactional authority for Communication V3. Runtime telemetry may mirror
 * these transitions, but scheduler decisions must read this store. */
export class CoordinationV3Store {
  constructor(private readonly sqlite: Database.Database) {}

  recordRuntimeCommunication(input: RuntimeCommunicationV3Input): RuntimeCommunicationV3Result {
    const now = input.now ?? new Date().toISOString();
    const activationInputs = [...(input.activation ? [input.activation] : []), ...(input.activations ?? [])];
    const canonical = {
      sender: input.sender,
      intent: input.intent,
      audience: input.audience,
      payload: input.payload,
      actionable: activationInputs.length > 0,
      activations: activationInputs,
    };
    const hash = payloadHash(canonical);
    return this.sqlite.transaction(() => {
      this.requireProject(input.projectId);
      const existing = this.sqlite.prepare(`
        SELECT payload_hash FROM runtime_communications WHERE id = ?
      `).get(input.id) as { payload_hash: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) throw new Error("runtime communication ID collision");
        const activations = this.sqlite.prepare(`
          SELECT a.id FROM agent_activations a
          JOIN activation_sources source ON source.activation_id = a.id
          WHERE source.source_kind = 'communication' AND source.source_id = ?
          ORDER BY a.created_at, a.id
        `).all(input.id) as Array<{ id: string }>;
        return {
          id: input.id,
          ...(activations[0] ? { activationId: activations[0].id } : {}),
          ...(activations.length ? { activationIds: activations.map((activation) => activation.id) } : {}),
          replayed: true,
        };
      }
      for (const activation of activationInputs) this.requireAgent(input.projectId, activation.agentId);
      this.sqlite.prepare(`
        INSERT INTO runtime_communications (
          id, project_id, sender_json, intent, audience_json, payload_json,
          payload_hash, actionable, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.projectId, stableJson(input.sender), input.intent,
        stableJson(input.audience), stableJson(input.payload), hash,
        activationInputs.length ? 1 : 0, now,
      );
      const activationIds = activationInputs.map((activation, index) => this.createActivation({
        projectId: input.projectId,
        agentId: activation.agentId,
        kind: activation.kind,
        priority: activation.priority,
        dispatchPolicy: activation.dispatchPolicy,
        promptClass: activation.promptClass,
        dedupeKey: activation.dedupeKey ?? `communication:${input.id}:${activation.agentId}:${index}`,
        payload: input.payload,
        sourceKind: "communication",
        sourceId: input.id,
        now,
      }));
      return {
        id: input.id,
        ...(activationIds[0] ? { activationId: activationIds[0] } : {}),
        ...(activationIds.length ? { activationIds } : {}),
        replayed: false,
      };
    })();
  }

  runtimeCommunications(projectId?: string): RuntimeCommunicationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, payload_json, created_at
      FROM runtime_communications
      WHERE (? IS NULL OR project_id = ?)
      ORDER BY created_at, id
    `).all(projectId ?? null, projectId ?? null) as Array<{
      id: string; project_id: string; payload_json: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  activationPayloads(agentId: string, activationIds: string[], runId?: string): Array<{
    id: string; kind: string; promptClass: ActivationPromptClass; payload: unknown;
  }> {
    if (activationIds.length === 0) return [];
    const placeholders = activationIds.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT id, kind, prompt_class, payload_json FROM agent_activations
      WHERE agent_id = ? AND id IN (${placeholders})
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          WHERE attached.activation_id = agent_activations.id AND attached.run_id = ?
        ))
    `).all(agentId, ...activationIds, runId ?? null, runId ?? null) as Array<{
      id: string; kind: string; prompt_class: ActivationPromptClass; payload_json: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return activationIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ id, kind: row.kind, promptClass: row.prompt_class, payload: JSON.parse(row.payload_json) as unknown }] : [];
    });
  }

  requestIdsAttachedToRun(runId: string, agentId: string): string[] {
    const directRows = this.sqlite.prepare(`
      SELECT DISTINCT request.id, request.created_at
      FROM scheduler_runs run
      JOIN scheduler_run_activations attached ON attached.run_id = run.id
      JOIN activation_sources source ON source.activation_id = attached.activation_id
      LEFT JOIN coordination_request_updates request_update
        ON source.source_kind = 'request_update' AND request_update.id = source.source_id
      JOIN coordination_requests request ON request.id = CASE
        WHEN source.source_kind = 'request' THEN source.source_id
        WHEN source.source_kind = 'request_update' THEN request_update.request_id
      END
      WHERE run.id = ? AND run.agent_id = ? AND request.project_id = run.project_id
        AND source.source_kind IN ('request', 'request_update')
      ORDER BY request.created_at, request.id
    `).all(runId, agentId) as Array<{ id: string; created_at: string }>;
    const continuationRows = this.sqlite.prepare(`
      SELECT DISTINCT request.id, request.created_at
      FROM scheduler_runs run
      JOIN scheduler_run_activations attached ON attached.run_id = run.id
      JOIN activation_sources source
        ON source.activation_id = attached.activation_id AND source.source_kind = 'join'
      JOIN coordination_joins join_record ON join_record.id = source.source_id
      JOIN json_each(join_record.continuation_request_ids_json) continuation
      JOIN coordination_requests request ON request.id = continuation.value
      WHERE run.id = ? AND run.agent_id = ? AND request.project_id = run.project_id
        AND request.recipient_agent_id = run.agent_id
    `).all(runId, agentId) as Array<{ id: string; created_at: string }>;
    return [...new Map([...directRows, ...continuationRows].map((row) => [row.id, row])).values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((row) => row.id);
  }

  /**
   * Return requesters that already received an authoritative terminal outcome
   * from this exact provider execution. An ordinary message to one of these
   * agents is a passive audit copy: the request or its Join owns the wake.
   * Matching the execution ID keeps earlier outcomes and unrelated messages
   * actionable, while callers may still explicitly override this for urgency.
   */
  terminalOutcomeRequesterIdsForRun(runId: string, agentId: string, executionId: string): string[] {
    const requestIds = this.requestIdsAttachedToRun(runId, agentId);
    if (requestIds.length === 0) return [];
    const terminalStates = [...TERMINAL_REQUEST_STATES];
    const requestPlaceholders = requestIds.map(() => "?").join(", ");
    const terminalPlaceholders = terminalStates.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT request.requester_agent_id
      FROM coordination_requests request
      WHERE request.id IN (${requestPlaceholders}) AND request.recipient_agent_id = ?
        AND request.requester_agent_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM coordination_request_updates request_update
          WHERE request_update.request_id = request.id
            AND request_update.actor_kind = 'agent'
            AND request_update.actor_id = ?
            AND request_update.resulting_state IN (${terminalPlaceholders})
            AND json_extract(request_update.payload_json, '$.executionId') = ?
        )
      ORDER BY request.requester_agent_id
    `).all(
      ...requestIds,
      agentId,
      agentId,
      ...terminalStates,
      executionId,
    ) as Array<{ requester_agent_id: string }>;
    return rows.map((row) => row.requester_agent_id);
  }

  /** Whether this Run consumes creation of a new request addressed to the
   * recipient. V3.1 uses this durable causal edge to select a fresh provider
   * cache without conflating provider memory with agent identity. Request
   * updates (including answers), joins, and ordinary messages intentionally do
   * not match and therefore retain continuity. */
  runStartsNewRecipientRequest(runId: string, agentId: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 AS matched
      FROM scheduler_runs run
      JOIN scheduler_run_activations attached ON attached.run_id = run.id
      JOIN activation_sources source ON source.activation_id = attached.activation_id
      JOIN coordination_requests request
        ON source.source_kind = 'request' AND request.id = source.source_id
      WHERE run.id = ? AND run.agent_id = ? AND request.project_id = run.project_id
        AND request.recipient_agent_id = ?
      LIMIT 1
    `).get(runId, agentId, agentId) as { matched: number } | undefined;
    return Boolean(row);
  }

  coordinate(input: CoordinateV3Input, now = new Date().toISOString()): CoordinateV3Result {
    if (!input.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    if (input.requests.length === 0 && !input.join?.requestIds?.length) {
      throw new Error("at least one new or existing request is required");
    }
    const normalized = {
      ...input,
      requests: input.requests.map((request) => ({ ...request, requestId: request.requestId ?? null })),
      join: input.join ? { ...input.join, id: input.join.id ?? null } : null,
    };
    const hash = payloadHash(normalized);

    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<CoordinateV3Result>(
        input.projectId, input.actorScope, "coordinate", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      this.requireProject(input.projectId);
      if (input.requesterAgentId) this.requireAgent(input.projectId, input.requesterAgentId);

      const requestIds: string[] = [];
      for (const request of input.requests) {
        this.requireAgent(input.projectId, request.recipientAgentId);
        this.validateLifetime(request.lifetime, now);
        const requestId = request.requestId ?? randomUUID();
        this.sqlite.prepare(`
          INSERT INTO coordination_requests (
            id, project_id, requester_agent_id, recipient_agent_id,
            communication_event_id, payload_json, state, version, lifetime_kind, deadline_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
        `).run(
          requestId, input.projectId, input.requesterAgentId ?? null,
          request.recipientAgentId, request.communicationEventId ?? null,
          stableJson(request.payload ?? null),
          request.lifetime.kind,
          request.lifetime.kind === "deadline" ? request.lifetime.at : null,
          now, now,
        );
        requestIds.push(requestId);
        this.createActivation({
          projectId: input.projectId,
          agentId: request.recipientAgentId,
          kind: "coordination_request",
          priority: PRIORITY.request,
          dedupeKey: `request:${requestId}:created`,
          payload: { requestId, requesterAgentId: input.requesterAgentId ?? null, request: request.payload ?? null },
          sourceKind: "request",
          sourceId: requestId,
          now,
        });
      }

      let joinId: string | undefined;
      if (input.join) {
        if (!input.requesterAgentId) throw new Error("a join requires an agent requester");
        const existingMemberRequestIds: string[] = [];
        const newRecipientIds = new Set(input.requests.map((request) => request.recipientAgentId));
        for (const requestId of input.join.requestIds ?? []) {
          const existing = this.sqlite.prepare(`
            SELECT project_id, requester_agent_id FROM coordination_requests WHERE id = ?
          `).get(requestId) as { project_id: string; requester_agent_id: string | null } | undefined;
          if (existing?.project_id === input.projectId && existing.requester_agent_id === input.requesterAgentId) {
            existingMemberRequestIds.push(requestId);
            continue;
          }
          // Provider models sometimes repeat the new recipients here even though
          // joins automatically include every request created in this call. This
          // spelling is unambiguous and safe to normalize; every other unknown or
          // foreign ID still fails closed.
          if (newRecipientIds.has(requestId)) continue;
          throw new Error("every existing join request must be owned by the requester in this project");
        }
        const memberRequestIds = [...new Set([...requestIds, ...existingMemberRequestIds])];
        const continuationRequestIds = [...new Set(input.join.continuationRequestIds ?? [])];
        for (const requestId of continuationRequestIds) {
          const continuation = this.getRequestRow(requestId);
          if (continuation.project_id !== input.projectId || continuation.recipient_agent_id !== input.requesterAgentId ||
              TERMINAL_REQUEST_STATES.has(continuation.state)) {
            throw new Error("every join continuation must be a nonterminal request assigned to the join owner");
          }
        }
        joinId = input.join.id ?? randomUUID();
        const mode = input.join.mode;
        const quorum = mode === "all" ? memberRequestIds.length : mode === "any" ? 1 : input.join.quorum ?? 0;
        if (quorum < 1 || quorum > memberRequestIds.length) throw new Error("join quorum is outside request membership");
        const satisfying = input.join.satisfyingOutcomes ?? ["completed"];
        if (satisfying.length === 0 || satisfying.some((state) => !TERMINAL_REQUEST_STATES.has(state))) {
          throw new Error("join satisfying outcomes must be terminal request states");
        }
        if (input.join.deadlineAt && (!isIso(input.join.deadlineAt) || input.join.deadlineAt <= now)) {
          throw new Error("join deadline must be a future ISO timestamp");
        }
        const definitionHash = payloadHash({
          requestIds: [...memberRequestIds].sort(),
          mode,
          quorum,
          satisfyingOutcomes: [...new Set(satisfying)].sort(),
          deadlineAt: input.join.deadlineAt ?? null,
          continuationRequestIds: [...continuationRequestIds].sort(),
        });
        const equivalent = this.sqlite.prepare(`
          SELECT id FROM coordination_joins
          WHERE project_id = ? AND owner_agent_id = ? AND definition_hash = ?
            AND state IN ('open', 'satisfied', 'impossible')
          ORDER BY created_at LIMIT 1
        `).get(input.projectId, input.requesterAgentId, definitionHash) as { id: string } | undefined;
        if (equivalent) {
          joinId = equivalent.id;
          const result: CoordinateV3Result = { requestIds, joinId, replayed: false };
          this.recordIdempotency(input.projectId, input.actorScope, "coordinate", input.idempotencyKey, hash, result, now);
          return result;
        }
        this.sqlite.prepare(`
          INSERT INTO coordination_joins (
            id, project_id, owner_agent_id, mode, quorum,
            satisfying_outcomes_json, state, deadline_at, definition_hash,
            continuation_request_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
        `).run(
          joinId, input.projectId, input.requesterAgentId, mode, quorum,
          stableJson([...new Set(satisfying)]), input.join.deadlineAt ?? null, definitionHash,
          stableJson(continuationRequestIds), now, now,
        );
        const insertMember = this.sqlite.prepare(`
          INSERT INTO coordination_join_members (join_id, request_id, position) VALUES (?, ?, ?)
        `);
        memberRequestIds.forEach((requestId, position) => insertMember.run(joinId, requestId, position));
        for (const requestId of continuationRequestIds) {
          const continuation = this.getRequestRow(requestId);
          if (continuation.state === "open" || continuation.state === "in_progress") this.updateRequest({
            requestId,
            updateId: `join:${joinId}:waiting:${requestId}`,
            kind: "waiting_dependency",
            actor: { kind: "agent", id: input.requesterAgentId },
            payload: { joinId, reason: "waiting_for_join" },
            now,
          });
        }
        this.reevaluateRequestJoins(memberRequestIds[0]!, now);
      }

      const result: CoordinateV3Result = { requestIds, ...(joinId ? { joinId } : {}), replayed: false };
      this.recordIdempotency(input.projectId, input.actorScope, "coordinate", input.idempotencyKey, hash, result, now);
      return result;
    })();
  }

  enqueueMessageActivation(input: EnqueueMessageActivationInput): string {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      this.requireProject(input.projectId);
      this.requireAgent(input.projectId, input.agentId);
      return this.createActivation({
        projectId: input.projectId,
        agentId: input.agentId,
        kind: `${input.kind}_message`,
        priority: input.kind === "human" ? PRIORITY.human : input.kind === "urgent" ? PRIORITY.urgent : PRIORITY.ordinary,
        dispatchPolicy: input.dispatchPolicy ?? (input.kind === "ordinary" ? "next_run" : "steer_or_run"),
        promptClass: input.promptClass ?? (input.kind === "human" ? "human" : input.kind === "urgent" ? "blocker" : "ordinary"),
        dedupeKey: `message:${input.messageId}`,
        payload: input.payload,
        sourceKind: "message",
        sourceId: input.messageId,
        now,
      });
    })();
  }

  getAgentAvailability(agentId: string): DerivedAgentAvailability {
    const hasActiveRun = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs WHERE agent_id = ? AND status IN ('leased', 'running') LIMIT 1
    `).get(agentId));
    const hasActionableActivation = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM agent_activations
      WHERE agent_id = ? AND state IN ('pending', 'retry_pending') LIMIT 1
    `).get(agentId));
    const ownsOpenJoin = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM coordination_joins WHERE owner_agent_id = ? AND state = 'open' LIMIT 1
    `).get(agentId));
    const hasSuspendedRecipientRequest = Boolean(this.sqlite.prepare(`
      SELECT 1 FROM coordination_requests
      WHERE recipient_agent_id = ? AND state IN ('awaiting_answer', 'waiting_dependency') LIMIT 1
    `).get(agentId));
    return deriveAgentAvailability({ hasActiveRun, hasActionableActivation, ownsOpenJoin, hasSuspendedRecipientRequest });
  }

  activeRunCount(): number {
    return (this.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM scheduler_runs WHERE status IN ('leased', 'running')
    `).get() as { count: number }).count;
  }

  ownsRun(runId: string, fencingToken: number, workerId?: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 FROM scheduler_runs
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
        AND (? IS NULL OR lease_owner = ?)
    `).get(runId, fencingToken, workerId ?? null, workerId ?? null);
    return Boolean(row);
  }

  schedulerMetrics(): {
    pendingActivations: number;
    activeRuns: number;
    completedRuns: number;
    failedRuns: number;
    outcomeUnknownRuns: number;
  } {
    const count = (table: string, predicate: string): number => (this.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
    ).get() as { count: number }).count;
    return {
      pendingActivations: count("agent_activations", "state IN ('pending', 'retry_pending')"),
      activeRuns: count("scheduler_runs", "status IN ('leased', 'running')"),
      completedRuns: count("scheduler_runs", "status = 'completed'"),
      failedRuns: count("scheduler_runs", "status = 'failed'"),
      outcomeUnknownRuns: count("scheduler_runs", "status = 'outcome_unknown'"),
    };
  }

  agentSnapshot(agentId: string): import("@ponderosa/core").AgentCoordinationV3Dto {
    const requests = this.sqlite.prepare(`
      SELECT id, requester_agent_id, recipient_agent_id, state, version, deadline_at, updated_at
      FROM coordination_requests
      WHERE requester_agent_id = ? OR recipient_agent_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 100
    `).all(agentId, agentId) as Array<{
      id: string; requester_agent_id: string | null; recipient_agent_id: string;
      state: string; version: number; deadline_at: string | null; updated_at: string;
    }>;
    const joins = this.sqlite.prepare(`
      SELECT j.id, j.mode, j.quorum, j.state, j.deadline_at, j.updated_at,
        COUNT(m.request_id) AS total,
        SUM(CASE WHEN r.state = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM coordination_joins j
      JOIN coordination_join_members m ON m.join_id = j.id
      JOIN coordination_requests r ON r.id = m.request_id
      WHERE j.owner_agent_id = ?
      GROUP BY j.id ORDER BY j.updated_at DESC, j.id DESC LIMIT 100
    `).all(agentId) as Array<{
      id: string; mode: CoordinationJoinMode; quorum: number; state: CoordinationJoinState;
      deadline_at: string | null; updated_at: string; total: number; completed: number;
    }>;
    const activations = this.sqlite.prepare(`
      SELECT id, kind, priority, state, created_at
      FROM agent_activations WHERE agent_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100
    `).all(agentId) as Array<{ id: string; kind: string; priority: number; state: string; created_at: string }>;
    const activeRun = this.sqlite.prepare(`
      SELECT id, status, fencing_token, prompt_injection_state, lease_expires_at
      FROM scheduler_runs WHERE agent_id = ? AND status IN ('leased', 'running') LIMIT 1
    `).get(agentId) as {
      id: string; status: string; fencing_token: number;
      prompt_injection_state: "not_injected" | "injecting" | "injected"; lease_expires_at: string;
    } | undefined;
    return {
      availability: this.getAgentAvailability(agentId),
      requests: requests.map((request) => ({
        id: request.id,
        direction: request.requester_agent_id === agentId ? "outbound" : "inbound",
        ...(request.requester_agent_id === agentId
          ? { counterpartyAgentId: request.recipient_agent_id }
          : request.requester_agent_id ? { counterpartyAgentId: request.requester_agent_id } : {}),
        state: request.state,
        version: request.version,
        ...(request.deadline_at ? { deadlineAt: request.deadline_at } : {}),
        updatedAt: request.updated_at,
      })),
      joins: joins.map((join) => ({
        id: join.id, mode: join.mode, quorum: join.quorum, state: join.state,
        completed: join.completed, total: join.total,
        ...(join.deadline_at ? { deadlineAt: join.deadline_at } : {}),
        updatedAt: join.updated_at,
      })),
      activations: activations.map((activation) => ({
        id: activation.id, kind: activation.kind, priority: activation.priority,
        state: activation.state, createdAt: activation.created_at,
      })),
      ...(activeRun ? { activeRun: {
        id: activeRun.id, status: activeRun.status, fencingToken: activeRun.fencing_token,
        promptInjectionState: activeRun.prompt_injection_state,
        leaseExpiresAt: activeRun.lease_expires_at,
      } } : {}),
    };
  }

  updateRequest(input: UpdateRequestV3Input): RequestUpdateV3Result {
    const now = input.now ?? new Date().toISOString();
    const replayPayload = {
      requestId: input.requestId,
      kind: input.kind,
      actor: input.actor,
      inReplyToUpdateId: input.inReplyToUpdateId ?? null,
      payload: input.payload ?? null,
    };
    const hash = payloadHash(replayPayload);
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT request_id, actor_kind, actor_id, payload_hash, resulting_state, resulting_version
        FROM coordination_request_updates WHERE id = ?
      `).get(input.updateId) as {
        request_id: string; actor_kind: Actor["kind"]; actor_id: string | null;
        payload_hash: string; resulting_state: CoordinationRequestState; resulting_version: number;
      } | undefined;
      if (existing) {
        if (
          existing.request_id !== input.requestId || existing.actor_kind !== input.actor.kind ||
          existing.actor_id !== (input.actor.id ?? null) || existing.payload_hash !== hash
        ) throw new Error("request update idempotency collision");
        return {
          requestId: existing.request_id,
          state: existing.resulting_state,
          version: existing.resulting_version,
          replayed: true,
        };
      }

      const request = this.getRequestRow(input.requestId);
      this.authorizeUpdate(request, input.kind, input.actor);
      const next = reduceCoordinationRequest(
        {
          state: request.state,
          version: request.version,
          ...(request.open_question_update_id ? { openQuestionUpdateId: request.open_question_update_id } : {}),
        },
        {
          kind: input.kind,
          updateId: input.updateId,
          ...(input.inReplyToUpdateId ? { inReplyToUpdateId: input.inReplyToUpdateId } : {}),
        },
      );
      this.sqlite.prepare(`
        INSERT INTO coordination_request_updates (
          id, request_id, kind, actor_kind, actor_id, in_reply_to_update_id,
          payload_json, payload_hash, resulting_state, resulting_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.updateId, request.id, input.kind, input.actor.kind, input.actor.id ?? null,
        input.inReplyToUpdateId ?? null, stableJson(input.payload ?? null), hash,
        next.state, next.version, now,
      );
      this.sqlite.prepare(`
        UPDATE coordination_requests
        SET state = ?, version = ?, open_question_update_id = ?,
            updated_at = ?, terminal_at = ?
        WHERE id = ? AND version = ?
      `).run(
        next.state, next.version, next.openQuestionUpdateId ?? null, now,
        terminalAt(next.state, now), request.id, request.version,
      );

      const joined = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM coordination_join_members WHERE request_id = ?
      `).get(request.id) as { count: number }).count > 0;
      this.reevaluateRequestJoins(request.id, now);
      this.activateForRequestTransition(request, input.kind, next.state, joined, input.updateId, input.payload, now);
      return { requestId: request.id, state: next.state, version: next.version, replayed: false };
    })();
  }

  getRequest(requestId: string): CoordinationRequestV3View | undefined {
    const row = this.sqlite.prepare(`SELECT * FROM coordination_requests WHERE id = ?`).get(requestId) as (RequestRow & { payload_json: string }) | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
      recipientAgentId: row.recipient_agent_id,
      state: row.state,
      version: row.version,
      payload: JSON.parse(row.payload_json) as unknown,
    };
  }

  attachRequestCommunication(requestId: string, communicationEventId: string, projectId: string): void {
    const changed = this.sqlite.prepare(`
      UPDATE coordination_requests SET communication_event_id = ?
      WHERE id = ? AND project_id = ?
        AND (communication_event_id IS NULL OR communication_event_id = ?)
    `).run(communicationEventId, requestId, projectId, communicationEventId).changes;
    if (changed !== 1) throw new Error("request communication identity conflict");
  }

  expireDue(now = new Date().toISOString()): { requests: number; joins: number } {
    return this.sqlite.transaction(() => {
      const requests = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE deadline_at IS NOT NULL AND deadline_at <= ?
          AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
        ORDER BY deadline_at, id
      `).all(now) as Array<{ id: string }>;
      for (const { id } of requests) {
        this.updateRequest({
          requestId: id,
          updateId: `system:expired:${id}:${now}`,
          kind: "expired",
          actor: { kind: "system", id: "deadline-sweeper" },
          payload: { deadlineObservedAt: now },
          now,
        });
      }
      const joins = this.sqlite.prepare(`
        SELECT * FROM coordination_joins
        WHERE deadline_at IS NOT NULL AND deadline_at <= ? AND state = 'open'
        ORDER BY deadline_at, id
      `).all(now) as JoinRow[];
      for (const join of joins) {
        this.sqlite.prepare(`
          UPDATE coordination_joins SET state = 'expired', updated_at = ?, terminal_at = ?
          WHERE id = ? AND state = 'open'
        `).run(now, now, join.id);
        if (this.agentSurvives(join.owner_agent_id)) this.createJoinActivation(join, "expired", now);
      }
      return { requests: requests.length, joins: joins.length };
    })();
  }

  /** On single-host startup every active lease owned by another server process
   * is orphaned. Pre-submission work is retryable; submitted or acknowledged
   * injections fail closed until an adapter can prove provider reconciliation. */
  recoverOrphanedRuns(workerId: string, now = new Date().toISOString()): { retried: number; outcomeUnknown: number } {
    return this.sqlite.transaction(() => {
      const runs = this.sqlite.prepare(`
        SELECT id, prompt_injection_state FROM scheduler_runs
        WHERE status IN ('leased', 'running') AND lease_owner <> ?
      `).all(workerId) as Array<{ id: string; prompt_injection_state: string }>;
      let retried = 0;
      let outcomeUnknown = 0;
      for (const run of runs) {
        if (run.prompt_injection_state === "not_injected") {
          this.sqlite.prepare(`
            UPDATE scheduler_runs SET status = 'failed', updated_at = ?, terminal_at = ? WHERE id = ?
          `).run(now, now, run.id);
          this.sqlite.prepare(`
            UPDATE agent_activations SET state = 'retry_pending', available_at = ?, updated_at = ?
            WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
              AND state = 'attached'
          `).run(now, now, run.id);
          this.sqlite.prepare(`
            UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
            WHERE run_id = ? AND state = 'pending'
          `).run(now, now, run.id);
          retried += 1;
        } else {
          this.sqlite.prepare(`
            UPDATE scheduler_runs SET status = 'outcome_unknown', updated_at = ?, terminal_at = ? WHERE id = ?
          `).run(now, now, run.id);
          this.sqlite.prepare(`
            UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
            WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
              AND state = 'attached'
          `).run(now, run.id);
          this.sqlite.prepare(`
            UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
            WHERE run_id = ? AND state IN ('pending', 'submitted')
          `).run(now, now, run.id);
          this.markRelatedRequestsOutcomeUnknown(run.id, now, "server_restart_after_prompt_submission", [
            "open", "in_progress", "waiting_dependency", "awaiting_answer",
          ]);
          outcomeUnknown += 1;
        }
      }
      return { retried, outcomeUnknown };
    })();
  }

  cancelJoin(joinId: string, ownerAgentId: string, now = new Date().toISOString()): boolean {
    return this.sqlite.transaction(() => {
      const join = this.sqlite.prepare(`SELECT * FROM coordination_joins WHERE id = ?`).get(joinId) as JoinRow | undefined;
      if (!join) throw new Error("join not found");
      if (join.owner_agent_id !== ownerAgentId) throw new Error("only the join owner may cancel it");
      if (join.state === "cancelled") return false;
      if (join.state !== "open") throw new Error(`join is terminal (${join.state})`);
      this.sqlite.prepare(`
        UPDATE coordination_joins SET state = 'cancelled', updated_at = ?, terminal_at = ? WHERE id = ?
      `).run(now, now, joinId);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE state IN ('pending', 'retry_pending') AND id IN (
          SELECT activation_id FROM activation_sources WHERE source_kind = 'join' AND source_id = ?
        )
      `).run(now, joinId);
      return true;
    })();
  }

  handleAgentDeletion(agentId: string, now = new Date().toISOString()): void {
    this.sqlite.transaction(() => {
      const owned = this.sqlite.prepare(`
        SELECT id FROM coordination_joins WHERE owner_agent_id = ? AND state = 'open'
      `).all(agentId) as Array<{ id: string }>;
      for (const join of owned) {
        this.sqlite.prepare(`
          UPDATE coordination_joins SET state = 'cancelled', updated_at = ?, terminal_at = ? WHERE id = ?
        `).run(now, now, join.id);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'cancelled', updated_at = ?
          WHERE state IN ('pending', 'retry_pending') AND id IN (
            SELECT activation_id FROM activation_sources WHERE source_kind = 'join' AND source_id = ?
          )
        `).run(now, join.id);
      }
      const received = this.sqlite.prepare(`
        SELECT id FROM coordination_requests WHERE recipient_agent_id = ?
          AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
      `).all(agentId) as Array<{ id: string }>;
      for (const request of received) this.updateRequest({
        requestId: request.id,
        updateId: `system:recipient-unavailable:${request.id}:${now}`,
        kind: "recipient_unavailable",
        actor: { kind: "system", id: "agent-deletion" },
        now,
      });
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending')
      `).run(now, agentId);
    })();
  }

  leaseNextRun(input: {
    workerId: string;
    now?: string;
    leaseMs?: number;
    coalesceLimit?: number;
  }): SchedulerLease | undefined {
    const now = input.now ?? new Date().toISOString();
    const leaseMs = input.leaseMs ?? 30_000;
    const limit = Math.max(1, Math.min(input.coalesceLimit ?? 8, 64));
    return this.sqlite.transaction(() => {
      this.recoverExpiredUninjectedRuns(now);
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id
        FROM agent_activations a
        WHERE a.state IN ('pending', 'retry_pending') AND a.available_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_runs r
            WHERE r.agent_id = a.agent_id AND r.status IN ('leased', 'running')
          )
        ORDER BY a.priority DESC, a.created_at, a.id
        LIMIT 1
      `).get(now) as { agent_id: string; project_id: string } | undefined;
      if (!candidate) return undefined;
      const queuedActivations = this.sqlite.prepare(`
        SELECT * FROM agent_activations
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending') AND available_at <= ?
        ORDER BY priority DESC, created_at, id LIMIT 64
      `).all(candidate.agent_id, now) as ActivationRow[];
      // A new inbound request starts a fresh provider task context. Human
      // messages, join resumptions, answers, and blockers retain continuity,
      // so combining the two classes would make session disposition ambiguous.
      // Keep the lower-priority class pending for the next authoritative Run.
      const startsFreshTask = (activation: ActivationRow) => activation.kind === "coordination_request";
      const candidateStartsFreshTask = startsFreshTask(queuedActivations[0]!);
      const activations = queuedActivations
        .filter((activation) => startsFreshTask(activation) === candidateStartsFreshTask)
        .slice(0, limit);
      if (activations.length === 0) return undefined;
      const fencingToken = this.nextFence(candidate.agent_id);
      const runId = randomUUID();
      const injectionId = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      this.sqlite.prepare(`
        INSERT INTO scheduler_runs (
          id, project_id, agent_id, status, lease_owner, lease_expires_at,
          fencing_token, prompt_injection_state, heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'leased', ?, ?, ?, 'not_injected', ?, ?, ?)
      `).run(runId, candidate.project_id, candidate.agent_id, input.workerId, leaseExpiresAt, fencingToken, now, now, now);
      const attach = this.sqlite.prepare(`
        INSERT INTO scheduler_run_activations (run_id, activation_id, attached_at) VALUES (?, ?, ?)
      `);
      const setAttached = this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'attached', updated_at = ?
        WHERE id = ? AND state IN ('pending', 'retry_pending')
      `);
      for (const activation of activations) {
        const changed = setAttached.run(now, activation.id).changes;
        if (changed !== 1) throw new Error("activation claim race");
        attach.run(runId, activation.id, now);
      }
      this.sqlite.prepare(`
        INSERT INTO scheduler_prompt_injections (
          id, run_id, kind, sequence, state, prompt_hash, activation_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, 'turn', 0, 'pending', '', ?, ?, ?)
      `).run(injectionId, runId, stableJson(activations.map((activation) => activation.id)), now, now);
      return {
        runId,
        projectId: candidate.project_id,
        agentId: candidate.agent_id,
        fencingToken,
        leaseOwner: input.workerId,
        leaseExpiresAt,
        injectionId,
        activationIds: activations.map((activation) => activation.id),
        activations: activations.map((activation) => ({
          id: activation.id,
          kind: activation.kind,
          priority: activation.priority,
          dispatchPolicy: activation.dispatch_policy,
          promptClass: activation.prompt_class,
          payload: JSON.parse(activation.payload_json) as unknown,
        })),
      };
    })();
  }

  leaseNextSteering(input: { workerId: string; now?: string; coalesceLimit?: number }): SteeringLease | undefined {
    const now = input.now ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(input.coalesceLimit ?? 4, 16));
    return this.sqlite.transaction(() => {
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id, r.id AS run_id, r.fencing_token, r.provider_session_id
        FROM agent_activations a
        JOIN scheduler_runs r ON r.agent_id = a.agent_id AND r.status = 'running'
        WHERE a.state IN ('pending', 'retry_pending') AND a.available_at <= ?
          AND a.dispatch_policy = 'steer_or_run'
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_prompt_injections injection
            WHERE injection.run_id = r.id AND injection.kind = 'steer'
              AND injection.state IN ('pending', 'submitted')
          )
        ORDER BY a.priority DESC, a.created_at, a.id
        LIMIT 1
      `).get(now) as {
        agent_id: string; project_id: string; run_id: string;
        fencing_token: number; provider_session_id: string | null;
      } | undefined;
      if (!candidate) return undefined;
      const activations = this.sqlite.prepare(`
        SELECT * FROM agent_activations
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending') AND available_at <= ?
          AND dispatch_policy = 'steer_or_run'
        ORDER BY priority DESC, created_at, id LIMIT ?
      `).all(candidate.agent_id, now, limit) as ActivationRow[];
      if (activations.length === 0) return undefined;
      const injectionId = randomUUID();
      const sequence = (this.sqlite.prepare(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
        FROM scheduler_prompt_injections WHERE run_id = ?
      `).get(candidate.run_id) as { sequence: number }).sequence;
      const attach = this.sqlite.prepare(`
        INSERT OR IGNORE INTO scheduler_run_activations (run_id, activation_id, attached_at)
        VALUES (?, ?, ?)
      `);
      const setAttached = this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'attached', updated_at = ?
        WHERE id = ? AND state IN ('pending', 'retry_pending')
      `);
      for (const activation of activations) {
        if (setAttached.run(now, activation.id).changes !== 1) throw new Error("steering activation claim race");
        attach.run(candidate.run_id, activation.id, now);
      }
      this.sqlite.prepare(`
        INSERT INTO scheduler_prompt_injections (
          id, run_id, kind, sequence, state, prompt_hash, activation_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, 'steer', ?, 'pending', '', ?, ?, ?)
      `).run(
        injectionId, candidate.run_id, sequence,
        stableJson(activations.map((activation) => activation.id)), now, now,
      );
      return {
        runId: candidate.run_id,
        projectId: candidate.project_id,
        agentId: candidate.agent_id,
        fencingToken: candidate.fencing_token,
        injectionId,
        ...(candidate.provider_session_id ? { providerSessionId: candidate.provider_session_id } : {}),
        activationIds: activations.map((activation) => activation.id),
        activations: activations.map((activation) => ({
          id: activation.id,
          kind: activation.kind,
          priority: activation.priority,
          dispatchPolicy: activation.dispatch_policy,
          promptClass: activation.prompt_class,
          payload: JSON.parse(activation.payload_json) as unknown,
        })),
      };
    })();
  }

  deferSteering(input: {
    injectionId: string; runId: string; fencingToken: number; retryDelayMs?: number; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const availableAt = new Date(Date.parse(now) + (input.retryDelayMs ?? 0)).toISOString();
    this.sqlite.transaction(() => {
      this.getFencedRun(input.runId, input.fencingToken);
      const injection = this.sqlite.prepare(`
        SELECT activation_ids_json FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted')
      `).get(input.injectionId, input.runId) as { activation_ids_json: string } | undefined;
      if (!injection) throw new Error("pending steering injection not found");
      const activationIds = JSON.parse(injection.activation_ids_json) as string[];
      if (activationIds.length) {
        const placeholders = activationIds.map(() => "?").join(", ");
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'retry_pending', dispatch_policy = 'next_run',
            available_at = ?, updated_at = ?
          WHERE id IN (${placeholders}) AND state = 'attached'
        `).run(availableAt, now, ...activationIds);
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted')
      `).run(now, now, input.injectionId, input.runId);
    })();
  }

  markSteeringOutcomeUnknown(input: {
    injectionId: string; runId: string; fencingToken: number; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      this.getFencedRun(input.runId, input.fencingToken);
      const injection = this.sqlite.prepare(`
        SELECT activation_ids_json FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted')
      `).get(input.injectionId, input.runId) as { activation_ids_json: string } | undefined;
      if (!injection) throw new Error("unsettled steering injection not found");
      const activationIds = JSON.parse(injection.activation_ids_json) as string[];
      if (activationIds.length) {
        const placeholders = activationIds.map(() => "?").join(", ");
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
          WHERE id IN (${placeholders}) AND state = 'attached'
        `).run(now, ...activationIds);
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted')
      `).run(now, now, input.injectionId, input.runId);
    })();
  }

  markRunStarted(runId: string, fence: number, now = new Date().toISOString()): void {
    this.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
    `, [now, now, runId, fence]);
  }

  preparePromptInjection(input: {
    injectionId: string; runId: string; fencingToken: number; prompt: string; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const hash = createHash("sha256").update(input.prompt).digest("hex");
    this.sqlite.transaction(() => {
      this.getFencedRun(input.runId, input.fencingToken);
      const row = this.sqlite.prepare(`
        SELECT prompt_hash, state FROM scheduler_prompt_injections WHERE id = ? AND run_id = ?
      `).get(input.injectionId, input.runId) as { prompt_hash: string; state: string } | undefined;
      if (!row) throw new Error("prompt injection not found");
      if (row.prompt_hash && row.prompt_hash !== hash) throw new Error("prompt injection payload changed");
      if (row.state !== "pending" && !row.prompt_hash) throw new Error("submitted injection has no durable prompt hash");
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET prompt_hash = ?, updated_at = ?
        WHERE id = ? AND run_id = ? AND state = 'pending'
      `).run(hash, now, input.injectionId, input.runId);
    })();
  }

  markPromptSubmitted(input: {
    injectionId: string; runId: string; fencingToken: number; providerSessionId?: string; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      const run = this.getFencedRun(input.runId, input.fencingToken);
      const changed = this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'submitted', submitted_at = COALESCE(submitted_at, ?), updated_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted') AND prompt_hash <> ''
      `).run(now, now, input.injectionId, input.runId).changes;
      if (changed !== 1) throw new Error("prompt injection is not submit-ready");
      this.sqlite.prepare(`
        UPDATE scheduler_runs SET prompt_injection_state = 'injecting',
          provider_session_id = COALESCE(?, provider_session_id), heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
      `).run(input.providerSessionId ?? null, now, now, input.runId, input.fencingToken);
      if ((run.status as string) === "leased") this.sqlite.prepare(`
        UPDATE scheduler_runs SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ? AND fencing_token = ?
      `).run(now, input.runId, input.fencingToken);
    })();
  }

  acknowledgePromptInjection(input: {
    injectionId: string; runId: string; fencingToken: number;
    providerTurnId?: string; providerSessionId?: string; now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      this.getFencedRun(input.runId, input.fencingToken);
      const changed = this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'acknowledged', provider_turn_id = COALESCE(?, provider_turn_id),
          acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('submitted', 'acknowledged')
      `).run(input.providerTurnId ?? null, now, now, input.injectionId, input.runId).changes;
      if (changed !== 1) throw new Error("prompt injection was not submitted");
      this.sqlite.prepare(`
        UPDATE scheduler_runs SET prompt_injection_state = 'injected',
          provider_session_id = COALESCE(?, provider_session_id), heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND fencing_token = ? AND status = 'running'
      `).run(input.providerSessionId ?? null, now, now, input.runId, input.fencingToken);
    })();
  }

  renewLease(runId: string, fence: number, workerId: string, leaseMs = 30_000, now = new Date().toISOString()): string {
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();
    this.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND fencing_token = ? AND lease_owner = ? AND status IN ('leased', 'running')
    `, [expires, now, now, runId, fence, workerId]);
    return expires;
  }

  completeRun(runId: string, fence: number, now = new Date().toISOString()): void {
    this.sqlite.transaction(() => {
      const unsettled = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM scheduler_prompt_injections
        WHERE run_id = ? AND state IN ('pending', 'submitted')
      `).get(runId) as { count: number }).count;
      if (unsettled > 0) throw new Error("run cannot complete with an unsettled prompt injection");
      this.mutateFencedRun(runId, fence, `
        UPDATE scheduler_runs SET status = 'completed', updated_at = ?, terminal_at = ?
        WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
      `, [now, now, runId, fence]);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'consumed', updated_at = ?, consumed_at = ?
        WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
          AND state = 'attached'
      `).run(now, now, runId);
      this.sqlite.prepare(`
        UPDATE scheduler_run_activations SET consumed_at = ? WHERE run_id = ?
      `).run(now, runId);
      this.markRelatedRequestsOutcomeUnknown(
        runId,
        now,
        "run_completed_without_request_update",
        ["open", "in_progress"],
        ["open", "in_progress", "waiting_dependency"],
      );
    })();
  }

  failRun(input: {
    runId: string;
    fencingToken: number;
    workerId: string;
    sameRunResumable: boolean;
    now?: string;
    retryDelayMs?: number;
    leaseMs?: number;
  }): "retry" | "resume_same_run" | "outcome_unknown" {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const run = this.getFencedRun(input.runId, input.fencingToken);
      const disposition = activationRetryDisposition({
        promptInjectionState: run.prompt_injection_state as "not_injected" | "injecting" | "injected",
        sameRunResumable: input.sameRunResumable,
      });
      if (disposition === "retry") {
        const availableAt = new Date(Date.parse(now) + (input.retryDelayMs ?? 1_000)).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'failed', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'retry_pending', available_at = ?, updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(availableAt, now, input.runId);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state = 'pending'
        `).run(now, now, input.runId);
      } else if (disposition === "resume_same_run") {
        const nextFence = this.nextFence(run.agent_id as string);
        const leaseExpiresAt = new Date(Date.parse(now) + (input.leaseMs ?? 30_000)).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
            fencing_token = ?, updated_at = ? WHERE id = ? AND fencing_token = ?
        `).run(input.workerId, leaseExpiresAt, nextFence, now, input.runId, input.fencingToken);
      } else {
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(now, input.runId);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('pending', 'submitted')
        `).run(now, now, input.runId);
        this.markRelatedRequestsOutcomeUnknown(input.runId, now, "provider_outcome_unknown", [
          "open", "in_progress", "waiting_dependency", "awaiting_answer",
        ]);
      }
      return disposition;
    })();
  }

  cancelAgentRun(input: { agentId: string; idempotencyKey: string; now?: string }): CancellationResult {
    if (!input.idempotencyKey.trim()) throw new Error("cancellation idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const replay = this.sqlite.prepare(`
        SELECT run_id, accepted, fencing_token FROM scheduler_cancellation_receipts
        WHERE agent_id = ? AND idempotency_key = ?
      `).get(input.agentId, input.idempotencyKey) as {
        run_id: string | null; accepted: number; fencing_token: number | null;
      } | undefined;
      if (replay) return {
        cancelled: replay.accepted === 1,
        replayed: true,
        ...(replay.run_id ? { runId: replay.run_id } : {}),
        ...(replay.fencing_token !== null ? { fencingToken: replay.fencing_token } : {}),
      };
      const run = this.sqlite.prepare(`
        SELECT id, fencing_token FROM scheduler_runs
        WHERE agent_id = ? AND status IN ('leased', 'running')
      `).get(input.agentId) as { id: string; fencing_token: number } | undefined;
      if (!run) {
        this.sqlite.prepare(`
          INSERT INTO scheduler_cancellation_receipts (
            agent_id, idempotency_key, run_id, accepted, fencing_token, created_at
          ) VALUES (?, ?, NULL, 0, NULL, ?)
        `).run(input.agentId, input.idempotencyKey, now);
        return { cancelled: false, replayed: false };
      }
      const fence = this.nextFence(input.agentId);
      this.sqlite.prepare(`
        UPDATE scheduler_runs SET status = 'cancelled', fencing_token = ?, updated_at = ?, terminal_at = ?
        WHERE id = ?
      `).run(fence, now, now, run.id);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
          AND state = 'attached'
      `).run(now, run.id);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'pending'
      `).run(now, now, run.id);
      this.sqlite.prepare(`
        INSERT INTO scheduler_cancellation_receipts (
          agent_id, idempotency_key, run_id, accepted, fencing_token, created_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(input.agentId, input.idempotencyKey, run.id, fence, now);
      const operation = this.sqlite.prepare(`
        INSERT INTO provider_operation_outbox (
          run_id, operation, idempotency_key, payload_json, state,
          available_at, created_at, updated_at
        ) VALUES (?, 'interrupt', ?, ?, 'pending', ?, ?, ?)
      `).run(
        run.id, `cancel:${input.agentId}:${input.idempotencyKey}`,
        stableJson({ agentId: input.agentId, runId: run.id, fencingToken: fence }),
        now, now, now,
      );
      return {
        cancelled: true,
        replayed: false,
        runId: run.id,
        fencingToken: fence,
        operationId: Number(operation.lastInsertRowid),
      };
    })();
  }

  /** Compatibility wrapper for store-level callers. Runtime cancellation must
   * use cancelAgentRun so the receipt and provider interrupt are transactional. */
  cancelRun(runId: string, now = new Date().toISOString()): number {
    const row = this.sqlite.prepare(`SELECT agent_id FROM scheduler_runs WHERE id = ?`).get(runId) as { agent_id: string } | undefined;
    if (!row) throw new Error("run not found");
    const result = this.cancelAgentRun({ agentId: row.agent_id, idempotencyKey: `legacy:${runId}`, now });
    return result.fencingToken ?? (this.sqlite.prepare(`SELECT fencing_token FROM scheduler_runs WHERE id = ?`).get(runId) as { fencing_token: number }).fencing_token;
  }

  claimProviderOperations(workerId: string, limit = 20, now = new Date().toISOString(), staleMs = 30_000): ProviderOperation[] {
    return this.sqlite.transaction(() => {
      const stale = new Date(Date.parse(now) - staleMs).toISOString();
      const rows = this.sqlite.prepare(`
        SELECT id, run_id, operation, idempotency_key, payload_json, attempts
        FROM provider_operation_outbox
        WHERE available_at <= ? AND (
          state = 'pending' OR (state = 'claimed' AND claimed_at <= ?)
        )
        ORDER BY id LIMIT ?
      `).all(now, stale, Math.max(1, Math.min(limit, 100))) as Array<{
        id: number; run_id: string; operation: "interrupt"; idempotency_key: string;
        payload_json: string; attempts: number;
      }>;
      const claimed: ProviderOperation[] = [];
      for (const row of rows) {
        const changed = this.sqlite.prepare(`
          UPDATE provider_operation_outbox
          SET state = 'claimed', claimed_by = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND claimed_at <= ?))
        `).run(workerId, now, now, row.id, stale).changes;
        if (changed === 1) claimed.push({
          id: row.id,
          runId: row.run_id,
          operation: row.operation,
          idempotencyKey: row.idempotency_key,
          payload: JSON.parse(row.payload_json) as unknown,
          attempts: row.attempts + 1,
        });
      }
      return claimed;
    })();
  }

  completeProviderOperation(id: number, workerId: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = 'completed', completed_at = ?, updated_at = ?, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(now, now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  failProviderOperation(id: number, workerId: string, error: string, retryDelayMs = 1_000, now = new Date().toISOString()): void {
    const availableAt = new Date(Date.parse(now) + retryDelayMs).toISOString();
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = 'pending', available_at = ?, last_error = ?, updated_at = ?,
        claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(availableAt, error.slice(0, 2_000), now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  claimOutbox(workerId: string, limit = 50, now = new Date().toISOString(), staleMs = 30_000): OutboxItem[] {
    return this.sqlite.transaction(() => {
      const stale = new Date(Date.parse(now) - staleMs).toISOString();
      const rows = this.sqlite.prepare(`
        SELECT id, activation_id, event_kind, payload_json, attempts
        FROM activation_outbox
        WHERE processed_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)
        ORDER BY id LIMIT ?
      `).all(stale, Math.max(1, Math.min(limit, 500))) as Array<{
        id: number; activation_id: string; event_kind: string; payload_json: string; attempts: number;
      }>;
      const claim = this.sqlite.prepare(`
        UPDATE activation_outbox SET claimed_by = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND processed_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)
      `);
      const claimed: OutboxItem[] = [];
      for (const row of rows) {
        if (claim.run(workerId, now, row.id, stale).changes !== 1) continue;
        claimed.push({
          id: row.id,
          activationId: row.activation_id,
          eventKind: row.event_kind,
          payload: JSON.parse(row.payload_json) as unknown,
          attempts: row.attempts + 1,
        });
      }
      return claimed;
    })();
  }

  completeOutbox(id: number, workerId: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox SET processed_at = ?, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL
    `).run(now, id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  failOutbox(id: number, workerId: string, error: string): void {
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox SET claimed_by = NULL, claimed_at = NULL, last_error = ?
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL
    `).run(error.slice(0, 2_000), id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  private validateLifetime(lifetime: RequestLifetime, now: string): void {
    if (lifetime.kind === "deadline" && (!isIso(lifetime.at) || lifetime.at <= now)) {
      throw new Error("request deadline must be a future ISO timestamp");
    }
  }

  private requireProject(projectId: string): void {
    if (!this.sqlite.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(projectId)) throw new Error("project not found");
  }

  private requireAgent(projectId: string, agentId: string): void {
    if (!this.sqlite.prepare(`SELECT 1 FROM agents WHERE id = ? AND project_id = ? AND archived = 0`).get(agentId, projectId)) {
      throw new Error("agent not found in project");
    }
  }

  private agentSurvives(agentId: string): boolean {
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM agents WHERE id = ? AND archived = 0`).get(agentId));
  }

  private getRequestRow(requestId: string): RequestRow {
    const row = this.sqlite.prepare(`SELECT * FROM coordination_requests WHERE id = ?`).get(requestId) as RequestRow | undefined;
    if (!row) throw new Error("request not found");
    return row;
  }

  private authorizeUpdate(request: RequestRow, kind: CoordinationRequestUpdateKind, actor: Actor): void {
    const authorization: CoordinationActorClass = REQUEST_UPDATE_AUTHORIZATION[kind];
    const isRecipient = actor.kind === "agent" && actor.id === request.recipient_agent_id;
    const isRequester = actor.kind === "agent" && actor.id === request.requester_agent_id;
    const allowed = authorization === "recipient"
      ? isRecipient
      : authorization === "requester_or_user"
        ? isRequester || actor.kind === "user"
        : authorization === "system"
          ? actor.kind === "system"
          : actor.kind === "system" || actor.kind === "supervisor" || actor.kind === "user";
    if (!allowed) throw new Error(`actor is not authorized for ${kind}`);
  }

  private activateForRequestTransition(
    request: RequestRow,
    kind: CoordinationRequestUpdateKind,
    nextState: CoordinationRequestState,
    joined: boolean,
    updateId: string,
    updatePayload: unknown,
    now: string,
  ): void {
    if (kind === "question" && request.requester_agent_id && this.agentSurvives(request.requester_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.requester_agent_id,
        kind: "coordination_question", priority: PRIORITY.urgent,
        dedupeKey: `request:${request.id}:question:${updateId}`,
        payload: { requestId: request.id, questionUpdateId: updateId, update: updatePayload ?? null },
        sourceKind: "request_update", sourceId: updateId, now,
      });
      return;
    }
    if ((kind === "answer" || kind === "dependency_resolved") && this.agentSurvives(request.recipient_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.recipient_agent_id,
        kind: kind === "answer" ? "coordination_answer" : "coordination_dependency_resolved",
        priority: kind === "answer" ? PRIORITY.urgent : PRIORITY.actionable,
        dedupeKey: `request:${request.id}:${kind}:${updateId}`,
        payload: { requestId: request.id, updateId, update: updatePayload ?? null },
        sourceKind: "request_update", sourceId: updateId, now,
      });
      return;
    }
    if ((kind === "cancelled" || kind === "superseded") && this.agentSurvives(request.recipient_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.recipient_agent_id,
        kind: `coordination_${kind}`, priority: PRIORITY.urgent,
        dedupeKey: `request:${request.id}:${kind}`,
        payload: { requestId: request.id, state: nextState, update: updatePayload ?? null },
        sourceKind: "request", sourceId: request.id, now,
      });
      return;
    }
    if (TERMINAL_REQUEST_STATES.has(nextState) && !joined && request.requester_agent_id && this.agentSurvives(request.requester_agent_id)) {
      this.createActivation({
        projectId: request.project_id, agentId: request.requester_agent_id,
        kind: "coordination_outcome",
        priority: nextState === "completed" ? PRIORITY.satisfied : PRIORITY.actionable,
        dedupeKey: `request:${request.id}:terminal`,
        payload: { requestId: request.id, state: nextState, update: updatePayload ?? null },
        sourceKind: "request", sourceId: request.id, now,
      });
    }
  }

  private reevaluateRequestJoins(requestId: string, now: string): void {
    const joins = this.sqlite.prepare(`
      SELECT j.* FROM coordination_joins j
      JOIN coordination_join_members m ON m.join_id = j.id
      WHERE m.request_id = ? AND j.state = 'open'
    `).all(requestId) as JoinRow[];
    for (const join of joins) {
      const requestRows = this.sqlite.prepare(`
        SELECT r.id, r.state FROM coordination_join_members m
        JOIN coordination_requests r ON r.id = m.request_id
        WHERE m.join_id = ? ORDER BY m.position
      `).all(join.id) as Array<{ id: string; state: CoordinationRequestState }>;
      const requestIds = requestRows.map((row) => row.id);
      const states = new Map(requestRows.map((row) => [row.id, row.state]));
      const next = evaluateCoordinationJoin({
        state: join.state,
        mode: join.mode,
        quorum: join.quorum,
        requestIds,
        satisfyingOutcomes: JSON.parse(join.satisfying_outcomes_json) as CoordinationRequestState[],
      }, states);
      if (next === join.state) continue;
      this.sqlite.prepare(`
        UPDATE coordination_joins SET state = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND state = 'open'
      `).run(next, now, now, join.id);
      if (joinTransitionNeedsActivation(join.state, next) && this.agentSurvives(join.owner_agent_id)) {
        this.createJoinActivation(join, next, now);
      }
    }
  }

  private createJoinActivation(join: JoinRow, state: CoordinationJoinState, now: string): void {
    const outcomes = this.sqlite.prepare(`
      SELECT r.id AS request_id, r.state, r.payload_json AS request_payload_json,
        u.id AS update_id, u.kind AS update_kind,
        u.payload_json AS update_payload_json, u.created_at AS update_created_at
      FROM coordination_join_members m
      JOIN coordination_requests r ON r.id = m.request_id
      LEFT JOIN coordination_request_updates u
        ON u.request_id = r.id AND u.resulting_version = r.version
      WHERE m.join_id = ?
      ORDER BY m.position
    `).all(join.id) as Array<{
      request_id: string;
      state: CoordinationRequestState;
      request_payload_json: string;
      update_id: string | null;
      update_kind: CoordinationRequestUpdateKind | null;
      update_payload_json: string | null;
      update_created_at: string | null;
    }>;
    const continuations = (JSON.parse(join.continuation_request_ids_json) as string[]).map((requestId) => {
      const request = this.getRequestRow(requestId) as RequestRow & { payload_json: string };
      return {
        requestId: request.id,
        state: request.state,
        request: JSON.parse(request.payload_json) as unknown,
      };
    });
    this.createActivation({
      projectId: join.project_id,
      agentId: join.owner_agent_id,
      kind: `coordination_join_${state}`,
      priority: state === "satisfied" ? PRIORITY.satisfied : PRIORITY.actionable,
      dedupeKey: `join:${join.id}:terminal`,
      payload: {
        joinId: join.id,
        state,
        outcomes: outcomes.map((outcome) => ({
          requestId: outcome.request_id,
          state: outcome.state,
          request: JSON.parse(outcome.request_payload_json) as unknown,
          ...(outcome.update_id ? {
            update: {
              id: outcome.update_id,
              kind: outcome.update_kind,
              payload: JSON.parse(outcome.update_payload_json ?? "null") as unknown,
              createdAt: outcome.update_created_at,
            },
          } : {}),
        })),
        ...(continuations.length ? {
          continuations,
          continuationInstruction: "Integrate the joined outcomes, then terminally update every nonterminal continuation request before ending this Run. Sending a message does not fulfill a correlated request.",
        } : {}),
      },
      sourceKind: "join",
      sourceId: join.id,
      now,
    });
  }

  private createActivation(input: {
    projectId: string; agentId: string; kind: string; priority: number; dedupeKey: string;
    dispatchPolicy?: ActivationDispatchPolicy; promptClass?: ActivationPromptClass;
    payload: unknown; sourceKind: string; sourceId: string; now: string;
  }): string {
    const id = randomUUID();
    const defaults = activationDefaults(input.kind, input.priority);
    const inserted = this.sqlite.prepare(`
      INSERT OR IGNORE INTO agent_activations (
        id, project_id, agent_id, kind, priority, dispatch_policy, prompt_class, state, dedupe_key,
        payload_json, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id, input.projectId, input.agentId, input.kind, input.priority,
      input.dispatchPolicy ?? defaults.dispatchPolicy,
      input.promptClass ?? defaults.promptClass,
      input.dedupeKey, stableJson(input.payload), input.now, input.now, input.now,
    ).changes;
    const activationId = inserted === 1 ? id : (this.sqlite.prepare(`
      SELECT id FROM agent_activations WHERE project_id = ? AND agent_id = ? AND dedupe_key = ?
    `).get(input.projectId, input.agentId, input.dedupeKey) as { id: string }).id;
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO activation_sources (activation_id, source_kind, source_id) VALUES (?, ?, ?)
    `).run(activationId, input.sourceKind, input.sourceId);
    if (inserted === 1) this.sqlite.prepare(`
      INSERT INTO activation_outbox (activation_id, event_kind, payload_json, created_at)
      VALUES (?, 'activation_ready', ?, ?)
    `).run(activationId, stableJson({ activationId, agentId: input.agentId, kind: input.kind }), input.now);
    return activationId;
  }

  private recoverExpiredUninjectedRuns(now: string): void {
    const runs = this.sqlite.prepare(`
      SELECT id, prompt_injection_state FROM scheduler_runs
      WHERE status IN ('leased', 'running') AND lease_expires_at <= ?
    `).all(now) as Array<{ id: string; prompt_injection_state: string }>;
    for (const run of runs) {
      if (run.prompt_injection_state === "not_injected") {
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'failed', updated_at = ?, terminal_at = ? WHERE id = ?
        `).run(now, now, run.id);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'retry_pending', available_at = ?, updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(now, now, run.id);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state = 'pending'
        `).run(now, now, run.id);
      } else {
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'outcome_unknown', updated_at = ?, terminal_at = ? WHERE id = ?
        `).run(now, now, run.id);
        this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(now, run.id);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('pending', 'submitted')
        `).run(now, now, run.id);
        this.markRelatedRequestsOutcomeUnknown(run.id, now, "lease_expired_after_prompt_injection", [
          "open", "in_progress", "waiting_dependency", "awaiting_answer",
        ]);
      }
    }
  }

  private markRelatedRequestsOutcomeUnknown(
    runId: string,
    now: string,
    reason: string,
    eligibleStates: CoordinationRequestState[],
    continuationEligibleStates: CoordinationRequestState[] = eligibleStates,
  ): void {
    const placeholders = eligibleStates.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT r.id
      FROM scheduler_run_activations ra
      JOIN scheduler_runs run ON run.id = ra.run_id
      JOIN activation_sources source ON source.activation_id = ra.activation_id
      LEFT JOIN coordination_request_updates update_record
        ON source.source_kind = 'request_update' AND update_record.id = source.source_id
      JOIN coordination_requests r ON r.id = CASE
        WHEN source.source_kind = 'request' THEN source.source_id
        WHEN source.source_kind = 'request_update' THEN update_record.request_id
      END
      WHERE ra.run_id = ?
        AND r.recipient_agent_id = run.agent_id
        AND r.state IN (${placeholders})
    `).all(runId, ...eligibleStates) as Array<{ id: string }>;
    const continuationPlaceholders = continuationEligibleStates.map(() => "?").join(", ");
    const continuationRows = this.sqlite.prepare(`
      SELECT DISTINCT request.id
      FROM scheduler_run_activations attached
      JOIN scheduler_runs run ON run.id = attached.run_id
      JOIN activation_sources source
        ON source.activation_id = attached.activation_id AND source.source_kind = 'join'
      JOIN coordination_joins join_record ON join_record.id = source.source_id
      JOIN json_each(join_record.continuation_request_ids_json) continuation
      JOIN coordination_requests request ON request.id = continuation.value
      WHERE attached.run_id = ?
        AND request.recipient_agent_id = run.agent_id
        AND request.state IN (${continuationPlaceholders})
    `).all(runId, ...continuationEligibleStates) as Array<{ id: string }>;
    const related = [...new Map([...rows, ...continuationRows].map((row) => [row.id, row])).values()];
    for (const row of related) this.updateRequest({
      requestId: row.id,
      updateId: `system:outcome-unknown:${runId}:${row.id}`,
      kind: "outcome_unknown",
      actor: { kind: "supervisor", id: "v3-runtime-supervisor" },
      payload: { reason, runId },
      now,
    });
  }

  private nextFence(agentId: string): number {
    const row = this.sqlite.prepare(`
      SELECT next_fencing_token FROM scheduler_agent_fences WHERE agent_id = ?
    `).get(agentId) as { next_fencing_token: number } | undefined;
    const token = row?.next_fencing_token ?? 1;
    this.sqlite.prepare(`
      INSERT INTO scheduler_agent_fences (agent_id, next_fencing_token) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET next_fencing_token = excluded.next_fencing_token
    `).run(agentId, token + 1);
    return token;
  }

  private getFencedRun(runId: string, fence: number): Record<string, unknown> {
    const run = this.sqlite.prepare(`SELECT * FROM scheduler_runs WHERE id = ? AND fencing_token = ?`).get(runId, fence) as Record<string, unknown> | undefined;
    if (!run) throw new Error("stale run fencing token");
    return run;
  }

  private mutateFencedRun(runId: string, fence: number, sql: string, values: unknown[]): void {
    const changed = this.sqlite.prepare(sql).run(...values).changes;
    if (changed !== 1) throw new Error(`stale run fencing token for ${runId}:${fence}`);
  }

  private idempotentReplay<T>(
    projectId: string, actorScope: string, operation: string, key: string, hash: string,
  ): T | undefined {
    const row = this.sqlite.prepare(`
      SELECT payload_hash, result_json FROM coordination_idempotency
      WHERE project_id = ? AND actor_scope = ? AND operation = ? AND idempotency_key = ?
    `).get(projectId, actorScope, operation, key) as { payload_hash: string; result_json: string } | undefined;
    if (!row) return undefined;
    if (row.payload_hash !== hash) throw new Error("idempotency key collision");
    return JSON.parse(row.result_json) as T;
  }

  private recordIdempotency(
    projectId: string, actorScope: string, operation: string, key: string,
    hash: string, result: unknown, now: string,
  ): void {
    this.sqlite.prepare(`
      INSERT INTO coordination_idempotency (
        project_id, actor_scope, operation, idempotency_key,
        payload_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, actorScope, operation, key, hash, stableJson(result), now);
  }
}
