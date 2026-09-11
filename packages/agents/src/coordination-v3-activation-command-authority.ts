import type Database from "better-sqlite3";
import type { RetryMessageDeliveryResponse } from "@ponderosa/core";
import { PRIORITY } from "./coordination-v3-activation.js";
import { payloadHash, stableJson } from "./coordination-v3-canonical-json.js";
import { CoordinationIdempotencyConflictError } from "./coordination-v3-errors.js";
import type { CoordinationV3RuntimeArtifactAuthority } from "./coordination-v3-runtime-artifact-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type {
  ActivationDispatchPolicy,
  ActivationPromptClass,
  ActivationTerminalOutcome,
  RuntimeArtifactInputV3,
  SettleUnavailableActivationResult,
} from "./coordination-v3-types.js";

interface DeliveryActivationRow {
  id: string;
  project_id: string;
  agent_id: string;
  scope_key: string;
  kind: string;
  priority: number;
  dispatch_policy: ActivationDispatchPolicy;
  prompt_class: ActivationPromptClass;
  state: string;
  payload_json: string;
}
type CreateActivation = (input: {
  projectId: string;
  agentId: string;
  kind: string;
  priority: number;
  dedupeKey: string;
  scopeKey: string;
  dispatchPolicy?: ActivationDispatchPolicy;
  promptClass?: ActivationPromptClass;
  payload: unknown;
  sourceKind: string;
  sourceId: string;
  now: string;
  externalIntake?: boolean;
}) => string;

export class CoordinationV3ActivationCommandAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly runtimeArtifactAuthority: CoordinationV3RuntimeArtifactAuthority,
    private readonly createActivation: CreateActivation,
    private readonly settleRequestsForFailedActivations: (
      activationIds: string[],
      now: string,
    ) => void,
  ) {}

  /** Create a new delivery attempt without duplicating the canonical user
   * message. Only the latest terminal attempt can advance the attempt chain. */
  retryMessageDelivery(input: {
    projectId: string;
    activationId: string;
    idempotencyKey: string;
    now?: string;
  }): RetryMessageDeliveryResponse {
    if (!input.idempotencyKey.trim()) throw new Error("delivery retry idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction((): RetryMessageDeliveryResponse => {
      const original = this.sqlite.prepare(`
        SELECT id, project_id, agent_id, scope_key, kind, priority, dispatch_policy,
          prompt_class, state, payload_json
        FROM agent_activations WHERE id = ? AND project_id = ?
      `).get(input.activationId, input.projectId) as Pick<DeliveryActivationRow,
        "id" | "project_id" | "agent_id" | "scope_key" | "kind" | "priority" |
        "dispatch_policy" | "prompt_class" | "state" | "payload_json"
      > | undefined;
      if (!original) return {
        accepted: false, replayed: false, state: "not_retryable", rejectionReason: "not_found",
      };

      const hash = payloadHash({ projectId: input.projectId, activationId: original.id });
      const replay = this.idempotentReplay<Omit<RetryMessageDeliveryResponse, "replayed">>(
        input.projectId, "user:local-operator", "retry_message_delivery", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };

      const sources = this.sqlite.prepare(`
        SELECT source.source_kind, source.source_id, runtime.project_id AS runtime_project_id,
          runtime.sender_json, runtime.intent, runtime.audience_json, runtime.payload_json
        FROM activation_sources source
        LEFT JOIN runtime_communications runtime
          ON source.source_kind = 'communication' AND runtime.id = source.source_id
        WHERE source.activation_id = ?
        ORDER BY source.source_kind, source.source_id
      `).all(original.id) as Array<{
        source_kind: string; source_id: string; runtime_project_id: string | null;
        sender_json: string | null; intent: string | null; audience_json: string | null; payload_json: string | null;
      }>;
      const communicationSources = sources.filter((source) => source.source_kind === "communication");
      const communicationAuthorityAgrees = communicationSources.length > 0 && communicationSources.every((source) => {
        if (source.runtime_project_id !== input.projectId || !source.sender_json || !source.intent ||
          !source.audience_json || !source.payload_json) return false;
        try {
          return this.runtimeScopeAuthority.runtimeCommunicationAuthorityAgrees({
            projectId: input.projectId,
            sender: JSON.parse(source.sender_json) as unknown,
            intent: source.intent,
            audience: JSON.parse(source.audience_json) as unknown,
            payload: JSON.parse(source.payload_json) as unknown,
            activations: [{ agentId: original.agent_id, kind: original.kind, scopeKey: original.scope_key }],
          });
        } catch {
          return false;
        }
      });
      if (!communicationAuthorityAgrees) return {
        accepted: false, replayed: false, state: "not_retryable", rejectionReason: "recipient_unavailable",
      };
      const authoredByOperator = communicationSources.some((source) => {
        if (!source.sender_json) return false;
        try {
          const sender = JSON.parse(source.sender_json) as { kind?: unknown; userId?: unknown };
          return sender.kind === "user" && sender.userId === "local-operator";
        } catch {
          return false;
        }
      });
      if (!authoredByOperator) return {
        accepted: false, replayed: false, state: "not_retryable", rejectionReason: "not_operator_message",
      };
      if (!this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(
        input.projectId,
        original.agent_id,
        original.scope_key,
      )) return {
        accepted: false, replayed: false, state: "not_retryable", rejectionReason: "recipient_unavailable",
      };

      const payload = JSON.parse(original.payload_json) as Record<string, unknown>;
      const lineage = this.sqlite.prepare(`
        SELECT root_activation_id, attempt_number
        FROM activation_delivery_retry_lineage
        WHERE successor_activation_id = ?
      `).get(original.id) as { root_activation_id: string; attempt_number: number } | undefined;
      const successor = this.sqlite.prepare(`
        SELECT successor_activation_id
        FROM activation_delivery_retry_lineage
        WHERE predecessor_activation_id = ?
      `).get(original.id) as { successor_activation_id: string } | undefined;
      if (successor) return {
        accepted: false, replayed: false, state: "not_retryable", rejectionReason: "stale_attempt",
      };

      let retryMayDuplicate = false;
      let retryable = original.state === "failed";
      if (original.state === "outcome_unknown") {
        retryMayDuplicate = true;
        const recovery = this.sqlite.prepare(`
          SELECT recovery.state, recovery_activation.state AS activation_state
          FROM scheduler_prompt_injections injection
          JOIN json_each(injection.activation_ids_json) member ON member.value = ?
          LEFT JOIN scheduler_steering_recoveries recovery ON recovery.injection_id = injection.id
          LEFT JOIN scheduler_steering_recovery_activations mapping
            ON mapping.injection_id = injection.id AND mapping.source_activation_id = ?
          LEFT JOIN agent_activations recovery_activation ON recovery_activation.id = mapping.recovery_activation_id
          ORDER BY injection.created_at DESC, injection.sequence DESC LIMIT 1
        `).get(original.id, original.id) as {
          state: "grace_period" | "wait_for_run" | "recovery_queued" | null;
          activation_state: string | null;
        } | undefined;
        retryable = !recovery || recovery.state === null ||
          ["failed", "outcome_unknown", "cancelled"].includes(recovery.activation_state ?? "");
      }
      if (!retryable) return {
        accepted: false, replayed: false, state: "not_retryable", rejectionReason: "not_terminal",
      };

      const rootActivationId = lineage?.root_activation_id ?? original.id;
      const attemptNumber = (lineage?.attempt_number ?? 0) + 1;
      const retryPayload = {
        ...payload,
        deliveryRetry: {
          previousActivationId: original.id,
          rootActivationId,
          previousState: original.state,
          requestedBy: "local-operator",
          requestedAt: now,
        },
        ...(retryMayDuplicate ? {
          steeringRecovery: {
            instruction: "This is an operator-requested retry after the previous delivery acknowledgement was not confirmed. Audit current state before acting. If the request was already completed, report that result instead of repeating side effects.",
          },
        } : {}),
      };
      const primarySource = communicationSources[0] ?? sources[0];
      if (!primarySource) throw new Error("delivery retry has no durable source");
      const activationId = this.createActivation({
        projectId: original.project_id,
        agentId: original.agent_id,
        scopeKey: original.scope_key,
        kind: original.kind,
        priority: Math.max(original.priority, PRIORITY.human),
        dispatchPolicy: original.dispatch_policy,
        promptClass: original.prompt_class,
        dedupeKey: `delivery-retry-successor:${original.id}`,
        payload: retryPayload,
        sourceKind: primarySource.source_kind,
        sourceId: primarySource.source_id,
        now,
        externalIntake: true,
      });
      this.sqlite.prepare(`
        INSERT INTO activation_delivery_retry_lineage (
          predecessor_activation_id, successor_activation_id,
          root_activation_id, attempt_number, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(original.id, activationId, rootActivationId, attemptNumber, now);
      for (const source of sources) this.sqlite.prepare(`
        INSERT OR IGNORE INTO activation_sources (activation_id, source_kind, source_id)
        VALUES (?, ?, ?)
      `).run(activationId, source.source_kind, source.source_id);
      const result: Omit<RetryMessageDeliveryResponse, "replayed"> = {
        accepted: true,
        state: "queued",
        activationId,
        targetAgentId: original.agent_id,
        ...(retryMayDuplicate ? { retryMayDuplicate: true } : {}),
      };
      this.recordIdempotency(
        input.projectId, "user:local-operator", "retry_message_delivery",
        input.idempotencyKey, hash, result, now,
      );
      return { ...result, replayed: false };
    })();
  }

  replayRetryMessageDelivery(input: {
    projectId: string;
    activationId: string;
    idempotencyKey: string;
  }): RetryMessageDeliveryResponse | undefined {
    if (!input.idempotencyKey.trim()) throw new Error("delivery retry idempotency key is required");
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<Omit<RetryMessageDeliveryResponse, "replayed">>(
        input.projectId,
        "user:local-operator",
        "retry_message_delivery",
        input.idempotencyKey,
        payloadHash({ projectId: input.projectId, activationId: input.activationId }),
      );
      return replay ? { ...replay, replayed: true } : undefined;
    })();
  }

  /** Acknowledge a terminal delivery failure without replaying the immutable
   * message. The original terminal outcome/error remain available for audit. */
  cancelTerminalMessageDelivery(input: {
    projectId: string;
    activationId: string;
    idempotencyKey: string;
    now?: string;
  }): { cancelled: boolean; replayed: boolean; state: "cancelled" | "not_cancellable"; targetAgentId?: string } {
    if (!input.idempotencyKey.trim()) throw new Error("delivery cancellation idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    const hash = payloadHash({ projectId: input.projectId, activationId: input.activationId });
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<{ cancelled: boolean; state: "cancelled" | "not_cancellable"; targetAgentId?: string }>(
        input.projectId, "user:local-operator", "cancel_terminal_message_delivery", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      const activation = this.sqlite.prepare(`
        SELECT agent_id FROM agent_activations WHERE id = ? AND project_id = ?
      `).get(input.activationId, input.projectId) as { agent_id: string } | undefined;
      const changed = this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE id = ? AND project_id = ? AND state IN ('failed', 'outcome_unknown')
      `).run(now, input.activationId, input.projectId).changes;
      const result = changed === 1
        ? { cancelled: true, state: "cancelled" as const, ...(activation ? { targetAgentId: activation.agent_id } : {}) }
        : { cancelled: false, state: "not_cancellable" as const };
      this.recordIdempotency(
        input.projectId, "user:local-operator", "cancel_terminal_message_delivery", input.idempotencyKey, hash, result, now,
      );
      return { ...result, replayed: false };
    })();
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
      if (changed === 1) this.settleRequestsForFailedActivations([activation.id], now);
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
    return this.sqlite.transaction(() => {
      const error = "activation recipient is missing or archived during startup reconciliation";
      const candidates = (this.sqlite.prepare(`
        SELECT id FROM agent_activations
        WHERE state IN ('pending', 'retry_pending') AND NOT EXISTS (
          SELECT 1 FROM agents
          WHERE agents.id = agent_activations.agent_id
            AND agents.project_id = agent_activations.project_id
            AND agents.archived = 0
        )
      `).all() as Array<{ id: string }>).map((row) => row.id);
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
      this.settleRequestsForFailedActivations(candidates, now);
      return { settled: changed };
    })();
  }

  replayCancelPendingActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    now?: string;
  }): { cancelled: boolean; replayed: true; status: "cancelled" | "delivery_started" } | undefined {
    if (!input.idempotencyKey.trim()) throw new Error("cancellation idempotency key is required");
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<{ cancelled: boolean; status: "cancelled" | "delivery_started" }>(
        input.projectId,
        "user:local-operator",
        "cancel_activation",
        input.idempotencyKey,
        payloadHash({ activationId: input.activationId }),
      );
      if (!replay) return undefined;
      if (replay.cancelled) this.ensureQueuedMessageCancellationOutbox(
        input.projectId,
        input.activationId,
        input.now ?? new Date().toISOString(),
      );
      return { ...replay, replayed: true as const };
    })();
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
      if (replay) {
        if (replay.cancelled) this.ensureQueuedMessageCancellationOutbox(
          input.projectId,
          input.activationId,
          now,
        );
        return { ...replay, replayed: true };
      }
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
      if (result.cancelled) this.ensureQueuedMessageCancellationOutbox(
        input.projectId,
        input.activationId,
        now,
      );
      return { ...result, replayed: false };
    })();
  }

  editPendingActivationText(input: {
    activationId: string;
    projectId: string;
    /** Stable operator-authored replacement used for idempotency. Prepared
     * document metadata may contain a first-attempt timestamp. */
    requestText: string;
    text: string;
    document?: Record<string, unknown>;
    artifactId?: string;
    resultRef?: string;
    revisionOwnerId: string;
    artifact?: RuntimeArtifactInputV3;
    revisionOutboxPayload: unknown;
    idempotencyKey: string;
    now?: string;
  }): { edited: boolean; replayed: boolean; status: "edited" | "delivery_started" } {
    if (!input.idempotencyKey.trim()) throw new Error("edit idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    const resolvedArtifact = input.artifact
      ? this.runtimeArtifactAuthority.resolveRuntimeArtifacts(
        input.projectId,
        [input.artifact],
        "queued edit",
      )[0]
      : undefined;
    const hash = payloadHash({
      activationId: input.activationId,
      requestText: input.requestText,
    });
    return this.sqlite.transaction(() => {
      if (resolvedArtifact) {
        this.runtimeArtifactAuthority.requireRuntimeArtifacts(
          input.projectId,
          [resolvedArtifact],
          "queued edit",
        );
      }
      const replay = this.idempotentReplay<{ edited: boolean; status: "edited" | "delivery_started" }>(
        input.projectId, "user:local-operator", "edit_activation", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      const sources = this.sqlite.prepare(`
        SELECT source.source_id
        FROM agent_activations activation
        JOIN activation_sources source
          ON source.activation_id = activation.id
          AND source.source_kind = 'communication'
        WHERE activation.id = ? AND activation.project_id = ?
        ORDER BY source.source_id
      `).all(input.activationId, input.projectId) as Array<{ source_id: string }>;
      let edited = false;
      if (sources.length === 1) {
        const siblings = this.sqlite.prepare(`
          SELECT activation.id, activation.state, activation.payload_json
          FROM activation_sources source
          JOIN agent_activations activation ON activation.id = source.activation_id
          WHERE source.source_kind = 'communication' AND source.source_id = ?
            AND activation.project_id = ?
          ORDER BY activation.id
        `).all(sources[0]!.source_id, input.projectId) as Array<{
          id: string;
          state: string;
          payload_json: string;
        }>;
        const targetIncluded = siblings.some((sibling) => sibling.id === input.activationId);
        const allPending = siblings.length > 0 && siblings.every((sibling) =>
          sibling.state === "pending" || sibling.state === "retry_pending");
        const updates = targetIncluded && allPending
          ? siblings.map((sibling) => {
            const payload = JSON.parse(sibling.payload_json) as Record<string, unknown>;
            const dispatch = payload.dispatch && typeof payload.dispatch === "object"
              ? payload.dispatch as Record<string, unknown>
              : {};
            const communication = payload.communication && typeof payload.communication === "object"
              ? payload.communication as Record<string, unknown>
              : undefined;
            if (communication?.eventId !== sources[0]!.source_id) return undefined;
            const { document: _oldDocument, ...communicationWithoutDocument } = communication;
            const {
              artifactId: _oldArtifactId,
              resultRef: _oldResultRef,
              ...dispatchWithoutArtifact
            } = dispatch;
            return {
              id: sibling.id,
              payload: stableJson({
                ...payload,
                communication: {
                  ...communicationWithoutDocument,
                  text: input.text,
                  ...(input.document ? { document: input.document } : {}),
                },
                dispatch: {
                  ...dispatchWithoutArtifact,
                  text: input.text,
                  ...(input.artifactId ? { artifactId: input.artifactId } : {}),
                  ...(input.resultRef ? { resultRef: input.resultRef } : {}),
                },
              }),
            };
          })
          : [];
        if (updates.length === siblings.length && updates.every((update) => update !== undefined)) {
          const updateActivation = this.sqlite.prepare(`
            UPDATE agent_activations SET payload_json = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND state IN ('pending', 'retry_pending')
          `);
          for (const update of updates) {
            if (updateActivation.run(
              update!.payload,
              now,
              update!.id,
              input.projectId,
            ).changes !== 1) {
              throw new Error("queued-message sibling changed during edit");
            }
          }
          edited = true;
          if (resolvedArtifact) {
            this.sqlite.prepare(`
              INSERT INTO runtime_artifacts (
                id, owner_kind, owner_id, project_id, role, title, media_type,
                blob_path, blob_hash, byte_length, origin_agent_id, execution_id, created_at
              ) VALUES (?, 'communication', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              resolvedArtifact.id, input.revisionOwnerId, input.projectId,
              resolvedArtifact.role, resolvedArtifact.title, resolvedArtifact.mediaType,
              resolvedArtifact.blobPath, resolvedArtifact.blobHash.toLowerCase(), resolvedArtifact.byteLength,
              resolvedArtifact.originAgentId ?? null, resolvedArtifact.executionId ?? null, now,
            );
          }
          this.sqlite.prepare(`
            INSERT INTO activation_outbox (activation_id, event_kind, payload_json, created_at)
            VALUES (?, 'communication_revision', ?, ?)
          `).run(input.activationId, stableJson(input.revisionOutboxPayload), now);
        }
      }
      const result = edited
        ? { edited: true, status: "edited" as const }
        : { edited: false, status: "delivery_started" as const };
      this.recordIdempotency(
        input.projectId, "user:local-operator", "edit_activation", input.idempotencyKey, hash, result, now,
      );
      return { ...result, replayed: false };
    }).immediate();
  }

  replayEditPendingActivationText(input: {
    activationId: string;
    projectId: string;
    requestText: string;
    idempotencyKey: string;
  }): { edited: boolean; replayed: true; status: "edited" | "delivery_started" } | undefined {
    if (!input.idempotencyKey.trim()) throw new Error("edit idempotency key is required");
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<{ edited: boolean; status: "edited" | "delivery_started" }>(
        input.projectId,
        "user:local-operator",
        "edit_activation",
        input.idempotencyKey,
        payloadHash({ activationId: input.activationId, requestText: input.requestText }),
      );
      return replay ? { ...replay, replayed: true as const } : undefined;
    })();
  }

  steerPendingActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
    now?: string;
  }): { steered: boolean; replayed: boolean; status: "steered" | "delivery_started" } {
    if (!input.idempotencyKey.trim()) throw new Error("steering idempotency key is required");
    const now = input.now ?? new Date().toISOString();
    const hash = payloadHash({ activationId: input.activationId });
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<{ steered: boolean; status: "steered" | "delivery_started" }>(
        input.projectId, "user:local-operator", "steer_activation", input.idempotencyKey, hash,
      );
      if (replay) return { ...replay, replayed: true };
      const changed = this.sqlite.prepare(`
        UPDATE agent_activations
        SET dispatch_policy = 'steer_or_run', priority = CASE WHEN priority < 100 THEN 100 ELSE priority END,
          updated_at = ?
        WHERE id = ? AND project_id = ? AND state IN ('pending', 'retry_pending')
      `).run(now, input.activationId, input.projectId).changes;
      const result = changed === 1
        ? { steered: true, status: "steered" as const }
        : { steered: false, status: "delivery_started" as const };
      this.recordIdempotency(
        input.projectId, "user:local-operator", "steer_activation", input.idempotencyKey, hash, result, now,
      );
      return { ...result, replayed: false };
    })();
  }

  replaySteerPendingActivation(input: {
    activationId: string;
    projectId: string;
    idempotencyKey: string;
  }): { steered: boolean; replayed: true; status: "steered" | "delivery_started" } | undefined {
    if (!input.idempotencyKey.trim()) throw new Error("steering idempotency key is required");
    return this.sqlite.transaction(() => {
      const replay = this.idempotentReplay<{ steered: boolean; status: "steered" | "delivery_started" }>(
        input.projectId,
        "user:local-operator",
        "steer_activation",
        input.idempotencyKey,
        payloadHash({ activationId: input.activationId }),
      );
      return replay ? { ...replay, replayed: true as const } : undefined;
    })();
  }

  private agentSurvives(agentId: string): boolean {
    return Boolean(this.sqlite.prepare(
      `SELECT 1 FROM agents WHERE id = ? AND archived = 0`,
    ).get(agentId));
  }

  private ensureQueuedMessageCancellationOutbox(
    projectId: string,
    activationId: string,
    now: string,
  ): void {
    const change = this.queuedMessageCancellationChange(activationId);
    if (!change || change.projectId !== projectId) return;
    const canonicalPayload = stableJson({
      activationId: change.activationId,
      projectId: change.projectId,
      agentId: change.agentId,
      conversationId: change.conversationId,
      action: change.action,
    });
    this.sqlite.prepare(`
      UPDATE activation_outbox
      SET payload_json = ?
      WHERE activation_id = ? AND event_kind = 'queued_message_change'
        AND processed_at IS NULL AND claimed_by IS NULL
    `).run(canonicalPayload, activationId);
    this.sqlite.prepare(`
      UPDATE activation_outbox
      SET dead_lettered_at = NULL, last_error = NULL, attempts = 0
      WHERE activation_id = ? AND event_kind = 'queued_message_change'
        AND processed_at IS NULL AND dead_lettered_at IS NOT NULL
        AND claimed_by IS NULL
    `).run(activationId);
    this.sqlite.prepare(`
      INSERT INTO activation_outbox (
        activation_id, event_kind, payload_json, created_at
      )
      SELECT ?, 'queued_message_change', ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM activation_outbox
        WHERE activation_id = ? AND event_kind = 'queued_message_change'
      )
    `).run(
      activationId,
      canonicalPayload,
      now,
      activationId,
    );
  }

  queuedMessageCancellationChange(activationId: string): {
    activationId: string;
    projectId: string;
    agentId: string;
    conversationId: string;
    action: "cancelled";
  } | undefined {
    const activation = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, dispatch_policy, state, payload_json
      FROM agent_activations
      WHERE id = ?
    `).get(activationId) as {
      id: string;
      project_id: string;
      agent_id: string;
      dispatch_policy: ActivationDispatchPolicy;
      state: string;
      payload_json: string;
    } | undefined;
    if (!activation || activation.dispatch_policy !== "next_run" ||
        activation.state !== "cancelled") return undefined;
    let payload: {
      communication?: {
        conversationId?: unknown;
        sender?: { kind?: unknown; userId?: unknown };
      };
      dispatch?: { conversationId?: unknown; sourceConversationId?: unknown };
    };
    try {
      payload = JSON.parse(activation.payload_json) as typeof payload;
    } catch {
      return undefined;
    }
    if (payload.communication?.sender?.kind !== "user" ||
        payload.communication.sender.userId !== "local-operator") return undefined;
    const conversationId = payload.dispatch?.sourceConversationId ??
      payload.dispatch?.conversationId ?? payload.communication.conversationId;
    if (typeof conversationId !== "string" || !conversationId) return undefined;
    const canonicalOwners = this.sqlite.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM agents
          WHERE id = ? AND project_id = ?
        ) AS owns_agent,
        EXISTS (
          SELECT 1 FROM conversations
          WHERE id = ? AND project_id = ?
        ) AS owns_conversation
    `).get(
      activation.agent_id,
      activation.project_id,
      conversationId,
      activation.project_id,
    ) as { owns_agent: number; owns_conversation: number };
    if (!canonicalOwners.owns_agent || !canonicalOwners.owns_conversation) {
      return undefined;
    }
    return {
      activationId: activation.id,
      projectId: activation.project_id,
      agentId: activation.agent_id,
      conversationId,
      action: "cancelled",
    };
  }

  private idempotentReplay<T>(
    projectId: string,
    actorScope: string,
    operation: string,
    key: string,
    hash: string,
  ): T | undefined {
    const row = this.sqlite.prepare(`
      SELECT payload_hash, result_json FROM coordination_idempotency
      WHERE project_id = ? AND actor_scope = ? AND operation = ? AND idempotency_key = ?
    `).get(projectId, actorScope, operation, key) as {
      payload_hash: string;
      result_json: string;
    } | undefined;
    if (!row) return undefined;
    if (row.payload_hash !== hash) throw new CoordinationIdempotencyConflictError();
    return JSON.parse(row.result_json) as T;
  }

  private recordIdempotency(
    projectId: string,
    actorScope: string,
    operation: string,
    key: string,
    hash: string,
    result: unknown,
    now: string,
  ): void {
    this.sqlite.prepare(`
      INSERT INTO coordination_idempotency (
        project_id, actor_scope, operation, idempotency_key,
        payload_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      actorScope,
      operation,
      key,
      hash,
      stableJson(result),
      now,
    );
  }
}
