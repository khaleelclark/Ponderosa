import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CoordinationRequestState } from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
import type { CoordinationV3ActivationLifecycleAuthority } from "./coordination-v3-activation-lifecycle-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type { CoordinationV3TriggerRegistry } from "./coordination-v3-trigger-registry.js";
import type { SchedulerLease } from "./coordination-v3-types.js";

interface ActivationRow {
  id: string;
  kind: string;
  priority: number;
  dispatch_policy: SchedulerLease["activations"][number]["dispatchPolicy"];
  prompt_class: SchedulerLease["activations"][number]["promptClass"];
  payload_json: string;
  delivery_failures: number;
  last_delivery_error: string | null;
}

/** Recovers abandoned scheduler work and exclusively creates new Runs. */
export class CoordinationV3SchedulerLeaseAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly activationLifecycle: CoordinationV3ActivationLifecycleAuthority,
    private readonly triggerRegistry: CoordinationV3TriggerRegistry,
    private readonly markRelatedRequestsOutcomeUnknown: (
      runId: string,
      now: string,
      reason: string,
      eligibleStates: CoordinationRequestState[],
    ) => void,
  ) {}

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
      for (const run of runs) {
        if (run.prompt_injection_state === "not_injected") {
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
          retried += 1;
        } else {
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
          );
          outcomeUnknown += 1;
        }
      }
      return { retried, outcomeUnknown };
    })();
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
      this.recoverExpiredUninjectedRuns(now);
      this.triggerRegistry.resetExpiredBudgets(now);
      this.activationLifecycle.settleUnauthorizedPendingActivations(now);
      const candidate = this.sqlite.prepare(`
        SELECT a.agent_id, a.project_id, a.scope_key
        FROM agent_activations a
        WHERE a.state IN ('pending', 'retry_pending')
          AND a.available_at <= ?
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
            SELECT 1 FROM trigger_occurrences occurrence
            JOIN trigger_definitions definition
              ON definition.id = occurrence.trigger_id
            WHERE occurrence.activation_id = a.id
              AND occurrence.budget_charge_id IS NULL
              AND definition.run_budget_limit IS NOT NULL
              AND definition.run_budget_used >=
                definition.run_budget_limit +
                definition.run_budget_allowance
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
        SELECT * FROM agent_activations
        WHERE agent_id = ? AND scope_key = ?
          AND state IN ('pending', 'retry_pending') AND available_at <= ?
          AND (
            (kind = 'context_rollover_handoff' AND EXISTS (
              SELECT 1 FROM context_rollovers rollover
              WHERE rollover.agent_id = agent_activations.agent_id
                AND rollover.id = json_extract(agent_activations.payload_json, '$.rolloverId')
                AND rollover.state = 'requested'
            ))
            OR (kind <> 'context_rollover_handoff' AND NOT EXISTS (
              SELECT 1 FROM context_rollovers rollover
              WHERE rollover.agent_id = agent_activations.agent_id
                AND rollover.state IN ('requested','handoff_committed','session_retiring')
            ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM activation_outbox audit
            WHERE audit.activation_id = agent_activations.id
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
      const triggerId = (
        activation: ActivationRow,
      ): string | undefined => {
        if (activation.kind !== "trigger_occurrence") return undefined;
        try {
          const payload = JSON.parse(activation.payload_json) as {
            trigger?: { id?: unknown };
          };
          return typeof payload.trigger?.id === "string"
            ? payload.trigger.id
            : undefined;
        } catch {
          return undefined;
        }
      };
      const candidateTriggerId = triggerId(queuedActivations[0]!);
      const triggerBudgetChargeId = (
        activation: ActivationRow,
      ): string | undefined => {
        if (activation.kind !== "trigger_occurrence") return undefined;
        return (this.sqlite.prepare(`
          SELECT budget_charge_id FROM trigger_occurrences
          WHERE activation_id = ?
        `).get(activation.id) as {
          budget_charge_id: string | null;
        } | undefined)?.budget_charge_id ?? undefined;
      };
      const candidateBudgetChargeId = triggerBudgetChargeId(
        queuedActivations[0]!,
      );
      const activations = candidateIsExplicitQueuedTurn
        ? [queuedActivations[0]!]
        : queuedActivations
          .filter((activation) =>
            !isExplicitQueuedTurn(activation) &&
            startsFreshTask(activation) === candidateStartsFreshTask &&
            (
              candidateTriggerId
                ? triggerId(activation) === candidateTriggerId &&
                  triggerBudgetChargeId(activation) ===
                    candidateBudgetChargeId
                : triggerId(activation) === undefined
            ))
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
      if (candidateTriggerId && !candidateBudgetChargeId) {
        const charged = this.sqlite.prepare(`
          UPDATE trigger_definitions
          SET run_budget_used = CASE
                WHEN run_budget_limit IS NULL THEN run_budget_used
                ELSE run_budget_used + 1
              END,
              updated_at = ?
          WHERE id = ? AND (
            run_budget_limit IS NULL
            OR run_budget_used < run_budget_limit + run_budget_allowance
          )
        `).run(now, candidateTriggerId).changes;
        if (charged !== 1) return undefined;
        const budgetChargeId = randomUUID();
        this.sqlite.prepare(`
          UPDATE trigger_occurrences
          SET budget_charge_id = ?, budget_charged_at = ?, updated_at = ?
          WHERE budget_charge_id IS NULL
            AND activation_id IN (
              ${activations.map(() => "?").join(", ")}
            )
        `).run(
          budgetChargeId,
          now,
          now,
          ...activations.map((activation) => activation.id),
        );
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
        UPDATE agent_activations SET state = 'attached', updated_at = ?
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
          ...(activation.last_delivery_error
            ? { lastDeliveryError: activation.last_delivery_error }
            : {}),
        })),
      };
    })();
  }

  recoverExpiredUninjectedRuns(now: string): void {
    const runs = this.sqlite.prepare(`
      SELECT id, prompt_injection_state FROM scheduler_runs
      WHERE status IN ('leased', 'running') AND lease_expires_at <= ?
    `).all(now) as Array<{
      id: string;
      prompt_injection_state: string;
    }>;
    for (const run of runs) {
      if (run.prompt_injection_state === "not_injected") {
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
      } else {
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
      }
    }
  }
}
