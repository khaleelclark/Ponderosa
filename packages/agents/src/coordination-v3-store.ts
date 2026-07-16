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
  type MessageDeliveryReceiptDto,
  type RequestLifetime,
  type DerivedAgentAvailability,
} from "@ponderosa/core";

type Actor = { kind: "agent" | "user" | "system" | "supervisor"; id?: string };

export interface RunAuthorizationV3 {
  runId: string;
  agentId: string;
  fencingToken: number;
}

interface RequestRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
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
  conversation_id: string | null;
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
  scope_key: string;
  kind: string;
  priority: number;
  dispatch_policy: ActivationDispatchPolicy;
  prompt_class: ActivationPromptClass;
  state: string;
  dedupe_key: string;
  payload_json: string;
  available_at: string;
  delivery_failures: number;
  last_delivery_error: string | null;
  terminal_outcome: ActivationTerminalOutcome | null;
  terminal_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoordinateV3Input {
  projectId: string;
  /** Team Chat authorization boundary. Provider-authored coordination must set this. */
  conversationId?: string;
  requesterAgentId?: string;
  actorScope: string;
  idempotencyKey: string;
  /** Required for provider-authored mutations. Checked in the same SQLite
   * transaction as the mutation so cancellation cannot race authorization. */
  runAuthorization?: RunAuthorizationV3;
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
  /** Provider-authored updates may only target requests attached to this Run. */
  runAuthorization?: RunAuthorizationV3;
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
  conversationId?: string;
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
  scopeKey: string;
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
    deliveryFailures: number;
    lastDeliveryError?: string;
  }>;
}

export type ActivationDispatchPolicy = "steer_or_run" | "next_run";
export type ActivationPromptClass = "human" | "blocker" | "coordination" | "ordinary";
export type ActivationTerminalOutcome = "recipient_unavailable" | "permanent_failure" | "retry_exhausted";

export interface RuntimeCommunicationV3Input {
  id: string;
  projectId: string;
  sender: unknown;
  intent: string;
  audience: unknown;
  payload: unknown;
  scopeKey?: string;
  /** Required for provider-authored communications. */
  runAuthorization?: RunAuthorizationV3;
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
  audience: unknown;
  payload: unknown;
  createdAt: string;
}

export interface PendingActivationV3View {
  id: string;
  projectId: string;
  agentId: string;
  kind: string;
  state: "pending" | "retry_pending";
  payload: unknown;
  createdAt: string;
}

export interface TerminalActivationV3View {
  id: string;
  projectId: string;
  agentId: string;
  kind: string;
  outcome: ActivationTerminalOutcome;
  deliveryFailures: number;
  lastDeliveryError?: string;
  terminalAt: string;
}

export interface SettleUnavailableActivationResult {
  settled: boolean;
  replayed: boolean;
  status: "recipient_unavailable" | "not_pending";
}

export interface CoordinationWaitCycleV3 {
  agentIds: string[];
  requestIds: string[];
  oldestRequestAt: string;
}

export interface SteeringLease {
  runId: string;
  projectId: string;
  agentId: string;
  scopeKey: string;
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

export interface SteeringRecoveryDecisionResult {
  accepted: boolean;
  replayed: boolean;
  state: "waiting_for_run" | "recovery_queued" | "not_recoverable";
  agentId?: string;
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
  scopeKey?: string;
  messageId: string;
  kind: "human" | "urgent" | "ordinary";
  dispatchPolicy?: ActivationDispatchPolicy;
  promptClass?: ActivationPromptClass;
  payload: unknown;
  now?: string;
}

export type TriggerOccurrenceState = "pending" | "activated" | "debounced" | "dead_lettered";

export interface RecordTriggerOccurrenceInput {
  projectId: string;
  triggerId: string;
  occurrenceKey: string;
  agentId: string;
  conversationId?: string;
  payload: unknown;
  provenance: { source: string; [key: string]: unknown };
  debounceMs?: number;
  retryDelayMs?: number;
  priority?: number;
  dispatchPolicy?: ActivationDispatchPolicy;
  promptClass?: ActivationPromptClass;
  now?: string;
}

export interface TriggerOccurrenceResult {
  occurrenceId: string;
  state: TriggerOccurrenceState;
  activationId?: string;
  replayed: boolean;
}

export interface CoordinationV3StoreOptions {
  /** Backpressure only applies to new external/model-authored intake. Internal
   * terminal outcomes remain writable so quota pressure cannot strand work. */
  maxPendingActivationsPerAgent?: number;
  maxOutboxAttempts?: number;
  maxPendingTriggerOccurrencesPerAgent?: number;
  maxTriggerAttempts?: number;
}

const DEFAULT_MAX_PENDING_ACTIVATIONS_PER_AGENT = 1_000;
const DEFAULT_MAX_OUTBOX_ATTEMPTS = 8;
const DEFAULT_MAX_PENDING_TRIGGER_OCCURRENCES_PER_AGENT = 1_000;
const DEFAULT_MAX_TRIGGER_ATTEMPTS = 8;

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
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: CoordinationV3StoreOptions = {},
  ) {}

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
      if (input.runAuthorization) this.requireAuthorizedRun(input.runAuthorization, input.scopeKey);
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
        scopeKey: input.scopeKey ?? this.communicationScopeKey(input.payload, activation.agentId),
        kind: activation.kind,
        priority: activation.priority,
        dispatchPolicy: activation.dispatchPolicy,
        promptClass: activation.promptClass,
        dedupeKey: activation.dedupeKey ?? `communication:${input.id}:${activation.agentId}:${index}`,
        payload: input.payload,
        sourceKind: "communication",
        sourceId: input.id,
        externalIntake: true,
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
      SELECT id, project_id, audience_json, payload_json, created_at
      FROM runtime_communications
      WHERE (? IS NULL OR project_id = ?)
      ORDER BY created_at, id
    `).all(projectId ?? null, projectId ?? null) as Array<{
      id: string; project_id: string; audience_json: string; payload_json: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      audience: JSON.parse(row.audience_json) as unknown,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  runtimeCommunication(id: string): RuntimeCommunicationV3View | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, project_id, audience_json, payload_json, created_at FROM runtime_communications WHERE id = ?
    `).get(id) as { id: string; project_id: string; audience_json: string; payload_json: string; created_at: string } | undefined;
    return row ? {
      id: row.id,
      projectId: row.project_id,
      audience: JSON.parse(row.audience_json) as unknown,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    } : undefined;
  }

  /** Project immutable authored messages onto mutable, per-recipient delivery
   * evidence without rewriting the Communication or its chat projection. */
  deliveryReceiptsForCommunication(communicationEventId: string): MessageDeliveryReceiptDto[] {
    if (!communicationEventId.trim()) return [];
    const activations = this.sqlite.prepare(`
      SELECT DISTINCT activation.id, activation.agent_id, activation.state, activation.updated_at
      FROM activation_sources source
      JOIN runtime_communications runtime ON runtime.id = source.source_id
      JOIN agent_activations activation ON activation.id = source.activation_id
      WHERE source.source_kind = 'communication'
        AND (
          runtime.id = ? OR
          CASE WHEN json_valid(runtime.payload_json)
            THEN json_extract(runtime.payload_json, '$.communication.eventId')
            ELSE NULL
          END = ?
        )
      ORDER BY activation.created_at, activation.id
    `).all(communicationEventId, communicationEventId) as Array<{
      id: string; agent_id: string; state: string; updated_at: string;
    }>;
    return activations.map((activation) => {
      const injection = this.sqlite.prepare(`
        SELECT injection.id, injection.kind, injection.state, injection.updated_at
        FROM scheduler_prompt_injections injection, json_each(injection.activation_ids_json) member
        WHERE member.value = ?
        ORDER BY injection.created_at DESC, injection.sequence DESC LIMIT 1
      `).get(activation.id) as {
        id: string; kind: "turn" | "steer"; state: string; updated_at: string;
      } | undefined;
      const recovery = injection ? this.sqlite.prepare(`
        SELECT recovery.state, recovery.recover_at, recovery.updated_at,
          mapping.recovery_activation_id, recovery_activation.state AS recovery_activation_state
        FROM scheduler_steering_recoveries recovery
        LEFT JOIN scheduler_steering_recovery_activations mapping
          ON mapping.injection_id = recovery.injection_id AND mapping.source_activation_id = ?
        LEFT JOIN agent_activations recovery_activation ON recovery_activation.id = mapping.recovery_activation_id
        WHERE recovery.injection_id = ?
      `).get(activation.id, injection.id) as {
        state: "grace_period" | "wait_for_run" | "recovery_queued";
        recover_at: string; updated_at: string;
        recovery_activation_id: string | null; recovery_activation_state: string | null;
      } | undefined : undefined;
      let state: MessageDeliveryReceiptDto["state"];
      if (activation.state === "outcome_unknown") {
        if (!recovery) state = "undelivered";
        else if (recovery.state === "grace_period") state = "unconfirmed";
        else if (recovery.recovery_activation_state === "consumed") state = "recovered";
        else if (["failed", "outcome_unknown", "cancelled"].includes(recovery.recovery_activation_state ?? "")) state = "failed";
        else if (recovery.recovery_activation_state === "attached") state = "recovering";
        else state = recovery.state === "wait_for_run" ? "waiting_for_run" : "recovery_queued";
      } else if (activation.state === "failed") state = "failed";
      else if (activation.state === "cancelled") state = "cancelled";
      else if (activation.state === "consumed") state = "processed";
      else if (injection?.state === "acknowledged") state = "delivered";
      else if (injection?.kind === "steer" && (injection.state === "pending" || injection.state === "submitted")) state = "steering";
      else if (activation.state === "attached") state = "started";
      else state = "queued";
      return {
        activationId: activation.id,
        targetAgentId: activation.agent_id,
        state,
        updatedAt: recovery?.updated_at ?? injection?.updated_at ?? activation.updated_at,
        ...(injection ? { injectionId: injection.id } : {}),
        ...(recovery ? { recoveryAt: recovery.recover_at } : {}),
        ...(recovery?.state === "grace_period" ? { canLetCurrentRunFinish: true } : {}),
        ...(recovery?.recovery_activation_id ? { recoveryActivationId: recovery.recovery_activation_id } : {}),
      };
    });
  }

  pendingActivations(projectId?: string): PendingActivationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, kind, state, payload_json, created_at
      FROM agent_activations
      WHERE state IN ('pending', 'retry_pending') AND (? IS NULL OR project_id = ?)
      ORDER BY priority DESC, created_at, id
    `).all(projectId ?? null, projectId ?? null) as Array<{
      id: string; project_id: string; agent_id: string; kind: string;
      state: "pending" | "retry_pending"; payload_json: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      kind: row.kind,
      state: row.state,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  terminalActivations(projectId?: string, limit = 100): TerminalActivationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, kind, terminal_outcome, delivery_failures,
        last_delivery_error, terminal_at
      FROM agent_activations
      WHERE terminal_outcome IS NOT NULL AND (? IS NULL OR project_id = ?)
      ORDER BY terminal_at DESC, id DESC LIMIT ?
    `).all(projectId ?? null, projectId ?? null, Math.max(1, Math.min(limit, 500))) as Array<{
      id: string; project_id: string; agent_id: string; kind: string;
      terminal_outcome: ActivationTerminalOutcome; delivery_failures: number;
      last_delivery_error: string | null; terminal_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      kind: row.kind,
      outcome: row.terminal_outcome,
      deliveryFailures: row.delivery_failures,
      ...(row.last_delivery_error ? { lastDeliveryError: row.last_delivery_error } : {}),
      terminalAt: row.terminal_at,
    }));
  }

  /** Idempotent, preconditioned operator repair for one known poison
   * Activation. It cannot override in-flight or ambiguous provider work. */
  settleUnavailableActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    reason?: string;
    now?: string;
  }): SettleUnavailableActivationResult {
    if (!input.idempotencyKey.trim()) throw new Error("settlement idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    const error = (input.reason?.trim() || "activation recipient is missing or archived").slice(0, 2_000);
    const hash = payloadHash({ activationId: input.activationId, reason: error });
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<Omit<SettleUnavailableActivationResult, "replayed">>(
        input.projectId, "user:local-operator", "settle_unavailable_activation", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      const activation = this.sqlite.prepare(`
        SELECT id, agent_id, state, terminal_outcome FROM agent_activations
        WHERE id = ? AND project_id = ?
      `).get(input.activationId, input.projectId) as {
        id: string; agent_id: string; state: string; terminal_outcome: ActivationTerminalOutcome | null;
      } | undefined;
      if (!activation) throw new Error("activation not found in project");
      if (this.agentSurvives(activation.agent_id)) throw new Error("activation recipient is still available");
      const changed = this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'recipient_unavailable',
          terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?, updated_at = ?
        WHERE id = ? AND state IN ('pending', 'retry_pending')
      `).run(now, error, now, activation.id).changes;
      const result: Omit<SettleUnavailableActivationResult, "replayed"> = changed === 1 || activation.terminal_outcome === "recipient_unavailable"
        ? { settled: changed === 1, status: "recipient_unavailable" }
        : { settled: false, status: "not_pending" };
      this.recordIdempotency(
        input.projectId, "user:local-operator", "settle_unavailable_activation",
        input.idempotencyKey, hash, result, now,
      );
      return { ...result, replayed: false };
    })();
  }

  /** Startup integrity repair for detached work that can never be delivered.
   * Orphaned Runs must be recovered first so their pre-submission Activations
   * return to retry_pending before this scan. */
  reconcileUnavailableActivationRecipients(now = new Date().toISOString()): { settled: number } {
    const error = "activation recipient is missing or archived during startup reconciliation";
    const changed = this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'failed', terminal_outcome = 'recipient_unavailable',
        terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?, updated_at = ?
      WHERE state IN ('pending', 'retry_pending') AND NOT EXISTS (
        SELECT 1 FROM agents
        WHERE agents.id = agent_activations.agent_id
          AND agents.project_id = agent_activations.project_id
          AND agents.archived = 0
      )
    `).run(now, error, now).changes;
    return { settled: changed };
  }

  communicationRecipientAgentIds(communicationId: string): string[] {
    return (this.sqlite.prepare(`
      SELECT DISTINCT activation.agent_id
      FROM activation_sources source
      JOIN agent_activations activation ON activation.id = source.activation_id
      JOIN runtime_communications communication ON communication.id = source.source_id
      WHERE source.source_kind = 'communication'
        AND (source.source_id = ? OR json_extract(communication.payload_json, '$.communication.eventId') = ?)
      ORDER BY activation.agent_id
    `).all(communicationId, communicationId) as Array<{ agent_id: string }>).map((row) => row.agent_id);
  }

  cancelPendingActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    now?: string;
  }): { cancelled: boolean; replayed: boolean; status: "cancelled" | "delivery_started" } {
    if (!input.idempotencyKey.trim()) throw new Error("cancellation idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    const hash = payloadHash({ activationId: input.activationId });
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<{ cancelled: boolean; status: "cancelled" | "delivery_started" }>(
        input.projectId, "user:local-operator", "cancel_activation", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      const changed = this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE id = ? AND project_id = ? AND state IN ('pending', 'retry_pending')
      `).run(now, input.activationId, input.projectId).changes;
      const result = changed === 1
        ? { cancelled: true, status: "cancelled" as const }
        : { cancelled: false, status: "delivery_started" as const };
      this.recordIdempotency(
        input.projectId, "user:local-operator", "cancel_activation", input.idempotencyKey, hash, result, now,
      );
      return { ...result, replayed: false };
    })();
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

  /** Ordinary recipient-to-requester messages during correlated work are
   * audit copies regardless of provider tool order. The Request or Join owns
   * the single actionable wake; urgent messages remain an explicit override. */
  requesterIdsForRun(runId: string, agentId: string): string[] {
    const requestIds = this.requestIdsAttachedToRun(runId, agentId);
    if (requestIds.length === 0) return [];
    const placeholders = requestIds.map(() => "?").join(", ");
    return (this.sqlite.prepare(`
      SELECT DISTINCT requester_agent_id
      FROM coordination_requests
      WHERE id IN (${placeholders}) AND recipient_agent_id = ?
        AND requester_agent_id IS NOT NULL
      ORDER BY requester_agent_id
    `).all(...requestIds, agentId) as Array<{ requester_agent_id: string }>)
      .map((row) => row.requester_agent_id);
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

  /** A provider cache is scoped to one Team Chat at a time. Switching an
   * Agent between chats must reseed rather than carrying hidden context across
   * membership boundaries. */
  runChangesScope(runId: string, agentId: string): boolean {
    const current = this.sqlite.prepare(`
      SELECT scope_key FROM scheduler_runs WHERE id = ? AND agent_id = ?
    `).get(runId, agentId) as { scope_key: string } | undefined;
    if (!current) throw new Error("run not found");
    const previous = this.sqlite.prepare(`
      SELECT scope_key FROM scheduler_runs
      WHERE agent_id = ? AND id <> ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(agentId, runId) as { scope_key: string } | undefined;
    return Boolean(previous && previous.scope_key !== current.scope_key);
  }

  coordinate(input: CoordinateV3Input, now = new Date().toISOString()): CoordinateV3Result {
    if (!input.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    if (input.requests.length === 0 && !input.join?.requestIds?.length) {
      throw new Error("at least one new or existing request is required");
    }
    const normalized = {
      projectId: input.projectId,
      conversationId: input.conversationId ?? null,
      requesterAgentId: input.requesterAgentId,
      actorScope: input.actorScope,
      idempotencyKey: input.idempotencyKey,
      requests: input.requests.map((request) => ({ ...request, requestId: request.requestId ?? null })),
      join: input.join ? { ...input.join, id: input.join.id ?? null } : null,
    };
    const hash = payloadHash(normalized);

    return this.sqlite.transaction(() => {
      if (input.runAuthorization) this.requireAuthorizedRun(
        input.runAuthorization,
        input.conversationId ? `conversation:${input.conversationId}` : undefined,
      );
      const replay = this.idempotentReplay<CoordinateV3Result>(
        input.projectId, input.actorScope, "coordinate", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      this.requireProject(input.projectId);
      if (input.requesterAgentId) this.requireAgent(input.projectId, input.requesterAgentId);
      if (input.runAuthorization && !input.conversationId) {
        throw new Error("provider coordination requires a Team Chat scope");
      }
      if (input.conversationId) {
        this.requireConversation(input.projectId, input.conversationId);
        if (input.requesterAgentId) this.requireConversationMember(input.conversationId, input.requesterAgentId);
      }
      const scopeKey = input.conversationId
        ? `conversation:${input.conversationId}`
        : `agent:${input.requesterAgentId ?? input.requests[0]?.recipientAgentId ?? "system"}`;

      const requestIds: string[] = [];
      for (const request of input.requests) {
        this.requireAgent(input.projectId, request.recipientAgentId);
        if (input.conversationId) this.requireConversationMember(input.conversationId, request.recipientAgentId);
        this.validateLifetime(request.lifetime, now);
        const requestId = request.requestId ?? randomUUID();
        this.sqlite.prepare(`
          INSERT INTO coordination_requests (
            id, project_id, conversation_id, requester_agent_id, recipient_agent_id,
            communication_event_id, payload_json, state, version, lifetime_kind, deadline_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
        `).run(
          requestId, input.projectId, input.conversationId ?? null, input.requesterAgentId ?? null,
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
          scopeKey,
          kind: "coordination_request",
          priority: PRIORITY.request,
          dedupeKey: `request:${requestId}:created`,
          payload: { requestId, requesterAgentId: input.requesterAgentId ?? null, request: request.payload ?? null },
          sourceKind: "request",
          sourceId: requestId,
          externalIntake: true,
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
            SELECT project_id, conversation_id, requester_agent_id FROM coordination_requests WHERE id = ?
          `).get(requestId) as { project_id: string; conversation_id: string | null; requester_agent_id: string | null } | undefined;
          if (existing?.project_id === input.projectId && existing.requester_agent_id === input.requesterAgentId &&
              existing.conversation_id === (input.conversationId ?? null)) {
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
              continuation.conversation_id !== (input.conversationId ?? null) ||
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
          conversationId: input.conversationId ?? null,
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
            id, project_id, conversation_id, owner_agent_id, mode, quorum,
            satisfying_outcomes_json, state, deadline_at, definition_hash,
            continuation_request_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
        `).run(
          joinId, input.projectId, input.conversationId ?? null, input.requesterAgentId, mode, quorum,
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
        scopeKey: input.scopeKey ?? `agent:${input.agentId}`,
        kind: `${input.kind}_message`,
        priority: input.kind === "human" ? PRIORITY.human : input.kind === "urgent" ? PRIORITY.urgent : PRIORITY.ordinary,
        dispatchPolicy: input.dispatchPolicy ?? (input.kind === "ordinary" ? "next_run" : "steer_or_run"),
        promptClass: input.promptClass ?? (input.kind === "human" ? "human" : input.kind === "urgent" ? "blocker" : "ordinary"),
        dedupeKey: `message:${input.messageId}`,
        payload: input.payload,
        sourceKind: "message",
        sourceId: input.messageId,
        externalIntake: true,
        now,
      });
    })();
  }

  /** Persist external trigger intake before it can affect scheduling. The only
   * executable state this path may create is an Activation; Run ownership stays
   * exclusively in leaseNextRun(). */
  recordTriggerOccurrence(input: RecordTriggerOccurrenceInput): TriggerOccurrenceResult {
    if (!input.triggerId.trim()) throw new Error("triggerId is required");
    if (!input.occurrenceKey.trim()) throw new Error("occurrenceKey is required");
    if (!input.provenance.source?.trim()) throw new Error("trigger provenance source is required");
    const debounceMs = input.debounceMs ?? 0;
    const retryDelayMs = input.retryDelayMs ?? 1_000;
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 86_400_000) {
      throw new Error("trigger debounceMs must be an integer between 0 and 86400000");
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 3_600_000) {
      throw new Error("trigger retryDelayMs must be an integer between 1 and 3600000");
    }
    const priority = input.priority ?? PRIORITY.actionable;
    if (!Number.isInteger(priority) || priority < 0) throw new Error("trigger priority must be a non-negative integer");
    const now = input.now ?? new Date().toISOString();
    const scopeKey = input.conversationId ? `conversation:${input.conversationId}` : `agent:${input.agentId}`;
    const activationConfig = {
      conversationId: input.conversationId ?? null,
      priority,
      dispatchPolicy: input.dispatchPolicy ?? "next_run",
      promptClass: input.promptClass ?? "ordinary",
      retryDelayMs,
    };
    const hash = payloadHash({
      projectId: input.projectId,
      triggerId: input.triggerId,
      occurrenceKey: input.occurrenceKey,
      agentId: input.agentId,
      scopeKey,
      payload: input.payload,
      provenance: input.provenance,
      debounceMs,
      activationConfig,
    });

    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT id, input_hash, state, activation_id FROM trigger_occurrences
        WHERE trigger_id = ? AND occurrence_key = ?
      `).get(input.triggerId, input.occurrenceKey) as {
        id: string; input_hash: string; state: TriggerOccurrenceState; activation_id: string | null;
      } | undefined;
      if (existing) {
        if (existing.input_hash !== hash) throw new Error("trigger occurrence idempotency conflict");
        return {
          occurrenceId: existing.id,
          state: existing.state,
          ...(existing.activation_id ? { activationId: existing.activation_id } : {}),
          replayed: true,
        };
      }

      this.requireProject(input.projectId);
      this.requireAgent(input.projectId, input.agentId);
      if (input.conversationId) {
        this.requireConversation(input.projectId, input.conversationId);
        this.requireConversationMember(input.conversationId, input.agentId);
      }

      const occurrenceId = randomUUID();
      const cutoff = new Date(Date.parse(now) - debounceMs).toISOString();
      const debounced = debounceMs > 0 && Boolean(this.sqlite.prepare(`
        SELECT 1 FROM trigger_occurrences
        WHERE trigger_id = ? AND agent_id = ? AND scope_key = ? AND occurred_at >= ?
          AND state IN ('pending', 'activated', 'debounced')
        LIMIT 1
      `).get(input.triggerId, input.agentId, scopeKey, cutoff));
      const maximumPending = Math.max(
        1,
        this.options.maxPendingTriggerOccurrencesPerAgent
          ?? DEFAULT_MAX_PENDING_TRIGGER_OCCURRENCES_PER_AGENT,
      );
      const pending = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM trigger_occurrences
        WHERE agent_id = ? AND state = 'pending'
      `).get(input.agentId) as { count: number }).count;
      const overflow = !debounced && pending >= maximumPending;
      const initialState: TriggerOccurrenceState = debounced
        ? "debounced"
        : overflow ? "dead_lettered" : "pending";
      this.sqlite.prepare(`
        INSERT INTO trigger_occurrences (
          id, trigger_id, occurrence_key, project_id, agent_id, scope_key,
          payload_json, provenance_json, input_hash, activation_config_json,
          state, attempts, available_at, last_error, occurred_at, created_at,
          updated_at, dead_lettered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        occurrenceId, input.triggerId, input.occurrenceKey, input.projectId, input.agentId, scopeKey,
        stableJson(input.payload), stableJson(input.provenance), hash, stableJson(activationConfig),
        initialState, now,
        overflow ? `pending trigger occurrence limit reached for Agent (${maximumPending})` : null,
        now, now, now, overflow ? now : null,
      );
      if (initialState === "pending") this.processTriggerOccurrence(occurrenceId, now);
      return this.triggerOccurrenceResult(occurrenceId, false);
    })();
  }

  processDueTriggerOccurrences(
    now = new Date().toISOString(),
    limit = 100,
  ): { activated: number; pending: number; deadLettered: number } {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT id FROM trigger_occurrences
        WHERE state = 'pending' AND available_at <= ?
        ORDER BY available_at, id LIMIT ?
      `).all(now, Math.max(1, Math.min(limit, 500))) as Array<{ id: string }>;
      let activated = 0;
      let pending = 0;
      let deadLettered = 0;
      for (const row of rows) {
        const state = this.processTriggerOccurrence(row.id, now);
        if (state === "activated") activated += 1;
        else if (state === "pending") pending += 1;
        else if (state === "dead_lettered") deadLettered += 1;
      }
      return { activated, pending, deadLettered };
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
    pendingActivationOutbox: number;
    deadLetteredActivationOutbox: number;
    pendingProviderOperations: number;
    deadLetteredProviderOperations: number;
    pendingTriggerOccurrences: number;
    deadLetteredTriggerOccurrences: number;
    recipientUnavailableActivations: number;
    permanentFailureActivations: number;
    retryExhaustedActivations: number;
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
      pendingActivationOutbox: count("activation_outbox", "processed_at IS NULL AND dead_lettered_at IS NULL"),
      deadLetteredActivationOutbox: count("activation_outbox", "dead_lettered_at IS NOT NULL"),
      pendingProviderOperations: count("provider_operation_outbox", "state IN ('pending', 'claimed')"),
      deadLetteredProviderOperations: count("provider_operation_outbox", "state = 'failed'"),
      pendingTriggerOccurrences: count("trigger_occurrences", "state = 'pending'"),
      deadLetteredTriggerOccurrences: count("trigger_occurrences", "state = 'dead_lettered'"),
      recipientUnavailableActivations: count("agent_activations", "terminal_outcome = 'recipient_unavailable'"),
      permanentFailureActivations: count("agent_activations", "terminal_outcome = 'permanent_failure'"),
      retryExhaustedActivations: count("agent_activations", "terminal_outcome = 'retry_exhausted'"),
    };
  }

  /** Diagnose long-lived indefinite wait cycles without rejecting flexible
   * organization shapes. Consumers may surface these as operational warnings. */
  waitGraphCycles(
    now = new Date().toISOString(),
    minimumAgeMs = 5 * 60_000,
  ): CoordinationWaitCycleV3[] {
    const cutoff = new Date(Date.parse(now) - Math.max(0, minimumAgeMs)).toISOString();
    const edges = this.sqlite.prepare(`
      SELECT id, requester_agent_id, recipient_agent_id, created_at
      FROM coordination_requests
      WHERE requester_agent_id IS NOT NULL AND lifetime_kind = 'indefinite'
        AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
        AND created_at <= ?
      ORDER BY created_at, id
    `).all(cutoff) as Array<{
      id: string; requester_agent_id: string; recipient_agent_id: string; created_at: string;
    }>;
    const graph = new Map<string, Set<string>>();
    for (const edge of edges) {
      graph.set(edge.requester_agent_id, graph.get(edge.requester_agent_id) ?? new Set());
      graph.get(edge.requester_agent_id)!.add(edge.recipient_agent_id);
      if (!graph.has(edge.recipient_agent_id)) graph.set(edge.recipient_agent_id, new Set());
    }
    let index = 0;
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const stacked = new Set<string>();
    const components: string[][] = [];
    const visit = (agentId: string): void => {
      indices.set(agentId, index);
      low.set(agentId, index);
      index += 1;
      stack.push(agentId);
      stacked.add(agentId);
      for (const target of graph.get(agentId) ?? []) {
        if (!indices.has(target)) {
          visit(target);
          low.set(agentId, Math.min(low.get(agentId)!, low.get(target)!));
        } else if (stacked.has(target)) {
          low.set(agentId, Math.min(low.get(agentId)!, indices.get(target)!));
        }
      }
      if (low.get(agentId) !== indices.get(agentId)) return;
      const component: string[] = [];
      while (stack.length) {
        const member = stack.pop()!;
        stacked.delete(member);
        component.push(member);
        if (member === agentId) break;
      }
      if (component.length > 1) components.push(component.sort());
    };
    for (const agentId of [...graph.keys()].sort()) if (!indices.has(agentId)) visit(agentId);
    return components.map((agentIds) => {
      const members = new Set(agentIds);
      const cycleEdges = edges.filter((edge) =>
        members.has(edge.requester_agent_id) && members.has(edge.recipient_agent_id));
      return {
        agentIds,
        requestIds: cycleEdges.map((edge) => edge.id).sort(),
        oldestRequestAt: cycleEdges.map((edge) => edge.created_at).sort()[0]!,
      };
    });
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
      SELECT id, status, fencing_token, prompt_injection_state, context_disposition, lease_expires_at
      FROM scheduler_runs WHERE agent_id = ? AND status IN ('leased', 'running') LIMIT 1
    `).get(agentId) as {
      id: string; status: string; fencing_token: number;
      prompt_injection_state: "not_injected" | "injecting" | "injected";
      context_disposition: "fresh_task" | "continued_session" | "reseeded"; lease_expires_at: string;
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
        providerContextDisposition: activeRun.context_disposition,
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
      const request = this.getRequestRow(input.requestId);
      if (input.runAuthorization) {
        this.requireAuthorizedRun(input.runAuthorization);
        const attached = this.requestIdsAttachedToRun(input.runAuthorization.runId, input.runAuthorization.agentId);
        const requesterOwnedTerminalControl =
          (input.kind === "cancelled" || input.kind === "superseded") &&
          input.actor.kind === "agent" &&
          input.actor.id === request.requester_agent_id &&
          input.runAuthorization.agentId === request.requester_agent_id;
        if (!attached.includes(input.requestId) && !requesterOwnedTerminalControl) {
          throw new Error("request is not attached to the authoritative run");
        }
      }
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
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
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
      // This is intentionally idempotent with the server's pre-interrupt call.
      // Keeping it here makes direct store callers uphold the same fence-first
      // deletion invariant inside the projection-deletion transaction.
      this.cancelAgentRun({ agentId, idempotencyKey: `agent-delete:${agentId}`, now });
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
        UPDATE agent_activations SET state = 'failed', terminal_outcome = 'recipient_unavailable',
          terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?, updated_at = ?
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending')
      `).run(now, "activation recipient was deleted", now, agentId);
      this.sqlite.prepare(`
        UPDATE trigger_occurrences
        SET state = 'dead_lettered', last_error = 'recipient Agent deleted',
          updated_at = ?, dead_lettered_at = ?
        WHERE agent_id = ? AND state = 'pending'
      `).run(now, now, agentId);
    })();
  }

  /** Revoke one explicit Team Chat capability without affecting the Agent's
   * memberships or work in its other chats. */
  handleAgentConversationRemoval(
    agentId: string,
    conversationId: string,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      const scopeKey = `conversation:${conversationId}`;
      const active = this.sqlite.prepare(`
        SELECT 1 FROM scheduler_runs
        WHERE agent_id = ? AND scope_key = ? AND status IN ('leased', 'running')
      `).get(agentId, scopeKey);
      if (active) this.cancelAgentRun({
        agentId,
        idempotencyKey: `conversation-removal:${conversationId}:${agentId}`,
        now,
      });
      const joins = this.sqlite.prepare(`
        SELECT id FROM coordination_joins
        WHERE owner_agent_id = ? AND conversation_id = ? AND state = 'open'
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const join of joins) this.cancelJoin(join.id, agentId, now);
      const received = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE recipient_agent_id = ? AND conversation_id = ?
          AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const request of received) this.updateRequest({
        requestId: request.id,
        updateId: `system:conversation-recipient-unavailable:${conversationId}:${request.id}`,
        kind: "recipient_unavailable",
        actor: { kind: "system", id: "conversation-membership-removal" },
        payload: { conversationId },
        now,
      });
      const requested = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE requester_agent_id = ? AND conversation_id = ?
          AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
      `).all(agentId, conversationId) as Array<{ id: string }>;
      for (const request of requested) this.updateRequest({
        requestId: request.id,
        updateId: `user:conversation-request-cancelled:${conversationId}:${request.id}`,
        kind: "cancelled",
        actor: { kind: "user", id: "local-operator" },
        payload: { conversationId, reason: "requester_removed_from_conversation" },
        now,
      });
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'failed', terminal_outcome = 'recipient_unavailable',
          terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?, updated_at = ?
        WHERE agent_id = ? AND scope_key = ? AND state IN ('pending', 'retry_pending')
      `).run(now, "activation recipient is no longer a member of the Team Chat", now, agentId, scopeKey);
      this.sqlite.prepare(`
        UPDATE trigger_occurrences
        SET state = 'dead_lettered', last_error = 'Team Chat membership removed',
          updated_at = ?, dead_lettered_at = ?
        WHERE agent_id = ? AND scope_key = ? AND state = 'pending'
      `).run(now, now, agentId, scopeKey);
    })();
  }

  /** Fence and settle a whole project before any provider process is stopped.
   * The canonical project still exists during this phase, so a crash leaves a
   * retryable deletion with no live scheduler ownership. */
  prepareProjectDeletion(projectId: string, now = new Date().toISOString()): void {
    this.sqlite.transaction(() => {
      this.requireProject(projectId);
      const activeAgents = this.sqlite.prepare(`
        SELECT agent_id FROM scheduler_runs
        WHERE project_id = ? AND status IN ('leased', 'running')
        ORDER BY agent_id
      `).all(projectId) as Array<{ agent_id: string }>;
      for (const { agent_id } of activeAgents) {
        this.cancelAgentRun({ agentId: agent_id, idempotencyKey: `project-delete:${projectId}:${agent_id}`, now });
      }
      this.sqlite.prepare(`
        UPDATE coordination_joins
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE project_id = ? AND state = 'open'
      `).run(now, now, projectId);
      this.sqlite.prepare(`
        UPDATE coordination_requests
        SET state = 'cancelled', version = version + 1, open_question_update_id = NULL,
            updated_at = ?, terminal_at = ?
        WHERE project_id = ? AND state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')
      `).run(now, now, projectId);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE project_id = ? AND state IN ('pending', 'retry_pending', 'attached')
      `).run(now, projectId);
      this.sqlite.prepare(`
        UPDATE trigger_occurrences
        SET state = 'dead_lettered', last_error = 'Project deleted',
          updated_at = ?, dead_lettered_at = ?
        WHERE project_id = ? AND state = 'pending'
      `).run(now, now, projectId);
    })();
  }

  /** Remove every authoritative V3 row for a project. Call from the same
   * SQLite transaction that deletes the canonical project projections. */
  purgeProject(projectId: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`DELETE FROM trigger_occurrences WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM activation_outbox WHERE activation_id IN (
        SELECT id FROM agent_activations WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM provider_operation_outbox WHERE run_id IN (
        SELECT id FROM scheduler_runs WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM scheduler_cancellation_receipts WHERE agent_id IN (
        SELECT id FROM agents WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM scheduler_prompt_injections WHERE run_id IN (
        SELECT id FROM scheduler_runs WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM scheduler_run_activations WHERE run_id IN (
        SELECT id FROM scheduler_runs WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM scheduler_runs WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM activation_sources WHERE activation_id IN (
        SELECT id FROM agent_activations WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM agent_activations WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM coordination_join_members WHERE join_id IN (
        SELECT id FROM coordination_joins WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM coordination_joins WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM coordination_request_updates WHERE request_id IN (
        SELECT id FROM coordination_requests WHERE project_id = ?
      )`).run(projectId);
      this.sqlite.prepare(`DELETE FROM coordination_requests WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM runtime_communications WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM coordination_idempotency WHERE project_id = ?`).run(projectId);
      this.sqlite.prepare(`DELETE FROM scheduler_agent_fences WHERE agent_id IN (
        SELECT id FROM agents WHERE project_id = ?
      )`).run(projectId);
    })();
  }

  leaseNextRun(input: {
    workerId: string;
    now?: string;
    leaseMs?: number;
    coalesceLimit?: number;
    /** Agents whose configured runtime has durable negative availability evidence. */
    excludedAgentIds?: readonly string[];
  }): SchedulerLease | undefined {
    const now = input.now ?? new Date().toISOString();
    const leaseMs = input.leaseMs ?? 30_000;
    const limit = Math.max(1, Math.min(input.coalesceLimit ?? 8, 64));
    const excludedAgentIds = [...new Set(input.excludedAgentIds ?? [])];
    const excludedClause = excludedAgentIds.length
      ? `AND a.agent_id NOT IN (${excludedAgentIds.map(() => "?").join(", ")})`
      : "";
    return this.sqlite.transaction(() => {
      this.recoverExpiredUninjectedRuns(now);
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id, a.scope_key
        FROM agent_activations a
        WHERE a.state IN ('pending', 'retry_pending') AND a.available_at <= ?
          ${excludedClause}
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_runs r
            WHERE r.agent_id = a.agent_id AND r.status IN ('leased', 'running')
          )
        ORDER BY a.priority DESC, a.created_at, a.rowid
        LIMIT 1
      `).get(now, ...excludedAgentIds) as { agent_id: string; project_id: string; scope_key: string } | undefined;
      if (!candidate) return undefined;
      const queuedActivations = this.sqlite.prepare(`
        SELECT * FROM agent_activations
        WHERE agent_id = ? AND scope_key = ?
          AND state IN ('pending', 'retry_pending') AND available_at <= ?
        ORDER BY priority DESC, created_at, rowid LIMIT 64
      `).all(candidate.agent_id, candidate.scope_key, now) as ActivationRow[];
      // A new inbound request starts a fresh provider task context. Human
      // messages, join resumptions, answers, and blockers retain continuity,
      // so combining the two classes would make session disposition ambiguous.
      // Keep the lower-priority class pending for the next authoritative Run.
      const startsFreshTask = (activation: ActivationRow) => activation.kind === "coordination_request";
      const candidateStartsFreshTask = startsFreshTask(queuedActivations[0]!);
      const isExplicitQueuedTurn = (activation: ActivationRow): boolean => {
        try {
          const payload = JSON.parse(activation.payload_json) as {
            dispatch?: { activeRunDelivery?: unknown };
          };
          return payload.dispatch?.activeRunDelivery === "queue";
        } catch {
          return false;
        }
      };
      const candidateIsExplicitQueuedTurn = isExplicitQueuedTurn(queuedActivations[0]!);
      // Queue is an operator-selected turn boundary. Attaching multiple queued
      // turns to one Run lets a single provider response consume later work it
      // never handled. Isolate the candidate and never pull a later queued turn
      // into another compatible activation bundle.
      const activations = candidateIsExplicitQueuedTurn
        ? [queuedActivations[0]!]
        : queuedActivations
            .filter((activation) =>
              !isExplicitQueuedTurn(activation) &&
              startsFreshTask(activation) === candidateStartsFreshTask)
            .slice(0, limit);
      if (activations.length === 0) return undefined;
      const fencingToken = this.nextFence(candidate.agent_id);
      const runId = randomUUID();
      const injectionId = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      this.sqlite.prepare(`
        INSERT INTO scheduler_runs (
          id, project_id, agent_id, scope_key, status, lease_owner, lease_expires_at,
          fencing_token, prompt_injection_state, heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'leased', ?, ?, ?, 'not_injected', ?, ?, ?)
      `).run(runId, candidate.project_id, candidate.agent_id, candidate.scope_key, input.workerId, leaseExpiresAt, fencingToken, now, now, now);
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
        scopeKey: candidate.scope_key,
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
          deliveryFailures: activation.delivery_failures,
          ...(activation.last_delivery_error ? { lastDeliveryError: activation.last_delivery_error } : {}),
        })),
      };
    })();
  }

  leaseNextSteering(input: { workerId: string; now?: string; coalesceLimit?: number }): SteeringLease | undefined {
    const now = input.now ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(input.coalesceLimit ?? 4, 16));
    return this.sqlite.transaction(() => {
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id, a.scope_key, r.id AS run_id, r.fencing_token, r.provider_session_id
        FROM agent_activations a
        JOIN scheduler_runs r ON r.agent_id = a.agent_id AND r.scope_key = a.scope_key AND r.status = 'running'
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
        agent_id: string; project_id: string; scope_key: string; run_id: string;
        fencing_token: number; provider_session_id: string | null;
      } | undefined;
      if (!candidate) return undefined;
      const activations = this.sqlite.prepare(`
        SELECT * FROM agent_activations
        WHERE agent_id = ? AND scope_key = ?
          AND state IN ('pending', 'retry_pending') AND available_at <= ?
          AND dispatch_policy = 'steer_or_run'
        ORDER BY priority DESC, created_at, id LIMIT ?
      `).all(candidate.agent_id, candidate.scope_key, now, limit) as ActivationRow[];
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
        scopeKey: candidate.scope_key,
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
          deliveryFailures: activation.delivery_failures,
          ...(activation.last_delivery_error ? { lastDeliveryError: activation.last_delivery_error } : {}),
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
    recoveryGraceMs?: number; error?: string;
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
          UPDATE agent_activations SET state = 'outcome_unknown',
            last_delivery_error = COALESCE(?, last_delivery_error), updated_at = ?
          WHERE id IN (${placeholders}) AND state = 'attached'
        `).run(input.error?.slice(0, 2_000) ?? null, now, ...activationIds);
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
        WHERE id = ? AND run_id = ? AND state IN ('pending', 'submitted')
      `).run(now, now, input.injectionId, input.runId);
      const hasHumanActivation = activationIds.length > 0 && Boolean(this.sqlite.prepare(`
        SELECT 1 FROM agent_activations
        WHERE id IN (${activationIds.map(() => "?").join(", ")}) AND prompt_class = 'human' LIMIT 1
      `).get(...activationIds));
      if (hasHumanActivation) {
        const run = this.sqlite.prepare(`SELECT agent_id FROM scheduler_runs WHERE id = ?`)
          .get(input.runId) as { agent_id: string };
        const graceMs = Math.max(0, Math.min(input.recoveryGraceMs ?? 10_000, 60_000));
        this.sqlite.prepare(`
          INSERT OR IGNORE INTO scheduler_steering_recoveries (
            injection_id, run_id, agent_id, state, recover_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'grace_period', ?, ?, ?)
        `).run(
          input.injectionId, input.runId, run.agent_id,
          new Date(Date.parse(now) + graceMs).toISOString(), now, now,
        );
      }
    })();
  }

  letCurrentRunFinish(input: {
    injectionId: string; idempotencyKey: string; now?: string;
  }): SteeringRecoveryDecisionResult {
    if (!input.idempotencyKey.trim()) throw new Error("steering recovery idempotency key is required");
    return this.queueSteeringRecovery({
      injectionId: input.injectionId,
      interruptOriginalRun: false,
      idempotencyKey: input.idempotencyKey,
      now: input.now ?? new Date().toISOString(),
    });
  }

  /** Latest provider-confirmed steering fence for host-side output publication. */
  latestAcknowledgedSteeringInjection(runId: string): string | undefined {
    return (this.sqlite.prepare(`
      SELECT id FROM scheduler_prompt_injections
      WHERE run_id = ? AND kind = 'steer' AND state = 'acknowledged'
      ORDER BY sequence DESC, created_at DESC, id DESC LIMIT 1
    `).get(runId) as { id: string } | undefined)?.id;
  }

  /** Materialize due recovery work transactionally. The recovery Activation is
   * created before the exact originating Run is fenced and interrupted. */
  processDueSteeringRecoveries(now = new Date().toISOString(), limit = 100): string[] {
    const due = this.sqlite.prepare(`
      SELECT injection_id FROM scheduler_steering_recoveries
      WHERE state = 'grace_period' AND recover_at <= ?
      ORDER BY recover_at, injection_id LIMIT ?
    `).all(now, Math.max(1, Math.min(limit, 500))) as Array<{ injection_id: string }>;
    const changed = new Set<string>();
    for (const row of due) {
      const result = this.queueSteeringRecovery({
        injectionId: row.injection_id,
        interruptOriginalRun: true,
        idempotencyKey: `automatic:${row.injection_id}`,
        now,
      });
      if (result.accepted && result.agentId) changed.add(result.agentId);
    }
    return [...changed];
  }

  private queueSteeringRecovery(input: {
    injectionId: string; interruptOriginalRun: boolean; idempotencyKey: string; now: string;
  }): SteeringRecoveryDecisionResult {
    return this.sqlite.transaction((): SteeringRecoveryDecisionResult => {
      const recovery = this.sqlite.prepare(`
        SELECT run_id, agent_id, state FROM scheduler_steering_recoveries WHERE injection_id = ?
      `).get(input.injectionId) as {
        run_id: string; agent_id: string;
        state: "grace_period" | "wait_for_run" | "recovery_queued";
      } | undefined;
      if (!recovery) return { accepted: false, replayed: false, state: "not_recoverable" };
      if (recovery.state !== "grace_period") return {
        accepted: true,
        replayed: true,
        state: recovery.state === "wait_for_run" ? "waiting_for_run" : "recovery_queued",
        agentId: recovery.agent_id,
      };
      const sources = this.sqlite.prepare(`
        SELECT activation.id, activation.project_id, activation.agent_id, activation.scope_key,
          activation.priority, activation.payload_json
        FROM scheduler_prompt_injections injection, json_each(injection.activation_ids_json) member
        JOIN agent_activations activation ON activation.id = member.value
        WHERE injection.id = ?
        ORDER BY activation.created_at, activation.id
      `).all(input.injectionId) as Array<{
        id: string; project_id: string; agent_id: string; scope_key: string;
        priority: number; payload_json: string;
      }>;
      if (sources.length === 0) return { accepted: false, replayed: false, state: "not_recoverable" };
      for (const source of sources) {
        const originalPayload = JSON.parse(source.payload_json) as unknown;
        const payloadRecord = originalPayload && typeof originalPayload === "object" && !Array.isArray(originalPayload)
          ? originalPayload as Record<string, unknown>
          : { originalPayload };
        const recoveryActivationId = this.createActivation({
          projectId: source.project_id,
          agentId: source.agent_id,
          scopeKey: source.scope_key,
          kind: "steering_recovery",
          priority: Math.max(PRIORITY.human, source.priority),
          dispatchPolicy: "next_run",
          promptClass: "human",
          dedupeKey: `steering-recovery:${input.injectionId}:${source.id}`,
          payload: {
            ...payloadRecord,
            steeringRecovery: {
              sourceRunId: recovery.run_id,
              sourceInjectionId: input.injectionId,
              sourceActivationId: source.id,
              reason: "provider_steering_acknowledgement_unconfirmed",
              instruction: "Audit current project and runtime state before acting. Preserve completed results, then handle the original user message exactly once. Do not assume the prior Run either ignored or applied the uncertain steer.",
            },
          },
          sourceKind: "steering_recovery",
          sourceId: `${input.injectionId}:${source.id}`,
          now: input.now,
        });
        this.sqlite.prepare(`
          INSERT OR IGNORE INTO scheduler_steering_recovery_activations (
            injection_id, source_activation_id, recovery_activation_id
          ) VALUES (?, ?, ?)
        `).run(input.injectionId, source.id, recoveryActivationId);
      }
      const originalStillActive = Boolean(this.sqlite.prepare(`
        SELECT 1 FROM scheduler_runs WHERE id = ? AND agent_id = ? AND status IN ('leased', 'running')
      `).get(recovery.run_id, recovery.agent_id));
      const nextState = input.interruptOriginalRun || !originalStillActive ? "recovery_queued" : "wait_for_run";
      this.sqlite.prepare(`
        UPDATE scheduler_steering_recoveries
        SET state = ?, decision_idempotency_key = ?, updated_at = ?
        WHERE injection_id = ? AND state = 'grace_period'
      `).run(nextState, input.idempotencyKey, input.now, input.injectionId);
      if (input.interruptOriginalRun && originalStillActive) this.cancelAgentRun({
        agentId: recovery.agent_id,
        expectedRunId: recovery.run_id,
        idempotencyKey: `steering-recovery:${input.injectionId}`,
        now: input.now,
      });
      return {
        accepted: true,
        replayed: false,
        state: nextState === "wait_for_run" ? "waiting_for_run" : "recovery_queued",
        agentId: recovery.agent_id,
      };
    })();
  }

  markRunStarted(runId: string, fence: number, now = new Date().toISOString()): void {
    this.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
    `, [now, now, runId, fence]);
  }

  setRunContextDisposition(
    runId: string,
    fence: number,
    disposition: "fresh_task" | "continued_session" | "reseeded",
    now = new Date().toISOString(),
  ): void {
    this.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET context_disposition = ?, updated_at = ?
      WHERE id = ? AND fencing_token = ? AND status IN ('leased', 'running')
    `, [disposition, now, runId, fence]);
  }

  /** Persist exactly what Ponderosa submitted, plus the reconstructible source recipe. */
  recordProviderInput(input: {
    executionId: string;
    schedulerRunId: string;
    fencingToken: number;
    agentId: string;
    projectId: string;
    prompt: string;
    sourceManifest: import("@ponderosa/core").ProviderInputSourceManifest;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const run = this.getFencedRun(input.schedulerRunId, input.fencingToken);
    if (run.agent_id !== input.agentId || run.project_id !== input.projectId) {
      throw new Error("provider input scope does not match its scheduler run");
    }
    const hash = createHash("sha256").update(input.prompt).digest("hex");
    this.sqlite.prepare(`
      INSERT INTO provider_inputs (
        execution_id, scheduler_run_id, agent_id, project_id, provider_prompt,
        prompt_hash, source_manifest_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        provider_prompt = excluded.provider_prompt,
        prompt_hash = excluded.prompt_hash,
        source_manifest_json = excluded.source_manifest_json,
        updated_at = excluded.updated_at
    `).run(
      input.executionId, input.schedulerRunId, input.agentId, input.projectId,
      input.prompt, hash, stableJson(input.sourceManifest), now, now,
    );
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

  activationIdsForInjection(injectionId: string, runId: string): string[] {
    const row = this.sqlite.prepare(`
      SELECT activation_ids_json FROM scheduler_prompt_injections WHERE id = ? AND run_id = ?
    `).get(injectionId, runId) as { activation_ids_json: string } | undefined;
    return row ? JSON.parse(row.activation_ids_json) as string[] : [];
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
    retryable?: boolean;
    terminalOutcome?: Exclude<ActivationTerminalOutcome, "retry_exhausted">;
    error?: string;
    maxDeliveryFailures?: number;
    /** Explicit provider rejection proves the prompt did not execute despite submission. */
    confirmedNotExecuted?: boolean;
    failureKind?: "capacity" | "rate_limit" | "authentication" | "context" | "unknown";
  }): "retry" | "terminal" | "resume_same_run" | "outcome_unknown" {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const run = this.getFencedRun(input.runId, input.fencingToken);
      const disposition = input.confirmedNotExecuted ? "retry" : activationRetryDisposition({
        promptInjectionState: run.prompt_injection_state as "not_injected" | "injecting" | "injected",
        sameRunResumable: input.sameRunResumable,
      });
      if (disposition === "retry") {
        const error = (input.error ?? "scheduler dispatch rejected").slice(0, 2_000);
        const requestedMaximum = input.maxDeliveryFailures ?? 5;
        const maximum = Number.isFinite(requestedMaximum)
          ? Math.max(1, Math.floor(requestedMaximum)) : 5;
        const terminalOutcome = input.retryable === false
          ? input.terminalOutcome ?? "permanent_failure"
          : undefined;
        const currentFailures = (this.sqlite.prepare(`
          SELECT COALESCE(MAX(delivery_failures), 0) AS failures FROM agent_activations
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
        `).get(input.runId) as { failures: number }).failures;
        const capacityBackoff = input.failureKind === "capacity" || input.failureKind === "rate_limit"
          ? Math.min(120_000, 2_000 * (2 ** Math.min(currentFailures, 6)))
          : 1_000;
        const availableAt = new Date(Date.parse(now) + (input.retryDelayMs ?? capacityBackoff)).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET status = 'failed', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET delivery_failures = delivery_failures + 1,
            last_delivery_error = ?,
            state = CASE
              WHEN ? IS NOT NULL OR delivery_failures + 1 >= ? THEN 'failed'
              ELSE 'retry_pending'
            END,
            terminal_outcome = CASE
              WHEN ? IS NOT NULL THEN ?
              WHEN delivery_failures + 1 >= ? THEN 'retry_exhausted'
              ELSE NULL
            END,
            terminal_at = CASE
              WHEN ? IS NOT NULL OR delivery_failures + 1 >= ? THEN ?
              ELSE NULL
            END,
            available_at = ?, updated_at = ?
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'attached'
        `).run(
          error,
          terminalOutcome ?? null, maximum,
          terminalOutcome ?? null, terminalOutcome ?? null, maximum,
          terminalOutcome ?? null, maximum, now,
          availableAt, now, input.runId,
        );
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state = 'pending'
        `).run(now, now, input.runId);
        if (input.confirmedNotExecuted) this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('submitted', 'injected')
        `).run(now, now, input.runId);
        const pending = (this.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM agent_activations
          WHERE id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)
            AND state = 'retry_pending'
        `).get(input.runId) as { count: number }).count;
        if (pending === 0) return "terminal";
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

  cancelAgentRun(input: { agentId: string; idempotencyKey: string; expectedRunId?: string; now?: string }): CancellationResult {
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
        WHERE agent_id = ? AND status IN ('leased', 'running') AND (? IS NULL OR id = ?)
      `).get(input.agentId, input.expectedRunId ?? null, input.expectedRunId ?? null) as { id: string; fencing_token: number } | undefined;
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
        UPDATE agent_activations SET state = 'outcome_unknown', updated_at = ?
        WHERE id IN (
          SELECT activation.value
          FROM scheduler_prompt_injections injection, json_each(injection.activation_ids_json) activation
          WHERE injection.run_id = ? AND injection.state = 'submitted'
        ) AND state = 'attached'
      `).run(now, run.id);
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
        UPDATE scheduler_prompt_injections SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'submitted'
      `).run(now, now, run.id);
      // Fencing stops future provider work but cannot prove which request-owned
      // effects already happened. Terminalize correlated work so its no-Join
      // requester or owning Join receives a deterministic recovery wake.
      this.markRelatedRequestsOutcomeUnknown(
        run.id,
        now,
        "run_cancelled_by_operator",
        ["open", "in_progress", "waiting_dependency", "awaiting_answer"],
      );
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
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json) as unknown;
        } catch {
          this.sqlite.prepare(`
            UPDATE provider_operation_outbox
            SET state = 'failed', dead_lettered_at = ?, last_error = ?, updated_at = ?,
              claimed_by = NULL, claimed_at = NULL
            WHERE id = ?
          `).run(now, "invalid provider-operation payload", now, row.id);
          continue;
        }
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
          payload,
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
    const maximumAttempts = Math.max(1, this.options.maxOutboxAttempts ?? DEFAULT_MAX_OUTBOX_ATTEMPTS);
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        dead_lettered_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
        available_at = ?, last_error = ?, updated_at = ?,
        claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(maximumAttempts, maximumAttempts, now, availableAt, error.slice(0, 2_000), now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  deadLetterProviderOperation(id: number, workerId: string, error: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE provider_operation_outbox
      SET state = 'failed', dead_lettered_at = ?, last_error = ?, updated_at = ?,
        claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND state = 'claimed' AND claimed_by = ?
    `).run(now, error.slice(0, 2_000), now, id, workerId).changes;
    if (changed !== 1) throw new Error("provider operation claim is stale");
  }

  claimOutbox(workerId: string, limit = 50, now = new Date().toISOString(), staleMs = 30_000): OutboxItem[] {
    return this.sqlite.transaction(() => {
      const stale = new Date(Date.parse(now) - staleMs).toISOString();
      const rows = this.sqlite.prepare(`
        SELECT id, activation_id, event_kind, payload_json, attempts
        FROM activation_outbox
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND (claimed_at IS NULL OR claimed_at <= ?)
        ORDER BY id LIMIT ?
      `).all(stale, Math.max(1, Math.min(limit, 500))) as Array<{
        id: number; activation_id: string; event_kind: string; payload_json: string; attempts: number;
      }>;
      const claim = this.sqlite.prepare(`
        UPDATE activation_outbox SET claimed_by = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
          AND (claimed_at IS NULL OR claimed_at <= ?)
      `);
      const claimed: OutboxItem[] = [];
      for (const row of rows) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload_json) as unknown;
        } catch {
          this.sqlite.prepare(`
            UPDATE activation_outbox
            SET dead_lettered_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL
            WHERE id = ? AND processed_at IS NULL
          `).run(now, "invalid activation-outbox payload", row.id);
          continue;
        }
        if (claim.run(workerId, now, row.id, stale).changes !== 1) continue;
        claimed.push({
          id: row.id,
          activationId: row.activation_id,
          eventKind: row.event_kind,
          payload,
          attempts: row.attempts + 1,
        });
      }
      return claimed;
    })();
  }

  completeOutbox(id: number, workerId: string, now = new Date().toISOString()): void {
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox SET processed_at = ?, claimed_by = NULL, claimed_at = NULL
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).run(now, id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  failOutbox(id: number, workerId: string, error: string): void {
    const maximumAttempts = Math.max(1, this.options.maxOutboxAttempts ?? DEFAULT_MAX_OUTBOX_ATTEMPTS);
    const now = new Date().toISOString();
    const changed = this.sqlite.prepare(`
      UPDATE activation_outbox
      SET claimed_by = NULL, claimed_at = NULL, last_error = ?,
        dead_lettered_at = CASE WHEN attempts >= ? THEN ? ELSE dead_lettered_at END
      WHERE id = ? AND claimed_by = ? AND processed_at IS NULL AND dead_lettered_at IS NULL
    `).run(error.slice(0, 2_000), maximumAttempts, now, id, workerId).changes;
    if (changed !== 1) throw new Error("outbox claim is stale");
  }

  /** Settled delivery receipts are operational bookkeeping, not semantic
   * communication history. Keep a bounded diagnostic tail while preserving all
   * pending and dead-lettered work. */
  pruneSettledOutboxes(retain = 10_000): { activationOutbox: number; providerOperations: number } {
    const keep = Math.max(100, Math.floor(retain));
    return this.sqlite.transaction(() => {
      const activationOutbox = this.sqlite.prepare(`
        DELETE FROM activation_outbox
        WHERE processed_at IS NOT NULL AND id NOT IN (
          SELECT id FROM activation_outbox WHERE processed_at IS NOT NULL ORDER BY id DESC LIMIT ?
        )
      `).run(keep).changes;
      const providerOperations = this.sqlite.prepare(`
        DELETE FROM provider_operation_outbox
        WHERE state = 'completed' AND id NOT IN (
          SELECT id FROM provider_operation_outbox WHERE state = 'completed' ORDER BY id DESC LIMIT ?
        )
      `).run(keep).changes;
      return { activationOutbox, providerOperations };
    })();
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

  private requireConversation(projectId: string, conversationId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM conversations WHERE id = ? AND project_id = ? AND archived = 0
    `).get(conversationId, projectId)) throw new Error("Team Chat not found in project");
  }

  private requireConversationMember(conversationId: string, agentId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM agent_conversation_memberships
      WHERE conversation_id = ? AND agent_id = ?
    `).get(conversationId, agentId)) {
      throw new Error("every coordination participant must be an active member of this Team Chat");
    }
  }

  private coordinationScopeKey(conversationId: string | null, agentId: string): string {
    return conversationId ? `conversation:${conversationId}` : `agent:${agentId}`;
  }

  private communicationScopeKey(payload: unknown, agentId: string): string {
    if (payload && typeof payload === "object") {
      const root = payload as Record<string, unknown>;
      const communication = root.communication && typeof root.communication === "object"
        ? root.communication as Record<string, unknown>
        : root;
      if (typeof communication.conversationId === "string" && communication.conversationId) {
        return `conversation:${communication.conversationId}`;
      }
    }
    return `agent:${agentId}`;
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
        scopeKey: this.coordinationScopeKey(request.conversation_id, request.requester_agent_id),
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
        scopeKey: this.coordinationScopeKey(request.conversation_id, request.recipient_agent_id),
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
        scopeKey: this.coordinationScopeKey(request.conversation_id, request.recipient_agent_id),
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
        scopeKey: this.coordinationScopeKey(request.conversation_id, request.requester_agent_id),
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
      scopeKey: this.coordinationScopeKey(join.conversation_id, join.owner_agent_id),
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

  private triggerOccurrenceResult(occurrenceId: string, replayed: boolean): TriggerOccurrenceResult {
    const row = this.sqlite.prepare(`
      SELECT state, activation_id FROM trigger_occurrences WHERE id = ?
    `).get(occurrenceId) as { state: TriggerOccurrenceState; activation_id: string | null } | undefined;
    if (!row) throw new Error("trigger occurrence not found");
    return {
      occurrenceId,
      state: row.state,
      ...(row.activation_id ? { activationId: row.activation_id } : {}),
      replayed,
    };
  }

  private processTriggerOccurrence(occurrenceId: string, now: string): TriggerOccurrenceState {
    const row = this.sqlite.prepare(`
      SELECT trigger_id, occurrence_key, project_id, agent_id, scope_key,
        payload_json, provenance_json, activation_config_json, attempts
      FROM trigger_occurrences WHERE id = ? AND state = 'pending'
    `).get(occurrenceId) as {
      trigger_id: string;
      occurrence_key: string;
      project_id: string;
      agent_id: string;
      scope_key: string;
      payload_json: string;
      provenance_json: string;
      activation_config_json: string;
      attempts: number;
    } | undefined;
    if (!row) return this.triggerOccurrenceResult(occurrenceId, false).state;
    const attempts = row.attempts + 1;
    try {
      const config = JSON.parse(row.activation_config_json) as {
        conversationId: string | null;
        priority: number;
        dispatchPolicy: ActivationDispatchPolicy;
        promptClass: ActivationPromptClass;
        retryDelayMs: number;
      };
      const payload = JSON.parse(row.payload_json) as unknown;
      const provenance = JSON.parse(row.provenance_json) as unknown;
      this.requireProject(row.project_id);
      this.requireAgent(row.project_id, row.agent_id);
      if (config.conversationId) {
        this.requireConversation(row.project_id, config.conversationId);
        this.requireConversationMember(config.conversationId, row.agent_id);
      }
      const activationId = this.createActivation({
        projectId: row.project_id,
        agentId: row.agent_id,
        scopeKey: row.scope_key,
        kind: "trigger_occurrence",
        priority: config.priority,
        dispatchPolicy: config.dispatchPolicy,
        promptClass: config.promptClass,
        dedupeKey: `trigger:${row.trigger_id}:${row.occurrence_key}`,
        payload: { occurrenceId, triggerId: row.trigger_id, payload, provenance },
        sourceKind: "trigger_occurrence",
        sourceId: occurrenceId,
        externalIntake: true,
        now,
      });
      this.sqlite.prepare(`
        UPDATE trigger_occurrences
        SET state = 'activated', attempts = ?, activation_id = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(attempts, activationId, now, occurrenceId);
      return "activated";
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      const maximumAttempts = Math.max(1, this.options.maxTriggerAttempts ?? DEFAULT_MAX_TRIGGER_ATTEMPTS);
      let retryDelayMs = 1_000;
      try {
        const config = JSON.parse(row.activation_config_json) as { retryDelayMs?: unknown };
        if (typeof config.retryDelayMs === "number" && Number.isFinite(config.retryDelayMs)) {
          retryDelayMs = Math.max(1, Math.min(3_600_000, Math.floor(config.retryDelayMs)));
        }
      } catch {
        // The malformed config is itself the failure and will be dead-lettered
        // after the bounded attempt count.
      }
      const deadLettered = attempts >= maximumAttempts;
      this.sqlite.prepare(`
        UPDATE trigger_occurrences
        SET state = ?, attempts = ?, available_at = ?, last_error = ?, updated_at = ?, dead_lettered_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(
        deadLettered ? "dead_lettered" : "pending",
        attempts,
        new Date(Date.parse(now) + retryDelayMs).toISOString(),
        message,
        now,
        deadLettered ? now : null,
        occurrenceId,
      );
      return deadLettered ? "dead_lettered" : "pending";
    }
  }

  private createActivation(input: {
    projectId: string; agentId: string; kind: string; priority: number; dedupeKey: string;
    scopeKey: string;
    dispatchPolicy?: ActivationDispatchPolicy; promptClass?: ActivationPromptClass;
    payload: unknown; sourceKind: string; sourceId: string; now: string;
    externalIntake?: boolean;
  }): string {
    const existing = this.sqlite.prepare(`
      SELECT id FROM agent_activations WHERE project_id = ? AND agent_id = ? AND dedupe_key = ?
    `).get(input.projectId, input.agentId, input.dedupeKey) as { id: string } | undefined;
    if (existing) {
      this.sqlite.prepare(`
        INSERT OR IGNORE INTO activation_sources (activation_id, source_kind, source_id) VALUES (?, ?, ?)
      `).run(existing.id, input.sourceKind, input.sourceId);
      return existing.id;
    }
    if (input.externalIntake) {
      const maximum = Math.max(1, this.options.maxPendingActivationsPerAgent ?? DEFAULT_MAX_PENDING_ACTIVATIONS_PER_AGENT);
      const pending = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM agent_activations
        WHERE agent_id = ? AND state IN ('pending', 'retry_pending')
      `).get(input.agentId) as { count: number }).count;
      if (pending >= maximum) {
        throw new Error(`pending activation limit reached for Agent (${maximum})`);
      }
    }
    const id = randomUUID();
    const defaults = activationDefaults(input.kind, input.priority);
    const inserted = this.sqlite.prepare(`
      INSERT OR IGNORE INTO agent_activations (
        id, project_id, agent_id, scope_key, kind, priority, dispatch_policy, prompt_class, state, dedupe_key,
        payload_json, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id, input.projectId, input.agentId, input.scopeKey, input.kind, input.priority,
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

  private requireAuthorizedRun(authorization: RunAuthorizationV3, expectedScopeKey?: string): void {
    if (!Number.isSafeInteger(authorization.fencingToken) || authorization.fencingToken <= 0) {
      throw new Error("invalid run fencing token");
    }
    const authoritative = this.sqlite.prepare(`
      SELECT scope_key FROM scheduler_runs
      WHERE id = ? AND agent_id = ? AND fencing_token = ?
        AND status IN ('leased', 'running')
    `).get(authorization.runId, authorization.agentId, authorization.fencingToken) as { scope_key: string } | undefined;
    if (!authoritative) throw new Error("run is no longer authoritative");
    if (expectedScopeKey && authoritative.scope_key !== expectedScopeKey) {
      throw new Error("mutation scope does not match the authoritative run");
    }
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
