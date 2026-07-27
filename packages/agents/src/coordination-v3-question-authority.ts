import type Database from "better-sqlite3";
import { PRIORITY } from "./coordination-v3-activation.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type { UpdateRequestV3Input } from "./coordination-v3-types.js";

type DependencyKind = "decision" | "join";

/** Owns suspended questions, dependency continuations, and unanswered outcomes. */
export class CoordinationV3QuestionAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly requestIdsAttachedToRun: (
      runId: string,
      agentId: string,
    ) => string[],
    private readonly outboundQuestionRequestIdsAttachedToRun: (
      runId: string,
      agentId: string,
    ) => string[],
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
    private readonly createActivation: (input: CreateActivationV3Input) => string,
  ) {}

  suspendQuestionsForDecision(input: {
    runId: string;
    agentId: string;
    decisionId: string;
    requestIds?: string[];
    strict?: boolean;
    now?: string;
  }): string[] {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      const attached = new Set(
        this.outboundQuestionRequestIdsAttachedToRun(
          input.runId,
          input.agentId,
        ),
      );
      const requested = input.requestIds ?? [...attached];
      const requestIds = [...new Set(requested)].filter((requestId) =>
        attached.has(requestId));
      if (
        input.strict !== false &&
        requestIds.length !== new Set(requested).size
      ) {
        throw new Error(
          "Decision question suspension is not attached to the originating Run",
        );
      }
      this.insertQuestionSuspensions(
        requestIds,
        input.agentId,
        "decision",
        input.decisionId,
        now,
      );
      return requestIds;
    })();
  }

  releaseDecisionQuestionSuspensions(
    decisionId: string,
    now = new Date().toISOString(),
  ): void {
    this.sqlite.transaction(() => {
      this.releaseQuestionDependency("decision", decisionId, now);
    })();
  }

  insertQuestionSuspensions(
    requestIds: string[],
    ownerAgentId: string,
    dependencyKind: DependencyKind,
    dependencyId: string,
    now: string,
  ): void {
    const insert = this.sqlite.prepare(`
      INSERT INTO coordination_question_suspensions (
        question_update_id, request_id, owner_agent_id, dependency_kind,
        dependency_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(question_update_id, dependency_kind, dependency_id)
      DO UPDATE SET state = 'open', updated_at = excluded.updated_at,
        terminal_at = NULL
    `);
    for (const requestId of requestIds) {
      const request = this.support.getRequestRow(requestId);
      if (
        request.requester_agent_id !== ownerAgentId ||
        request.state !== "awaiting_answer" ||
        !request.open_question_update_id
      ) {
        throw new Error(
          "only an attached outbound question can be suspended",
        );
      }
      insert.run(
        request.open_question_update_id,
        request.id,
        ownerAgentId,
        dependencyKind,
        dependencyId,
        now,
        now,
      );
    }
  }

  questionSuspended(questionUpdateId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM coordination_question_suspensions suspension
      WHERE suspension.question_update_id = ? AND suspension.state = 'open'
        AND (
          suspension.dependency_kind = 'decision'
          OR EXISTS (
            SELECT 1 FROM coordination_joins join_record
            WHERE join_record.id = suspension.dependency_id
              AND join_record.state = 'open'
          )
        )
      LIMIT 1
    `).get(questionUpdateId));
  }

  questionRowsAttachedToRun(runId: string): Array<{
    activation_id: string | null;
    request_id: string;
    question_update_id: string;
    delivered_as_steer: number;
  }> {
    const run = this.sqlite.prepare(`
      SELECT agent_id FROM scheduler_runs WHERE id = ?
    `).get(runId) as { agent_id: string } | undefined;
    if (!run) return [];
    const requestIds = this.requestIdsAttachedToRun(runId, run.agent_id);
    if (requestIds.length === 0) return [];
    const placeholders = requestIds.map(() => "?").join(", ");
    return this.sqlite.prepare(`
      SELECT request.id AS request_id,
        request.open_question_update_id AS question_update_id,
        question_activation.id AS activation_id,
        CASE WHEN question_activation.id IS NOT NULL AND EXISTS (
          SELECT 1
          FROM scheduler_prompt_injections injection,
            json_each(injection.activation_ids_json) injected
          WHERE injection.run_id = ?
            AND injection.kind = 'steer'
            AND injection.state = 'acknowledged'
            AND injected.value = question_activation.id
        ) THEN 1 ELSE 0 END AS delivered_as_steer
      FROM coordination_requests request
      LEFT JOIN agent_activations question_activation
        ON question_activation.id = (
          SELECT activation.id
          FROM agent_activations activation
          JOIN activation_sources source
            ON source.activation_id = activation.id
          WHERE source.source_kind = 'request_update'
            AND source.source_id = request.open_question_update_id
            AND activation.kind = 'coordination_question'
            AND activation.id IN (
              SELECT activation_id FROM scheduler_run_activations
              WHERE run_id = ?
            )
          ORDER BY activation.created_at, activation.id
          LIMIT 1
        )
      WHERE request.id IN (${placeholders})
        AND request.requester_agent_id = ?
        AND request.state = 'awaiting_answer'
        AND request.open_question_update_id IS NOT NULL
      ORDER BY request.created_at, request.id
    `).all(runId, runId, ...requestIds, run.agent_id) as Array<{
      activation_id: string | null;
      request_id: string;
      question_update_id: string;
      delivered_as_steer: number;
    }>;
  }

  settleUnansweredQuestionsForRun(
    runId: string,
    now: string,
    disposition: "completed" | "outcome_unknown",
    reason = "requester_run_completed_without_answer",
  ): void {
    for (const question of this.questionRowsAttachedToRun(runId)) {
      if (this.questionSuspended(question.question_update_id)) continue;
      if (
        disposition === "completed" &&
        question.activation_id &&
        question.delivered_as_steer === 1
      ) {
        this.sqlite.prepare(`
          UPDATE agent_activations
          SET state = 'retry_pending', dispatch_policy = 'next_run',
            available_at = ?, updated_at = ?, consumed_at = NULL
          WHERE id = ? AND state = 'attached'
        `).run(now, now, question.activation_id);
        continue;
      }
      this.updateRequest({
        requestId: question.request_id,
        updateId:
          `system:unanswered-question:${runId}:${question.request_id}`,
        kind: "outcome_unknown",
        actor: { kind: "supervisor", id: "v3-runtime-supervisor" },
        payload: {
          reason,
          runId,
          questionUpdateId: question.question_update_id,
        },
        now,
      });
    }
  }

  terminalizeUnansweredQuestionsForActivations(
    activationIds: string[],
    runId: string,
    now: string,
    reason: string,
  ): void {
    if (activationIds.length === 0) return;
    const selected = new Set(activationIds);
    for (const question of this.questionRowsAttachedToRun(runId)) {
      if (
        !question.activation_id ||
        !selected.has(question.activation_id)
      ) {
        continue;
      }
      if (this.questionSuspended(question.question_update_id)) continue;
      this.updateRequest({
        requestId: question.request_id,
        updateId:
          `system:unanswered-question:${runId}:${question.request_id}`,
        kind: "outcome_unknown",
        actor: { kind: "supervisor", id: "v3-runtime-supervisor" },
        payload: {
          reason,
          runId,
          questionUpdateId: question.question_update_id,
        },
        now,
      });
    }
  }

  settleQuestionsForFailedActivations(
    activationIds: string[],
    now: string,
  ): void {
    if (activationIds.length === 0) return;
    const placeholders = activationIds.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT DISTINCT request.id AS request_id,
        request.open_question_update_id AS question_update_id,
        activation.id AS activation_id, activation.last_delivery_error
      FROM agent_activations activation
      JOIN activation_sources source
        ON source.activation_id = activation.id
        AND source.source_kind = 'request_update'
      JOIN coordination_request_updates question_update
        ON question_update.id = source.source_id
        AND question_update.kind = 'question'
      JOIN coordination_requests request
        ON request.id = question_update.request_id
      WHERE activation.id IN (${placeholders})
        AND activation.state = 'failed'
        AND activation.terminal_outcome IS NOT NULL
        AND request.state = 'awaiting_answer'
        AND request.open_question_update_id = question_update.id
      ORDER BY request.created_at, request.id
    `).all(...activationIds) as Array<{
      request_id: string;
      question_update_id: string;
      activation_id: string;
      last_delivery_error: string | null;
    }>;
    for (const row of rows) {
      if (this.questionSuspended(row.question_update_id)) continue;
      this.updateRequest({
        requestId: row.request_id,
        updateId:
          `system:unanswered-question-delivery:` +
          `${row.activation_id}:${row.request_id}`,
        kind: "outcome_unknown",
        actor: { kind: "supervisor", id: "v3-activation-supervisor" },
        payload: {
          reason:
            row.last_delivery_error ??
            "question continuation could not execute",
          activationId: row.activation_id,
          questionUpdateId: row.question_update_id,
        },
        now,
      });
    }
  }

  cancelUninjectedRunsForClearedQuestion(
    questionUpdateId: string,
    now: string,
  ): void {
    const runs = this.sqlite.prepare(`
      SELECT DISTINCT run.id, run.agent_id, run.fencing_token
      FROM agent_activations activation
      JOIN activation_sources source
        ON source.activation_id = activation.id
        AND source.source_kind = 'request_update'
        AND source.source_id = ?
      JOIN scheduler_run_activations attached
        ON attached.activation_id = activation.id
      JOIN scheduler_runs run ON run.id = attached.run_id
      WHERE activation.kind = 'coordination_question'
        AND activation.state = 'attached'
        AND run.status IN ('leased', 'running')
        AND run.prompt_injection_state = 'not_injected'
    `).all(questionUpdateId) as Array<{
      id: string;
      agent_id: string;
      fencing_token: number;
    }>;
    for (const run of runs) {
      const replacementFence = this.support.nextFence(run.agent_id);
      const cancelled = this.sqlite.prepare(`
        UPDATE scheduler_runs
        SET status = 'cancelled', fencing_token = ?,
          side_effects_fenced_at = COALESCE(side_effects_fenced_at, ?),
          updated_at = ?, terminal_at = ?
        WHERE id = ? AND fencing_token = ?
          AND status IN ('leased', 'running')
          AND prompt_injection_state = 'not_injected'
      `).run(
        replacementFence,
        now,
        now,
        now,
        run.id,
        run.fencing_token,
      ).changes;
      if (cancelled !== 1) continue;
      this.sqlite.prepare(`
        UPDATE agent_activations
        SET state = 'retry_pending', available_at = ?, updated_at = ?
        WHERE state = 'attached'
          AND id IN (
            SELECT activation_id FROM scheduler_run_activations
            WHERE run_id = ?
          )
      `).run(now, now, run.id);
      this.sqlite.prepare(`
        UPDATE scheduler_prompt_injections
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE run_id = ? AND state = 'pending'
      `).run(now, now, run.id);
    }
  }

  settleClearedQuestion(questionUpdateId: string, now: string): void {
    this.cancelUninjectedRunsForClearedQuestion(questionUpdateId, now);
    this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'cancelled', terminal_at = ?, updated_at = ?,
        last_delivery_error = 'question was settled before delivery'
      WHERE kind = 'coordination_question'
        AND state IN ('pending', 'retry_pending')
        AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_kind = 'request_update' AND source_id = ?
        )
    `).run(now, now, questionUpdateId);
    this.sqlite.prepare(`
      UPDATE coordination_question_suspensions
      SET state = 'resolved', updated_at = ?, terminal_at = ?
      WHERE question_update_id = ? AND state = 'open'
    `).run(now, now, questionUpdateId);
  }

  questionDependencyContinuations(
    dependencyKind: DependencyKind,
    dependencyId: string,
  ): Array<{ requestId: string; inReplyToUpdateId: string }> {
    return this.sqlite.prepare(`
      SELECT suspension.request_id AS requestId,
        suspension.question_update_id AS inReplyToUpdateId
      FROM coordination_question_suspensions suspension
      JOIN coordination_requests request ON request.id = suspension.request_id
      WHERE suspension.dependency_kind = ? AND suspension.dependency_id = ?
        AND suspension.state = 'open'
        AND request.state = 'awaiting_answer'
        AND request.open_question_update_id = suspension.question_update_id
      ORDER BY suspension.created_at, suspension.question_update_id
    `).all(dependencyKind, dependencyId) as Array<{
      requestId: string;
      inReplyToUpdateId: string;
    }>;
  }

  attachQuestionDependencyToActivation(
    activationId: string,
    dependencyKind: DependencyKind,
    dependencyId: string,
    now: string,
    resolve: boolean,
  ): void {
    const rows = this.sqlite.prepare(`
      SELECT suspension.question_update_id
      FROM coordination_question_suspensions suspension
      JOIN coordination_requests request ON request.id = suspension.request_id
      WHERE suspension.dependency_kind = ? AND suspension.dependency_id = ?
        AND suspension.state = 'open'
        AND request.state = 'awaiting_answer'
        AND request.open_question_update_id = suspension.question_update_id
      ORDER BY suspension.created_at, suspension.question_update_id
    `).all(dependencyKind, dependencyId) as Array<{
      question_update_id: string;
    }>;
    const attach = this.sqlite.prepare(`
      INSERT OR IGNORE INTO activation_sources (
        activation_id, source_kind, source_id
      ) VALUES (?, 'request_update', ?)
    `);
    for (const row of rows) attach.run(activationId, row.question_update_id);
    if (resolve) {
      this.sqlite.prepare(`
        UPDATE coordination_question_suspensions
        SET state = 'resolved', updated_at = ?, terminal_at = ?
        WHERE dependency_kind = ? AND dependency_id = ? AND state = 'open'
      `).run(now, now, dependencyKind, dependencyId);
    }
  }

  releaseQuestionDependency(
    dependencyKind: DependencyKind,
    dependencyId: string,
    now: string,
  ): void {
    const rows = this.sqlite.prepare(`
      SELECT suspension.question_update_id, suspension.request_id,
        suspension.owner_agent_id, request.project_id, request.conversation_id
      FROM coordination_question_suspensions suspension
      JOIN coordination_requests request ON request.id = suspension.request_id
      WHERE suspension.dependency_kind = ? AND suspension.dependency_id = ?
        AND suspension.state = 'open'
        AND request.state = 'awaiting_answer'
        AND request.open_question_update_id = suspension.question_update_id
      ORDER BY suspension.created_at, suspension.question_update_id
    `).all(dependencyKind, dependencyId) as Array<{
      question_update_id: string;
      request_id: string;
      owner_agent_id: string;
      project_id: string;
      conversation_id: string | null;
    }>;
    for (const row of rows) {
      if (!this.support.agentSurvives(row.owner_agent_id)) continue;
      this.createActivation({
        projectId: row.project_id,
        agentId: row.owner_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
          row.conversation_id,
          row.owner_agent_id,
        ),
        kind: "coordination_question",
        priority: PRIORITY.urgent,
        dedupeKey:
          `request:${row.request_id}:question:${row.question_update_id}:` +
          `released:${dependencyKind}:${dependencyId}`,
        payload: {
          requestId: row.request_id,
          inReplyToUpdateId: row.question_update_id,
          recoveryInstruction:
            `${dependencyKind} ${dependencyId} ended without answering ` +
            "this question",
        },
        sourceKind: "request_update",
        sourceId: row.question_update_id,
        now,
      });
    }
    this.sqlite.prepare(`
      UPDATE coordination_question_suspensions
      SET state = 'cancelled', updated_at = ?, terminal_at = ?
      WHERE dependency_kind = ? AND dependency_id = ? AND state = 'open'
    `).run(now, now, dependencyKind, dependencyId);
  }
}
