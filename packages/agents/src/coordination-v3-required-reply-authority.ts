import type Database from "better-sqlite3";
import type {
  CommunicationAudience,
  CommunicationIntent,
  CoordinationReplyAuthority,
} from "@ponderosa/core";
import { PRIORITY } from "./coordination-v3-activation.js";
import { stableJson } from "./coordination-v3-canonical-json.js";
import { delegationOriginsForActivation, hasOutstandingDelegation } from "./coordination-v3-task-lineage.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";

const MAX_REQUIRED_REPLY_ATTEMPTS = 5;
const REQUIRED_REPLY_EXHAUSTED_ERROR =
  `Required Chat reply was not published after ${MAX_REQUIRED_REPLY_ATTEMPTS + 1} provider Runs. Automatic recovery stopped; use Try Delivery Again to start an explicit bounded retry.`;

type ActivationInput = { id: string; kind: string; payload: unknown };
type RequiredReplyTerminalState = "cancelled" | "retried" | "superseded";

export interface RequiredReplyObligation {
  runId: string;
  sourceActivationId: string;
  projectId: string;
  agentId: string;
  scopeKey: string;
  replyAuthority: CoordinationReplyAuthority;
  attemptCount: number;
  deliveryPhase: "initial" | "final";
  interimCommunicationId?: string;
  blockingDecisionId?: string;
  state:
    | "pending"
    | "satisfied"
    | "recovery_pending"
    | "failed"
    | RequiredReplyTerminalState;
  satisfiedCommunicationId?: string;
  recoveryActivationId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeCoordinationReplyAuthority(value: unknown): CoordinationReplyAuthority | undefined {
  const candidate = record(value);
  if (!candidate || !(candidate.intent === "broadcast" || candidate.intent === "direct_to_user" || candidate.intent === "collaboration")) {
    return undefined;
  }
  const rawRecipients = candidate.recipientAgentIds;
  const recipients = Array.isArray(rawRecipients)
    ? rawRecipients.filter((agentId): agentId is string => typeof agentId === "string" && Boolean(agentId.trim()))
    : [];
  if ((rawRecipients !== undefined && (!Array.isArray(rawRecipients) || recipients.length !== rawRecipients.length)) ||
      (candidate.intent === "collaboration" ? recipients.length === 0 : recipients.length > 0)) return undefined;
  return {
    intent: candidate.intent,
    ...(recipients.length ? { recipientAgentIds: [...new Set(recipients)].sort() } : {}),
  };
}

const EXPLICIT_PROTOCOL_REPLY_KINDS = new Set([
  "human_message",
  "required_reply_recovery",
  "coordination_outcome",
  "coordination_join_satisfied",
  "coordination_join_impossible",
  "context_rollover_handoff",
]);

function replyAuthorityForActivation(activation: ActivationInput): CoordinationReplyAuthority | undefined {
  const payload = record(activation.payload);
  if (!payload) return undefined;
  if (EXPLICIT_PROTOCOL_REPLY_KINDS.has(activation.kind)) {
    const inherited = normalizeCoordinationReplyAuthority(payload.replyAuthority);
    if (inherited) return inherited;
  }
  if (activation.kind !== "human_message") return undefined;
  const communication = record(payload.communication);
  const sender = record(communication?.sender);
  if (!communication || sender?.kind !== "user") return undefined;
  if (communication.intent === "broadcast") return { intent: "broadcast" };
  if (communication.intent === "user_dm") return { intent: "direct_to_user" };
  return undefined;
}

export function requiredReplyAuthoritiesForActivations(
  activations: readonly ActivationInput[],
): Array<{ activationId: string; replyAuthority: CoordinationReplyAuthority; attemptCount: number }> {
  return activations.flatMap((activation) => {
    const replyAuthority = replyAuthorityForActivation(activation);
    if (!replyAuthority) return [];
    const recovery = record(record(activation.payload)?.requiredReplyRecovery);
    const attemptCount = typeof recovery?.attempt === "number" && Number.isSafeInteger(recovery.attempt)
      ? Math.max(0, recovery.attempt)
      : 0;
    return [{ activationId: activation.id, replyAuthority, attemptCount }];
  });
}

export function requiredReplyAuthorityForActivations(
  activations: readonly ActivationInput[],
): CoordinationReplyAuthority | undefined {
  const distinct = [...new Map(
    requiredReplyAuthoritiesForActivations(activations)
      .map(({ replyAuthority }) => [stableJson(replyAuthority), replyAuthority]),
  ).values()];
  return distinct.length === 1 ? distinct[0] : undefined;
}

export function communicationSatisfiesReplyAuthority(
  authority: CoordinationReplyAuthority,
  intent: CommunicationIntent | string,
  audience: CommunicationAudience,
): boolean {
  if (authority.intent === "broadcast") return intent === "broadcast" && audience.kind === "organization";
  if (authority.intent === "direct_to_user") {
    return (intent === "user_dm" && audience.kind === "user_agent") ||
      (intent === "direct_to_user" && audience.kind === "user");
  }
  if (intent !== "collaboration" || audience.kind !== "agents") return false;
  const expected = [...new Set(authority.recipientAgentIds ?? [])].sort();
  const actual = [...new Set(audience.agentIds)].sort();
  return stableJson(expected) === stableJson(actual);
}

export class CoordinationV3RequiredReplyAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly createActivation: (input: CreateActivationV3Input) => string,
    private readonly afterRecoveryCreated: (activationId: string, now: string) => void,
  ) {}

  registerForRun(input: {
    runId: string;
    projectId: string;
    agentId: string;
    scopeKey: string;
    activations: readonly ActivationInput[];
    now: string;
  }): RequiredReplyObligation[] {
    this.transferContextRolloverObligations(input);
    this.transferFromOrigins(input, input.activations.flatMap(a =>
      delegationOriginsForActivation(this.sqlite, a.id)), true);
    const inheritedFinalRoutes = new Set(input.activations.flatMap(a => delegationOriginsForActivation(this.sqlite, a.id))
      .flatMap(origin => this.forRun(origin)).filter(o => o.deliveryPhase === 'final')
      .map(o => stableJson(o.replyAuthority)));
    const required = requiredReplyAuthoritiesForActivations(input.activations);
    const insert = this.sqlite.prepare(`
      INSERT OR IGNORE INTO required_reply_obligations (
        run_id, source_activation_id, project_id, agent_id, scope_key,
        reply_authority_json, attempt_count, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    for (const obligation of required) {
      const source = input.activations.find(a => a.id === obligation.activationId);
      // Callback convenience routes must not create a second copy of their
      // task root. A distinct authored input or recovery still owns its own
      // obligation even when its route happens to match that root.
      if (source && ['coordination_outcome', 'coordination_join_satisfied', 'coordination_join_impossible'].includes(source.kind) &&
          inheritedFinalRoutes.has(stableJson(obligation.replyAuthority))) continue;
      // Final-delivery recovery retains one root and increments its existing
      // generation. Do not also create a second initial-response obligation.
      if (input.activations.some(a => a.id === obligation.activationId && a.kind === 'required_reply_recovery') &&
          this.sqlite.prepare(`SELECT 1 FROM required_reply_obligations
            WHERE recovery_activation_id = ? AND delivery_phase = 'final'
              AND project_id = ? AND agent_id = ? AND scope_key = ?`)
            .get(obligation.activationId, input.projectId, input.agentId, input.scopeKey)) continue;
      this.sqlite.prepare(`
        UPDATE required_reply_obligations
        SET state = 'superseded', updated_at = ?, terminal_at = ?
        WHERE recovery_activation_id = ? AND state = 'recovery_pending'
      `).run(input.now, input.now, obligation.activationId);
      insert.run(
        input.runId,
        obligation.activationId,
        input.projectId,
        input.agentId,
        input.scopeKey,
        stableJson(obligation.replyAuthority),
        obligation.attemptCount,
        input.now,
        input.now,
      );
    }
    return this.forRun(input.runId);
  }

  /** A context-rollover continuation is not a new authored request, but it
   * executes the unfinished source task in a replacement provider session.
   * Move the exact source obligations onto that Run and retire the recovery
   * Activations they had queued when the pressure-source Run completed. This
   * keeps one durable reply owner while preserving its retry generation. */
  private transferContextRolloverObligations(input: {
    runId: string;
    projectId: string;
    agentId: string;
    scopeKey: string;
    activations: readonly ActivationInput[];
    now: string;
  }): void {
    const continuations = input.activations.filter(
      (activation) => activation.kind === "context_rollover_continuation",
    );
    if (continuations.length === 0) return;
    if (continuations.length !== 1 || input.activations.length !== 1) {
      throw new Error("context rollover continuation Run must be isolated");
    }
    const continuation = continuations[0]!;
    const payload = record(continuation.payload);
    const rolloverId = typeof payload?.rolloverId === "string"
      ? payload.rolloverId
      : undefined;
    const payloadReplyAuthority = normalizeCoordinationReplyAuthority(
      payload?.replyAuthority,
    );
    if (!rolloverId) {
      throw new Error("context rollover continuation is missing its durable owner");
    }
    const rollover = this.sqlite.prepare(`
      SELECT id, source_run_id, source_activation_ids_json,
        reply_authority_json
      FROM context_rollovers
      WHERE id = ? AND continuation_activation_id = ?
        AND project_id = ? AND agent_id = ? AND scope_key = ?
        AND state = 'continuation_ready'
    `).get(
      rolloverId,
      continuation.id,
      input.projectId,
      input.agentId,
      input.scopeKey,
    ) as {
      id: string;
      source_run_id: string;
      source_activation_ids_json: string;
      reply_authority_json: string | null;
    } | undefined;
    if (!rollover) {
      throw new Error("context rollover continuation authority is unavailable");
    }
    if (!rollover.reply_authority_json) {
      if (payloadReplyAuthority) {
        throw new Error("context rollover continuation reply authority conflicts with its durable owner");
      }
    }
    if (rollover.reply_authority_json && (!payloadReplyAuthority ||
        stableJson(payloadReplyAuthority) !== rollover.reply_authority_json)) {
      throw new Error("context rollover continuation reply authority conflicts with its durable owner");
    }
    const sourceActivationIds = JSON.parse(
      rollover.source_activation_ids_json,
    ) as unknown;
    if (!Array.isArray(sourceActivationIds) ||
        sourceActivationIds.some((id) => typeof id !== "string")) {
      throw new Error("context rollover source activation lineage is invalid");
    }
    if (sourceActivationIds.length === 0) return;
    const sourceRun = this.sqlite.prepare(`
      SELECT project_id, agent_id, scope_key
      FROM scheduler_runs
      WHERE id = ?
    `).get(rollover.source_run_id) as {
      project_id: string;
      agent_id: string;
      scope_key: string;
    } | undefined;
    if (!sourceRun || sourceRun.project_id !== input.projectId ||
        sourceRun.agent_id !== input.agentId ||
        sourceRun.scope_key !== input.scopeKey) {
      throw new Error("context rollover source Run authority conflicts with its durable owner");
    }
    const attachedSourceCount = this.sqlite.prepare(`
      SELECT COUNT(DISTINCT source.value) AS count
      FROM json_each(?) source
      JOIN scheduler_run_activations attached
        ON attached.run_id = ? AND attached.activation_id = source.value
      JOIN agent_activations activation ON activation.id = attached.activation_id
      WHERE activation.project_id = ? AND activation.agent_id = ?
        AND activation.scope_key = ?
    `).get(
      rollover.source_activation_ids_json,
      rollover.source_run_id,
      input.projectId,
      input.agentId,
      input.scopeKey,
    ) as { count: number };
    if (attachedSourceCount.count !== sourceActivationIds.length) {
      throw new Error("context rollover source activation lineage conflicts with its source Run");
    }
    this.transferFromOrigins(input, [rollover.source_run_id]);
  }

  private transferFromOrigins(input: {
    runId: string; projectId: string; agentId: string; scopeKey: string; now: string;
    activations?: readonly ActivationInput[];
  }, originRunIds: string[], finalOnly = false): void {
    for (const originRunId of new Set(originRunIds)) {
      const roots = this.forRun(originRunId).filter(o =>
        o.projectId === input.projectId && o.agentId === input.agentId && o.scopeKey === input.scopeKey &&
        (!finalOnly || o.deliveryPhase === "final"));
      for (const root of roots) {
        const row = this.sqlite.prepare(`
          SELECT obligation.run_id FROM required_reply_obligations obligation
          JOIN scheduler_runs run ON run.id = obligation.run_id
          WHERE obligation.source_activation_id = ? AND obligation.project_id = ?
            AND obligation.agent_id = ? AND obligation.scope_key = ?
          ORDER BY run.rowid DESC LIMIT 1
        `).get(root.sourceActivationId, input.projectId, input.agentId, input.scopeKey) as { run_id: string } | undefined;
        const predecessor = row ? this.forRun(row.run_id).find(o => o.sourceActivationId === root.sourceActivationId) : undefined;
        if (!predecessor || predecessor.runId === input.runId ||
            !["pending", "recovery_pending", "retried"].includes(predecessor.state)) continue;
        const isRecovery = input.activations?.some(a => a.id === predecessor.recoveryActivationId && a.kind === 'required_reply_recovery');
        const answeredDecision = predecessor.blockingDecisionId && input.activations?.some(a => Boolean(this.sqlite.prepare(`
          SELECT 1 FROM activation_sources source JOIN agent_activations wake ON wake.id=source.activation_id
          WHERE source.activation_id=? AND source.source_kind='task_decision' AND source.source_id=?
            AND wake.agent_id=? AND wake.project_id=? AND wake.scope_key=?
            AND json_extract(wake.payload_json, '$.decision.id')=source.source_id
        `).get(a.id, predecessor.blockingDecisionId, input.agentId, input.projectId, input.scopeKey)));
        this.sqlite.prepare(`
          INSERT OR IGNORE INTO required_reply_obligations (
            run_id, source_activation_id, project_id, agent_id, scope_key, reply_authority_json,
            attempt_count, state, delivery_phase, interim_communication_id, blocking_decision_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
        `).run(input.runId, predecessor.sourceActivationId, input.projectId, input.agentId, input.scopeKey,
          stableJson(predecessor.replyAuthority), predecessor.attemptCount + (isRecovery ? 1 : 0), predecessor.deliveryPhase,
          predecessor.interimCommunicationId ?? null,
          answeredDecision ? null : predecessor.blockingDecisionId ?? null, input.now, input.now);
        if (predecessor.recoveryActivationId) this.sqlite.prepare(`
          UPDATE agent_activations SET state = 'cancelled', updated_at = ?, terminal_at = ?
          WHERE id = ? AND state IN ('pending','retry_pending')
        `).run(input.now, input.now, predecessor.recoveryActivationId);
        this.sqlite.prepare(`
          UPDATE required_reply_obligations SET state = 'superseded', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND source_activation_id = ? AND state IN ('pending','recovery_pending','retried')
        `).run(input.now, input.now, predecessor.runId, predecessor.sourceActivationId);
      }
    }
  }

  /** Creating a tracked delegation establishes a distinct final-delivery
   * obligation. An earlier initial reply is preserved as an interim receipt,
   * not retroactively presented as task completion. Historical rows are never
   * inferred or backfilled. An already satisfied final obligation stays final. */
  retainForDelegation(runId: string, now: string): void {
    this.sqlite.prepare(`
      UPDATE required_reply_obligations SET delivery_phase = 'final', state = 'pending',
        interim_communication_id = satisfied_communication_id, satisfied_communication_id = NULL,
        terminal_at = NULL, updated_at = ?
      WHERE run_id = ? AND delivery_phase = 'initial'
        AND state IN ('pending','satisfied')
        AND json_extract(reply_authority_json, '$.intent') IN ('broadcast','direct_to_user')
    `).run(now, runId);
  }

  /** Called only after a canonical, blocking operator Decision is stored by
   * the active Run's authenticated server route. A Decision is a wait, not
   * fabricated completion or permission. Its exact response supplies a wake. */
  waitForDecision(runId: string, decisionId: string, now: string): void {
    if (this.forRun(runId).some(o => o.deliveryPhase === 'final' && o.state === 'pending' &&
        o.blockingDecisionId && o.blockingDecisionId !== decisionId)) {
      throw new Error('task_decision_already_pending: answer the existing exact blocking Decision first');
    }
    this.sqlite.prepare(`UPDATE required_reply_obligations
      SET blocking_decision_id = ?, updated_at = ?
      WHERE run_id = ? AND delivery_phase = 'final' AND state = 'pending'`)
      .run(decisionId, now, runId);
  }

  attachDecisionWake(decisionId: string, activationId: string): void {
    this.sqlite.prepare(`INSERT OR IGNORE INTO activation_sources (activation_id, source_kind, source_id)
      SELECT wake.id, 'task_decision', obligation.blocking_decision_id
      FROM agent_activations wake JOIN required_reply_obligations obligation
        ON obligation.agent_id = wake.agent_id AND obligation.project_id = wake.project_id
          AND obligation.scope_key = wake.scope_key
      WHERE wake.id = ? AND obligation.blocking_decision_id = ?
        AND json_extract(wake.payload_json, '$.decision.id')=obligation.blocking_decision_id
        AND obligation.delivery_phase = 'final' AND obligation.state = 'pending'`)
      .run(activationId, decisionId);
  }

  reconcileDecision(input: { decisionId: string; runId: string; projectId: string; agentId: string; scopeKey: string }, now: string): void {
    const source = this.sqlite.prepare(`SELECT 1 FROM scheduler_runs run JOIN agents owner ON owner.id = run.agent_id
      WHERE run.id = ? AND run.agent_id = ? AND run.project_id = ? AND run.scope_key = ?
        AND run.status <> 'cancelled' AND owner.archived = 0 AND owner.deleted_at IS NULL`)
      .get(input.runId, input.agentId, input.projectId, input.scopeKey);
    if (!source) return;
    for (const root of this.forRun(input.runId).filter(o => o.deliveryPhase === 'final')) {
      const latest = this.sqlite.prepare(`SELECT obligation.run_id FROM required_reply_obligations obligation
        JOIN scheduler_runs run ON run.id = obligation.run_id
        WHERE source_activation_id = ? AND obligation.agent_id = ? AND obligation.project_id = ? AND obligation.scope_key = ?
        ORDER BY run.rowid DESC LIMIT 1`).get(root.sourceActivationId, input.agentId, input.projectId, input.scopeKey) as { run_id: string } | undefined;
      if (!latest) continue;
      const pending = this.forRun(latest.run_id).find(o => o.sourceActivationId === root.sourceActivationId);
      if (!pending || !['pending','recovery_pending'].includes(pending.state)) continue;
      if (pending.blockingDecisionId && pending.blockingDecisionId !== input.decisionId) continue;
      if (pending.recoveryActivationId) this.sqlite.prepare(`UPDATE agent_activations SET state='cancelled', updated_at=?, terminal_at=?
        WHERE id=? AND state IN ('pending','retry_pending')`).run(now, now, pending.recoveryActivationId);
      this.sqlite.prepare(`UPDATE required_reply_obligations SET state='pending', blocking_decision_id=?,
        recovery_activation_id=NULL, updated_at=? WHERE run_id=? AND source_activation_id=?`)
        .run(input.decisionId, now, pending.runId, pending.sourceActivationId);
    }
  }

  forRun(runId: string): RequiredReplyObligation[] {
    const rows = this.sqlite.prepare(`
      SELECT run_id, source_activation_id, project_id, agent_id, scope_key,
        reply_authority_json, attempt_count, state, delivery_phase, interim_communication_id, blocking_decision_id,
        satisfied_communication_id, recovery_activation_id
      FROM required_reply_obligations WHERE run_id = ?
      ORDER BY source_activation_id
    `).all(runId) as Array<{
      run_id: string; source_activation_id: string; project_id: string;
      agent_id: string; scope_key: string; reply_authority_json: string;
      attempt_count: number; state: RequiredReplyObligation["state"];
      delivery_phase: "initial" | "final"; interim_communication_id: string | null;
      blocking_decision_id: string | null;
      satisfied_communication_id: string | null; recovery_activation_id: string | null;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      sourceActivationId: row.source_activation_id,
      projectId: row.project_id,
      agentId: row.agent_id,
      scopeKey: row.scope_key,
      replyAuthority: JSON.parse(row.reply_authority_json) as CoordinationReplyAuthority,
      attemptCount: row.attempt_count,
      deliveryPhase: row.delivery_phase,
      ...(row.interim_communication_id ? { interimCommunicationId: row.interim_communication_id } : {}),
      ...(row.blocking_decision_id ? { blockingDecisionId: row.blocking_decision_id } : {}),
      state: row.state,
      ...(row.satisfied_communication_id ? { satisfiedCommunicationId: row.satisfied_communication_id } : {}),
      ...(row.recovery_activation_id ? { recoveryActivationId: row.recovery_activation_id } : {}),
    }));
  }

  unambiguousForRun(runId: string): RequiredReplyObligation | undefined {
    const obligations = this.forRun(runId);
    const distinct = new Set(obligations.map((item) => stableJson(item.replyAuthority)));
    return distinct.size === 1 ? obligations[0] : undefined;
  }

  authoritiesForRun(runId: string): CoordinationReplyAuthority[] {
    return [...new Map(
      this.forRun(runId)
        .filter((item) => item.state === "pending")
        .map((item) => [stableJson(item.replyAuthority), item.replyAuthority]),
    ).values()];
  }

  markSatisfied(input: {
    runId: string;
    communicationId: string;
    intent: CommunicationIntent | string;
    audience: CommunicationAudience;
    taskDelivery?: "final" | "blocked";
    now: string;
  }): number {
    const update = this.sqlite.prepare(`
      UPDATE required_reply_obligations
      SET state = 'satisfied', satisfied_communication_id = ?, updated_at = ?, terminal_at = ?
      WHERE run_id = ? AND source_activation_id = ? AND state = 'pending'
    `);
    let satisfied = 0;
    for (const obligation of this.forRun(input.runId)) {
      if (obligation.state !== "pending" ||
          !communicationSatisfiesReplyAuthority(obligation.replyAuthority, input.intent, input.audience)) continue;
      if (obligation.deliveryPhase === 'final' && obligation.interimCommunicationId === input.communicationId) continue;
      if (obligation.deliveryPhase === 'final' && input.taskDelivery === 'final' &&
          (obligation.blockingDecisionId || hasOutstandingDelegation(this.sqlite, obligation))) {
        throw new Error('task_delivery_dependencies_pending: integrate the exact pending results or publish an explicit blocked outcome');
      }
      // A blocked status can accompany an actionable Decision, but must not
      // sever the exact answer's continuation from its unfinished task.
      if (obligation.deliveryPhase === "final" && (!input.taskDelivery || obligation.blockingDecisionId)) {
        this.sqlite.prepare(`UPDATE required_reply_obligations SET interim_communication_id = ?, updated_at = ?
          WHERE run_id = ? AND source_activation_id = ? AND state = 'pending'`)
          .run(input.communicationId, input.now, input.runId, obligation.sourceActivationId);
        continue;
      }
      satisfied += update.run(
        input.communicationId,
        input.now,
        input.now,
        input.runId,
        obligation.sourceActivationId,
      ).changes;
    }
    return satisfied;
  }

  recoverPending(runId: string, now: string): RequiredReplyObligation[] {
    for (const obligation of this.forRun(runId)) {
      if (obligation.state !== "pending") continue;
      if (obligation.deliveryPhase === "final" && (obligation.blockingDecisionId || hasOutstandingDelegation(this.sqlite, obligation))) continue;
      if (obligation.attemptCount >= MAX_REQUIRED_REPLY_ATTEMPTS) {
        const sourceActivation = this.sqlite.prepare(`
          WITH RECURSIVE reply_chain(activation_id, depth) AS (
            SELECT ?, 0
            UNION ALL
            SELECT parent.source_activation_id, reply_chain.depth + 1
            FROM reply_chain
            JOIN required_reply_obligations parent
              ON parent.recovery_activation_id = reply_chain.activation_id
            WHERE reply_chain.depth <= ?
          )
          SELECT activation.id
          FROM reply_chain
          JOIN agent_activations activation ON activation.id = reply_chain.activation_id
          JOIN activation_sources source
            ON source.activation_id = activation.id AND source.source_kind = 'communication'
          JOIN runtime_communications runtime ON runtime.id = source.source_id
          WHERE activation.kind = 'human_message'
            AND json_extract(runtime.sender_json, '$.kind') = 'user'
            AND runtime.intent IN ('broadcast', 'user_dm')
          ORDER BY reply_chain.depth DESC
          LIMIT 1
        `).get(
          obligation.sourceActivationId,
          MAX_REQUIRED_REPLY_ATTEMPTS,
        ) as { id: string } | undefined;
        if (sourceActivation) this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'outcome_unknown',
            delivery_failures = MAX(delivery_failures, ?),
            last_delivery_error = ?,
            terminal_outcome = 'retry_exhausted',
            terminal_at = ?, updated_at = ?
          WHERE id = ? AND state = 'consumed'
        `).run(
          MAX_REQUIRED_REPLY_ATTEMPTS + 1,
          REQUIRED_REPLY_EXHAUSTED_ERROR,
          now,
          now,
          sourceActivation.id,
        );
        this.sqlite.prepare(`
          UPDATE required_reply_obligations
          SET state = 'failed', updated_at = ?, terminal_at = ?
          WHERE run_id = ? AND source_activation_id = ? AND state = 'pending'
        `).run(now, now, runId, obligation.sourceActivationId);
        continue;
      }
      const activationId = this.createActivation({
        projectId: obligation.projectId,
        agentId: obligation.agentId,
        scopeKey: obligation.scopeKey,
        kind: "required_reply_recovery",
        priority: PRIORITY.human,
        dispatchPolicy: "next_run",
        promptClass: "human",
        dedupeKey: `required-reply-recovery:${runId}:${obligation.sourceActivationId}`,
        payload: {
          replyAuthority: obligation.replyAuthority,
          requiredReplyRecovery: {
            sourceRunId: runId,
            sourceActivationId: obligation.sourceActivationId,
            attempt: obligation.attemptCount + 1,
            instruction: "The previous provider Run ended without publishing this source's required Chat reply. Ordinary provider output remains Work log only. Review canonical context, then publish exactly one reply through the inherited Ponderosa reply capability.",
          },
        },
        sourceKind: "required_reply",
        sourceId: `${runId}:${obligation.sourceActivationId}`,
        now,
      });
      this.sqlite.prepare(`
        UPDATE required_reply_obligations
        SET state = 'recovery_pending', recovery_activation_id = ?, updated_at = ?
        WHERE run_id = ? AND source_activation_id = ? AND state = 'pending'
      `).run(activationId, now, runId, obligation.sourceActivationId);
      this.afterRecoveryCreated(activationId, now);
    }
    return this.forRun(runId);
  }

  settleRetried(runId: string, now: string): number {
    return this.sqlite.prepare(`
      UPDATE required_reply_obligations
      SET state = 'retried', updated_at = ?, terminal_at = ?
      WHERE run_id = ? AND state = 'pending' AND (
        source_activation_id IN (
          SELECT activation_id FROM scheduler_run_activations attached
          JOIN agent_activations activation ON activation.id = attached.activation_id
          WHERE attached.run_id = ? AND activation.state = 'retry_pending'
        ) OR EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          JOIN agent_activations activation ON activation.id = attached.activation_id
          JOIN context_rollovers rollover
            ON rollover.continuation_activation_id = activation.id
          WHERE attached.run_id = required_reply_obligations.run_id
            AND activation.kind = 'context_rollover_continuation'
            AND activation.state = 'retry_pending'
        )
      )
    `).run(now, now, runId, runId).changes;
  }

  settleForRun(runId: string, state: Exclude<RequiredReplyTerminalState, "retried">, now: string): number {
    return this.sqlite.prepare(`
      UPDATE required_reply_obligations
      SET state = ?, updated_at = ?, terminal_at = ?
      WHERE run_id = ? AND state IN ('pending', 'recovery_pending')
    `).run(state, now, now, runId).changes;
  }
}
