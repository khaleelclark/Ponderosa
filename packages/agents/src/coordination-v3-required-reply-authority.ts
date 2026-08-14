import type Database from "better-sqlite3";
import type {
  CommunicationAudience,
  CommunicationIntent,
  CoordinationReplyAuthority,
} from "@ponderosa/core";
import { PRIORITY } from "./coordination-v3-activation.js";
import { stableJson } from "./coordination-v3-canonical-json.js";
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
  ) {}

  registerForRun(input: {
    runId: string;
    projectId: string;
    agentId: string;
    scopeKey: string;
    activations: readonly ActivationInput[];
    now: string;
  }): RequiredReplyObligation[] {
    const required = requiredReplyAuthoritiesForActivations(input.activations);
    const insert = this.sqlite.prepare(`
      INSERT OR IGNORE INTO required_reply_obligations (
        run_id, source_activation_id, project_id, agent_id, scope_key,
        reply_authority_json, attempt_count, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    for (const obligation of required) {
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

  forRun(runId: string): RequiredReplyObligation[] {
    const rows = this.sqlite.prepare(`
      SELECT run_id, source_activation_id, project_id, agent_id, scope_key,
        reply_authority_json, attempt_count, state,
        satisfied_communication_id, recovery_activation_id
      FROM required_reply_obligations WHERE run_id = ?
      ORDER BY source_activation_id
    `).all(runId) as Array<{
      run_id: string; source_activation_id: string; project_id: string;
      agent_id: string; scope_key: string; reply_authority_json: string;
      attempt_count: number; state: RequiredReplyObligation["state"];
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
    }
    return this.forRun(runId);
  }

  settleRetried(runId: string, now: string): number {
    return this.sqlite.prepare(`
      UPDATE required_reply_obligations
      SET state = 'retried', updated_at = ?, terminal_at = ?
      WHERE run_id = ? AND state = 'pending' AND source_activation_id IN (
        SELECT activation_id FROM scheduler_run_activations attached
        JOIN agent_activations activation ON activation.id = attached.activation_id
        WHERE attached.run_id = ? AND activation.state = 'retry_pending'
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
