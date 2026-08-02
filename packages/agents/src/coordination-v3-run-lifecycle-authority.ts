import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CoordinationRequestState,
  ProviderInputSourceManifest,
} from "@ponderosa/core";
import {
  activationRetryDisposition,
} from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
import type { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import type { CoordinationV3QuestionAuthority } from "./coordination-v3-question-authority.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type {
  ActivationTerminalOutcome,
  CancellationResult,
  UpdateRequestV3Input,
} from "./coordination-v3-types.js";

/** Owns provider-input fences and terminal scheduler Run transitions. */
export class CoordinationV3RunLifecycleAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly questionAuthority: CoordinationV3QuestionAuthority,
    private readonly activationLifecycle: CoordinationV3ActivationLifecycleAuthority,
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
  ) {}

  markRunStarted(
    runId: string,
    fence: number,
    now = new Date().toISOString(),
  ): void {
    this.support.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs
      SET status = 'running', started_at = COALESCE(started_at, ?),
        updated_at = ?
      WHERE id = ? AND fencing_token = ?
        AND status IN ('leased', 'running')
    `, [now, now, runId, fence]);
  }

  setRunContextDisposition(
    runId: string,
    fence: number,
    disposition: "fresh_task" | "continued_session" | "reseeded",
    now = new Date().toISOString(),
  ): void {
    this.support.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs SET context_disposition = ?, updated_at = ?
      WHERE id = ? AND fencing_token = ?
        AND status IN ('leased', 'running')
    `, [disposition, now, runId, fence]);
  }

  recordProviderInput(input: {
    executionId: string;
    schedulerRunId: string;
    fencingToken: number;
    agentId: string;
    projectId: string;
    prompt: string;
    sourceManifest: ProviderInputSourceManifest;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const run = this.support.getFencedRun(
      input.schedulerRunId,
      input.fencingToken,
    );
    if (
      run.agent_id !== input.agentId ||
      run.project_id !== input.projectId
    ) {
      throw new Error(
        "provider input scope does not match its scheduler run",
      );
    }
    const hash = createHash("sha256").update(input.prompt).digest("hex");
    this.sqlite.prepare(`
      INSERT INTO provider_inputs (
        execution_id, scheduler_run_id, agent_id, project_id,
        provider_prompt, prompt_hash, source_manifest_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        provider_prompt = excluded.provider_prompt,
        prompt_hash = excluded.prompt_hash,
        source_manifest_json = excluded.source_manifest_json,
        updated_at = excluded.updated_at
    `).run(
      input.executionId,
      input.schedulerRunId,
      input.agentId,
      input.projectId,
      input.prompt,
      hash,
      stableJson(input.sourceManifest),
      now,
      now,
    );
  }

  preparePromptInjection(input: {
    injectionId: string;
    runId: string;
    fencingToken: number;
    prompt: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const hash = createHash("sha256").update(input.prompt).digest("hex");
    this.sqlite.transaction(() => {
      this.support.getFencedRun(input.runId, input.fencingToken);
      const row = this.sqlite.prepare(`
        SELECT prompt_hash, state FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ?
      `).get(input.injectionId, input.runId) as {
        prompt_hash: string;
        state: string;
      } | undefined;
      if (!row) throw new Error("prompt injection not found");
      if (row.prompt_hash && row.prompt_hash !== hash) {
        throw new Error("prompt injection payload changed");
      }
      if (row.state !== "pending" && !row.prompt_hash) {
        throw new Error("submitted injection has no durable prompt hash");
      }
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET prompt_hash = ?, updated_at = ?
        WHERE id = ? AND run_id = ? AND state = 'pending'
      `).run(hash, now, input.injectionId, input.runId);
    })();
  }

  activationIdsForInjection(
    injectionId: string,
    runId: string,
  ): string[] {
    const row = this.sqlite.prepare(`
      SELECT activation_ids_json FROM scheduler_prompt_injections
      WHERE id = ? AND run_id = ?
    `).get(injectionId, runId) as {
      activation_ids_json: string;
    } | undefined;
    return row ? JSON.parse(row.activation_ids_json) as string[] : [];
  }

  markPromptSubmitted(input: {
    injectionId: string;
    runId: string;
    fencingToken: number;
    providerSessionId?: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(
        input.runId,
        input.fencingToken,
      );
      const unavailableTrigger = this.sqlite.prepare(`
        SELECT occurrence.trigger_id AS trigger_id
        FROM scheduler_run_activations attached
        JOIN agent_activations activation
          ON activation.id = attached.activation_id
        JOIN trigger_occurrences occurrence
          ON occurrence.activation_id = activation.id
        LEFT JOIN trigger_definitions definition
          ON definition.id = occurrence.trigger_id
        WHERE attached.run_id = ?
          AND activation.kind = 'trigger_occurrence'
          AND definition.id IS NULL
        LIMIT 1
      `).get(input.runId) as { trigger_id: string } | undefined;
      if (unavailableTrigger) {
        throw new Error(
          `Trigger ${unavailableTrigger.trigger_id} was deleted before prompt injection`,
        );
      }
      const changed = this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'submitted',
          submitted_at = COALESCE(submitted_at, ?), updated_at = ?
        WHERE id = ? AND run_id = ?
          AND state IN ('pending', 'submitted') AND prompt_hash <> ''
      `).run(
        now,
        now,
        input.injectionId,
        input.runId,
      ).changes;
      if (changed !== 1) {
        throw new Error("prompt injection is not submit-ready");
      }
      this.sqlite.prepare(`
        UPDATE scheduler_runs
        SET prompt_injection_state = 'injecting',
          provider_session_id = COALESCE(?, provider_session_id),
          heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND fencing_token = ?
          AND status IN ('leased', 'running')
      `).run(
        input.providerSessionId ?? null,
        now,
        now,
        input.runId,
        input.fencingToken,
      );
      if ((run.status as string) === "leased") {
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET status = 'running', started_at = COALESCE(started_at, ?)
          WHERE id = ? AND fencing_token = ?
        `).run(now, input.runId, input.fencingToken);
      }
    })();
  }

  acknowledgePromptInjection(input: {
    injectionId: string;
    runId: string;
    fencingToken: number;
    providerTurnId?: string;
    providerSessionId?: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      this.support.getFencedRun(input.runId, input.fencingToken);
      const changed = this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'acknowledged',
          provider_turn_id = COALESCE(?, provider_turn_id),
          acknowledged_at = COALESCE(acknowledged_at, ?),
          updated_at = ?
        WHERE id = ? AND run_id = ?
          AND state IN ('submitted', 'acknowledged')
      `).run(
        input.providerTurnId ?? null,
        now,
        now,
        input.injectionId,
        input.runId,
      ).changes;
      if (changed !== 1) {
        throw new Error("prompt injection was not submitted");
      }
      this.sqlite.prepare(`
        UPDATE scheduler_runs
        SET prompt_injection_state = 'injected',
          provider_session_id = COALESCE(?, provider_session_id),
          heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND fencing_token = ? AND status = 'running'
      `).run(
        input.providerSessionId ?? null,
        now,
        now,
        input.runId,
        input.fencingToken,
      );
    })();
  }

  renewLease(
    runId: string,
    fence: number,
    workerId: string,
    leaseMs = 30_000,
    now = new Date().toISOString(),
  ): string {
    const expires = new Date(Date.parse(now) + leaseMs).toISOString();
    this.support.mutateFencedRun(runId, fence, `
      UPDATE scheduler_runs
      SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND fencing_token = ? AND lease_owner = ?
        AND status IN ('leased', 'running')
    `, [expires, now, now, runId, fence, workerId]);
    return expires;
  }

  completeRun(
    runId: string,
    fence: number,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      const unsettled = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count FROM scheduler_prompt_injections
        WHERE run_id = ? AND state IN ('pending', 'submitted')
      `).get(runId) as { count: number }).count;
      if (unsettled > 0) {
        throw new Error(
          "run cannot complete with an unsettled prompt injection",
        );
      }
      this.support.mutateFencedRun(runId, fence, `
        UPDATE scheduler_runs
        SET status = 'completed', updated_at = ?, terminal_at = ?
        WHERE id = ? AND fencing_token = ?
          AND status IN ('leased', 'running')
      `, [now, now, runId, fence]);
      this.questionAuthority.settleUnansweredQuestionsForRun(
        runId,
        now,
        "completed",
      );
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'consumed', updated_at = ?, consumed_at = ?
        WHERE id IN (
          SELECT activation_id FROM scheduler_run_activations
          WHERE run_id = ?
        ) AND state = 'attached'
      `).run(now, now, runId);
      this.sqlite.prepare(`
        UPDATE scheduler_run_activations
        SET consumed_at = ? WHERE run_id = ?
      `).run(now, runId);
      this.markRelatedRequestsOutcomeUnknown(
        runId,
        now,
        "run_completed_without_request_update",
        ["open", "in_progress"],
        ["open", "in_progress", "waiting_dependency"],
        false,
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
    terminalOutcome?: Exclude<
      ActivationTerminalOutcome,
      "retry_exhausted"
    >;
    error?: string;
    maxDeliveryFailures?: number;
    confirmedNotExecuted?: boolean;
    failureKind?:
      | "capacity"
      | "rate_limit"
      | "authentication"
      | "context"
      | "unknown";
    failureDetail?: {
      phase: string;
      promptInjectionState: "not_injected" | "injecting" | "injected";
      exitCode?: number | null;
      signal?: string | null;
      stderr?: string;
      message?: string;
    };
  }): "retry" | "terminal" | "resume_same_run" | "outcome_unknown" {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(
        input.runId,
        input.fencingToken,
      );
      if (input.failureDetail) {
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET provider_failure_json = ?
          WHERE id = ? AND fencing_token = ?
        `).run(
          stableJson({
            ...input.failureDetail,
            ...(input.failureDetail.stderr
              ? { stderr: input.failureDetail.stderr.slice(-8_192) }
              : {}),
            ...(input.failureDetail.message
              ? {
                message: input.failureDetail.message.slice(0, 2_000),
              }
              : {}),
          }),
          input.runId,
          input.fencingToken,
        );
      }
      const disposition = input.confirmedNotExecuted
        ? "retry"
        : activationRetryDisposition({
          promptInjectionState:
            run.prompt_injection_state as
              | "not_injected"
              | "injecting"
              | "injected",
          sameRunResumable: input.sameRunResumable,
        });
      if (disposition === "retry") {
        const error = (
          input.error ?? "scheduler dispatch rejected"
        ).slice(0, 2_000);
        const requestedMaximum = input.maxDeliveryFailures ?? 5;
        const maximum = Number.isFinite(requestedMaximum)
          ? Math.max(1, Math.floor(requestedMaximum))
          : 5;
        const terminalOutcome = input.retryable === false
          ? input.terminalOutcome ?? "permanent_failure"
          : undefined;
        const providerUnavailable = input.failureKind === "capacity" || input.failureKind === "rate_limit";
        const currentFailures = (this.sqlite.prepare(`
          SELECT COALESCE(MAX(delivery_failures), 0) AS failures
          FROM agent_activations
          WHERE id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          )
        `).get(input.runId) as { failures: number }).failures;
        const capacityBackoff =
          input.failureKind === "capacity" ||
          input.failureKind === "rate_limit"
            ? Math.min(
              120_000,
              2_000 * (2 ** Math.min(currentFailures, 6)),
            )
            : 1_000;
        const availableAt = new Date(
          Date.parse(now) +
            (input.retryDelayMs ?? capacityBackoff),
        ).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET status = 'failed', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET delivery_failures = delivery_failures + 1,
            last_delivery_error = ?,
            state = CASE
              WHEN ? IS NOT NULL OR (? = 1 AND delivery_failures + 1 >= ?)
                THEN 'failed'
              ELSE 'retry_pending'
            END,
            terminal_outcome = CASE
              WHEN ? IS NOT NULL THEN ?
              WHEN ? = 1 AND delivery_failures + 1 >= ? THEN 'retry_exhausted'
              ELSE NULL
            END,
            terminal_at = CASE
              WHEN ? IS NOT NULL OR (? = 1 AND delivery_failures + 1 >= ?)
                THEN ?
              ELSE NULL
            END,
            available_at = ?, updated_at = ?
          WHERE id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          ) AND state = 'attached'
        `).run(
          error,
          terminalOutcome ?? null,
          providerUnavailable ? 0 : 1,
          maximum,
          terminalOutcome ?? null,
          terminalOutcome ?? null,
          providerUnavailable ? 0 : 1,
          maximum,
          terminalOutcome ?? null,
          providerUnavailable ? 0 : 1,
          maximum,
          now,
          availableAt,
          now,
          input.runId,
        );
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections
          SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state = 'pending'
        `).run(now, now, input.runId);
        if (input.confirmedNotExecuted) {
          this.sqlite.prepare(`
            UPDATE scheduler_prompt_injections
            SET state = 'cancelled', updated_at = ?, terminal_at = ?
            WHERE run_id = ? AND state IN ('submitted', 'injected')
          `).run(now, now, input.runId);
        }
        const terminalActivations = (this.sqlite.prepare(`
          SELECT attached.activation_id AS id
          FROM scheduler_run_activations attached
          JOIN agent_activations activation
            ON activation.id = attached.activation_id
          WHERE attached.run_id = ? AND activation.state = 'failed'
            AND activation.terminal_outcome IS NOT NULL
        `).all(input.runId) as Array<{ id: string }>).map(
          (row) => row.id,
        );
        this.activationLifecycle.settleRequestsForFailedActivations(
          terminalActivations,
          now,
        );
        const pending = (this.sqlite.prepare(`
          SELECT COUNT(*) AS count FROM agent_activations
          WHERE id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          ) AND state = 'retry_pending'
        `).get(input.runId) as { count: number }).count;
        if (pending === 0) return "terminal";
      } else if (disposition === "resume_same_run") {
        const nextFence = this.support.nextFence(
          run.agent_id as string,
        );
        const leaseExpiresAt = new Date(
          Date.parse(now) + (input.leaseMs ?? 30_000),
        ).toISOString();
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
            fencing_token = ?, updated_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(
          input.workerId,
          leaseExpiresAt,
          nextFence,
          now,
          input.runId,
          input.fencingToken,
        );
      } else {
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET status = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE id = ? AND fencing_token = ?
        `).run(now, now, input.runId, input.fencingToken);
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'outcome_unknown', updated_at = ?
          WHERE id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          ) AND state = 'attached'
        `).run(now, input.runId);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections
          SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('pending', 'submitted')
        `).run(now, now, input.runId);
        this.markRelatedRequestsOutcomeUnknown(
          input.runId,
          now,
          "provider_outcome_unknown",
          [
            "open",
            "in_progress",
            "waiting_dependency",
            "awaiting_answer",
          ],
        );
      }
      return disposition;
    })();
  }

  /** Make retained provider-blocked work immediately eligible after an explicit
   * operator runtime change. This advances the existing Activations only; it
   * never creates a second wake-up. */
  resumeProviderBlockedAgent(
    agentId: string,
    runtimeSelection: {
      activeEngine: string;
      model?: string;
      effort?: string;
    },
    now = new Date().toISOString(),
  ): { activationIds: string[]; resumed: number } {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT id, payload_json FROM agent_activations
        WHERE agent_id = ? AND state = 'retry_pending'
          AND (last_delivery_error LIKE '[capacity] %'
            OR last_delivery_error LIKE '[rate_limit] %')
        ORDER BY id
      `).all(agentId) as Array<{ id: string; payload_json: string }>;
      if (!rows.length) return { activationIds: [], resumed: 0 };
      const normalizedSelection = {
        activeEngine: runtimeSelection.activeEngine,
        model: runtimeSelection.model ?? null,
        effort: runtimeSelection.effort ?? null,
      };
      const selectionHash = createHash("sha256")
        .update(stableJson(normalizedSelection))
        .digest("hex");
      const update = this.sqlite.prepare(`
        UPDATE agent_activations
        SET payload_json = ?, available_at = ?, updated_at = ?
        WHERE id = ? AND agent_id = ? AND state = 'retry_pending'
          AND (last_delivery_error LIKE '[capacity] %'
            OR last_delivery_error LIKE '[rate_limit] %')
      `);
      const activationIds: string[] = [];
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        const previousRecovery = payload.providerRecovery && typeof payload.providerRecovery === "object"
          ? payload.providerRecovery as Record<string, unknown>
          : undefined;
        if (previousRecovery?.runtimeSelectionHash === selectionHash) continue;
        const dispatch = payload.dispatch && typeof payload.dispatch === "object"
          ? payload.dispatch as Record<string, unknown>
          : undefined;
        const { model: _oldModel, effort: _oldEffort, ...dispatchWithoutRuntimeOverrides } = dispatch ?? {};
        const nextPayload = {
          ...payload,
          ...(dispatch ? { dispatch: dispatchWithoutRuntimeOverrides } : {}),
          providerRecovery: {
            runtimeSelectionHash: selectionHash,
            runtimeSelection: normalizedSelection,
            reboundAt: now,
          },
        };
        if (update.run(stableJson(nextPayload), now, now, row.id, agentId).changes === 1) {
          activationIds.push(row.id);
        }
      }
      return { activationIds, resumed: activationIds.length };
    })();
  }

  cancelAgentRun(input: {
    agentId: string;
    idempotencyKey: string;
    expectedRunId?: string;
    now?: string;
  }): CancellationResult {
    if (!input.idempotencyKey.trim()) {
      throw new Error("cancellation idempotency key is required");
    }
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const replay = this.sqlite.prepare(`
        SELECT run_id, accepted, fencing_token
        FROM scheduler_cancellation_receipts
        WHERE agent_id = ? AND idempotency_key = ?
      `).get(input.agentId, input.idempotencyKey) as {
        run_id: string | null;
        accepted: number;
        fencing_token: number | null;
      } | undefined;
      if (replay) {
        return {
          cancelled: replay.accepted === 1,
          replayed: true,
          ...(replay.run_id ? { runId: replay.run_id } : {}),
          ...(replay.fencing_token !== null
            ? { fencingToken: replay.fencing_token }
            : {}),
        };
      }
      const run = this.sqlite.prepare(`
        SELECT id, fencing_token FROM scheduler_runs
        WHERE agent_id = ? AND status IN ('leased', 'running')
          AND (? IS NULL OR id = ?)
      `).get(
        input.agentId,
        input.expectedRunId ?? null,
        input.expectedRunId ?? null,
      ) as { id: string; fencing_token: number } | undefined;
      if (!run) {
        this.sqlite.prepare(`
          INSERT INTO scheduler_cancellation_receipts (
            agent_id, idempotency_key, run_id, accepted,
            fencing_token, created_at
          ) VALUES (?, ?, NULL, 0, NULL, ?)
        `).run(input.agentId, input.idempotencyKey, now);
        return { cancelled: false, replayed: false };
      }
      const fence = this.support.nextFence(input.agentId);
      this.sqlite.prepare(`
        UPDATE scheduler_runs
        SET status = 'cancelled', fencing_token = ?,
          updated_at = ?, terminal_at = ?
        WHERE id = ?
      `).run(fence, now, now, run.id);
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'outcome_unknown', updated_at = ?
        WHERE id IN (
          SELECT activation.value
          FROM scheduler_prompt_injections injection,
            json_each(injection.activation_ids_json) activation
          WHERE injection.run_id = ? AND injection.state = 'submitted'
        ) AND state = 'attached'
      `).run(now, run.id);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE id IN (
          SELECT activation_id FROM scheduler_run_activations
          WHERE run_id = ?
        ) AND state = 'attached'
      `).run(now, run.id);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'pending'
      `).run(now, now, run.id);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'submitted'
      `).run(now, now, run.id);
      this.markRelatedRequestsOutcomeUnknown(
        run.id,
        now,
        "run_cancelled_by_operator",
        [
          "open",
          "in_progress",
          "waiting_dependency",
          "awaiting_answer",
        ],
      );
      this.sqlite.prepare(`
        INSERT INTO scheduler_cancellation_receipts (
          agent_id, idempotency_key, run_id, accepted,
          fencing_token, created_at
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(
        input.agentId,
        input.idempotencyKey,
        run.id,
        fence,
        now,
      );
      const operation = this.sqlite.prepare(`
        INSERT INTO provider_operation_outbox (
          run_id, operation, idempotency_key, payload_json, state,
          available_at, created_at, updated_at
        ) VALUES (?, 'interrupt', ?, ?, 'pending', ?, ?, ?)
      `).run(
        run.id,
        `cancel:${input.agentId}:${input.idempotencyKey}`,
        stableJson({
          agentId: input.agentId,
          runId: run.id,
          fencingToken: fence,
        }),
        now,
        now,
        now,
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

  markRelatedRequestsOutcomeUnknown(
    runId: string,
    now: string,
    reason: string,
    eligibleStates: CoordinationRequestState[],
    continuationEligibleStates: CoordinationRequestState[] = eligibleStates,
    settleOutboundQuestions = true,
  ): void {
    const placeholders = eligibleStates.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT request.id
      FROM scheduler_run_activations attached
      JOIN scheduler_runs run ON run.id = attached.run_id
      JOIN activation_sources source
        ON source.activation_id = attached.activation_id
      LEFT JOIN coordination_request_updates update_record
        ON source.source_kind = 'request_update'
        AND update_record.id = source.source_id
      JOIN coordination_requests request ON request.id = CASE
        WHEN source.source_kind = 'request' THEN source.source_id
        WHEN source.source_kind = 'request_update'
          THEN update_record.request_id
      END
      WHERE attached.run_id = ?
        AND request.recipient_agent_id = run.agent_id
        AND request.state IN (${placeholders})
    `).all(runId, ...eligibleStates) as Array<{ id: string }>;
    const continuationPlaceholders = continuationEligibleStates
      .map(() => "?")
      .join(", ");
    const continuationRows = this.sqlite.prepare(`
      SELECT DISTINCT request.id
      FROM scheduler_run_activations attached
      JOIN scheduler_runs run ON run.id = attached.run_id
      JOIN activation_sources source
        ON source.activation_id = attached.activation_id
        AND source.source_kind = 'join'
      JOIN coordination_joins join_record
        ON join_record.id = source.source_id
      JOIN json_each(
        join_record.continuation_request_ids_json
      ) continuation
      JOIN coordination_requests request ON request.id = continuation.value
      WHERE attached.run_id = ?
        AND request.recipient_agent_id = run.agent_id
        AND request.state IN (${continuationPlaceholders})
        AND NOT EXISTS (
          SELECT 1
          FROM coordination_joins open_join
          JOIN json_each(
            open_join.continuation_request_ids_json
          ) open_continuation
          WHERE open_join.owner_agent_id = run.agent_id
            AND open_join.state = 'open'
            AND open_continuation.value = request.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM activation_sources terminal_source
          JOIN agent_activations terminal_activation
            ON terminal_activation.id = terminal_source.activation_id
          WHERE terminal_source.source_kind = 'join'
            AND terminal_source.source_id = join_record.id
            AND terminal_activation.kind IN (
              'coordination_join_satisfied',
              'coordination_join_impossible'
            )
            AND terminal_activation.state IN (
              'pending', 'retry_pending', 'leased'
            )
        )
    `).all(
      runId,
      ...continuationEligibleStates,
    ) as Array<{ id: string }>;
    const related = [
      ...new Map(
        [...rows, ...continuationRows].map((row) => [row.id, row]),
      ).values(),
    ];
    for (const row of related) {
      this.updateRequest({
        requestId: row.id,
        updateId: `system:outcome-unknown:${runId}:${row.id}`,
        kind: "outcome_unknown",
        actor: { kind: "supervisor", id: "v3-runtime-supervisor" },
        payload: { reason, runId },
        now,
      });
    }
    if (settleOutboundQuestions) {
      this.questionAuthority.settleUnansweredQuestionsForRun(
        runId,
        now,
        "outcome_unknown",
        reason,
      );
    }
  }
}
