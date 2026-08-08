import { randomUUID } from "node:crypto";
import type { CoordinationReplyAuthority } from "@ponderosa/core";
import type Database from "better-sqlite3";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type { ContextRolloverState, ContextRolloverV3 } from "./coordination-v3-types.js";

interface RolloverRow {
  id: string; project_id: string; agent_id: string; state: ContextRolloverState;
  old_provider_session_id: string; provider_session_generation: string;
  detected_occupancy: number; aggregate_tokens: number | null; threshold: number;
  context_window: number | null; low_water_mark: number;
  low_water_confirmation_required: number; source_run_id: string;
  source_activation_ids_json: string; scope_key: string; conversation_id: string | null;
  reply_authority_json: string | null;
  handoff_event_id: string | null; continuation_activation_id: string | null;
  replacement_session_id: string | null; visible_response_committed: number;
  handoff_committed_at: string | null; session_retiring_at: string | null;
  continuation_ready_at: string | null; replacement_session_at: string | null;
  visible_response_committed_at: string | null;
  last_error: string | null; created_at: string; updated_at: string; terminal_at: string | null;
}

export class CoordinationV3ContextRolloverAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly createActivation: (input: CreateActivationV3Input) => string,
  ) {}

  request(input: {
    projectId: string; agentId: string; oldProviderSessionId: string;
    providerSessionGeneration: string; detectedOccupancy: number; aggregateTokens?: number;
    threshold: number; contextWindow?: number; lowWaterMark: number;
    lowWaterConfirmationRequired?: boolean; sourceRunId: string;
    sourceActivationIds: string[]; scopeKey: string; conversationId?: string;
    replyAuthority?: CoordinationReplyAuthority; visibleResponseCommitted?: boolean; now?: string;
  }): { rollover: ContextRolloverV3; created: boolean } {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT * FROM context_rollovers
        WHERE agent_id = ? AND provider_session_generation = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(input.agentId, input.providerSessionGeneration) as RolloverRow | undefined;
      const retryableTerminalFailure = existing
        && (existing.state === "failed" || existing.state === "outcome_unknown")
        && !existing.last_error?.startsWith("rollover_seed_overflow:");
      if (existing && !retryableTerminalFailure) {
        return { rollover: this.view(existing), created: false };
      }
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO context_rollovers (
          id, project_id, agent_id, state, old_provider_session_id,
          provider_session_generation, detected_occupancy, aggregate_tokens,
          threshold, context_window, low_water_mark, low_water_confirmation_required, source_run_id,
          source_activation_ids_json, scope_key, conversation_id, reply_authority_json,
          visible_response_committed, visible_response_committed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.projectId, input.agentId, input.oldProviderSessionId,
        input.providerSessionGeneration, input.detectedOccupancy, input.aggregateTokens ?? null,
        input.threshold, input.contextWindow ?? null, input.lowWaterMark,
        input.lowWaterConfirmationRequired === false ? 0 : 1, input.sourceRunId,
        JSON.stringify([...new Set(input.sourceActivationIds)].sort()), input.scopeKey,
        input.conversationId ?? null,
        input.replyAuthority ? JSON.stringify(input.replyAuthority) : null,
        input.visibleResponseCommitted ? 1 : 0,
        input.visibleResponseCommitted ? now : null,
        now, now,
      );
      this.createActivation({
        projectId: input.projectId,
        agentId: input.agentId,
        scopeKey: input.scopeKey,
        kind: "context_rollover_handoff",
        priority: 100,
        // The source task may have an exact output contract (for example,
        // reply only DONE). A rollover handoff therefore runs at the next
        // scheduler boundary on the retained old provider session, where its
        // bounded output cannot be confused with or override task output.
        dispatchPolicy: "next_run",
        promptClass: "blocker",
        dedupeKey: `context-rollover-handoff:${id}`,
        payload: {
          rolloverId: id,
          detectedOccupancy: input.detectedOccupancy,
          threshold: input.threshold,
          instruction: "The pressure source Run has ended. Produce only one self-contained 150–500-word bounded handoff using these exact labels: Objective:, Completed work:, Unfinished work:, Blockers:, Exact next action:, Verified facts:, Assumptions:. Include relevant file, path, artifact, or reference identifiers. Do not call a tool, send a message, resume the task, or repeat its output contract; place the handoff only in the Work log. The Ponderosa runtime, not a provider tool call, owns session replacement.",
        },
        sourceKind: "context_rollover",
        sourceId: id,
        now,
      });
      return { rollover: this.get(id)!, created: true };
    })();
  }

  get(id: string): ContextRolloverV3 | undefined {
    const row = this.sqlite.prepare(`SELECT * FROM context_rollovers WHERE id = ?`).get(id) as RolloverRow | undefined;
    return row ? this.view(row) : undefined;
  }

  activeForAgent(agentId: string): ContextRolloverV3 | undefined {
    const row = this.sqlite.prepare(`
      SELECT * FROM context_rollovers WHERE agent_id = ?
        AND state IN ('requested','handoff_committed','session_retiring','continuation_ready')
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(agentId) as RolloverRow | undefined;
    return row ? this.view(row) : undefined;
  }

  forReplacementSession(agentId: string, replacementSessionId: string): ContextRolloverV3 | undefined {
    const row = this.sqlite.prepare(`
      SELECT * FROM context_rollovers
      WHERE agent_id = ? AND replacement_session_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(agentId, replacementSessionId) as RolloverRow | undefined;
    return row ? this.view(row) : undefined;
  }

  forContinuationRun(runId: string, agentId: string): ContextRolloverV3 | undefined {
    const row = this.sqlite.prepare(`
      SELECT rollover.*
      FROM context_rollovers rollover
      JOIN scheduler_run_activations attached
        ON attached.activation_id = rollover.continuation_activation_id
      JOIN scheduler_runs run ON run.id = attached.run_id
      WHERE attached.run_id = ? AND run.agent_id = ?
        AND rollover.agent_id = run.agent_id
      ORDER BY rollover.updated_at DESC, rollover.id DESC LIMIT 1
    `).get(runId, agentId) as RolloverRow | undefined;
    return row ? this.view(row) : undefined;
  }

  recoveryForRun(runId: string, agentId: string): ContextRolloverV3 | undefined {
    const row = this.sqlite.prepare(`
      SELECT rollover.*
      FROM scheduler_run_activations attached
      JOIN scheduler_runs run ON run.id = attached.run_id
      JOIN activation_sources recovery
        ON recovery.activation_id = attached.activation_id
        AND recovery.source_kind = 'context_rollover_recovery'
      JOIN context_rollovers rollover ON rollover.id = recovery.source_id
      WHERE attached.run_id = ? AND run.agent_id = ?
        AND rollover.agent_id = run.agent_id
        AND rollover.state IN ('failed','outcome_unknown')
        AND rollover.handoff_event_id IS NOT NULL
      ORDER BY rollover.terminal_at DESC, rollover.updated_at DESC,
        rollover.id DESC
      LIMIT 1
    `).get(runId, agentId) as RolloverRow | undefined;
    return row ? this.view(row) : undefined;
  }

  recoveryForRequest(requestId: string): ContextRolloverV3 | undefined {
    const row = this.sqlite.prepare(`
      SELECT rollover.*
      FROM agent_activations activation
      JOIN activation_sources request_source
        ON request_source.activation_id = activation.id
        AND request_source.source_kind = 'request'
        AND request_source.source_id = ?
      JOIN activation_sources recovery
        ON recovery.activation_id = activation.id
        AND recovery.source_kind = 'context_rollover_recovery'
      JOIN context_rollovers rollover ON rollover.id = recovery.source_id
      ORDER BY rollover.terminal_at DESC, rollover.updated_at DESC,
        rollover.id DESC
      LIMIT 1
    `).get(requestId) as RolloverRow | undefined;
    return row ? this.view(row) : undefined;
  }

  active(projectId?: string): ContextRolloverV3[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM context_rollovers
      WHERE state IN ('requested','handoff_committed','session_retiring','continuation_ready')
        AND (? IS NULL OR project_id = ?)
      ORDER BY updated_at, id
    `).all(projectId ?? null, projectId ?? null) as RolloverRow[];
    return rows.map((row) => this.view(row));
  }

  cancelledReplacements(): ContextRolloverV3[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM context_rollovers
      WHERE state = 'outcome_unknown'
        AND last_error = 'replacement Run was cancelled before low-water context confirmation'
      ORDER BY terminal_at, id
    `).all() as RolloverRow[];
    return rows.map((row) => this.view(row));
  }

  commitHandoff(id: string, handoffEventId: string, now = new Date().toISOString()): ContextRolloverV3 {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE context_rollovers SET state = 'handoff_committed', handoff_event_id = ?,
          handoff_committed_at = COALESCE(handoff_committed_at, ?), updated_at = ?
        WHERE id = ? AND state IN ('requested','handoff_committed')
          AND (handoff_event_id IS NULL OR handoff_event_id = ?)
      `).run(handoffEventId, now, now, id, handoffEventId);
      // A manual rollover already supplied the bounded handoff. Retire only
      // the still-unclaimed request Activation so it cannot be coalesced into
      // the replacement Run alongside the continuation Activation.
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE kind = 'context_rollover_handoff' AND state IN ('pending','retry_pending')
          AND id IN (
            SELECT activation_id FROM activation_sources
            WHERE source_kind = 'context_rollover' AND source_id = ?
          )
      `).run(now, now, id);
    })();
    const result = this.get(id);
    if (!result?.handoffEventId || result.handoffEventId !== handoffEventId) throw new Error("context rollover handoff conflict");
    return result;
  }

  beginRetiring(id: string, now = new Date().toISOString()): ContextRolloverV3 {
    this.sqlite.prepare(`
      UPDATE context_rollovers SET state = 'session_retiring',
        session_retiring_at = COALESCE(session_retiring_at, ?), updated_at = ?
      WHERE id = ? AND state IN ('handoff_committed','session_retiring') AND handoff_event_id IS NOT NULL
    `).run(now, now, id);
    const result = this.get(id);
    if (!result || !["session_retiring", "continuation_ready", "completed"].includes(result.state)) {
      throw new Error("context rollover is not ready to retire its session");
    }
    return result;
  }

  markVisibleResponseCommitted(agentId: string, sourceRunId: string, now = new Date().toISOString()): ContextRolloverV3 | undefined {
    this.sqlite.prepare(`
      UPDATE context_rollovers SET visible_response_committed = 1,
        visible_response_committed_at = COALESCE(visible_response_committed_at, ?), updated_at = ?
      WHERE agent_id = ? AND source_run_id = ?
        AND state IN ('requested','handoff_committed','session_retiring')
    `).run(now, now, agentId, sourceRunId);
    return this.activeForAgent(agentId);
  }

  prepareContinuation(input: { id: string; visibleResponseCommitted: boolean; now?: string }): ContextRolloverV3 {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const current = this.get(input.id);
      if (!current) throw new Error("context rollover not found");
      if (current.state === "completed" || current.state === "continuation_ready") return current;
      if (current.state !== "session_retiring") throw new Error("context rollover session is not retiring");
      if (current.visibleResponseCommitted || input.visibleResponseCommitted) {
        this.sqlite.prepare(`
          UPDATE context_rollovers SET state = 'completed', visible_response_committed = 1,
            visible_response_committed_at = COALESCE(visible_response_committed_at, ?),
            updated_at = ?, terminal_at = ? WHERE id = ? AND state = 'session_retiring'
        `).run(now, now, now, input.id);
        return this.get(input.id)!;
      }
      const activationId = this.createActivation({
        projectId: current.projectId,
        agentId: current.agentId,
        scopeKey: current.scopeKey,
        kind: "context_rollover_continuation",
        // This must open the replacement generation before unrelated queued
        // work in another chat can claim the Agent's one active Run slot.
        priority: 110,
        dispatchPolicy: "next_run",
        promptClass: "blocker",
        dedupeKey: `context-rollover:${current.id}`,
        payload: {
          rolloverId: current.id,
          sourceRunId: current.sourceRunId,
          sourceActivationIds: current.sourceActivationIds,
          ...(current.replyAuthority ? { replyAuthority: current.replyAuthority } : {}),
          instruction: "Continue the unfinished task from the bounded continuation handoff in this fresh provider session. Preserve the original reply route and do not duplicate already committed communication.",
        },
        sourceKind: "context_rollover",
        sourceId: current.id,
        now,
      });
      if (current.sourceActivationIds.length > 0) {
        const placeholders = current.sourceActivationIds.map(() => "?").join(", ");
        // The continuation executes only its bounded handoff Activation, but
        // inherits the source Run's canonical lineage. Request capability,
        // wake/source projections, automatic result publication, and terminal
        // settlement can therefore follow durable sources without attaching
        // or re-executing the original Activations.
        this.sqlite.prepare(`
          INSERT OR IGNORE INTO activation_sources (
            activation_id, source_kind, source_id
          )
          SELECT ?, source.source_kind, source.source_id
          FROM activation_sources source
          JOIN agent_activations original ON original.id = source.activation_id
          WHERE source.activation_id IN (${placeholders})
            AND original.project_id = ? AND original.agent_id = ?
        `).run(
          activationId,
          ...current.sourceActivationIds,
          current.projectId,
          current.agentId,
        );
      }
      this.sqlite.prepare(`
        UPDATE context_rollovers SET state = 'continuation_ready', continuation_activation_id = ?,
          continuation_ready_at = COALESCE(continuation_ready_at, ?), updated_at = ?
        WHERE id = ? AND state = 'session_retiring'
      `).run(activationId, now, now, input.id);
      return this.get(input.id)!;
    })();
  }

  recordReplacementSession(continuationActivationId: string, replacementSessionId: string, now = new Date().toISOString()): ContextRolloverV3 | undefined {
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare(`
        SELECT * FROM context_rollovers WHERE continuation_activation_id = ?
      `).get(continuationActivationId) as RolloverRow | undefined;
      if (!current) return undefined;
      if (current.replacement_session_id) {
        if (current.replacement_session_id !== replacementSessionId) {
          throw new Error("context rollover replacement session conflict");
        }
        return this.view(current);
      }
      if (current.state !== "continuation_ready") {
        throw new Error("context rollover is not ready for a replacement session");
      }
      this.sqlite.prepare(`
        UPDATE context_rollovers SET replacement_session_id = ?,
          replacement_session_at = COALESCE(replacement_session_at, ?), updated_at = ?,
          state = CASE WHEN low_water_confirmation_required = 0 THEN 'completed' ELSE state END,
          terminal_at = CASE WHEN low_water_confirmation_required = 0 THEN ? ELSE terminal_at END
        WHERE id = ? AND replacement_session_id IS NULL AND state = 'continuation_ready'
      `).run(replacementSessionId, now, now, now, current.id);
      return this.get(current.id)!;
    })();
  }

  observeReplacementOccupancy(id: string, replacementSessionId: string, usedTokens: number, now = new Date().toISOString()): ContextRolloverV3 {
    const current = this.get(id);
    if (!current || current.state !== "continuation_ready" || current.replacementSessionId !== replacementSessionId) {
      throw new Error("replacement session does not own this context rollover");
    }
    if (usedTokens >= current.lowWaterMark) {
      return this.fail(id, "failed", `rollover_seed_overflow: reconstructed context occupancy ${usedTokens} did not fall below low-water mark ${current.lowWaterMark}`, now);
    }
    this.sqlite.prepare(`
      UPDATE context_rollovers SET state = 'completed', updated_at = ?, terminal_at = ?
      WHERE id = ? AND state = 'continuation_ready' AND replacement_session_id = ?
    `).run(now, now, id, replacementSessionId);
    return this.get(id)!;
  }

  fail(id: string, state: "failed" | "outcome_unknown", error: string, now = new Date().toISOString()): ContextRolloverV3 {
    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE context_rollovers SET state = ?, last_error = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND state IN ('requested','handoff_committed','session_retiring','continuation_ready')
      `).run(state, error.slice(0, 2_000), now, now, id);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE kind IN ('context_rollover_handoff','context_rollover_continuation')
          AND state IN ('pending','retry_pending')
          AND id IN (
            SELECT activation_id FROM activation_sources
            WHERE source_kind = 'context_rollover' AND source_id = ?
          )
      `).run(now, now, id);
    })();
    const result = this.get(id);
    if (!result) throw new Error("context rollover not found");
    return result;
  }

  private view(row: RolloverRow): ContextRolloverV3 {
    return {
      id: row.id, projectId: row.project_id, agentId: row.agent_id, state: row.state,
      oldProviderSessionId: row.old_provider_session_id,
      providerSessionGeneration: row.provider_session_generation,
      detectedOccupancy: row.detected_occupancy,
      ...(row.aggregate_tokens !== null ? { aggregateTokens: row.aggregate_tokens } : {}),
      threshold: row.threshold,
      ...(row.context_window !== null ? { contextWindow: row.context_window } : {}),
      lowWaterMark: row.low_water_mark,
      lowWaterConfirmationRequired: row.low_water_confirmation_required === 1,
      sourceRunId: row.source_run_id,
      sourceActivationIds: JSON.parse(row.source_activation_ids_json) as string[],
      scopeKey: row.scope_key,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.reply_authority_json
        ? { replyAuthority: JSON.parse(row.reply_authority_json) as CoordinationReplyAuthority }
        : {}),
      ...(row.handoff_event_id ? { handoffEventId: row.handoff_event_id } : {}),
      ...(row.continuation_activation_id ? { continuationActivationId: row.continuation_activation_id } : {}),
      ...(row.replacement_session_id ? { replacementSessionId: row.replacement_session_id } : {}),
      visibleResponseCommitted: row.visible_response_committed === 1,
      ...(row.handoff_committed_at ? { handoffCommittedAt: row.handoff_committed_at } : {}),
      ...(row.session_retiring_at ? { sessionRetiringAt: row.session_retiring_at } : {}),
      ...(row.continuation_ready_at ? { continuationReadyAt: row.continuation_ready_at } : {}),
      ...(row.replacement_session_at ? { replacementSessionAt: row.replacement_session_at } : {}),
      ...(row.visible_response_committed_at
        ? { visibleResponseCommittedAt: row.visible_response_committed_at }
        : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    };
  }
}
