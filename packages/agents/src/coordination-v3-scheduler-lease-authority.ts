import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CoordinationRequestState } from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
import type { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type { SchedulerLease } from "./coordination-v3-types.js";
import {
  publicActivationDeliveryError,
  providerSafeActivationPayload,
} from "./coordination-v3-provider-failure-projection.js";

interface ActivationRow {
  id: string;
  kind: string;
  priority: number;
  dispatch_policy: SchedulerLease["activations"][number]["dispatchPolicy"];
  prompt_class: SchedulerLease["activations"][number]["promptClass"];
  payload_json: string;
  delivery_failures: number;
  last_delivery_error: string | null;
  provider_failure_category: string | null;
}

/** Recovers abandoned scheduler work and exclusively creates new Runs. */
export class CoordinationV3SchedulerLeaseAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly activationLifecycle: CoordinationV3ActivationLifecycleAuthority,
    private readonly markRelatedRequestsOutcomeUnknown: (
      runId: string,
      now: string,
      reason: string,
      eligibleStates: CoordinationRequestState[],
      incidentId?: string,
    ) => void,
    private readonly registerRequiredReply: (input: {
      runId: string;
      projectId: string;
      agentId: string;
      scopeKey: string;
      activations: ReadonlyArray<{ id: string; kind: string; payload: unknown }>;
      now: string;
    }) => void,
    private readonly recoverRequiredReply: (runId: string, now: string) => void,
    private readonly settleRetriedRequiredReply: (runId: string, now: string) => void,
    private readonly restoreUninjectedDecisionRoots: (runId: string, now: string) => void,
  ) {}

  /** A coarse injection flag alone cannot certify that abandoned work never
   * reached a provider. Preserve accepted evidence and use unknown-outcome
   * accounting rather than replaying its exact Activation. */
  canRetryUninjectedRun(runId: string): boolean {
    return Boolean(this.sqlite.prepare(`SELECT 1 FROM scheduler_runs run WHERE run.id=?
      AND run.prompt_injection_state='not_injected' AND run.started_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM provider_inputs WHERE scheduler_run_id=run.id)
      AND NOT EXISTS (SELECT 1 FROM scheduler_prompt_injections WHERE run_id=run.id
        AND state NOT IN ('pending','cancelled'))`).get(runId));
  }

  recoverOrphanedRuns(
    workerId: string,
    now = new Date().toISOString(),
  ): { retried: number; outcomeUnknown: number } {
    return this.sqlite.transaction(() => {
      const runs = this.sqlite.prepare(`
        SELECT id, prompt_injection_state FROM scheduler_runs
        WHERE status IN ('leased', 'running') AND lease_owner <> ?
      `).all(workerId) as Array<{
        id: string;
        prompt_injection_state: string;
      }>;
      let retried = 0;
      let outcomeUnknown = 0;
      const retryableRunIds = new Set(runs.filter(run => this.canRetryUninjectedRun(run.id)).map(run => run.id));
      const incidentId = runs.some(run => !retryableRunIds.has(run.id))
        ? randomUUID() : undefined;
      if (incidentId) {
        this.sqlite.prepare(`
          INSERT INTO system_incidents (id, kind, observed_at)
          VALUES (?, 'startup_orphaned_run_recovery', ?)
        `).run(incidentId, now);
      }
      for (const run of runs) {
        if (retryableRunIds.has(run.id)) {
          this.sqlite.prepare(`
            UPDATE scheduler_runs
            SET status = 'failed', updated_at = ?, terminal_at = ?
            WHERE id = ?
          `).run(now, now, run.id);
          this.sqlite.prepare(`
            UPDATE agent_activations
            SET state = 'retry_pending', available_at = ?, updated_at = ?
            WHERE id IN (
              SELECT activation_id FROM scheduler_run_activations
              WHERE run_id = ?
            ) AND state = 'attached'
          `).run(now, now, run.id);
          this.sqlite.prepare(`
            UPDATE scheduler_prompt_injections
            SET state = 'cancelled', updated_at = ?, terminal_at = ?
            WHERE run_id = ? AND state = 'pending'
          `).run(now, now, run.id);
          this.restoreUninjectedDecisionRoots(run.id, now);
          this.settleRetriedRequiredReply(run.id, now);
          retried += 1;
        } else {
          this.sqlite.prepare(`
            INSERT INTO system_incident_runs (incident_id, run_id) VALUES (?, ?)
          `).run(incidentId, run.id);
          this.sqlite.prepare(`
            UPDATE scheduler_runs
            SET status = 'outcome_unknown', updated_at = ?, terminal_at = ?
            WHERE id = ?
          `).run(now, now, run.id);
          this.sqlite.prepare(`
            UPDATE agent_activations
            SET state = 'outcome_unknown', updated_at = ?
            WHERE id IN (
              SELECT activation_id FROM scheduler_run_activations
              WHERE run_id = ?
            ) AND state = 'attached'
          `).run(now, run.id);
          this.sqlite.prepare(`
            UPDATE scheduler_prompt_injections
            SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
            WHERE run_id = ? AND state IN ('pending', 'submitted')
          `).run(now, now, run.id);
          this.markRelatedRequestsOutcomeUnknown(
            run.id,
            now,
            "server_restart_after_prompt_submission",
            [
              "open",
              "in_progress",
              "waiting_dependency",
              "awaiting_answer",
            ],
            incidentId,
          );
          this.recoverRequiredReply(run.id, now);
          outcomeUnknown += 1;
        }
      }
      return { retried, outcomeUnknown };
    })();
  }

  /** Recover expired live leases before scheduler capacity accounting. The
   * whole Run/Activation/request/rollover transition is one transaction, so a
   * saturated daemon cannot count stale ownership without also fencing it. */
  recoverExpiredRuns(now: string): { retried: number; outcomeUnknown: number } {
    return this.sqlite.transaction(() => this.recoverExpiredRunsInTransaction(now))();
  }

  leaseNextRun(input: {
    workerId: string;
    now?: string;
    leaseMs?: number;
    coalesceLimit?: number;
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
      this.recoverExpiredRunsInTransaction(now);
      this.activationLifecycle.settleUnauthorizedPendingActivations(now);
      const resume=this.sqlite.prepare(`SELECT pause.id AS pause_id,run.* FROM agent_run_pauses pause
        JOIN scheduler_runs run ON run.id=pause.run_id WHERE pause.state='resume_requested' AND run.status='cancelled'
        ORDER BY pause.paused_at LIMIT 1`).get() as {pause_id:string;id:string;agent_id:string;project_id:string;scope_key:string}|undefined;
      if(resume && !excludedAgentIds.includes(resume.agent_id)) {
        const rows=this.sqlite.prepare(`SELECT a.* FROM agent_activations a JOIN scheduler_run_activations attached ON attached.activation_id=a.id WHERE attached.run_id=? AND a.state='attached' ORDER BY a.created_at,a.id`).all(resume.id) as ActivationRow[];
        if(!rows.length)throw new Error('Paused Run lost its canonical attached sources');
        if(!this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(resume.project_id,resume.agent_id,resume.scope_key))throw new Error('Paused Run scope is no longer available');
        const fencingToken=this.support.nextFence(resume.agent_id), injectionId=randomUUID();
        const leaseExpiresAt=new Date(Date.parse(now)+leaseMs).toISOString();
        this.sqlite.prepare("UPDATE scheduler_runs SET status='leased',lease_owner=?,lease_expires_at=?,fencing_token=?,side_effects_fenced_at=NULL,terminal_at=NULL,updated_at=? WHERE id=? AND status='cancelled'").run(input.workerId,leaseExpiresAt,fencingToken,now,resume.id);
        this.sqlite.prepare("INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at) VALUES(?,?,'turn',(SELECT COALESCE(MAX(sequence),-1)+1 FROM scheduler_prompt_injections WHERE run_id=?),'pending','',?,?,?)").run(injectionId,resume.id,resume.id,stableJson(rows.map(a=>a.id)),now,now);
        this.sqlite.prepare("UPDATE agent_run_pauses SET state='resumed',resumed_at=? WHERE id=?").run(now,resume.pause_id);
        return {runId:resume.id,projectId:resume.project_id,agentId:resume.agent_id,scopeKey:resume.scope_key,fencingToken,leaseOwner:input.workerId,leaseExpiresAt,injectionId,activationIds:rows.map(a=>a.id),activations:rows.map(a=>({id:a.id,kind:a.kind,priority:a.priority,dispatchPolicy:a.dispatch_policy,promptClass:a.prompt_class,payload:providerSafeActivationPayload(this.sqlite,a.id,a.payload_json),deliveryFailures:a.delivery_failures})),resumedFromPause:true};
      }
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id, a.scope_key
        FROM agent_activations a
        WHERE a.state IN ('pending', 'retry_pending')
          AND NOT EXISTS(SELECT 1 FROM agent_run_pauses pause WHERE pause.agent_id=a.agent_id AND pause.state IN ('paused','resume_requested'))
          AND a.available_at <= ?
          AND NOT EXISTS (SELECT 1 FROM activation_sources held WHERE held.activation_id=a.id AND held.source_kind IN ('task_decision_repair_wait','task_reply_repair_wait','branch_schedule_update'))
          ${excludedClause}
          AND (
            (a.kind = 'context_rollover_handoff' AND EXISTS (
              SELECT 1 FROM context_rollovers rollover
              WHERE rollover.agent_id = a.agent_id
                AND rollover.id = json_extract(a.payload_json, '$.rolloverId')
                AND rollover.state = 'requested'
            ))
            OR (a.kind <> 'context_rollover_handoff' AND NOT EXISTS (
              SELECT 1 FROM context_rollovers rollover
              WHERE rollover.agent_id = a.agent_id
                AND rollover.state IN ('requested','handoff_committed','session_retiring')
            ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM activation_outbox audit
            WHERE audit.activation_id = a.id
              AND audit.event_kind = 'communication_revision'
              AND audit.processed_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM scheduler_runs r
            WHERE r.agent_id = a.agent_id
              AND r.status IN ('leased', 'running')
          )
        ORDER BY a.priority DESC, a.created_at, a.rowid
        LIMIT 1
      `).get(now, ...excludedAgentIds) as {
        agent_id: string;
        project_id: string;
        scope_key: string;
      } | undefined;
      if (!candidate) return undefined;
      const queuedActivations = this.sqlite.prepare(`
        SELECT a.* FROM agent_activations a
        WHERE agent_id = ? AND scope_key = ?
          AND state IN ('pending', 'retry_pending') AND available_at <= ?
          AND NOT EXISTS (SELECT 1 FROM activation_sources held WHERE held.activation_id=a.id AND held.source_kind IN ('task_decision_repair_wait','task_reply_repair_wait','branch_schedule_update'))
          AND (
            (kind = 'context_rollover_handoff' AND EXISTS (
              SELECT 1 FROM context_rollovers rollover
              WHERE rollover.agent_id = a.agent_id
                AND rollover.id = json_extract(a.payload_json, '$.rolloverId')
                AND rollover.state = 'requested'
            ))
            OR (kind <> 'context_rollover_handoff' AND NOT EXISTS (
              SELECT 1 FROM context_rollovers rollover
              WHERE rollover.agent_id = a.agent_id
                AND rollover.state IN ('requested','handoff_committed','session_retiring')
            ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM activation_outbox audit
            WHERE audit.activation_id = a.id
              AND audit.event_kind = 'communication_revision'
              AND audit.processed_at IS NULL
          )
        ORDER BY priority DESC, created_at, rowid LIMIT 64
      `).all(
        candidate.agent_id,
        candidate.scope_key,
        now,
      ) as ActivationRow[];
      const startsFreshTask = (activation: ActivationRow) =>
        activation.kind === "coordination_request";
      const candidateStartsFreshTask = startsFreshTask(
        queuedActivations[0]!,
      );
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
      const candidateIsExplicitQueuedTurn = isExplicitQueuedTurn(
        queuedActivations[0]!,
      );
      const isContextRolloverCandidate = (activation: ActivationRow): boolean =>
        Boolean(this.sqlite.prepare(`
          SELECT 1
          FROM context_rollovers rollover
          WHERE rollover.agent_id = ? AND rollover.project_id = ?
            AND (
              rollover.continuation_activation_id = ?
              OR EXISTS (
                SELECT 1 FROM activation_sources recovery
                WHERE recovery.activation_id = ?
                  AND recovery.source_kind = 'context_rollover_recovery'
                  AND recovery.source_id = rollover.id
              )
            )
          LIMIT 1
        `).get(
          candidate.agent_id,
          candidate.project_id,
          activation.id,
          activation.id,
        ));
      const candidateIsContextRollover = isContextRolloverCandidate(
        queuedActivations[0]!,
      );
      const activations = candidateIsExplicitQueuedTurn || candidateIsContextRollover
        ? [queuedActivations[0]!]
        : queuedActivations
          .filter((activation) =>
            !isExplicitQueuedTurn(activation) &&
            !isContextRolloverCandidate(activation) &&
            startsFreshTask(activation) === candidateStartsFreshTask)
          .slice(0, limit);
      if (activations.length === 0) return undefined;
      if (!this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(
        candidate.project_id,
        candidate.agent_id,
        candidate.scope_key,
      )) {
        this.activationLifecycle.settleUnauthorizedPendingActivations(now);
        return undefined;
      }
      const fencingToken = this.support.nextFence(candidate.agent_id);
      const runId = randomUUID();
      const injectionId = randomUUID();
      const leaseExpiresAt = new Date(
        Date.parse(now) + leaseMs,
      ).toISOString();
      this.sqlite.prepare(`
        INSERT INTO scheduler_runs (
          id, project_id, agent_id, scope_key, status, lease_owner,
          lease_expires_at, fencing_token, prompt_injection_state,
          heartbeat_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'leased', ?, ?, ?, 'not_injected', ?, ?, ?
        )
      `).run(
        runId,
        candidate.project_id,
        candidate.agent_id,
        candidate.scope_key,
        input.workerId,
        leaseExpiresAt,
        fencingToken,
        now,
        now,
        now,
      );
      const attach = this.sqlite.prepare(`
        INSERT INTO scheduler_run_activations (
          run_id, activation_id, attached_at
        ) VALUES (?, ?, ?)
      `);
      const setAttached = this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'attached', updated_at = ?, steering_wait_reason = NULL
        WHERE id = ? AND state IN ('pending', 'retry_pending')
      `);
      for (const activation of activations) {
        if (setAttached.run(now, activation.id).changes !== 1) {
          throw new Error("activation claim race");
        }
        attach.run(runId, activation.id, now);
      }
      this.sqlite.prepare(`
        INSERT INTO scheduler_prompt_injections (
          id, run_id, kind, sequence, state, prompt_hash,
          activation_ids_json, created_at, updated_at
        ) VALUES (?, ?, 'turn', 0, 'pending', '', ?, ?, ?)
      `).run(
        injectionId,
        runId,
        stableJson(activations.map((activation) => activation.id)),
        now,
        now,
      );
      this.registerRequiredReply({
        runId,
        projectId: candidate.project_id,
        agentId: candidate.agent_id,
        scopeKey: candidate.scope_key,
        activations: activations.map((activation) => ({
          id: activation.id,
          kind: activation.kind,
          payload: providerSafeActivationPayload(
            this.sqlite,
            activation.id,
            activation.payload_json,
          ),
        })),
        now,
      });
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

  private recoverExpiredRunsInTransaction(now: string): {
    retried: number;
    outcomeUnknown: number;
  } {
    const runs = this.sqlite.prepare(`
      SELECT id, prompt_injection_state FROM scheduler_runs
      WHERE status IN ('leased', 'running') AND lease_expires_at <= ?
    `).all(now) as Array<{
      id: string;
      prompt_injection_state: string;
    }>;
    let retried = 0;
    let outcomeUnknown = 0;
    for (const run of runs) {
      if (this.canRetryUninjectedRun(run.id)) {
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET status = 'failed', updated_at = ?, terminal_at = ?
          WHERE id = ?
        `).run(now, now, run.id);
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'retry_pending', available_at = ?, updated_at = ?
          WHERE id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          ) AND state = 'attached'
        `).run(now, now, run.id);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections
          SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state = 'pending'
        `).run(now, now, run.id);
        this.restoreUninjectedDecisionRoots(run.id, now);
        this.settleRetriedRequiredReply(run.id, now);
        retried += 1;
      } else {
        // Lease recovery runs inside the same immediate scheduler transaction
        // as the next claim. Once an injected replacement loses its lease, its
        // provider outcome is unknown and the matching unverified rollover can
        // no longer remain active. Terminalize that exact binding before any
        // recovery Activation is considered; the old accepted session and
        // unconsumed handoff remain authoritative until verified acceptance.
        this.sqlite.prepare(`
          UPDATE context_rollovers
          SET state = 'outcome_unknown',
            last_error = 'replacement Run lease expired after prompt injection before verified acceptance',
            updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
          WHERE replacement_run_id = ?
            AND state = 'continuation_ready'
            AND replacement_verified_at IS NULL
        `).run(now, now, run.id);
        this.terminalizeUncommittedRolloverForAbandonedRun(
          run.id,
          now,
          "rollover Run lease expired after prompt injection before durable handoff commit",
        );
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET status = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE id = ?
        `).run(now, now, run.id);
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'outcome_unknown', updated_at = ?
          WHERE id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          ) AND state = 'attached'
        `).run(now, run.id);
        this.sqlite.prepare(`
          UPDATE scheduler_prompt_injections
          SET state = 'outcome_unknown', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND state IN ('pending', 'submitted')
        `).run(now, now, run.id);
        this.markRelatedRequestsOutcomeUnknown(
          run.id,
          now,
          "lease_expired_after_prompt_injection",
          [
            "open",
            "in_progress",
            "waiting_dependency",
            "awaiting_answer",
          ],
        );
        this.recoverRequiredReply(run.id, now);
        outcomeUnknown += 1;
      }
    }
    return { retried, outcomeUnknown };
  }

  /** An injected source or handoff Run cannot be retried as ordinary delivery
   * after its lease is abandoned. Terminalize only a rollover that has not
   * committed a handoff, preserving the separate recovery authority for
   * committed handoffs and unverified replacement candidates. */
  private terminalizeUncommittedRolloverForAbandonedRun(
    runId: string,
    now: string,
    error: string,
  ): void {
    const rows = this.sqlite.prepare(`
      SELECT rollover.id
      FROM context_rollovers rollover
      WHERE rollover.state = 'requested'
        AND rollover.handoff_event_id IS NULL
        AND rollover.agent_id = (
          SELECT agent_id FROM scheduler_runs WHERE id = ?
        )
        AND rollover.project_id = (
          SELECT project_id FROM scheduler_runs WHERE id = ?
        )
        AND (
          rollover.source_run_id = ?
          OR EXISTS (
            SELECT 1
            FROM scheduler_run_activations attached
            JOIN agent_activations activation
              ON activation.id = attached.activation_id
              AND activation.kind = 'context_rollover_handoff'
            JOIN activation_sources source
              ON source.activation_id = activation.id
              AND source.source_kind = 'context_rollover'
              AND source.source_id = rollover.id
            WHERE attached.run_id = ?
          )
        )
    `).all(runId, runId, runId, runId) as Array<{ id: string }>;
    if (rows.length === 0) return;
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    this.sqlite.prepare(`
      UPDATE context_rollovers
      SET state = 'outcome_unknown', last_error = ?, updated_at = ?,
        terminal_at = COALESCE(terminal_at, ?)
      WHERE id IN (${placeholders}) AND state = 'requested'
        AND handoff_event_id IS NULL
    `).run(error, now, now, ...ids);
    this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'cancelled', updated_at = ?, terminal_at = ?
      WHERE kind = 'context_rollover_handoff'
        AND state IN ('pending','retry_pending')
        AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_kind = 'context_rollover'
            AND source_id IN (${placeholders})
        )
    `).run(now, now, ...ids);
  }
}
