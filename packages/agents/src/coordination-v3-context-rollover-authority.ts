import { createHash, randomUUID } from "node:crypto";
import {
  TERMINAL_REQUEST_STATES,
  type CoordinationReplyAuthority,
  type CoordinationRequestState,
} from "@ponderosa/core";
import type Database from "better-sqlite3";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import { REQUEST_SOURCE_LINEAGE_CTE } from "./coordination-v3-request-lineage.js";
import type { ContextRolloverState, ContextRolloverV3 } from "./coordination-v3-types.js";

const MAX_CONTEXT_ROLLOVER_RECENT_TAIL_IDS = 80;

interface RolloverRow {
  id: string; project_id: string; agent_id: string; state: ContextRolloverState;
  old_provider_session_id: string; provider_session_generation: string;
  detected_occupancy: number; aggregate_tokens: number | null; threshold: number;
  context_window: number | null; low_water_mark: number;
  low_water_confirmation_required: number; source_run_id: string;
  trigger_kind: "automatic" | "human";
  compaction_cutoff_ordinal: number; compaction_cutoff_event_id: string | null;
  recent_tail_event_ids_json: string;
  recent_tail_hashes_json: string;
  source_activation_ids_json: string; scope_key: string; conversation_id: string | null;
  reply_authority_json: string | null;
  handoff_event_id: string | null; continuation_activation_id: string | null;
  replacement_session_id: string | null; visible_response_committed: number;
  replacement_run_id: string | null; replacement_prompt_hash: string | null;
  replacement_system_prompt_hash: string | null;
  replacement_manifest_hash: string | null;
  replacement_attempt: number;
  handoff_committed_at: string | null; session_retiring_at: string | null;
  continuation_ready_at: string | null; replacement_session_at: string | null;
  replacement_input_committed_at: string | null; replacement_verified_at: string | null;
  visible_response_committed_at: string | null;
  completion_reason: ContextRolloverV3["completionReason"] | null;
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
    triggerKind?: "automatic" | "human";
    sourceRunId: string;
    compactionCutoffOrdinal: number; compactionCutoffEventId: string;
    recentTail: Array<{ communicationEventId: string; contentSha256: string }>;
    sourceActivationIds: string[]; scopeKey: string; conversationId?: string;
    replyAuthority?: CoordinationReplyAuthority; visibleResponseCommitted?: boolean; now?: string;
  }): { rollover: ContextRolloverV3; created: boolean } {
    const now = input.now ?? new Date().toISOString();
    if (!Number.isSafeInteger(input.compactionCutoffOrdinal) || input.compactionCutoffOrdinal <= 0 ||
        !input.compactionCutoffEventId.trim()) {
      throw new Error("context rollover requires an exact positive canonical boundary");
    }
    if (input.recentTail.length === 0 || input.recentTail.length > MAX_CONTEXT_ROLLOVER_RECENT_TAIL_IDS ||
        new Set(input.recentTail.map((binding) => binding.communicationEventId)).size !== input.recentTail.length ||
        input.recentTail.some((binding) => !binding.communicationEventId.trim() || !/^[a-f0-9]{64}$/u.test(binding.contentSha256))) {
      throw new Error("context rollover requires a bounded unique content-hash-bound recent tail");
    }
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT * FROM context_rollovers
        WHERE agent_id = ? AND provider_session_generation = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(input.agentId, input.providerSessionGeneration) as RolloverRow | undefined;
      // Automatic pressure owns at most one rollover attempt for an opaque
      // provider generation, including after failure, so a failed handoff can
      // never manufacture a rollover loop. A human may explicitly retry only
      // an attempt that failed before either a handoff or replacement candidate
      // became durable. That retry receives a new rollover ID and fresh frozen
      // boundary; recovery of a committed handoff remains bound to the original
      // record and can never be mistaken for a manual retry.
      if (existing) {
        const terminalFailure = ["failed", "outcome_unknown"].includes(existing.state);
        const explicitSafeRetry = input.triggerKind === "human" &&
          terminalFailure &&
          existing.handoff_event_id === null &&
          existing.replacement_run_id === null;
        if (existing.project_id !== input.projectId ||
            existing.old_provider_session_id !== input.oldProviderSessionId ||
            (!terminalFailure && (
              existing.compaction_cutoff_ordinal !== input.compactionCutoffOrdinal ||
              existing.compaction_cutoff_event_id !== input.compactionCutoffEventId ||
              existing.recent_tail_event_ids_json !== JSON.stringify(input.recentTail.map((binding) => binding.communicationEventId)) ||
              existing.recent_tail_hashes_json !== JSON.stringify(input.recentTail.map((binding) => binding.contentSha256))))) {
          throw new Error("context rollover provider generation replay conflicts with its durable owner");
        }
        if (!explicitSafeRetry) {
          return { rollover: this.view(existing), created: false };
        }
      }
      const id = randomUUID();
      this.sqlite.prepare(`
        INSERT INTO context_rollovers (
          id, project_id, agent_id, state, old_provider_session_id,
          provider_session_generation, detected_occupancy, aggregate_tokens,
          threshold, context_window, low_water_mark, low_water_confirmation_required, source_run_id,
          trigger_kind,
          compaction_cutoff_ordinal, compaction_cutoff_event_id, recent_tail_event_ids_json,
          recent_tail_hashes_json,
          source_activation_ids_json, scope_key, conversation_id, reply_authority_json,
          visible_response_committed, visible_response_committed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.projectId, input.agentId, input.oldProviderSessionId,
        input.providerSessionGeneration, input.detectedOccupancy, input.aggregateTokens ?? null,
        input.threshold, input.contextWindow ?? null, input.lowWaterMark,
        input.sourceRunId,
        input.triggerKind ?? "automatic",
        input.compactionCutoffOrdinal,
        input.compactionCutoffEventId,
        JSON.stringify(input.recentTail.map((binding) => binding.communicationEventId)),
        JSON.stringify(input.recentTail.map((binding) => binding.contentSha256)),
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

  /** Resolve both the original continuation Activation and one explicitly
   * authorized recovery Activation to the exact rollover generation they may
   * replace. Ordinary Runs never become replacement candidates by carrying a
   * handoff-like prompt. */
  candidateForRun(runId: string, agentId: string): ContextRolloverV3 | undefined {
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT rollover.*
      FROM context_rollovers rollover
      JOIN scheduler_runs run ON run.id = ? AND run.agent_id = ?
        AND run.agent_id = rollover.agent_id AND run.project_id = rollover.project_id
      JOIN scheduler_run_activations attached ON attached.run_id = run.id
      LEFT JOIN activation_sources recovery
        ON recovery.activation_id = attached.activation_id
        AND recovery.source_kind = 'context_rollover_recovery'
        AND recovery.source_id = rollover.id
      WHERE (
        attached.activation_id = rollover.continuation_activation_id
        OR recovery.activation_id IS NOT NULL
      )
      ORDER BY rollover.updated_at DESC, rollover.id DESC
    `).all(runId, agentId) as RolloverRow[];
    if (rows.length > 1) throw new Error("provider Run is attached to multiple context rollover generations");
    return rows[0] ? this.view(rows[0]) : undefined;
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

  canonicalAcceptanceCandidates(): ContextRolloverV3[] {
    const rows = this.sqlite.prepare(`
      SELECT * FROM context_rollovers
      WHERE replacement_session_id IS NOT NULL
        AND replacement_run_id IS NOT NULL
        AND replacement_verified_at IS NOT NULL
        AND handoff_event_id IS NOT NULL
        AND completion_reason IS NULL
      ORDER BY updated_at, id
    `).all() as RolloverRow[];
    return rows.map((row) => this.view(row));
  }

  /** Reconcile the narrow crash boundary where the canonical acceptance event
   * was fsynced and projected, but coordination completion did not commit. The
   * projected accepted snapshot and exact handoff consumption are required;
   * terminal failure state alone can never authorize a switch. */
  reconcileCanonicalAcceptance(input: {
    id: string;
    replacementSessionId: string;
    replacementRunId: string;
    handoffEventId: string;
    now?: string;
  }): ContextRolloverV3 {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT rollover.*, agent.active_session_id,
          handoff.consumed_by_execution_id, handoff.consumed_at
        FROM context_rollovers rollover
        JOIN agents agent ON agent.id = rollover.agent_id
        JOIN continuation_handoffs handoff
          ON handoff.id = rollover.handoff_event_id
          AND handoff.agent_id = rollover.agent_id
        WHERE rollover.id = ?
      `).get(input.id) as (RolloverRow & {
        active_session_id: string | null;
        consumed_by_execution_id: string | null;
        consumed_at: string | null;
      }) | undefined;
      if (!row || !row.replacement_verified_at ||
          row.replacement_session_id !== input.replacementSessionId ||
          row.replacement_run_id !== input.replacementRunId ||
          row.handoff_event_id !== input.handoffEventId ||
          row.active_session_id !== input.replacementSessionId ||
          row.consumed_by_execution_id !== input.replacementRunId || !row.consumed_at) {
        throw new Error("canonical context rollover acceptance is not exactly projected");
      }
      this.sqlite.prepare(`
        UPDATE context_rollovers
        SET state = 'completed', completion_reason = 'replacement_verified',
          last_error = NULL, updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
        WHERE id = ? AND replacement_session_id = ?
          AND replacement_run_id = ? AND replacement_verified_at IS NOT NULL
      `).run(now, now, input.id, input.replacementSessionId, input.replacementRunId);
      return this.get(input.id)!;
    })();
  }

  failUnidentifiedReplacementAfterRestart(id: string, now = new Date().toISOString()): ContextRolloverV3 {
    this.sqlite.prepare(`
      UPDATE context_rollovers SET state = 'outcome_unknown',
        last_error = 'server restarted after replacement input commit but before the candidate provider session was durably identified',
        updated_at = ?, terminal_at = COALESCE(terminal_at, ?)
      WHERE id = ? AND state = 'continuation_ready'
        AND replacement_run_id IS NOT NULL AND replacement_input_committed_at IS NOT NULL
        AND replacement_session_id IS NULL AND replacement_verified_at IS NULL
    `).run(now, now, id);
    const result = this.get(id);
    if (!result || result.state !== "outcome_unknown") {
      throw new Error("context rollover is not an unidentified restart candidate");
    }
    return result;
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

  prepareContinuation(input: { id: string; now?: string }): ContextRolloverV3 {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const current = this.get(input.id);
      if (!current) throw new Error("context rollover not found");
      if (current.state === "completed" || current.state === "continuation_ready") return current;
      if (current.state !== "session_retiring") throw new Error("context rollover session is not retiring");
      if (current.triggerKind !== "human" && (
        current.visibleResponseCommitted ||
        !this.continuationObligationRemains(current)
      )) {
        this.sqlite.prepare(`
          UPDATE context_rollovers SET state = 'completed',
            completion_reason = 'no_continuation_required', updated_at = ?, terminal_at = ?
          WHERE id = ? AND state = 'session_retiring'
        `).run(now, now, input.id);
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
          instruction: current.triggerKind === "human"
            ? "Verify this human-requested safe rollover in the fresh provider session. Use the bounded handoff only as non-authoritative continuity context. Do not publish Communication or resume unrelated work; provide one concise Work-log confirmation after reconstruction."
            : "Continue the unfinished task from the bounded continuation handoff in this fresh provider session. Preserve the original reply route and do not duplicate already committed communication.",
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

  recordReplacementSessionForRun(runId: string, agentId: string, replacementSessionId: string, now = new Date().toISOString()): ContextRolloverV3 | undefined {
    return this.sqlite.transaction(() => {
      const candidate = this.candidateForRun(runId, agentId);
      if (!candidate) return undefined;
      if (candidate.replacementRunId !== runId || !candidate.replacementInputCommittedAt) {
        throw new Error("context rollover replacement input is not durably committed");
      }
      const current = this.sqlite.prepare(`
        SELECT rollover.*, provider.prompt_hash AS current_prompt_hash,
          provider.system_prompt_hash AS current_system_prompt_hash,
          provider.source_manifest_json AS current_source_manifest_json
        FROM context_rollovers rollover
        JOIN scheduler_runs run ON run.id = ? AND run.agent_id = ?
          AND run.project_id = rollover.project_id
        JOIN provider_inputs provider ON provider.scheduler_run_id = run.id
          AND provider.agent_id = run.agent_id AND provider.project_id = run.project_id
        WHERE rollover.agent_id = run.agent_id
          AND rollover.replacement_run_id = run.id
      `).get(runId, agentId) as (RolloverRow & {
        current_prompt_hash: string;
        current_system_prompt_hash: string;
        current_source_manifest_json: string;
      }) | undefined;
      if (!current) throw new Error("context rollover replacement Run binding is unavailable");
      const currentManifestHash = createHash("sha256")
        .update(current.current_source_manifest_json).digest("hex");
      if (current.replacement_prompt_hash !== current.current_prompt_hash ||
          current.replacement_system_prompt_hash !== current.current_system_prompt_hash ||
          current.replacement_manifest_hash !== currentManifestHash) {
        throw new Error("context rollover replacement input changed after its durable commit");
      }
      if (current.replacement_session_id) {
        if (current.replacement_session_id !== replacementSessionId) {
          throw new Error("context rollover replacement session conflict");
        }
        return this.view(current);
      }
      if (current.state !== "continuation_ready") {
        throw new Error("context rollover is not ready for a replacement session");
      }
      if (!current.replacement_input_committed_at) {
        throw new Error("context rollover replacement input is not durably committed");
      }
      this.sqlite.prepare(`
        UPDATE context_rollovers SET replacement_session_id = ?,
          replacement_session_at = COALESCE(replacement_session_at, ?), updated_at = ?
        WHERE id = ? AND replacement_run_id = ?
          AND replacement_session_id IS NULL AND state = 'continuation_ready'
      `).run(replacementSessionId, now, now, current.id, runId);
      return this.get(current.id)!;
    })();
  }

  commitReplacementInputForRun(runId: string, agentId: string, now = new Date().toISOString()): ContextRolloverV3 | undefined {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT rollover.*, provider.prompt_hash, provider.system_prompt_hash,
          provider.source_manifest_json,
          CASE WHEN EXISTS (
            SELECT 1 FROM scheduler_run_activations recovery_attached
            JOIN activation_sources recovery_source
              ON recovery_source.activation_id = recovery_attached.activation_id
              AND recovery_source.source_kind = 'context_rollover_recovery'
              AND recovery_source.source_id = rollover.id
            WHERE recovery_attached.run_id = ?
          ) THEN 1 ELSE 0 END AS is_recovery,
          run.status AS run_status, run.project_id AS run_project_id,
          run.agent_id AS run_agent_id
        FROM context_rollovers rollover
        JOIN scheduler_runs run ON run.id = ?
        JOIN scheduler_run_activations attached ON attached.run_id = run.id
        JOIN provider_inputs provider
          ON provider.scheduler_run_id = run.id
          AND provider.agent_id = rollover.agent_id
          AND provider.project_id = rollover.project_id
        WHERE rollover.agent_id = ?
          AND run.agent_id = rollover.agent_id
          AND run.project_id = rollover.project_id
          AND (
            attached.activation_id = rollover.continuation_activation_id
            OR EXISTS (
              SELECT 1 FROM activation_sources recovery
              WHERE recovery.activation_id = attached.activation_id
                AND recovery.source_kind = 'context_rollover_recovery'
                AND recovery.source_id = rollover.id
            )
          )
        LIMIT 1
      `).get(runId, runId, agentId) as (RolloverRow & {
        prompt_hash: string;
        system_prompt_hash: string;
        source_manifest_json: string;
        is_recovery: number;
        run_status: string;
        run_project_id: string;
        run_agent_id: string;
      }) | undefined;
      if (!row) return undefined;
      const recovery = row.is_recovery === 1;
      if (row.run_status !== "running") throw new Error("context rollover replacement Run is not running");
      if (recovery) {
        if (!["failed", "outcome_unknown"].includes(row.state) ||
            row.completion_reason || row.replacement_verified_at) {
          throw new Error("context rollover recovery is not fenced to a failed unaccepted candidate");
        }
        if (row.last_error?.startsWith("rollover_seed_overflow:")) {
          throw new Error("context rollover seed overflow is terminal for this provider generation");
        }
        if (row.replacement_run_id && row.replacement_run_id !== runId) {
          const previous = this.sqlite.prepare(`
            SELECT status FROM scheduler_runs WHERE id = ? AND agent_id = ? AND project_id = ?
          `).get(row.replacement_run_id, agentId, row.project_id) as { status: string } | undefined;
          if (!previous || !["completed", "failed", "cancelled", "outcome_unknown"].includes(previous.status)) {
            throw new Error("context rollover previous candidate Run is not durably terminal");
          }
        }
      } else if (row.state !== "continuation_ready") {
        throw new Error("context rollover continuation is not ready for replacement input");
      }
      const manifest = JSON.parse(row.source_manifest_json) as {
        schemaVersion?: unknown;
        historyMessageCount?: unknown;
        retainedSessionSourceCount?: unknown;
        activationIds?: unknown;
        triggerOccurrenceIds?: unknown;
        communicationEventIds?: unknown;
        artifactIds?: unknown;
        providerSessionDisposition?: unknown;
        conversationId?: unknown;
        sources?: unknown;
      };
      if (manifest.schemaVersion !== 3 || manifest.providerSessionDisposition !== "reseeded" ||
          manifest.retainedSessionSourceCount !== 0 || !Array.isArray(manifest.activationIds) ||
          !Array.isArray(manifest.triggerOccurrenceIds) || manifest.triggerOccurrenceIds.length !== 0 ||
          !Array.isArray(manifest.communicationEventIds) || !Array.isArray(manifest.artifactIds) ||
          manifest.artifactIds.length !== 0 || !Array.isArray(manifest.sources)) {
        throw new Error("context rollover replacement manifest is not an exact fresh V3 packet");
      }
      const attachedActivationIds = (this.sqlite.prepare(`
        SELECT activation_id FROM scheduler_run_activations WHERE run_id = ? ORDER BY activation_id
      `).all(runId) as Array<{ activation_id: string }>).map((attached) => attached.activation_id);
      if (attachedActivationIds.length !== 1 || (!recovery &&
          attachedActivationIds[0] !== row.continuation_activation_id)) {
        throw new Error("context rollover replacement Run contains unrelated attached work");
      }
      if (recovery) {
        const recoveryBinding = this.sqlite.prepare(`
          SELECT COUNT(*) AS count
          FROM activation_sources
          WHERE activation_id = ?
            AND source_kind = 'context_rollover_recovery'
            AND source_id = ?
        `).get(attachedActivationIds[0], row.id) as { count: number };
        if (recoveryBinding.count !== 1) {
          throw new Error("context rollover recovery Run is not isolated to its exact authorization");
        }
      }
      const manifestActivationIds = manifest.activationIds.filter((id): id is string => typeof id === "string").sort();
      if (manifestActivationIds.length !== manifest.activationIds.length ||
          (!recovery && JSON.stringify(manifestActivationIds) !== JSON.stringify(attachedActivationIds))) {
        throw new Error("context rollover replacement manifest activation binding is mismatched");
      }
      const recentTail = JSON.parse(row.recent_tail_event_ids_json) as string[];
      const recentTailHashes = JSON.parse(row.recent_tail_hashes_json) as string[];
      if (manifest.historyMessageCount !== recentTail.length) {
        throw new Error("context rollover replacement history count does not match its frozen tail");
      }
      const communicationEventIds = manifest.communicationEventIds.filter((id): id is string => typeof id === "string");
      if (communicationEventIds.length !== manifest.communicationEventIds.length ||
          JSON.stringify(communicationEventIds) !== JSON.stringify(recentTail)) {
        throw new Error("context rollover replacement manifest does not exactly match its frozen recent tail");
      }
      const communicationSources = manifest.sources.filter((source): source is {
        kind: string; ref: string; hash?: string; delivery?: string;
      } => Boolean(source && typeof source === "object" &&
        (source as { kind?: unknown }).kind === "communication" &&
        typeof (source as { ref?: unknown }).ref === "string"));
      if (communicationSources.length !== recentTail.length || recentTail.some((eventId, index) => {
        const source = communicationSources[index];
        return source?.ref !== eventId || source.delivery !== "submitted" ||
          source.hash !== recentTailHashes[index];
      })) throw new Error("context rollover replacement sources do not match frozen canonical content hashes");
      const handoffSources = manifest.sources.filter((source): source is { kind: string; ref: string; hash?: string; delivery?: string } =>
        Boolean(source && typeof source === "object" &&
          (source as { kind?: unknown }).kind === "continuation_handoff" &&
          typeof (source as { ref?: unknown }).ref === "string"));
      const handoff = row.handoff_event_id ? this.sqlite.prepare(`
        SELECT handoff.text, handoff.source_execution_id,
          handoff.consumed_at, handoff.created_at,
          handoff_run.project_id AS source_project_id,
          handoff_run.agent_id AS source_agent_id,
          handoff_run.scope_key AS source_scope_key,
          handoff_activation.id AS handoff_activation_id
        FROM continuation_handoffs handoff
        JOIN scheduler_runs handoff_run
          ON handoff_run.id = handoff.source_execution_id
        JOIN scheduler_run_activations attached
          ON attached.run_id = handoff_run.id
        JOIN agent_activations handoff_activation
          ON handoff_activation.id = attached.activation_id
          AND handoff_activation.kind = 'context_rollover_handoff'
        JOIN activation_sources handoff_source
          ON handoff_source.activation_id = handoff_activation.id
          AND handoff_source.source_kind = 'context_rollover'
          AND handoff_source.source_id = ?
        WHERE handoff.id = ? AND handoff.agent_id = ?
          AND json_extract(handoff_activation.payload_json, '$.rolloverId') = ?
          AND EXISTS (
            SELECT 1
            FROM scheduler_prompt_injections injection,
              json_each(injection.activation_ids_json) injected_activation
            WHERE injection.run_id = handoff_run.id
              AND injection.state = 'acknowledged'
              AND injected_activation.value = handoff_activation.id
          )
      `).get(row.id, row.handoff_event_id, row.agent_id, row.id) as {
        text: string;
        source_execution_id: string;
        consumed_at: string | null;
        created_at: string;
        source_project_id: string;
        source_agent_id: string;
        source_scope_key: string;
        handoff_activation_id: string;
      } | undefined : undefined;
      const expectedHandoffHash = handoff
        ? createHash("sha256").update(handoff.text).digest("hex")
        : undefined;
      if (!handoff || handoff.source_project_id !== row.project_id ||
          handoff.source_agent_id !== row.agent_id || handoff.source_scope_key !== row.scope_key ||
          handoff.consumed_at ||
          handoffSources.length !== 1 || handoffSources[0]!.ref !== row.handoff_event_id ||
          handoffSources[0]!.delivery !== "submitted" || handoffSources[0]!.hash !== expectedHandoffHash ||
          ("createdAt" in handoffSources[0]! && handoffSources[0]!.createdAt !== handoff.created_at)) {
        throw new Error("context rollover replacement manifest is not bound to its exact durable handoff");
      }
      const sourceRecords = manifest.sources.filter((source): source is {
        kind: string;
        ref: string;
        hash?: string;
        delivery?: string;
      } => Boolean(source && typeof source === "object" &&
        typeof (source as { kind?: unknown }).kind === "string" &&
        typeof (source as { ref?: unknown }).ref === "string"));
      if (sourceRecords.length !== manifest.sources.length || sourceRecords.some((source) =>
        !["identity", "policy", "team_directory", "continuation_handoff", "communication", "activation"]
          .includes(source.kind) || source.delivery !== "submitted")) {
        throw new Error("context rollover replacement manifest contains an unapproved source kind or delivery");
      }
      const sourcesOf = (kind: string) => sourceRecords.filter((source) => source.kind === kind);
      const identitySources = sourcesOf("identity");
      const policySources = sourcesOf("policy");
      const teamSources = sourcesOf("team_directory");
      const activationSources = sourcesOf("activation");
      const expectedActivationSourceIds = recovery ? manifestActivationIds : attachedActivationIds;
      if (identitySources.length !== 1 || identitySources[0]!.ref !== row.agent_id ||
          policySources.length !== 1 || !/^[a-f0-9]{64}$/u.test(policySources[0]!.hash ?? "") ||
          teamSources.length !== 1 || !/^[a-f0-9]{64}$/u.test(teamSources[0]!.hash ?? "") ||
          JSON.stringify(activationSources.map((source) => source.ref).sort()) !==
            JSON.stringify(expectedActivationSourceIds)) {
        throw new Error("context rollover replacement manifest source multiset is mismatched");
      }
      if ((row.conversation_id ?? undefined) !== (typeof manifest.conversationId === "string" ? manifest.conversationId : undefined)) {
        throw new Error("context rollover replacement manifest conversation scope is mismatched");
      }
      const manifestHash = createHash("sha256").update(row.source_manifest_json).digest("hex");
      if (recovery && row.replacement_run_id && (
        row.replacement_prompt_hash !== row.prompt_hash ||
        row.replacement_system_prompt_hash !== row.system_prompt_hash ||
        row.replacement_manifest_hash !== manifestHash
      )) throw new Error("context rollover recovery must replay the exact previously committed provider packet");
      if (!recovery && row.replacement_run_id && (
        row.replacement_run_id !== runId ||
        row.replacement_prompt_hash !== row.prompt_hash ||
        row.replacement_system_prompt_hash !== row.system_prompt_hash ||
        row.replacement_manifest_hash !== manifestHash
      )) throw new Error("context rollover replacement input conflict");
      this.sqlite.prepare(`
        UPDATE context_rollovers SET replacement_run_id = ?, replacement_prompt_hash = ?,
          replacement_system_prompt_hash = ?, replacement_manifest_hash = ?,
          replacement_attempt = replacement_attempt + CASE WHEN replacement_run_id = ? THEN 0 ELSE 1 END,
          replacement_input_committed_at = ?, replacement_session_id = NULL,
          replacement_session_at = NULL, replacement_verified_at = NULL,
          state = 'continuation_ready', completion_reason = NULL, last_error = NULL,
          terminal_at = NULL, updated_at = ?
        WHERE id = ? AND state IN ('continuation_ready','failed','outcome_unknown')
      `).run(runId, row.prompt_hash, row.system_prompt_hash, manifestHash, runId, now, now, row.id);
      return this.get(row.id)!;
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
      UPDATE context_rollovers SET replacement_verified_at = COALESCE(replacement_verified_at, ?),
        updated_at = ?
      WHERE id = ? AND state = 'continuation_ready' AND replacement_session_id = ?
    `).run(now, now, id, replacementSessionId);
    return this.get(id)!;
  }

  completeVerifiedReplacement(id: string, replacementSessionId: string, now = new Date().toISOString()): ContextRolloverV3 {
    this.sqlite.prepare(`
      UPDATE context_rollovers SET state = 'completed', completion_reason = 'replacement_verified',
        updated_at = ?, terminal_at = ?
      WHERE id = ? AND state = 'continuation_ready'
        AND replacement_session_id = ? AND replacement_verified_at IS NOT NULL
    `).run(now, now, id, replacementSessionId);
    const result = this.get(id);
    if (!result || result.state !== "completed" || result.replacementSessionId !== replacementSessionId) {
      throw new Error("context rollover replacement was not verified for atomic switch");
    }
    return result;
  }

  cancelAfterNativeCompaction(input: {
    agentId: string;
    providerSessionGeneration: string;
    providerSessionId: string;
    usedTokens: number;
    now?: string;
  }): ContextRolloverV3 | undefined {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(`
        SELECT * FROM context_rollovers
        WHERE agent_id = ? AND provider_session_generation = ?
          AND old_provider_session_id = ?
          AND state IN ('requested','handoff_committed','session_retiring')
        ORDER BY updated_at DESC, id DESC LIMIT 1
      `).get(input.agentId, input.providerSessionGeneration, input.providerSessionId) as RolloverRow | undefined;
      if (!row || input.usedTokens >= row.low_water_mark) return undefined;
      this.sqlite.prepare(`
        UPDATE context_rollovers SET state = 'completed', completion_reason = 'native_compaction',
          updated_at = ?, terminal_at = ? WHERE id = ?
          AND state IN ('requested','handoff_committed','session_retiring')
      `).run(now, now, row.id);
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE kind = 'context_rollover_handoff' AND state IN ('pending','retry_pending')
          AND id IN (
            SELECT activation_id FROM activation_sources
            WHERE source_kind = 'context_rollover' AND source_id = ?
          )
      `).run(now, now, row.id);
      return this.get(row.id)!;
    })();
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

  private continuationObligationRemains(
    rollover: ContextRolloverV3,
  ): boolean {
    const requests = this.sqlite.prepare(`
      ${REQUEST_SOURCE_LINEAGE_CTE}
      SELECT DISTINCT request.id, request.state, request.recipient_agent_id
      FROM request_source_lineage lineage
      JOIN json_each(?) source_activation
        ON source_activation.value = lineage.activation_id
      JOIN agent_activations activation
        ON activation.id = lineage.activation_id
      JOIN coordination_requests request ON request.id = lineage.request_id
      WHERE activation.project_id = ? AND activation.agent_id = ?
    `).all(
      JSON.stringify(rollover.sourceActivationIds),
      rollover.projectId,
      rollover.agentId,
    ) as Array<{
      id: string;
      state: CoordinationRequestState;
      recipient_agent_id: string;
    }>;
    if (requests.some(request =>
      !TERMINAL_REQUEST_STATES.has(request.state))) return true;
    if (requests.some(request =>
      request.recipient_agent_id === rollover.agentId)) return false;
    return Boolean(rollover.replyAuthority);
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
      triggerKind: row.trigger_kind,
      compactionCutoffOrdinal: row.compaction_cutoff_ordinal,
      ...(row.compaction_cutoff_event_id ? { compactionCutoffEventId: row.compaction_cutoff_event_id } : {}),
      recentTailCommunicationEventIds: JSON.parse(row.recent_tail_event_ids_json) as string[],
      recentTailContentHashes: JSON.parse(row.recent_tail_hashes_json) as string[],
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
      ...(row.replacement_run_id ? { replacementRunId: row.replacement_run_id } : {}),
      ...(row.replacement_prompt_hash ? { replacementPromptHash: row.replacement_prompt_hash } : {}),
      ...(row.replacement_system_prompt_hash ? { replacementSystemPromptHash: row.replacement_system_prompt_hash } : {}),
      ...(row.replacement_manifest_hash ? { replacementManifestHash: row.replacement_manifest_hash } : {}),
      replacementAttempt: row.replacement_attempt,
      visibleResponseCommitted: row.visible_response_committed === 1,
      ...(row.handoff_committed_at ? { handoffCommittedAt: row.handoff_committed_at } : {}),
      ...(row.session_retiring_at ? { sessionRetiringAt: row.session_retiring_at } : {}),
      ...(row.continuation_ready_at ? { continuationReadyAt: row.continuation_ready_at } : {}),
      ...(row.replacement_session_at ? { replacementSessionAt: row.replacement_session_at } : {}),
      ...(row.replacement_input_committed_at ? { replacementInputCommittedAt: row.replacement_input_committed_at } : {}),
      ...(row.replacement_verified_at ? { replacementVerifiedAt: row.replacement_verified_at } : {}),
      ...(row.visible_response_committed_at
        ? { visibleResponseCommittedAt: row.visible_response_committed_at }
        : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.completion_reason ? { completionReason: row.completion_reason } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    };
  }
}
