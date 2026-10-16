import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PRIORITY } from "./coordination-v3-activation.js";
import { stableJson } from "./coordination-v3-canonical-json.js";
import type { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import type { CoordinationV3QuestionAuthority } from "./coordination-v3-question-authority.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type {
  SteeringLease,
  RunAuthorizationV3,
  SteeringRecoveryDecisionResult,
} from "./coordination-v3-types.js";
import {
  publicActivationDeliveryError,
  providerSafeActivationPayload,
} from "./coordination-v3-provider-failure-projection.js";

interface ActivationRow {
  id: string;
  kind: string;
  priority: number;
  dispatch_policy: SteeringLease["activations"][number]["dispatchPolicy"];
  prompt_class: SteeringLease["activations"][number]["promptClass"];
  payload_json: string;
  delivery_failures: number;
  last_delivery_error: string | null;
  provider_failure_category: string | null;
}

type CancelAgentRunInput = {
  agentId: string;
  idempotencyKey: string;
  expectedRunId?: string;
  now?: string;
};

// Revalidate at claim time, not when the Decision answer was enqueued: its
// owning Run can finish before another same-Chat task starts. Every coalesced
// answer must belong to this Run's latest live root; ordinary steering keeps
// its established Agent/scope selection.
const decisionSteeringAuthority = (activation: string, runId: string): string => `NOT EXISTS (
  SELECT 1 FROM activation_sources decision
  WHERE decision.activation_id=${activation}.id AND decision.source_kind='task_decision'
    AND NOT EXISTS (SELECT 1 FROM required_reply_obligations obligation
      JOIN scheduler_runs owner_run ON owner_run.id=obligation.run_id
      WHERE obligation.run_id=${runId} AND owner_run.side_effects_fenced_at IS NULL
        AND obligation.agent_id=${activation}.agent_id AND obligation.project_id=${activation}.project_id
        AND obligation.scope_key=${activation}.scope_key AND obligation.blocking_decision_id=decision.source_id
        AND json_extract(${activation}.payload_json,'$.decision.id')=decision.source_id
        AND (obligation.state='pending' OR (obligation.delivery_phase='initial' AND obligation.state='satisfied'))
        AND json_extract(obligation.reply_authority_json,'$.intent') IN ('broadcast','direct_to_user')
        AND NOT EXISTS (SELECT 1 FROM required_reply_obligations newer JOIN scheduler_runs newer_run ON newer_run.id=newer.run_id
          WHERE newer.source_activation_id=obligation.source_activation_id AND newer.agent_id=obligation.agent_id
            AND newer.project_id=obligation.project_id AND newer.scope_key=obligation.scope_key AND newer_run.rowid>owner_run.rowid))
)`;

/** Claims, defers, settles, and recovers steering prompt injections. */
export class CoordinationV3SteeringAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly activationLifecycle: CoordinationV3ActivationLifecycleAuthority,
    private readonly questionAuthority: CoordinationV3QuestionAuthority,
    private readonly createActivation: (input: CreateActivationV3Input) => string,
    private readonly cancelAgentRun: (input: CancelAgentRunInput) => unknown,
  ) {}

  leaseNextSteering(input: {
    workerId: string;
    now?: string;
    coalesceLimit?: number;
  }): SteeringLease | undefined {
    const now = input.now ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(input.coalesceLimit ?? 4, 16));
    return this.sqlite.transaction(() => {
      this.activationLifecycle.settleUnauthorizedPendingActivations(now);
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id, a.scope_key, r.id AS run_id,
          r.fencing_token, r.provider_session_id
        FROM agent_activations a
        JOIN scheduler_runs r
          ON r.agent_id = a.agent_id AND r.scope_key = a.scope_key
          AND r.status = 'running'
        WHERE a.state IN ('pending', 'retry_pending')
          AND a.available_at <= ?
          AND a.dispatch_policy = 'steer_or_run'
          AND NOT EXISTS (SELECT 1 FROM activation_sources held WHERE held.activation_id=a.id AND held.source_kind IN ('task_decision_repair_wait','task_reply_repair_wait'))
          AND ${decisionSteeringAuthority('a', 'r.id')}
          AND (a.kind = 'context_rollover_handoff' OR NOT EXISTS (
            SELECT 1 FROM context_rollovers rollover
            WHERE rollover.agent_id = a.agent_id
              AND rollover.state IN ('requested','handoff_committed','session_retiring','continuation_ready')
          ))
          AND NOT EXISTS (
            SELECT 1 FROM activation_outbox audit
            WHERE audit.activation_id = a.id
              AND audit.event_kind = 'communication_revision'
              AND audit.processed_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_prompt_injections injection
            WHERE injection.run_id = r.id AND injection.kind = 'steer'
              AND injection.state IN ('pending', 'submitted')
          )
        ORDER BY a.priority DESC, a.created_at, a.id
        LIMIT 1
      `).get(now) as {
        agent_id: string;
        project_id: string;
        scope_key: string;
        run_id: string;
        fencing_token: number;
        provider_session_id: string | null;
      } | undefined;
      if (!candidate) return undefined;
      const activations = this.sqlite.prepare(`
        SELECT * FROM agent_activations
        WHERE agent_id = ? AND scope_key = ?
          AND state IN ('pending', 'retry_pending')
          AND available_at <= ?
          AND dispatch_policy = 'steer_or_run'
          AND NOT EXISTS (SELECT 1 FROM activation_sources held WHERE held.activation_id=agent_activations.id AND held.source_kind IN ('task_decision_repair_wait','task_reply_repair_wait'))
          AND ${decisionSteeringAuthority('agent_activations', '?')}
          AND (kind = 'context_rollover_handoff' OR NOT EXISTS (
            SELECT 1 FROM context_rollovers rollover
            WHERE rollover.agent_id = agent_activations.agent_id
              AND rollover.state IN ('requested','handoff_committed','session_retiring','continuation_ready')
          ))
          AND NOT EXISTS (
            SELECT 1 FROM activation_outbox audit
            WHERE audit.activation_id = agent_activations.id
              AND audit.event_kind = 'communication_revision'
              AND audit.processed_at IS NULL
          )
        ORDER BY priority DESC, created_at, id LIMIT ?
      `).all(
        candidate.agent_id,
        candidate.scope_key,
        now,
        candidate.run_id,
        limit,
      ) as ActivationRow[];
      if (activations.length === 0) return undefined;
      if (!this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(
        candidate.project_id,
        candidate.agent_id,
        candidate.scope_key,
      )) {
        this.activationLifecycle.settleUnauthorizedPendingActivations(now);
        return undefined;
      }
      const injectionId = randomUUID();
      const sequence = (this.sqlite.prepare(`
        SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
        FROM scheduler_prompt_injections WHERE run_id = ?
      `).get(candidate.run_id) as { sequence: number }).sequence;
      const attach = this.sqlite.prepare(`
        INSERT OR IGNORE INTO scheduler_run_activations (
          run_id, activation_id, attached_at
        ) VALUES (?, ?, ?)
      `);
      const setAttached = this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'attached', updated_at = ?, steering_wait_reason = NULL
        WHERE id = ? AND state IN ('pending', 'retry_pending')
      `);
      for (const activation of activations) {
        if (setAttached.run(now, activation.id).changes !== 1) {
          throw new Error("steering activation claim race");
        }
        attach.run(candidate.run_id, activation.id, now);
      }
      this.sqlite.prepare(`
        INSERT INTO scheduler_prompt_injections (
          id, run_id, kind, sequence, state, prompt_hash,
          activation_ids_json, created_at, updated_at
        ) VALUES (?, ?, 'steer', ?, 'pending', '', ?, ?, ?)
      `).run(
        injectionId,
        candidate.run_id,
        sequence,
        stableJson(activations.map((activation) => activation.id)),
        now,
        now,
      );
      return {
        runId: candidate.run_id,
        projectId: candidate.project_id,
        agentId: candidate.agent_id,
        scopeKey: candidate.scope_key,
        fencingToken: candidate.fencing_token,
        injectionId,
        ...(candidate.provider_session_id
          ? { providerSessionId: candidate.provider_session_id }
          : {}),
        activationIds: activations.map((activation) => activation.id),
        activations: activations.map((activation) => {
          const lastDeliveryError = publicActivationDeliveryError({
            lastDeliveryError: activation.last_delivery_error,
            providerFailureCategory: activation.provider_failure_category,
          });
          return {
            id: activation.id,
            kind: activation.kind,
            priority: activation.priority,
            dispatchPolicy: activation.dispatch_policy,
            promptClass: activation.prompt_class,
            payload: providerSafeActivationPayload(
              this.sqlite,
              activation.id,
              activation.payload_json,
            ),
            deliveryFailures: activation.delivery_failures,
            ...(lastDeliveryError ? { lastDeliveryError } : {}),
          };
        }),
      };
    })();
  }

  failSteeringForActivationCompilation(input: {
    injectionId: string;
    runId: string;
    fencingToken: number;
    activationId: string;
    errorCode: string;
    errorDetail?: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(input.runId, input.fencingToken);
      if (run.status !== "running") {
        throw new Error("Run is not authoritative for steering containment");
      }
      const injection = this.sqlite.prepare(`
        SELECT activation_ids_json FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ? AND kind = 'steer' AND state = 'pending'
      `).get(input.injectionId, input.runId) as { activation_ids_json: string } | undefined;
      if (!injection) throw new Error("pending steering injection not found");
      const activationIds = JSON.parse(injection.activation_ids_json) as string[];
      if (!activationIds.includes(input.activationId)) {
        throw new Error("offending activation is not attached to the steering injection");
      }
      const detail = input.errorDetail
        ? (input.errorCode + ": " + input.errorDetail).slice(0, 2_000)
        : input.errorCode;
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'permanent_failure',
          last_delivery_error = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND state = 'attached'
      `).run(detail, now, now, input.activationId);
      const retriedIds = activationIds.filter((id) => id !== input.activationId);
      if (retriedIds.length) {
        const placeholders = retriedIds.map(() => "?").join(", ");
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'retry_pending', available_at = ?, updated_at = ?,
            last_delivery_error = ?, terminal_outcome = NULL, terminal_at = NULL
          WHERE id IN (${placeholders}) AND state = 'attached'
        `).run(
          now,
          now,
          "Steering preparation was retried after isolating another activation.",
          ...retriedIds,
        );
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE id = ? AND run_id = ? AND state = 'pending'
      `).run(now, now, input.injectionId, input.runId);
      this.activationLifecycle.settleRequestsForFailedActivations(
        [input.activationId],
        now,
      );
    })();
  }

  deferSteering(input: {
    injectionId: string;
    runId: string;
    fencingToken: number;
    retryDelayMs?: number;
    preserveSteering?: boolean;
    waitReason?: "provider_not_ready" | "provider_unsupported" | "preparation_retry";
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const availableAt = new Date(
      Date.parse(now) + (input.retryDelayMs ?? 0),
    ).toISOString();
    this.sqlite.transaction(() => {
      this.support.getFencedRun(input.runId, input.fencingToken);
      const injection = this.sqlite.prepare(`
        SELECT activation_ids_json FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ?
          AND state IN ('pending', 'submitted')
      `).get(input.injectionId, input.runId) as {
        activation_ids_json: string;
      } | undefined;
      if (!injection) throw new Error("pending steering injection not found");
      const activationIds = JSON.parse(
        injection.activation_ids_json,
      ) as string[];
      if (activationIds.length) {
        const placeholders = activationIds.map(() => "?").join(", ");
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'retry_pending',
            dispatch_policy = CASE
              WHEN ? = 1 THEN dispatch_policy
              ELSE 'next_run'
            END,
            available_at = ?, updated_at = ?, steering_wait_reason = ?
          WHERE id IN (${placeholders}) AND state = 'attached'
        `).run(input.preserveSteering ? 1 : 0, availableAt, now,
          input.preserveSteering ? input.waitReason ?? null : null, ...activationIds);
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE id = ? AND run_id = ?
          AND state IN ('pending', 'submitted')
      `).run(now, now, input.injectionId, input.runId);
    })();
  }

  markSteeringOutcomeUnknown(input: {
    injectionId: string;
    runId: string;
    fencingToken: number;
    now?: string;
    recoveryGraceMs?: number;
    error?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      this.support.getFencedRun(input.runId, input.fencingToken);
      const injection = this.sqlite.prepare(`
        SELECT activation_ids_json FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ?
          AND state IN ('pending', 'submitted')
      `).get(input.injectionId, input.runId) as {
        activation_ids_json: string;
      } | undefined;
      if (!injection) throw new Error("unsettled steering injection not found");
      const activationIds = JSON.parse(
        injection.activation_ids_json,
      ) as string[];
      this.questionAuthority.terminalizeUnansweredQuestionsForActivations(
        activationIds,
        input.runId,
        now,
        "steering_outcome_unknown",
      );
      if (activationIds.length) {
        const placeholders = activationIds.map(() => "?").join(", ");
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'outcome_unknown',
            last_delivery_error = COALESCE(?, last_delivery_error),
            updated_at = ?
          WHERE id IN (${placeholders}) AND state = 'attached'
        `).run(
          input.error?.slice(0, 2_000) ?? null,
          now,
          ...activationIds,
        );
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
        WHERE id = ? AND run_id = ?
          AND state IN ('pending', 'submitted')
      `).run(now, now, input.injectionId, input.runId);
      const hasHumanActivation =
        activationIds.length > 0 &&
        Boolean(this.sqlite.prepare(`
          SELECT 1 FROM agent_activations
          WHERE id IN (${activationIds.map(() => "?").join(", ")})
            AND prompt_class = 'human' LIMIT 1
        `).get(...activationIds));
      if (hasHumanActivation) {
        const run = this.sqlite.prepare(`
          SELECT agent_id FROM scheduler_runs WHERE id = ?
        `).get(input.runId) as { agent_id: string };
        const graceMs = Math.max(
          0,
          Math.min(input.recoveryGraceMs ?? 10_000, 60_000),
        );
        this.sqlite.prepare(`
          INSERT OR IGNORE INTO scheduler_steering_recoveries (
            injection_id, run_id, agent_id, state, recover_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'grace_period', ?, ?, ?)
        `).run(
          input.injectionId,
          input.runId,
          run.agent_id,
          new Date(Date.parse(now) + graceMs).toISOString(),
          now,
          now,
        );
      }
    })();
  }

  letCurrentRunFinish(input: {
    injectionId: string;
    idempotencyKey: string;
    now?: string;
  }): SteeringRecoveryDecisionResult {
    if (!input.idempotencyKey.trim()) {
      throw new Error("steering recovery idempotency key is required");
    }
    return this.queueSteeringRecovery({
      injectionId: input.injectionId,
      interruptOriginalRun: false,
      idempotencyKey: input.idempotencyKey,
      now: input.now ?? new Date().toISOString(),
    });
  }

  /** Current acknowledged prompt identity, not only the optional steer kind.
   * Null keeps the existing no-steering legacy call contract; a supplied ID
   * must identify the current acknowledged prompt on this authoritative Run.
   */
  requireCurrentPromptInjection(
    authorization: RunAuthorizationV3,
    injectionId: string | null,
  ): void {
    this.support.requireAuthorizedRun(authorization);
    const latest = this.latestAcknowledgedPromptInjection(authorization.runId);
    if (latest?.kind === "steer" && injectionId !== latest.id) {
      throw new Error("output is fenced behind acknowledged steering; reconsider the newest steering prompt");
    }
    if (injectionId === null) return;
    if (latest?.id !== injectionId) {
      throw new Error("output prompt injection is not an acknowledged current prompt for this Run");
    }
  }

  latestAcknowledgedPromptInjection(runId: string): { id: string; kind: "turn" | "steer" } | undefined {
    return this.sqlite.prepare(`SELECT id, kind FROM scheduler_prompt_injections
      WHERE run_id = ? AND state = 'acknowledged'
      ORDER BY sequence DESC, created_at DESC, id DESC LIMIT 1`)
      .get(runId) as { id: string; kind: "turn" | "steer" } | undefined;
  }

  latestAcknowledgedSteeringInjection(
    runId: string,
  ): string | undefined {
    return (this.sqlite.prepare(`
      SELECT id FROM scheduler_prompt_injections
      WHERE run_id = ? AND kind = 'steer' AND state = 'acknowledged'
      ORDER BY sequence DESC, created_at DESC, id DESC LIMIT 1
    `).get(runId) as { id: string } | undefined)?.id;
  }

  steeringInjectionIds(runId: string): string[] {
    return (this.sqlite.prepare(`
      SELECT id FROM scheduler_prompt_injections
      WHERE run_id = ?
      ORDER BY sequence, created_at, id
    `).all(runId) as Array<{ id: string }>).map((row) => row.id);
  }

  processDueSteeringRecoveries(
    now = new Date().toISOString(),
    limit = 100,
  ): string[] {
    const due = this.sqlite.prepare(`
      SELECT injection_id FROM scheduler_steering_recoveries
      WHERE state = 'grace_period' AND recover_at <= ?
      ORDER BY recover_at, injection_id LIMIT ?
    `).all(
      now,
      Math.max(1, Math.min(limit, 500)),
    ) as Array<{ injection_id: string }>;
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

  queueSteeringRecovery(input: {
    injectionId: string;
    interruptOriginalRun: boolean;
    idempotencyKey: string;
    now: string;
  }): SteeringRecoveryDecisionResult {
    return this.sqlite.transaction((): SteeringRecoveryDecisionResult => {
      const recovery = this.sqlite.prepare(`
        SELECT run_id, agent_id, state
        FROM scheduler_steering_recoveries WHERE injection_id = ?
      `).get(input.injectionId) as {
        run_id: string;
        agent_id: string;
        state: "grace_period" | "wait_for_run" | "recovery_queued";
      } | undefined;
      if (!recovery) {
        return {
          accepted: false,
          replayed: false,
          state: "not_recoverable",
        };
      }
      if (recovery.state !== "grace_period") {
        return {
          accepted: true,
          replayed: true,
          state: recovery.state === "wait_for_run"
            ? "waiting_for_run"
            : "recovery_queued",
          agentId: recovery.agent_id,
        };
      }
      const sources = this.sqlite.prepare(`
        SELECT activation.id, activation.project_id, activation.agent_id,
          activation.scope_key, activation.priority, activation.payload_json
        FROM scheduler_prompt_injections injection,
          json_each(injection.activation_ids_json) member
        JOIN agent_activations activation ON activation.id = member.value
        WHERE injection.id = ?
        ORDER BY activation.created_at, activation.id
      `).all(input.injectionId) as Array<{
        id: string;
        project_id: string;
        agent_id: string;
        scope_key: string;
        priority: number;
        payload_json: string;
      }>;
      if (sources.length === 0) {
        return {
          accepted: false,
          replayed: false,
          state: "not_recoverable",
        };
      }
      for (const source of sources) {
        const originalPayload = JSON.parse(source.payload_json) as unknown;
        const payloadRecord =
          originalPayload &&
          typeof originalPayload === "object" &&
          !Array.isArray(originalPayload)
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
          dedupeKey:
            `steering-recovery:${input.injectionId}:${source.id}`,
          payload: {
            ...payloadRecord,
            steeringRecovery: {
              sourceRunId: recovery.run_id,
              sourceInjectionId: input.injectionId,
              sourceActivationId: source.id,
              reason: "provider_steering_acknowledgement_unconfirmed",
              instruction:
                "Audit current project and runtime state before acting. " +
                "Preserve completed results, then handle the original user " +
                "message exactly once. Do not assume the prior Run either " +
                "ignored or applied the uncertain steer.",
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
        SELECT 1 FROM scheduler_runs
        WHERE id = ? AND agent_id = ? AND status IN ('leased', 'running')
      `).get(recovery.run_id, recovery.agent_id));
      const nextState =
        input.interruptOriginalRun || !originalStillActive
          ? "recovery_queued"
          : "wait_for_run";
      this.sqlite.prepare(`
        UPDATE scheduler_steering_recoveries
        SET state = ?, decision_idempotency_key = ?, updated_at = ?
        WHERE injection_id = ? AND state = 'grace_period'
      `).run(
        nextState,
        input.idempotencyKey,
        input.now,
        input.injectionId,
      );
      if (input.interruptOriginalRun && originalStillActive) {
        this.cancelAgentRun({
          agentId: recovery.agent_id,
          expectedRunId: recovery.run_id,
          idempotencyKey: `steering-recovery:${input.injectionId}`,
          now: input.now,
        });
      }
      return {
        accepted: true,
        replayed: false,
        state: nextState === "wait_for_run"
          ? "waiting_for_run"
          : "recovery_queued",
        agentId: recovery.agent_id,
      };
    })();
  }
}
