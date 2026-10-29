import { requireBranchScheduleInjectionEligible } from "./coordination-v3-branch-schedule.js";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type {
  CoordinationRequestState,
  ProviderInputSourceManifest,
  PromptInjectionSourceManifestDto,
  ProviderFailureCategory,
  OutcomeInternalFailureCode,
} from "@ponderosa/core";
import {
  activationRetryDisposition,
  publicProviderFailureSummary,
  MAX_PROVIDER_RECOVERY_ATTEMPTS,
  providerRecoveryDelay,
} from "@ponderosa/core";
import { providerRecoveryAttempts } from "./coordination-v3-provider-recovery.js";
import { stableJson } from "./coordination-v3-canonical-json.js";
import { CoordinationIdempotencyConflictError } from "./coordination-v3-errors.js";
import type { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import type { CoordinationV3QuestionAuthority } from "./coordination-v3-question-authority.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type {
  ActivationTerminalOutcome,
  CoordinationV3StoreOptions,
  CancellationResult,
  UpdateRequestV3Input,
} from "./coordination-v3-types.js";

const UNSAFE_INTERNAL_ERROR_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function boundedInternalRunError(value: string | undefined): string {
  const normalized = (value ?? "scheduler dispatch rejected")
    .replace(UNSAFE_INTERNAL_ERROR_CONTROL, " ")
    .trim();
  const characters = Array.from(normalized || "scheduler dispatch rejected");
  return characters.slice(0, 2_000).join("");
}

/** Owns provider-input fences and terminal scheduler Run transitions. */
export class CoordinationV3RunLifecycleAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly questionAuthority: CoordinationV3QuestionAuthority,
    private readonly activationLifecycle: CoordinationV3ActivationLifecycleAuthority,
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
    private readonly recoverRequiredReply: (runId: string, now: string) => void,
    private readonly settleRetriedRequiredReply: (runId: string, now: string) => void,
    private readonly cancelRequiredReply: (runId: string, now: string) => void,
    private readonly restoreUninjectedDecisionRoots: (runId: string, now: string) => void,
    private readonly canonicalTaskDecisions: CoordinationV3StoreOptions["canonicalTaskDecisions"],
    private readonly createActivation: (input: CreateActivationV3Input) => string,
    private readonly preparePausedContinuation: (rolloverId: string, now: string) => string,
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

  /** Release only an uninjected scheduler claim when admission changed during
   * preparation. Preserve exact Activations/Requests and their retry budgets;
   * this is not a failed execution, assignment cancellation or recovery Run. */
  deferUninjectedRun(runId: string, fencingToken: number, now = new Date().toISOString()): void {
    if(this.containPauseRecoveryFailure(runId,fencingToken,'Recovery admission deferred by host resources or provider selection; original work remains paused'))return;
    this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(runId, fencingToken);
      if (run.status !== "leased" || run.prompt_injection_state !== "not_injected" || run.started_at !== null ||
          this.sqlite.prepare("SELECT 1 FROM provider_inputs WHERE scheduler_run_id=? LIMIT 1").get(runId) ||
          this.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id = ? AND state <> 'pending' LIMIT 1").get(runId)) {
        throw new Error("only an uninjected, unstarted scheduler claim can be deferred");
      }
      this.restoreUninjectedDecisionRoots(runId, now);
      const fence = this.support.nextFence(String(run.agent_id));
      this.sqlite.prepare(`UPDATE scheduler_runs SET status = 'cancelled', fencing_token = ?, side_effects_fenced_at = ?, updated_at = ?, terminal_at = ? WHERE id = ?`).run(fence, now, now, now, runId);
      this.sqlite.prepare(`UPDATE agent_activations SET state = CASE WHEN delivery_failures > 0 THEN 'retry_pending' ELSE 'pending' END, available_at = ?, updated_at = ? WHERE state = 'attached' AND id IN (SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?)`).run(now, now, runId);
      this.sqlite.prepare("UPDATE scheduler_prompt_injections SET state = 'cancelled', updated_at = ?, terminal_at = ? WHERE run_id = ? AND state = 'pending'").run(now, now, runId);
    })();
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
    systemPrompt?: string;
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
    const systemPrompt = input.systemPrompt ?? "";
    const systemPromptHash = systemPrompt
      ? createHash("sha256").update(systemPrompt).digest("hex")
      : "";
    this.sqlite.prepare(`
      INSERT INTO provider_inputs (
        execution_id, scheduler_run_id, agent_id, project_id,
        provider_prompt, prompt_hash, provider_system_prompt, system_prompt_hash, source_manifest_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO UPDATE SET
        provider_prompt = excluded.provider_prompt,
        prompt_hash = excluded.prompt_hash,
        provider_system_prompt = excluded.provider_system_prompt,
        system_prompt_hash = excluded.system_prompt_hash,
        source_manifest_json = excluded.source_manifest_json,
        updated_at = excluded.updated_at
    `).run(
      input.executionId,
      input.schedulerRunId,
      input.agentId,
      input.projectId,
      input.prompt,
      hash,
      systemPrompt,
      systemPromptHash,
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
      requireBranchScheduleInjectionEligible(this.sqlite,input.injectionId,input.runId,now,this.canonicalTaskDecisions);
      const row = this.sqlite.prepare(`
        SELECT prompt_hash, state, kind, activation_ids_json FROM scheduler_prompt_injections
        WHERE id = ? AND run_id = ?
      `).get(input.injectionId, input.runId) as {
        prompt_hash: string;
        state: string;
        activation_ids_json: string;
        kind: "turn" | "steer";
      } | undefined;
      if (!row) throw new Error("prompt injection not found");
      if (row.prompt_hash && row.prompt_hash !== hash) {
        throw new Error("prompt injection payload changed");
      }
      if (row.state !== "pending" && !row.prompt_hash) {
        throw new Error("submitted injection has no durable prompt hash");
      }
      const activationIds = JSON.parse(row.activation_ids_json) as string[];
      const manifest: PromptInjectionSourceManifestDto = {
        schemaVersion: 1, runId: input.runId, injectionId: input.injectionId,
        kind: row.kind, activationIds,
        sources: activationIds.map(ref => ({ kind: "activation", ref })),
      };
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET prompt_hash = ?, exact_prompt = ?, source_manifest_json = ?, updated_at = ?
        WHERE id = ? AND run_id = ? AND state = 'pending'
      `).run(hash, input.prompt, stableJson(manifest), now, input.injectionId, input.runId);
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

  promptInjectionForActivation(
    runId: string,
    activationId: string,
  ): { id: string; kind: "turn" | "steer"; state: string } | undefined {
    return this.sqlite.prepare(`
      SELECT injection.id, injection.kind, injection.state
      FROM scheduler_prompt_injections injection,
        json_each(injection.activation_ids_json) activation
      WHERE injection.run_id = ? AND activation.value = ?
      ORDER BY injection.sequence DESC, injection.created_at DESC
      LIMIT 1
    `).get(runId, activationId) as {
      id: string;
      kind: "turn" | "steer";
      state: string;
    } | undefined;
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
      requireBranchScheduleInjectionEligible(this.sqlite,input.injectionId,input.runId,now,this.canonicalTaskDecisions);
      const run = this.support.getFencedRun(
        input.runId,
        input.fencingToken,
      );
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
    if (input.providerTurnId !== undefined && (
      typeof input.providerTurnId !== "string"
      || input.providerTurnId.length > 512
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.providerTurnId)
    )) {
      throw new Error("provider turn id must be a bounded identifier");
    }
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
      this.sqlite.prepare(`UPDATE agent_pause_recoveries SET state='accepted' WHERE run_id=? AND state='pending'`).run(input.runId);
      this.sqlite.prepare(`UPDATE agent_run_pauses SET state='resumed',resumed_at=? WHERE state='resume_requested'
        AND recovery_activation_id IN (SELECT activation_id FROM agent_pause_recoveries WHERE run_id=? AND state='accepted')`).run(now,input.runId);
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
      this.recoverRequiredReply(runId, now);
    })();
  }

  failRunForActivationCompilation(input: {
    runId: string;
    fencingToken: number;
    workerId: string;
    activationId: string;
    errorCode: string;
    errorDetail?: string;
    now?: string;
  }): void {
    if (this.containPauseRecoveryFailure(input.runId,input.fencingToken,[input.errorCode,input.errorDetail].filter(Boolean).join(": "))) return;
    const now = input.now ?? new Date().toISOString();
    this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(input.runId, input.fencingToken);
      if (run.status !== "leased" || run.prompt_injection_state !== "not_injected" ||
          run.lease_owner !== input.workerId) {
        throw new Error("Run is not an authoritative leased preparation");
      }
      const attached = this.sqlite.prepare(`
        SELECT activation.id, activation.agent_id
        FROM agent_activations activation
        JOIN scheduler_run_activations attachment
          ON attachment.activation_id = activation.id
        WHERE attachment.run_id = ? AND activation.id = ?
          AND activation.state = 'attached'
      `).get(input.runId, input.activationId) as { id: string; agent_id: string } | undefined;
      if (!attached || attached.agent_id !== run.agent_id) {
        throw new Error("offending activation is not attached to the Run");
      }
      this.support.nextFence(run.agent_id as string);
      const detail = input.errorDetail
        ? (input.errorCode + ": " + input.errorDetail).slice(0, 2_000)
        : input.errorCode;
      this.sqlite.prepare(`
        UPDATE scheduler_runs
        SET status = 'failed', side_effects_fenced_at = ?,
          provider_failure_json = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND fencing_token = ? AND status = 'leased'
          AND prompt_injection_state = 'not_injected'
      `).run(
        now,
        stableJson({ category: "prompt_compilation", code: input.errorCode }),
        now,
        now,
        input.runId,
        input.fencingToken,
      );
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'failed', terminal_outcome = 'permanent_failure',
          last_delivery_error = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND state = 'attached'
      `).run(detail, now, now, input.activationId);
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'retry_pending', available_at = ?, updated_at = ?,
          last_delivery_error = ?, terminal_outcome = NULL, terminal_at = NULL
        WHERE id IN (
          SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?
        ) AND id <> ? AND state = 'attached'
      `).run(now, now, "Run preparation was retried after isolating another activation.", input.runId, input.activationId);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'pending'
      `).run(now, now, input.runId);
      this.activationLifecycle.settleRequestsForFailedActivations(
        [input.activationId],
        now,
      );
      this.restoreUninjectedDecisionRoots(input.runId, now);
      this.settleRetriedRequiredReply(input.runId, now);
      this.recoverRequiredReply(input.runId, now);
    })();
  }

  fenceRunSideEffects(runId: string, fencingToken: number, workerId: string, now = new Date().toISOString()): void {
    const result = this.sqlite.prepare(`
      UPDATE scheduler_runs SET side_effects_fenced_at = COALESCE(side_effects_fenced_at, ?), updated_at = ?
      WHERE id = ? AND fencing_token = ? AND lease_owner = ? AND status IN ('leased', 'running')
    `).run(now, now, runId, fencingToken, workerId);
    if (result.changes !== 1) throw new Error("Run no longer owns its cleanup fence");
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
    failureKind?: ProviderFailureCategory;
    internalFailureCode?: OutcomeInternalFailureCode;
    failureDetail?: {
      phase: string;
      promptInjectionState: "not_injected" | "injecting" | "injected";
      exitCode?: number | null;
      signal?: string | null;
      stderr?: string;
      message?: string;
      httpStatusCode?: number;
      retryAfterMs?: number;
      quotaResetAt?: string;
      quotaLimit?: import("@ponderosa/core").ProviderQuotaLimit;
      engineId?: string;
      model?: string;
    };
  }): "retry" | "terminal" | "resume_same_run" | "outcome_unknown" {
    if (this.containPauseRecoveryFailure(input.runId,input.fencingToken,input.error ?? "Recovery preparation failed")) return "outcome_unknown";
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const run = this.support.getFencedRun(
        input.runId,
        input.fencingToken,
      );
      if (input.failureDetail || input.failureKind !== undefined || input.retryable === false) {
        this.sqlite.prepare(`
          UPDATE scheduler_runs SET provider_failure_json = ?
          WHERE id = ? AND fencing_token = ?
        `).run(
          stableJson({
            ...input.failureDetail,
            retryable: input.retryable !== false,
            ...(input.failureKind ? { category: input.failureKind } : {}),
            ...(input.failureDetail?.stderr
              ? { stderr: input.failureDetail.stderr.slice(-8_192) }
              : {}),
            ...(input.failureDetail?.message
              ? {
                message: input.failureDetail.message.slice(0, 2_000),
              }
              : {}),
          }),
          input.runId,
          input.fencingToken,
        );
      }
      const hasProviderFailure = input.failureKind !== undefined ||
        input.failureDetail !== undefined;
      const failureCategory = hasProviderFailure
        ? input.failureKind ?? "unknown"
        : undefined;
      const durableError = hasProviderFailure
        ? publicProviderFailureSummary(input.error, failureCategory)
          ?? "Provider execution failed."
        : boundedInternalRunError(input.error);
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
      const boundReplacement = this.sqlite.prepare(`
        SELECT id FROM context_rollovers
        WHERE replacement_run_id = ? AND agent_id = ? AND project_id = ?
          AND state = 'continuation_ready' AND replacement_verified_at IS NULL
      `).get(input.runId, run.agent_id, run.project_id) as { id: string } | undefined;
      const candidateReplacement = boundReplacement ?? this.sqlite.prepare(`
        SELECT DISTINCT rollover.id
        FROM context_rollovers rollover
        JOIN scheduler_run_activations attached ON attached.run_id = ?
        LEFT JOIN activation_sources recovery
          ON recovery.activation_id = attached.activation_id
          AND recovery.source_kind = 'context_rollover_recovery'
          AND recovery.source_id = rollover.id
        WHERE rollover.agent_id = ? AND rollover.project_id = ?
          AND (
            attached.activation_id = rollover.continuation_activation_id
            OR recovery.activation_id IS NOT NULL
          )
        LIMIT 1
      `).get(input.runId, run.agent_id, run.project_id) as { id: string } | undefined;
      const attachedRequestedHandoff = this.sqlite.prepare(`
        SELECT rollover.id
        FROM context_rollovers rollover
        JOIN activation_sources source
          ON source.source_kind = 'context_rollover'
          AND source.source_id = rollover.id
        JOIN agent_activations activation
          ON activation.id = source.activation_id
          AND activation.kind = 'context_rollover_handoff'
        JOIN scheduler_run_activations attached
          ON attached.activation_id = activation.id
          AND attached.run_id = ?
        WHERE rollover.agent_id = ? AND rollover.project_id = ?
          AND rollover.state = 'requested'
          AND rollover.handoff_event_id IS NULL
        LIMIT 1
      `).get(input.runId, run.agent_id, run.project_id) as { id: string } | undefined;
      const requestedRollover = attachedRequestedHandoff ?? this.sqlite.prepare(`
        SELECT id FROM context_rollovers
        WHERE source_run_id = ? AND agent_id = ? AND project_id = ?
          AND state = 'requested' AND handoff_event_id IS NULL
        LIMIT 1
      `).get(input.runId, run.agent_id, run.project_id) as { id: string } | undefined;
      if (disposition === "retry") {
        const requestedMaximum = input.maxDeliveryFailures ?? MAX_PROVIDER_RECOVERY_ATTEMPTS;
        const maximum = Number.isFinite(requestedMaximum)
          ? Math.max(1, Math.floor(requestedMaximum))
          : MAX_PROVIDER_RECOVERY_ATTEMPTS;
        // Once the exact replacement packet is durably bound, an ordinary
        // Activation retry would create a different Run ID and either loop on
        // the old binding or weaken candidate fencing. Fail this candidate and
        // its attached Activation terminally; the old accepted session and
        // unconsumed handoff remain the only authority, and explicit recovery
        // may later rebind the same rollover generation.
        if (candidateReplacement) {
          this.sqlite.prepare(`
            UPDATE context_rollovers
            SET state = CASE WHEN replacement_run_id = ? THEN 'outcome_unknown' ELSE 'failed' END,
              last_error = ?, updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
            WHERE id = ? AND replacement_verified_at IS NULL
              AND state IN ('continuation_ready','failed','outcome_unknown')
          `).run(
            input.runId,
            "replacement Run failed before verified acceptance",
            now,
            now,
            candidateReplacement.id,
          );
        }
        // A requested rollover must not outlive failure of either its source
        // Run or its dedicated handoff Run. Terminalize the durable rollover
        // in this same fenced transaction and cancel any still-pending handoff.
        // Only an attached handoff becomes terminal here; an ordinary source
        // Activation retains its normal retry disposition. Explicit human
        // compact can create a fresh safe attempt, while automatic pressure is
        // suppressed for the failed provider generation.
        if (requestedRollover) {
          this.sqlite.prepare(`
            UPDATE context_rollovers
            SET state = 'failed', last_error = ?, updated_at = ?,
              terminal_at = COALESCE(terminal_at, ?)
            WHERE id = ? AND state = 'requested'
              AND handoff_event_id IS NULL
          `).run(durableError, now, now, requestedRollover.id);
          this.cancelPendingRolloverHandoff(requestedRollover.id, now);
        }
        const terminalOutcome = input.retryable === false || candidateReplacement || attachedRequestedHandoff
          ? input.terminalOutcome ?? "permanent_failure"
          : undefined;
        this.sqlite.prepare(`UPDATE scheduler_runs SET status='failed', updated_at=?, terminal_at=?
          WHERE id=? AND fencing_token=?`).run(now, now, input.runId, input.fencingToken);
        const activations = this.sqlite.prepare(`SELECT activation.id, activation.delivery_failures
          FROM agent_activations activation JOIN scheduler_run_activations attached
            ON attached.activation_id=activation.id AND attached.run_id=? WHERE activation.state='attached'`)
          .all(input.runId) as Array<{ id: string; delivery_failures: number }>;
        const update = this.sqlite.prepare(`UPDATE agent_activations
          SET delivery_failures=delivery_failures+1, last_delivery_error=?, provider_failure_category=?,
            state=?, terminal_outcome=?, terminal_at=?, available_at=?, updated_at=?
          WHERE id=? AND state='attached'`);
        for (const activation of activations) {
          const attempts = Math.max(activation.delivery_failures + 1,
            providerRecoveryAttempts(this.sqlite, input.runId, activation.id));
          const delay = providerRecoveryDelay(failureCategory, attempts, input.retryable !== false,
            input.retryDelayMs ?? input.failureDetail?.retryAfterMs ?? 0, input.failureDetail?.quotaResetAt, Date.parse(now));
          const outcome = terminalOutcome ?? (delay === null || attempts >= maximum
            ? attempts >= maximum ? "retry_exhausted" : providerRecoveryDelay(failureCategory, 0, input.retryable !== false, 0, input.failureDetail?.quotaResetAt, Date.parse(now)) === null
              ? "permanent_failure" : "retry_exhausted"
            : undefined);
          // The existing SQLite category is a broad rate-limit bucket; the exact
          // quota/reset evidence remains in this Run's provider_failure_json.
          update.run(durableError, (failureCategory === 'quota_exhausted' || failureCategory === 'throttled') ? 'rate_limit' : failureCategory ?? null, outcome ? 'failed' : 'retry_pending',
            outcome ?? null, outcome ? now : null, new Date(Date.parse(now) + (delay ?? 0)).toISOString(),
            now, activation.id);
        }
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
        this.restoreUninjectedDecisionRoots(input.runId, now);
        this.settleRetriedRequiredReply(input.runId, now);
        this.recoverRequiredReply(input.runId, now);
        if (pending === 0) {
          return "terminal";
        }
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
        if (boundReplacement) {
          this.sqlite.prepare(`
            UPDATE context_rollovers
            SET state = 'outcome_unknown',
              last_error = ?, updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
            WHERE id = ? AND replacement_run_id = ?
              AND state = 'continuation_ready' AND replacement_verified_at IS NULL
          `).run(
            "replacement Run outcome became unknown before verified acceptance",
            now,
            now,
            boundReplacement.id,
            input.runId,
          );
        }
        if (requestedRollover) {
          this.sqlite.prepare(`
            UPDATE context_rollovers
            SET state = 'outcome_unknown', last_error = ?, updated_at = ?,
              terminal_at = COALESCE(terminal_at, ?)
            WHERE id = ? AND state = 'requested'
              AND handoff_event_id IS NULL
          `).run(
            durableError,
            now,
            now,
            requestedRollover.id,
          );
          this.cancelPendingRolloverHandoff(requestedRollover.id, now);
        }
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
          hasProviderFailure
            ? "provider_outcome_unknown"
            : "scheduler_outcome_unknown",
          [
            "open",
            "in_progress",
            "waiting_dependency",
            "awaiting_answer",
          ],
          undefined,
          true,
          undefined,
          hasProviderFailure ? undefined : input.internalFailureCode ?? "internal_runtime_error",
        );
        this.recoverRequiredReply(input.runId, now);
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
          AND provider_failure_category IN ('capacity', 'rate_limit')
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
          AND provider_failure_category IN ('capacity', 'rate_limit')
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

  pauseAgentRun(input: {agentId:string; runId:string; idempotencyKey:string; now?:string}): {pauseId:string; runId:string} {
    const now=input.now??new Date().toISOString();
    return this.sqlite.transaction(()=>{
      const replay=this.sqlite.prepare('SELECT id,run_id FROM agent_run_pauses WHERE agent_id=? AND pause_key=?').get(input.agentId,input.idempotencyKey) as {id:string;run_id:string}|undefined;
      if(replay){if(replay.run_id!==input.runId)throw new CoordinationIdempotencyConflictError();return {pauseId:replay.id,runId:replay.run_id};}
      if(this.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')").get(input.agentId))throw new Error('Agent is already paused');
      const run=this.sqlite.prepare("SELECT * FROM scheduler_runs WHERE agent_id=? AND id=? AND status IN ('leased','running') AND side_effects_fenced_at IS NULL").get(input.agentId,input.runId) as {id:string;project_id:string;scope_key:string}|undefined;
      if(!run)throw new Error('Exact active Run is no longer available');
      const pauseId=createHash('sha256').update(stableJson([input.agentId,input.idempotencyKey])).digest('hex');
      const providerInput=this.sqlite.prepare('SELECT * FROM provider_inputs WHERE scheduler_run_id=?').all(run.id);
      const injections=this.sqlite.prepare('SELECT * FROM scheduler_prompt_injections WHERE run_id=? ORDER BY sequence').all(run.id);
      // A finalizing handoff keeps its execution role after the durable commit.
      const binding=this.sqlite.prepare(`SELECT source.source_id FROM scheduler_run_activations attached
        JOIN agent_activations activation ON activation.id=attached.activation_id
        JOIN activation_sources source ON source.activation_id=activation.id
        WHERE attached.run_id=? AND activation.kind='context_rollover_handoff'
          AND source.source_kind='context_rollover'`).get(run.id) as {source_id:string}|undefined;
      const rollover=this.sqlite.prepare(`SELECT id,state,source_run_id,replacement_run_id,handoff_event_id FROM context_rollovers
        WHERE agent_id=? AND (id=? OR source_run_id=? OR replacement_run_id=?)
          AND state IN ('requested','handoff_committed','session_retiring','continuation_ready')
        ORDER BY rowid DESC LIMIT 1`).get(input.agentId,binding?.source_id??null,run.id,run.id) as
        {id:string;state:string;source_run_id:string;replacement_run_id:string|null;handoff_event_id:string|null}|undefined;
      const phase=rollover?.replacement_run_id===run.id?'replacement':binding&&rollover?.id===binding.source_id
        ?rollover.handoff_event_id?'continuation':'handoff':rollover?.source_run_id===run.id?'refresh':'source';
      const sources=this.sqlite.prepare(`SELECT a.id,a.kind,a.payload_json,
        (SELECT injection.state FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member
         WHERE injection.run_id=? AND member.value=a.id ORDER BY injection.sequence DESC LIMIT 1) AS delivery
        FROM scheduler_run_activations attached JOIN agent_activations a ON a.id=attached.activation_id
        WHERE attached.run_id=? ORDER BY a.created_at,a.id`).all(run.id,run.id);
      // Select bounded partial evidence, never a model summary or a fabricated completed turn.
      const cutoff=this.sqlite.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE agent_id=?').get(input.agentId) as {seq:number};
      const start=this.sqlite.prepare(`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE agent_id=? AND type='agent_lifecycle'
        AND json_extract(payload_json,'$.executionId')=? AND json_extract(payload_json,'$.status')='running'`).get(input.agentId,run.id) as {seq:number};
      const evidence=this.sqlite.prepare(`SELECT id,seq,type,payload_json FROM events WHERE agent_id=? AND seq>? AND seq<=?
        AND type IN ('tool_call','tool_result','command','file_change','error') ORDER BY seq DESC LIMIT 16`).all(input.agentId,start.seq||cutoff.seq,cutoff.seq) as Array<{id:string;seq:number;type:string;payload_json:string}>;
      evidence.push(...this.sqlite.prepare(`SELECT id,seq,type,payload_json FROM events WHERE agent_id=? AND seq>? AND seq<=?
        AND type='text' ORDER BY seq DESC LIMIT 4`).all(input.agentId,start.seq||cutoff.seq,cutoff.seq) as typeof evidence);
      let evidenceBytes=0;
      const partial=evidence.sort((a,b)=>a.seq-b.seq).map(event=>{
        const bytes=Buffer.byteLength(event.payload_json);evidenceBytes+=bytes;
        return bytes<=4096&&evidenceBytes<=16384?event:{id:event.id,seq:event.seq,type:event.type,sha256:createHash('sha256').update(event.payload_json).digest('hex'),omittedUtf8Bytes:bytes};
      });
      const parent=this.sqlite.prepare(`SELECT pause.id,pause.checkpoint_json FROM agent_pause_recoveries recovery
        JOIN agent_run_pauses pause ON pause.id=recovery.pause_id WHERE recovery.run_id=?`).get(run.id) as {id:string;checkpoint_json:string}|undefined;
      const inherited=parent?JSON.parse(parent.checkpoint_json) as {sourceActivations:unknown[];priorInputs:unknown[];partialEvidence:unknown[]}:undefined;
      const currentInputs=this.sqlite.prepare(`SELECT input.execution_id,input.provider_prompt,input.prompt_hash,input.source_manifest_json
        FROM provider_inputs input JOIN scheduler_runs prior ON prior.id=input.scheduler_run_id
        WHERE prior.agent_id=? AND prior.project_id=? AND prior.scope_key=? AND prior.rowid<=
          (SELECT rowid FROM scheduler_runs WHERE id=?) AND (prior.id=? OR prior.provider_session_id=
          COALESCE((SELECT provider_session_id FROM scheduler_runs WHERE id=?),
            (SELECT previous.provider_session_id FROM scheduler_runs previous WHERE previous.agent_id=prior.agent_id
              AND previous.project_id=prior.project_id AND previous.scope_key=prior.scope_key
              AND previous.status='completed' AND previous.prompt_injection_state='injected'
              AND previous.rowid<(SELECT rowid FROM scheduler_runs WHERE id=?) ORDER BY previous.rowid DESC LIMIT 1)))
          ORDER BY prior.rowid DESC LIMIT 8`)
        .all(input.agentId,run.project_id,run.scope_key,run.id,run.id,run.id,run.id) as Array<{execution_id:string;provider_prompt:string;prompt_hash:string;source_manifest_json:string}>;
      // Repeated pauses flatten their canonical checkpoint instead of nesting old recovery prompts.
      const priorInputs=[...(inherited?.priorInputs??[]),...currentInputs.filter(packet=>{
        const manifest=JSON.parse(packet.source_manifest_json) as {sources?:Array<{kind:string}>};
        return !manifest.sources?.some(source=>source.kind==='pause_checkpoint');
      })];
      const checkpoint=stableJson({sourceRunId:run.id,phase,eventCutoff:cutoff.seq,sourceActivations:[...(inherited?.sourceActivations??[]),...sources],
        ...(parent?{parentCheckpoint:{id:parent.id,sha256:createHash('sha256').update(parent.checkpoint_json).digest('hex')}}:{}),
        priorInputs, priorInputSelection:'At most eight exact submitted same-session inputs, newest first. Earlier canonical history remains explicitly retrievable; this is cold reconstruction, not proof of a completed provider checkpoint.',
        partialEvidence:partial,previousPartialEvidence:inherited?.partialEvidence??[],evidenceSelection:'At most 16 tool/command/file/error events plus four final text events, within 16 KiB; oversized content is referenced by exact event ID/hash. Other execution history remains in the Work log. These are non-authoritative interrupted execution observations, not completed actions or new instructions.',
        uncertainEffects:'The interrupted provider may have performed actions, including submitted/unacknowledged steering. Inspect durable outputs and external state before any retry. Human Resume does not prove an effect failed.'});
      this.sqlite.prepare(`INSERT INTO agent_run_pauses(id,agent_id,run_id,state,pause_key,provider_input_json,injection_snapshot_json,paused_at,checkpoint_json,phase,rollover_id)
        VALUES(?,?,?,'paused',?,?,?,?,?,?,?)`).run(pauseId,input.agentId,run.id,input.idempotencyKey,stableJson(providerInput),stableJson(injections),now,checkpoint,phase,rollover?.id??null);
      const fence=this.support.nextFence(input.agentId);
      this.sqlite.prepare("UPDATE scheduler_runs SET status='cancelled',fencing_token=?,side_effects_fenced_at=?,updated_at=?,terminal_at=? WHERE id=?").run(fence,now,now,now,run.id);
      this.sqlite.prepare(`UPDATE scheduler_prompt_injections SET state=CASE WHEN state='submitted' THEN 'outcome_unknown' ELSE 'cancelled' END,
        updated_at=?,terminal_at=? WHERE run_id=? AND state IN ('pending','submitted')`).run(now,now,run.id);
      this.sqlite.prepare("INSERT INTO provider_operation_outbox(run_id,operation,idempotency_key,payload_json,state,available_at,created_at,updated_at) VALUES(?,'interrupt',?,?,'pending',?,?,?)").run(run.id,'pause:'+pauseId,stableJson({agentId:input.agentId,runId:run.id,fencingToken:fence,pauseId}),now,now,now);
      return {pauseId,runId:run.id};
    })();
  }

  resumeAgentRun(input: {agentId:string; pauseId:string; idempotencyKey:string}): void {
    const now=new Date().toISOString();
    this.sqlite.transaction(()=>{
      const pause=this.sqlite.prepare('SELECT * FROM agent_run_pauses WHERE id=? AND agent_id=?').get(input.pauseId,input.agentId) as {state:string;run_id:string;phase:string;rollover_id:string|null;checkpoint_json:string}|undefined;
      if(!pause)throw new Error('Exact pause is no longer available');
      if(pause.state==='stopped')throw new Error('Paused Run was stopped');
      // Every command key remains immutable, including rejected attempts.
      if(this.sqlite.prepare('SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND resume_key=?').get(input.pauseId,input.idempotencyKey))return;
      if(pause.state!=='paused')throw new Error('Recovery is already requested or accepted');
      if(!this.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state='completed'").get('pause:'+input.pauseId))throw new Error('Pause cleanup is not confirmed; Resume remains blocked');
      if(this.sqlite.prepare("SELECT 1 FROM provider_operation_outbox operation JOIN agent_pause_recoveries recovery ON recovery.run_id=operation.run_id WHERE recovery.pause_id=? AND operation.state<>'completed'").get(input.pauseId))throw new Error('Previous recovery cleanup is not confirmed');
      if(this.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='outcome_unknown'").get(input.pauseId))throw new Error('Previous recovery submission has an unknown outcome; inspect it before any retry');
      const run=this.sqlite.prepare('SELECT project_id,scope_key FROM scheduler_runs WHERE id=? AND agent_id=?').get(pause.run_id,input.agentId) as {project_id:string;scope_key:string};
      // A rejected committed candidate retains its packet proof. Only its exact,
      // terminal, never-submitted attempt can authorize saved-packet recovery.
      const packetRecovery=pause.phase==='continuation'&&pause.rollover_id?this.sqlite.prepare(`
        SELECT recovery.activation_id FROM context_rollovers rollover
        JOIN agent_pause_recoveries recovery ON recovery.run_id=rollover.replacement_run_id
        JOIN scheduler_runs rejected ON rejected.id=recovery.run_id
        JOIN provider_inputs packet ON packet.scheduler_run_id=rejected.id
        WHERE rollover.id=? AND rollover.state='failed' AND rollover.replacement_verified_at IS NULL
          AND recovery.pause_id=? AND recovery.state='rejected'
          AND rejected.agent_id=? AND rejected.status='cancelled' AND rejected.side_effects_fenced_at IS NOT NULL
          AND rejected.prompt_injection_state<>'injected'
          AND NOT EXISTS(SELECT 1 FROM scheduler_prompt_injections injection WHERE injection.run_id=rejected.id
            AND injection.state IN ('submitted','acknowledged','outcome_unknown'))`).get(pause.rollover_id,input.pauseId,input.agentId) as {activation_id:string}|undefined:undefined;
      const continuationId=pause.phase==='continuation'&&pause.rollover_id&&!packetRecovery
        ?this.preparePausedContinuation(pause.rollover_id,now):undefined;
      const templateId=packetRecovery?.activation_id??continuationId;
      const template=templateId?this.sqlite.prepare('SELECT kind,payload_json FROM agent_activations WHERE id=?').get(templateId) as {kind:string;payload_json:string}:
        pause.phase==='handoff'&&pause.rollover_id?this.sqlite.prepare(`SELECT a.kind,a.payload_json FROM scheduler_run_activations attached
          JOIN agent_activations a ON a.id=attached.activation_id WHERE attached.run_id=? AND a.kind='context_rollover_handoff'`).get(pause.run_id) as {kind:string;payload_json:string}|undefined:undefined;
      const activationId=this.createActivation({projectId:run.project_id,agentId:input.agentId,scopeKey:run.scope_key,
        kind:packetRecovery?'agent_pause_recovery':template?.kind??'agent_pause_recovery',priority:110,dispatchPolicy:'next_run',promptClass:'human',
        dedupeKey:`pause-recovery:${input.pauseId}:${input.idempotencyKey}`,sourceKind:'agent_pause',sourceId:input.pauseId,now,
        payload:{...(template?JSON.parse(template.payload_json):{}),pauseId:input.pauseId,
          ...(!templateId?{sourceRunId:pause.run_id,instruction:template?'Resume only the isolated bounded handoff contract. Do not execute the original task actions.':'The human resumed the unfinished work. Continue from the canonical source lineage and bounded interrupted checkpoint; do not start over. Preserve exact Request/reply routes and satisfied replies. Inspect uncertain effects before retrying actions. Unrelated queued inputs remain separate.'}:{})}});
      if(packetRecovery){
        this.sqlite.prepare(`INSERT OR IGNORE INTO activation_sources SELECT ?,source_kind,source_id FROM activation_sources
          WHERE activation_id=? AND source_kind NOT IN ('agent_pause','context_rollover','context_rollover_recovery')`).run(activationId,packetRecovery.activation_id);
        this.sqlite.prepare('INSERT OR IGNORE INTO activation_sources VALUES(?,?,?)').run(activationId,'context_rollover_recovery',pause.rollover_id);
      }
      if(continuationId){
        this.sqlite.prepare(`INSERT OR IGNORE INTO activation_sources SELECT ?,source_kind,source_id FROM activation_sources WHERE activation_id=?`).run(activationId,continuationId);
        this.sqlite.prepare(`UPDATE agent_activations SET state='cancelled',updated_at=?,terminal_at=? WHERE id=? AND state IN ('pending','retry_pending')`).run(now,now,continuationId);
        const bound=this.sqlite.prepare(`UPDATE context_rollovers SET continuation_activation_id=?,updated_at=?
          WHERE id=? AND state='continuation_ready' AND continuation_activation_id=? AND replacement_run_id IS NULL`).run(activationId,now,pause.rollover_id,continuationId);
        if(bound.changes!==1)throw new Error('Committed handoff continuation ownership changed; work remains paused');
      }
      this.sqlite.prepare(`INSERT OR IGNORE INTO activation_sources(activation_id,source_kind,source_id)
        SELECT ?,source.source_kind,source.source_id FROM activation_sources source
        JOIN scheduler_run_activations attached ON attached.activation_id=source.activation_id WHERE attached.run_id=?
        AND source.source_kind NOT IN ('agent_pause','context_rollover','context_rollover_recovery')`).run(activationId,pause.run_id);
      if(pause.rollover_id&&['replacement','handoff'].includes(pause.phase)){
        this.sqlite.prepare('INSERT OR IGNORE INTO activation_sources VALUES(?,?,?)').run(activationId,pause.phase==='replacement'?'context_rollover_recovery':'context_rollover',pause.rollover_id);
      }
      if(pause.rollover_id&&!['handoff','continuation'].includes(pause.phase))this.sqlite.prepare(`UPDATE context_rollovers SET state='outcome_unknown',last_error='Human pause owns interrupted work recovery',updated_at=?,terminal_at=?
        WHERE id=? AND replacement_verified_at IS NULL AND state IN ('requested','continuation_ready')`).run(now,now,pause.rollover_id);
      if(pause.rollover_id&&pause.phase==='refresh')this.sqlite.prepare(`UPDATE agent_activations SET state='cancelled',terminal_at=?,updated_at=?
        WHERE kind='context_rollover_handoff' AND state IN ('pending','retry_pending') AND id IN
          (SELECT activation_id FROM activation_sources WHERE source_kind='context_rollover' AND source_id=?)`).run(now,now,pause.rollover_id);
      this.sqlite.prepare("INSERT INTO agent_pause_recoveries VALUES(?,?,?,NULL,'pending',NULL,?)").run(input.pauseId,input.idempotencyKey,activationId,now);
      this.sqlite.prepare("UPDATE agent_run_pauses SET state='resume_requested',resume_key=?,recovery_activation_id=?,last_error=NULL WHERE id=? AND state='paused'").run(input.idempotencyKey,activationId,input.pauseId);
    })();
  }

  rejectPausedActivation(activationId:string,error:string,now:string): boolean {
    const recovery=this.sqlite.prepare(`SELECT pause_id FROM agent_pause_recoveries WHERE activation_id=? AND state='pending' AND run_id IS NULL`).get(activationId) as {pause_id:string}|undefined;
    if(!recovery)return false;
    this.sqlite.prepare("UPDATE agent_pause_recoveries SET state='rejected',error=? WHERE activation_id=?").run(error,activationId);
    this.sqlite.prepare("UPDATE agent_run_pauses SET state='paused',last_error=? WHERE id=? AND state='resume_requested'").run(error,recovery.pause_id);
    this.sqlite.prepare("UPDATE agent_activations SET state='failed',last_delivery_error=?,terminal_at=?,updated_at=? WHERE id=?").run(error,now,now,activationId);
    return true;
  }

  /** Canonical containment precedes all generic failure/request settlement paths. */
  containPauseRecoveryFailure(runId:string,fencingToken:number,error:string): boolean {
    return this.sqlite.transaction(()=>{
      const recovery=this.sqlite.prepare(`SELECT recovery.pause_id,recovery.activation_id,recovery.state FROM agent_pause_recoveries recovery
        JOIN agent_run_pauses pause ON pause.id=recovery.pause_id WHERE recovery.run_id=? AND pause.state<>'stopped'`).get(runId) as {pause_id:string;activation_id:string;state:string}|undefined;
      if(!recovery)return false;
      if(['rejected','outcome_unknown','stopped'].includes(recovery.state))return true;
      const run=this.support.getFencedRun(runId,fencingToken),now=new Date().toISOString();
      const submitted=Boolean(this.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND state IN ('submitted','acknowledged','outcome_unknown')").get(runId));
      const diagnostic=boundedInternalRunError(error),fence=this.support.nextFence(String(run.agent_id));
      this.sqlite.prepare(`UPDATE scheduler_runs SET status=?,fencing_token=?,side_effects_fenced_at=?,terminal_at=?,updated_at=? WHERE id=?`).run(submitted?'outcome_unknown':'cancelled',fence,now,now,now,runId);
      this.sqlite.prepare(`UPDATE scheduler_prompt_injections SET state=?,terminal_at=?,updated_at=? WHERE run_id=? AND state IN ('pending','submitted')`).run(submitted?'outcome_unknown':'cancelled',now,now,runId);
      this.sqlite.prepare("UPDATE agent_activations SET state=?,updated_at=?,last_delivery_error=? WHERE id=? AND state='attached'").run(submitted?'outcome_unknown':'failed',now,diagnostic,recovery.activation_id);
      if(!submitted)this.sqlite.prepare(`UPDATE context_rollovers SET state='failed',last_error=?,updated_at=?,terminal_at=?
        WHERE replacement_run_id=? AND replacement_verified_at IS NULL AND state='continuation_ready'
          AND id IN(SELECT rollover_id FROM agent_run_pauses WHERE id=?)`).run(diagnostic,now,now,runId,recovery.pause_id);
      this.sqlite.prepare('UPDATE agent_pause_recoveries SET state=?,error=? WHERE run_id=?').run(submitted?'outcome_unknown':'rejected',diagnostic,runId);
      this.sqlite.prepare("UPDATE agent_run_pauses SET state='paused',last_error=? WHERE id=?").run(diagnostic,recovery.pause_id);
      // Even an unstarted runtime may own browser/provider preparation resources.
      this.sqlite.prepare("INSERT OR IGNORE INTO provider_operation_outbox(run_id,operation,idempotency_key,payload_json,state,available_at,created_at,updated_at) VALUES(?,'interrupt',?,?,'pending',?,?,?)").run(runId,'pause-recovery:'+runId,stableJson({agentId:run.agent_id,runId,fencingToken:fence}),now,now,now);
      return true;
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
      const replay = this.cancellationReceipt(input.agentId, input.idempotencyKey);
      if (replay) {
        if (input.expectedRunId && replay.runId !== input.expectedRunId) {
          throw new CoordinationIdempotencyConflictError();
        }
        return { ...replay, replayed: true };
      }
      const held=this.sqlite.prepare(`SELECT pause.id,pause.run_id,pause.rollover_id FROM agent_run_pauses pause
        WHERE pause.agent_id=? AND (pause.state IN ('paused','resume_requested') OR (pause.state='resumed' AND EXISTS(SELECT 1 FROM agent_pause_recoveries recovery JOIN scheduler_runs live ON live.id=recovery.run_id WHERE recovery.pause_id=pause.id AND live.status IN ('leased','running'))))
          AND (? IS NULL OR pause.run_id=? OR EXISTS(SELECT 1 FROM agent_pause_recoveries recovery WHERE recovery.pause_id=pause.id AND recovery.run_id=?))`)
        .get(input.agentId,input.expectedRunId??null,input.expectedRunId??null,input.expectedRunId??null) as {id:string;run_id:string;rollover_id:string|null}|undefined;
      if(held){
        this.sqlite.prepare("UPDATE agent_run_pauses SET state='stopped' WHERE id=?").run(held.id);
        const descendants=this.sqlite.prepare("SELECT run_id FROM agent_pause_recoveries WHERE pause_id=? AND run_id IS NOT NULL AND state<>'stopped'").all(held.id) as Array<{run_id:string}>;
        this.sqlite.prepare("UPDATE agent_pause_recoveries SET state='stopped' WHERE pause_id=?").run(held.id);
        this.sqlite.prepare(`UPDATE agent_activations SET state='cancelled',terminal_at=?,updated_at=? WHERE id IN
          (SELECT activation_id FROM agent_pause_recoveries WHERE pause_id=?) AND state IN ('pending','retry_pending','attached','outcome_unknown')`).run(now,now,held.id);
        for(const recovery of descendants){
          const fence=this.support.nextFence(input.agentId);
          this.sqlite.prepare("UPDATE scheduler_runs SET status='cancelled',fencing_token=?,side_effects_fenced_at=?,terminal_at=?,updated_at=? WHERE id=?").run(fence,now,now,now,recovery.run_id);
          this.sqlite.prepare("UPDATE scheduler_prompt_injections SET state=CASE WHEN state='submitted' THEN 'outcome_unknown' ELSE 'cancelled' END,terminal_at=?,updated_at=? WHERE run_id=? AND state IN ('pending','submitted')").run(now,now,recovery.run_id);
          this.sqlite.prepare("INSERT OR IGNORE INTO provider_operation_outbox(run_id,operation,idempotency_key,payload_json,state,available_at,created_at,updated_at) VALUES(?,'interrupt',?,?,'pending',?,?,?)").run(recovery.run_id,'stop-pause-recovery:'+recovery.run_id,stableJson({agentId:input.agentId,runId:recovery.run_id,fencingToken:fence}),now,now,now);
          this.cancelRequiredReply(recovery.run_id,now);
        }
      }
      const cancellationTarget=held?(input.expectedRunId??held.run_id):input.expectedRunId;
      const run = this.sqlite.prepare(`
        SELECT id, fencing_token FROM scheduler_runs
        WHERE agent_id = ? AND (status IN ('leased','running') OR id=?)
          AND (? IS NULL OR id=?)
      `).get(input.agentId,held?cancellationTarget:null,cancellationTarget??null,cancellationTarget??null) as {id:string;fencing_token:number}|undefined;
      if (!run) {
        this.sqlite.prepare(`
          INSERT INTO scheduler_cancellation_receipts (
            agent_id, idempotency_key, run_id, accepted,
            fencing_token, created_at
          ) VALUES (?, ?, ?, 0, NULL, ?)
        `).run(input.agentId, input.idempotencyKey, input.expectedRunId ?? null, now);
        return {
          cancelled: false,
          replayed: false,
          ...(input.expectedRunId ? { runId: input.expectedRunId } : {}),
        };
      }
      this.sqlite.prepare("UPDATE agent_run_pauses SET state='stopped' WHERE run_id=? AND state IN ('paused','resume_requested')").run(run.id);
      const fence = this.support.nextFence(input.agentId);
      // Cancellation owns the rollover transition in the same transaction as
      // the scheduler fence. The provider cleanup path may run later—or not at
      // all after a crash—but restart recovery can never observe an active
      // continuation whose Run and Activation are already terminal.
      this.sqlite.prepare(`
        UPDATE context_rollovers
        SET state = 'outcome_unknown',
          failure_signal = 'replacement_cancelled',
          failure_provenance = 'internal',
          last_error = 'replacement Run was cancelled before low-water context confirmation',
          updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
        WHERE state = 'continuation_ready'
          AND replacement_verified_at IS NULL
          AND (
            replacement_run_id = ?
            OR (replacement_run_id IS NULL AND continuation_activation_id IN (
              SELECT activation_id FROM scheduler_run_activations WHERE run_id = ?
            ))
          )
      `).run(now, now, run.id, run.id);
      this.sqlite.prepare(`
        UPDATE context_rollovers
        SET state = 'outcome_unknown',
          failure_provenance = 'internal',
          last_error = CASE
            WHEN handoff_event_id IS NULL
              THEN 'rollover handoff Run was cancelled before durable commit'
            ELSE 'owning Run was cancelled before rollover continuation finalized'
          END,
          updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
        WHERE state IN ('requested','handoff_committed','session_retiring','continuation_ready')
          AND replacement_verified_at IS NULL
          AND (source_run_id = ? OR id IN (
            SELECT source.source_id
            FROM scheduler_run_activations attached
            JOIN agent_activations activation
              ON activation.id = attached.activation_id
              AND activation.kind = 'context_rollover_handoff'
            JOIN activation_sources source
              ON source.activation_id = activation.id
              AND source.source_kind = 'context_rollover'
            WHERE attached.run_id = ?
          ))
      `).run(now, now, run.id, run.id);
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE kind IN ('context_rollover_handoff','context_rollover_continuation')
          AND state IN ('pending','retry_pending')
          AND id IN (
            SELECT source.activation_id
            FROM activation_sources source
            JOIN context_rollovers rollover ON rollover.id = source.source_id
            WHERE source.source_kind = 'context_rollover'
              AND (rollover.source_run_id = ? OR EXISTS (
                SELECT 1
                FROM scheduler_run_activations owner_attached
                JOIN agent_activations owner_activation
                  ON owner_activation.id = owner_attached.activation_id
                  AND owner_activation.kind = 'context_rollover_handoff'
                JOIN activation_sources owner_source
                  ON owner_source.activation_id = owner_activation.id
                  AND owner_source.source_kind = 'context_rollover'
                  AND owner_source.source_id = rollover.id
                WHERE owner_attached.run_id = ?
              ))
              AND rollover.state = 'outcome_unknown'
          )
      `).run(now, now, run.id, run.id);
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
      this.cancelRequiredReply(run.id, now);
      // Isolated handoffs do not carry task reply roots; Stop also owns their source.
      const pausedSource=held?.rollover_id?this.sqlite.prepare('SELECT source_run_id FROM context_rollovers WHERE id=?').get(held.rollover_id) as {source_run_id:string}|undefined:undefined;
      if(pausedSource&&pausedSource.source_run_id!==run.id){
        this.markRelatedRequestsOutcomeUnknown(pausedSource.source_run_id,now,'run_cancelled_by_operator',
          ['open','in_progress','waiting_dependency','awaiting_answer']);
        this.cancelRequiredReply(pausedSource.source_run_id,now);
      }
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

  cancellationReceipt(
    agentId: string,
    idempotencyKey: string,
  ): CancellationResult | undefined {
    const receipt = this.sqlite.prepare(`
      SELECT run_id, accepted, fencing_token
      FROM scheduler_cancellation_receipts
      WHERE agent_id = ? AND idempotency_key = ?
    `).get(agentId, idempotencyKey) as {
      run_id: string | null;
      accepted: number;
      fencing_token: number | null;
    } | undefined;
    if (!receipt) return undefined;
    return {
      cancelled: receipt.accepted === 1,
      replayed: true,
      ...(receipt.run_id ? { runId: receipt.run_id } : {}),
      ...(receipt.fencing_token !== null
        ? { fencingToken: receipt.fencing_token }
        : {}),
    };
  }

  markRelatedRequestsOutcomeUnknown(
    runId: string,
    now: string,
    reason: string,
    eligibleStates: CoordinationRequestState[],
    continuationEligibleStates: CoordinationRequestState[] = eligibleStates,
    settleOutboundQuestions = true,
    incidentId?: string,
    internalFailureCode?: OutcomeInternalFailureCode,
  ): void {
    const normalCompletion = reason === "run_completed_without_request_update";
    const directEligibleStates = normalCompletion ? continuationEligibleStates : eligibleStates;
    const placeholders = directEligibleStates.map(() => "?").join(", ");
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
    `).all(runId, ...directEligibleStates) as Array<{ id: string }>;
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
        AND (? OR NOT EXISTS (
          SELECT 1
          FROM coordination_joins open_join
          JOIN json_each(
            open_join.continuation_request_ids_json
          ) open_continuation
          WHERE open_join.owner_agent_id = run.agent_id
            AND open_join.state = 'open'
            AND open_continuation.value = request.id
        ))
        AND (? OR NOT EXISTS (
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
        ))
    `).all(
      runId,
      ...continuationEligibleStates,
      normalCompletion ? 1 : 0,
      normalCompletion ? 1 : 0,
    ) as Array<{ id: string }>;
    const related = [
      ...new Map(
        [...rows, ...continuationRows].map((row) => [row.id, row]),
      ).values(),
    ].filter((row) => !(normalCompletion && this.requestOwnsViableDependency(row.id, runId, now)) && !this.requestOwnedByActiveRollover(
      row.id,
      runId,
    ));
    const runPhase = this.sqlite.prepare(`
      SELECT prompt_injection_state, provider_failure_json FROM scheduler_runs WHERE id = ?
    `).get(runId) as { prompt_injection_state: string; provider_failure_json: string | null } | undefined;
    let providerFailureCategory: ProviderFailureCategory | undefined;
    let processingPhase: string | undefined;
    if (runPhase?.provider_failure_json) {
      try {
        const failure = JSON.parse(runPhase.provider_failure_json) as { category?: unknown; phase?: unknown };
        const category = failure.category;
        if (typeof category === "string" && ["authentication", "rate_limit", "quota_exhausted", "throttled", "capacity", "context_length", "invalid_request", "unavailable"].includes(category)) {
          providerFailureCategory = category as ProviderFailureCategory;
        }
        if (typeof failure.phase === "string" && [
          "prompt_submission", "provider_execution",
          "turn_submission_rejection_before_acceptance", "turn_submission_rejection_after_acceptance",
          "iterator_rejection_before_acceptance", "iterator_rejection_after_acceptance",
          "event_projection_before_acceptance", "event_projection_after_acceptance",
        ].includes(failure.phase)) processingPhase = failure.phase;
      } catch { /* Legacy diagnostics may not contain structured JSON. */ }
    }
    for (const row of related) {
      this.updateRequest({
        requestId: row.id,
        updateId: `system:outcome-unknown:${runId}:${row.id}`,
        kind: "outcome_unknown",
        actor: { kind: "supervisor", id: "v3-runtime-supervisor" },
        payload: { reason, runId, ...(runPhase ? { promptSubmissionState: runPhase.prompt_injection_state } : {}),
          ...(incidentId ? { incidentId } : {}),
          ...(internalFailureCode ? { internalFailureCode } : {}),
          ...(providerFailureCategory ? { providerFailureCategory } : {}),
          ...(processingPhase ? { processingPhase } : {}) },
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

  private requestOwnsViableDependency(requestId: string, runId: string, now: string): boolean {
    // Consult the exact canonical continuation, regardless of how this Run
    // reached it. A consumed wakeup, dead owner or terminal Request cannot
    // indefinitely protect unfinished work. Failure/cancellation use their
    // existing finalization path, not this normal-completion exception.
    return Boolean(this.sqlite.prepare(`
      SELECT 1
      FROM coordination_requests request
      JOIN scheduler_runs run ON run.id = ? AND run.agent_id = request.recipient_agent_id
      JOIN agents owner ON owner.id = run.agent_id
        AND owner.project_id = request.project_id
        AND owner.deleted_at IS NULL
      JOIN coordination_joins dependency
        ON dependency.owner_agent_id = owner.id
        AND dependency.project_id = request.project_id
        AND dependency.conversation_id IS request.conversation_id
      JOIN json_each(dependency.continuation_request_ids_json) continuation
        ON continuation.value = request.id
      WHERE request.id = ?
        AND request.state IN ('open', 'in_progress', 'waiting_dependency')
        AND request.superseded_by_request_id IS NULL
        AND (request.deadline_at IS NULL OR request.deadline_at > ?)
        AND (
          (dependency.state = 'open' AND
            (dependency.deadline_at IS NULL OR dependency.deadline_at > ?))
          OR (dependency.state IN ('satisfied', 'impossible') AND EXISTS (
            SELECT 1 FROM activation_sources source
            JOIN agent_activations activation ON activation.id = source.activation_id
            WHERE source.source_kind = 'join' AND source.source_id = dependency.id
              AND activation.agent_id = owner.id
              AND activation.project_id = request.project_id
              AND activation.state IN ('pending', 'retry_pending')
              AND activation.kind = CASE dependency.state
                WHEN 'satisfied' THEN 'coordination_join_satisfied'
                ELSE 'coordination_join_impossible' END
          ))
        )
      LIMIT 1
    `).get(runId, requestId, now, now));
  }

  private cancelPendingRolloverHandoff(
    rolloverId: string,
    now: string,
  ): void {
    this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'cancelled', updated_at = ?, terminal_at = ?
      WHERE kind = 'context_rollover_handoff'
        AND state IN ('pending','retry_pending')
        AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_kind = 'context_rollover' AND source_id = ?
        )
    `).run(now, now, rolloverId);
  }

  private requestOwnedByActiveRollover(
    requestId: string,
    sourceRunId: string,
  ): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 AS owned
      FROM context_rollovers rollover
      JOIN scheduler_runs source_run ON source_run.id = ?
      JOIN json_each(rollover.source_activation_ids_json) source_activation_id
      JOIN agent_activations source_activation
        ON source_activation.id = source_activation_id.value
      JOIN activation_sources source
        ON source.activation_id = source_activation.id
      LEFT JOIN coordination_request_updates request_update
        ON source.source_kind = 'request_update'
        AND request_update.id = source.source_id
      LEFT JOIN coordination_joins join_record
        ON source.source_kind = 'join' AND join_record.id = source.source_id
      WHERE rollover.source_run_id = source_run.id
        AND rollover.state IN ('requested','handoff_committed','session_retiring','continuation_ready')
        AND (rollover.state = 'requested' OR rollover.handoff_event_id IS NOT NULL)
        AND rollover.agent_id = source_run.agent_id
        AND rollover.project_id = source_run.project_id
        AND source_activation.agent_id = source_run.agent_id
        AND source_activation.project_id = source_run.project_id
        AND (
          (source.source_kind = 'request' AND source.source_id = ?)
          OR (source.source_kind = 'request_update' AND request_update.request_id = ?)
          OR (source.source_kind = 'join' AND EXISTS (
            SELECT 1 FROM json_each(join_record.continuation_request_ids_json) continuation_request
            WHERE continuation_request.value = ?
          ))
        )
      LIMIT 1
    `).get(sourceRunId, requestId, requestId, requestId) as { owned: number } | undefined;
    return Boolean(row);
  }
}
