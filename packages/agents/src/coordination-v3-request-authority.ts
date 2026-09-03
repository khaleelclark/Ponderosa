import type Database from "better-sqlite3";
import {
  TERMINAL_REQUEST_STATES,
  evaluateCoordinationJoin,
  joinTransitionNeedsActivation,
  reduceCoordinationRequest,
  type CoordinationJoinMode,
  type CoordinationJoinState,
  type CoordinationJoinWakePolicy,
  type CoordinationReplyAuthority,
  type CoordinationRequestState,
  type CoordinationRequestUpdateKind,
} from "@ponderosa/core";
import { PRIORITY } from "./coordination-v3-activation.js";
import {
  payloadHash,
  stableJson,
} from "./coordination-v3-canonical-json.js";
import type { CoordinationV3QuestionAuthority } from "./coordination-v3-question-authority.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type { CoordinationV3RuntimeArtifactAuthority } from "./coordination-v3-runtime-artifact-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import {
  terminalAt,
} from "./coordination-v3-request-state.js";
import type {
  CoordinationV3StoreSupport,
  RequestRow,
} from "./coordination-v3-store-support.js";
import type {
  Actor,
  RequestUpdateV3Result,
  RuntimeArtifactInputV3,
  UpdateRequestV3Input,
} from "./coordination-v3-types.js";

interface JoinRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  owner_agent_id: string;
  mode: CoordinationJoinMode;
  wake_policy: CoordinationJoinWakePolicy;
  quorum: number;
  satisfying_outcomes_json: string;
  state: CoordinationJoinState;
  deadline_at: string | null;
  continuation_request_ids_json: string;
}

/** Owns Request transitions, aggregate Join evaluation, and wake Activations. */
export class CoordinationV3RequestAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly runtimeArtifactAuthority: CoordinationV3RuntimeArtifactAuthority,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly questionAuthority: CoordinationV3QuestionAuthority,
    private readonly requestIdsAttachedToRun: (
      runId: string,
      agentId: string,
    ) => string[],
    private readonly createActivation: (input: CreateActivationV3Input) => string,
  ) {}

  private resolvedUpdate(input: UpdateRequestV3Input, projectId: string) {
    const artifacts = this.runtimeArtifactAuthority.resolveRuntimeArtifacts(
      projectId,
      input.artifacts,
      "request update",
    );
    const hash = payloadHash({
      requestId: input.requestId,
      kind: input.kind,
      actor: input.actor,
      inReplyToUpdateId: input.inReplyToUpdateId ?? null,
      payload: input.payload ?? null,
      ...(input.providerFailureCategory
        ? { providerFailureCategory: input.providerFailureCategory }
        : {}),
      artifacts,
    });
    return { artifacts, hash };
  }

  private existingUpdate(
    input: UpdateRequestV3Input,
    hash: string,
    request: RequestRow,
  ): RequestUpdateV3Result | undefined {
    const existing = this.sqlite.prepare(`
      SELECT request_id, actor_kind, actor_id, payload_hash,
        resulting_state, resulting_version
      FROM coordination_request_updates WHERE id = ?
    `).get(input.updateId) as {
      request_id: string;
      actor_kind: Actor["kind"];
      actor_id: string | null;
      payload_hash: string;
      resulting_state: CoordinationRequestState;
      resulting_version: number;
    } | undefined;
    if (existing) {
      if (
        existing.request_id !== input.requestId ||
        existing.actor_kind !== input.actor.kind ||
        existing.actor_id !== (input.actor.id ?? null) ||
        existing.payload_hash !== hash
      ) {
        throw new Error("request update idempotency collision");
      }
      return {
        requestId: existing.request_id,
        state: existing.resulting_state,
        version: existing.resulting_version,
        replayed: true,
      };
    }
    const existingLate = this.sqlite.prepare(`
      SELECT request_id, actor_agent_id, payload_hash
      FROM coordination_request_late_results WHERE id = ?
    `).get(input.updateId) as {
      request_id: string;
      actor_agent_id: string;
      payload_hash: string;
    } | undefined;
    if (!existingLate) return undefined;
    if (
      existingLate.request_id !== input.requestId ||
      input.actor.kind !== "agent" ||
      existingLate.actor_agent_id !== input.actor.id ||
      existingLate.payload_hash !== hash
    ) {
      throw new Error("request update idempotency collision");
    }
    return {
      requestId: request.id,
      state: request.state,
      version: request.version,
      replayed: true,
    };
  }

  replayRequestUpdate(input: UpdateRequestV3Input): RequestUpdateV3Result | undefined {
    const request = this.support.getRequestRow(input.requestId);
    const { hash } = this.resolvedUpdate(input, request.project_id);
    return this.sqlite.transaction(() => {
      if (input.runAuthorization) {
        this.support.requireAuthorizedRun(
          input.runAuthorization,
          request.conversation_id ? `conversation:${request.conversation_id}` : undefined,
        );
      }
      return this.existingUpdate(input, hash, request);
    })();
  }

  updateRequest(input: UpdateRequestV3Input): RequestUpdateV3Result {
    const now = input.now ?? new Date().toISOString();
    const initialRequest = this.support.getRequestRow(input.requestId);
    const { artifacts, hash } = this.resolvedUpdate(input, initialRequest.project_id);
    return this.sqlite.transaction(() => {
      const request = this.support.getRequestRow(input.requestId);
      if (request.project_id !== initialRequest.project_id) {
        throw new Error(
          "request Project changed during artifact admission",
        );
      }
      const replay = this.existingUpdate(input, hash, request);
      if (replay) return replay;

      const lateTerminal =
        request.state === "outcome_unknown" &&
        (
          input.kind === "completed" ||
          input.kind === "blocked" ||
          input.kind === "failed"
        ) &&
        input.actor.kind === "agent" &&
        input.actor.id === request.recipient_agent_id;
      if (lateTerminal) {
        if (!input.runAuthorization) {
          throw new Error(
            "late result requires authorization from the original outcome-unknown run",
          );
        }
        const authorized = this.sqlite.prepare(`
          SELECT 1 FROM scheduler_runs run
          WHERE run.id = ? AND run.agent_id = ? AND run.fencing_token = ?
            AND run.status = 'outcome_unknown'
            AND EXISTS (
              SELECT 1 FROM scheduler_run_activations attached
              JOIN activation_sources source
                ON source.activation_id = attached.activation_id
              LEFT JOIN coordination_request_updates request_update
                ON source.source_kind = 'request_update'
                AND request_update.id = source.source_id
              WHERE attached.run_id = run.id AND (
                (
                  source.source_kind = 'request'
                  AND source.source_id = ?
                )
                OR (
                  source.source_kind = 'request_update'
                  AND request_update.request_id = ?
                )
                OR (
                  source.source_kind = 'join' AND EXISTS (
                    SELECT 1 FROM coordination_joins join_record,
                      json_each(
                        join_record.continuation_request_ids_json
                      ) continuation
                    WHERE join_record.id = source.source_id
                      AND continuation.value = ?
                  )
                )
              )
            )
        `).get(
          input.runAuthorization.runId,
          input.runAuthorization.agentId,
          input.runAuthorization.fencingToken,
          request.id,
          request.id,
          request.id,
        );
        if (!authorized) {
          throw new Error(
            "late result is not authorized by the original outcome-unknown run",
          );
        }
        this.runtimeArtifactAuthority.requireRuntimeArtifacts(
          request.project_id,
          artifacts,
          "late request result",
        );
        this.sqlite.prepare(`
          INSERT INTO coordination_request_late_results (
            id, request_id, kind, actor_agent_id, payload_json,
            payload_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.updateId,
          request.id,
          input.kind,
          input.actor.id,
          stableJson(input.payload ?? null),
          hash,
          now,
        );
        this.insertArtifacts(
          input.updateId,
          request.project_id,
          artifacts,
          now,
        );
        if (
          request.requester_agent_id &&
          this.support.agentSurvives(request.requester_agent_id)
        ) {
          this.createActivation({
            projectId: request.project_id,
            agentId: request.requester_agent_id,
            scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
              request.conversation_id,
              request.requester_agent_id,
            ),
            kind: "coordination_late_result",
            priority: PRIORITY.actionable,
            dedupeKey:
              `request:${request.id}:late-result:${input.updateId}`,
            payload: {
              requestId: request.id,
              originalState: request.state,
              lateResult: {
                updateId: input.updateId,
                kind: input.kind,
                update: input.payload ?? null,
              },
              recoveryInstruction:
                "Audit current state and incorporate this late handoff; " +
                "do not redo the original work.",
            },
            sourceKind: "late_result",
            sourceId: input.updateId,
            now,
          });
        }
        return {
          requestId: request.id,
          state: request.state,
          version: request.version,
          replayed: false,
        };
      }

      if (input.runAuthorization) {
        this.support.requireAuthorizedRun(input.runAuthorization);
        const attached = this.requestIdsAttachedToRun(
          input.runAuthorization.runId,
          input.runAuthorization.agentId,
        );
        const requesterOwnedTerminalControl =
          (
            input.kind === "cancelled" ||
            input.kind === "superseded"
          ) &&
          input.actor.kind === "agent" &&
          input.actor.id === request.requester_agent_id &&
          input.runAuthorization.agentId === request.requester_agent_id;
        if (
          !attached.includes(input.requestId) &&
          !requesterOwnedTerminalControl
        ) {
          throw new Error(
            "request is not attached to the authoritative run",
          );
        }
      }
      this.runtimeArtifactAuthority.requireRuntimeArtifacts(
        request.project_id,
        artifacts,
        "request update",
      );
      this.support.authorizeUpdate(request, input.kind, input.actor);
      const ownsUnresolvedJoin = Boolean(this.sqlite.prepare(`
        SELECT 1 FROM coordination_joins
        WHERE state = 'open'
          AND EXISTS (
            SELECT 1 FROM json_each(continuation_request_ids_json)
            WHERE value = ?
          )
        LIMIT 1
      `).get(request.id));
      const next = reduceCoordinationRequest(
        {
          state: request.state,
          version: request.version,
          ...(request.open_question_update_id
            ? { openQuestionUpdateId: request.open_question_update_id }
            : {}),
          ownsUnresolvedJoin,
        },
        {
          kind: input.kind,
          updateId: input.updateId,
          ...(input.inReplyToUpdateId
            ? { inReplyToUpdateId: input.inReplyToUpdateId }
            : {}),
        },
      );
      this.sqlite.prepare(`
        INSERT INTO coordination_request_updates (
          id, request_id, kind, actor_kind, actor_id,
          in_reply_to_update_id, payload_json, payload_hash,
          resulting_state, resulting_version, created_at,
          provider_failure_category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.updateId,
        request.id,
        input.kind,
        input.actor.kind,
        input.actor.id ?? null,
        input.inReplyToUpdateId ?? null,
        stableJson(input.payload ?? null),
        hash,
        next.state,
        next.version,
        now,
        input.providerFailureCategory ?? null,
      );
      this.insertArtifacts(
        input.updateId,
        request.project_id,
        artifacts,
        now,
      );
      this.sqlite.prepare(`
        UPDATE coordination_requests
        SET state = ?, version = ?, open_question_update_id = ?,
          updated_at = ?, terminal_at = ?
        WHERE id = ? AND version = ?
      `).run(
        next.state,
        next.version,
        next.openQuestionUpdateId ?? null,
        now,
        terminalAt(next.state, now),
        request.id,
        request.version,
      );
      if (
        request.open_question_update_id &&
        request.open_question_update_id !==
          (next.openQuestionUpdateId ?? null)
      ) {
        this.questionAuthority.settleClearedQuestion(
          {
            questionUpdateId: request.open_question_update_id,
            settledByUpdateId: input.updateId,
            resultingState: next.state,
            terminalRetraction: TERMINAL_REQUEST_STATES.has(next.state),
            now,
          },
        );
      }
      const joined = (this.sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM coordination_join_members WHERE request_id = ?
      `).get(request.id) as { count: number }).count > 0;
      if (
        input.kind === "cancelled" ||
        input.kind === "superseded" ||
        input.kind === "expired"
      ) {
        this.cancelPendingRequestWork(request.id, input.kind, now);
      }
      this.reevaluateRequestJoins(request.id, now);
      this.activateForRequestTransition(
        request,
        input.kind,
        next.state,
        joined,
        input.updateId,
        input.payload,
        now,
      );
      if (
        input.runAuthorization &&
        request.recipient_agent_id === input.runAuthorization.agentId &&
        !TERMINAL_REQUEST_STATES.has(request.state) &&
        TERMINAL_REQUEST_STATES.has(next.state) &&
        this.nonterminalInboundRequestIdsAttachedToRun(
          input.runAuthorization.runId,
          input.runAuthorization.agentId,
        ).length === 0
      ) {
        this.sqlite.prepare(`
          UPDATE scheduler_runs
          SET side_effects_fenced_at =
              COALESCE(side_effects_fenced_at, ?),
            updated_at = ?
          WHERE id = ? AND agent_id = ? AND fencing_token = ?
            AND status IN ('leased', 'running')
        `).run(
          now,
          now,
          input.runAuthorization.runId,
          input.runAuthorization.agentId,
          input.runAuthorization.fencingToken,
        );
      }
      return {
        requestId: request.id,
        state: next.state,
        version: next.version,
        replayed: false,
      };
    })();
  }

  attachRequestCommunication(
    requestId: string,
    communicationEventId: string,
    projectId: string,
  ): void {
    const changed = this.sqlite.prepare(`
      UPDATE coordination_requests SET communication_event_id = ?
      WHERE id = ? AND project_id = ?
        AND (
          communication_event_id IS NULL
          OR communication_event_id = ?
        )
    `).run(
      communicationEventId,
      requestId,
      projectId,
      communicationEventId,
    ).changes;
    if (changed !== 1) {
      throw new Error("request communication identity conflict");
    }
  }

  expireDue(
    now = new Date().toISOString(),
  ): { requests: number; joins: number } {
    return this.sqlite.transaction(() => {
      const requests = this.sqlite.prepare(`
        SELECT id FROM coordination_requests
        WHERE deadline_at IS NOT NULL AND deadline_at <= ?
          AND state IN (
            'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
          )
        ORDER BY deadline_at, id
      `).all(now) as Array<{ id: string }>;
      for (const { id } of requests) {
        this.updateRequest({
          requestId: id,
          updateId: `system:expired:${id}:${now}`,
          kind: "expired",
          actor: { kind: "system", id: "deadline-sweeper" },
          payload: { deadlineObservedAt: now },
          now,
        });
      }
      const joins = this.sqlite.prepare(`
        SELECT * FROM coordination_joins
        WHERE deadline_at IS NOT NULL AND deadline_at <= ?
          AND state = 'open'
        ORDER BY deadline_at, id
      `).all(now) as JoinRow[];
      for (const join of joins) {
        this.sqlite.prepare(`
          UPDATE coordination_joins
          SET state = 'expired', updated_at = ?, terminal_at = ?
          WHERE id = ? AND state = 'open'
        `).run(now, now, join.id);
        if (this.support.agentSurvives(join.owner_agent_id)) {
          this.createJoinActivation(join, "expired", now);
        }
      }
      return { requests: requests.length, joins: joins.length };
    })();
  }

  cancelJoin(
    joinId: string,
    ownerAgentId: string,
    now = new Date().toISOString(),
  ): boolean {
    return this.sqlite.transaction(() => {
      const join = this.sqlite.prepare(`
        SELECT * FROM coordination_joins WHERE id = ?
      `).get(joinId) as JoinRow | undefined;
      if (!join) throw new Error("join not found");
      if (join.owner_agent_id !== ownerAgentId) {
        throw new Error("only the join owner may cancel it");
      }
      if (join.state === "cancelled") return false;
      if (join.state !== "open") {
        throw new Error(`join is terminal (${join.state})`);
      }
      this.sqlite.prepare(`
        UPDATE coordination_joins
        SET state = 'cancelled', updated_at = ?, terminal_at = ?
        WHERE id = ?
      `).run(now, now, joinId);
      this.questionAuthority.releaseQuestionDependency(
        "join",
        joinId,
        now,
      );
      this.sqlite.prepare(`
        UPDATE agent_activations SET state = 'cancelled', updated_at = ?
        WHERE state IN ('pending', 'retry_pending') AND id IN (
          SELECT activation_id FROM activation_sources
          WHERE source_kind = 'join' AND source_id = ?
        )
      `).run(now, joinId);
      return true;
    })();
  }

  reevaluateRequestJoins(requestId: string, now: string): void {
    const joins = this.sqlite.prepare(`
      SELECT join_record.* FROM coordination_joins join_record
      JOIN coordination_join_members member
        ON member.join_id = join_record.id
      WHERE member.request_id = ? AND join_record.state = 'open'
    `).all(requestId) as JoinRow[];
    for (const join of joins) {
      const requestRows = this.sqlite.prepare(`
        SELECT request.id, request.state
        FROM coordination_join_members member
        JOIN coordination_requests request
          ON request.id = member.request_id
        WHERE member.join_id = ? ORDER BY member.position
      `).all(join.id) as Array<{
        id: string;
        state: CoordinationRequestState;
      }>;
      const requestIds = requestRows.map((row) => row.id);
      const states = new Map(
        requestRows.map((row) => [row.id, row.state]),
      );
      const next = evaluateCoordinationJoin({
        state: join.state,
        mode: join.mode,
        quorum: join.quorum,
        requestIds,
        satisfyingOutcomes: JSON.parse(
          join.satisfying_outcomes_json,
        ) as CoordinationRequestState[],
      }, states);
      if (next === join.state) {
        const changedRequest = requestRows.find(
          (row) => row.id === requestId,
        );
        if (
          join.wake_policy === "each_result" &&
          changedRequest &&
          TERMINAL_REQUEST_STATES.has(changedRequest.state) &&
          this.support.agentSurvives(join.owner_agent_id)
        ) {
          this.createJoinActivation(join, "open", now, requestId);
        }
        continue;
      }
      this.sqlite.prepare(`
        UPDATE coordination_joins
        SET state = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND state = 'open'
      `).run(next, now, now, join.id);
      if (
        joinTransitionNeedsActivation(join.state, next) &&
        this.support.agentSurvives(join.owner_agent_id)
      ) {
        this.createJoinActivation(join, next, now);
      }
    }
  }

  private insertArtifacts(
    updateId: string,
    projectId: string,
    artifacts: RuntimeArtifactInputV3[],
    now: string,
  ): void {
    const insertArtifact = this.sqlite.prepare(`
      INSERT INTO runtime_artifacts (
        id, owner_kind, owner_id, project_id, role, title, media_type,
        blob_path, blob_hash, byte_length, origin_agent_id,
        execution_id, created_at
      ) VALUES (?, 'request_update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const artifact of artifacts) {
      insertArtifact.run(
        artifact.id,
        updateId,
        projectId,
        artifact.role,
        artifact.title,
        artifact.mediaType,
        artifact.blobPath,
        artifact.blobHash.toLowerCase(),
        artifact.byteLength,
        artifact.originAgentId ?? null,
        artifact.executionId ?? null,
        now,
      );
    }
  }

  private cancelPendingRequestWork(
    requestId: string,
    reason: "cancelled" | "superseded" | "expired",
    now: string,
  ): void {
    this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'cancelled', terminal_outcome = NULL, terminal_at = ?,
        last_delivery_error = ?, updated_at = ?
      WHERE state IN ('pending', 'retry_pending')
        AND kind IN ('coordination_request', 'coordination_question')
        AND id IN (
          SELECT source.activation_id
          FROM activation_sources source
          LEFT JOIN coordination_request_updates request_update
            ON source.source_kind = 'request_update'
            AND request_update.id = source.source_id
          WHERE (
            source.source_kind = 'request' AND source.source_id = ?
          ) OR (
            source.source_kind = 'request_update'
            AND request_update.request_id = ?
          )
        )
    `).run(
      now,
      `request ${reason} before delivery`,
      now,
      requestId,
      requestId,
    );
  }

  private nonterminalInboundRequestIdsAttachedToRun(
    runId: string,
    agentId: string,
  ): string[] {
    return this.requestIdsAttachedToRun(runId, agentId).filter(
      (requestId) => {
        const request = this.support.getRequestRow(requestId);
        return (
          request.recipient_agent_id === agentId &&
          !TERMINAL_REQUEST_STATES.has(request.state)
        );
      },
    );
  }

  private activateForRequestTransition(
    request: RequestRow,
    kind: CoordinationRequestUpdateKind,
    nextState: CoordinationRequestState,
    joined: boolean,
    updateId: string,
    updatePayload: unknown,
    now: string,
  ): void {
    if (
      kind === "question" &&
      request.requester_agent_id &&
      this.support.agentSurvives(request.requester_agent_id)
    ) {
      this.createActivation({
        projectId: request.project_id,
        agentId: request.requester_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
          request.conversation_id,
          request.requester_agent_id,
        ),
        kind: "coordination_question",
        priority: PRIORITY.urgent,
        dedupeKey: `request:${request.id}:question:${updateId}`,
        payload: {
          requestId: request.id,
          inReplyToUpdateId: updateId,
          update: updatePayload ?? null,
        },
        sourceKind: "request_update",
        sourceId: updateId,
        now,
      });
      return;
    }
    if (
      (kind === "answer" || kind === "dependency_resolved") &&
      this.support.agentSurvives(request.recipient_agent_id)
    ) {
      this.createActivation({
        projectId: request.project_id,
        agentId: request.recipient_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
          request.conversation_id,
          request.recipient_agent_id,
        ),
        kind: kind === "answer"
          ? "coordination_answer"
          : "coordination_dependency_resolved",
        priority: kind === "answer"
          ? PRIORITY.urgent
          : PRIORITY.actionable,
        dedupeKey: `request:${request.id}:${kind}:${updateId}`,
        payload: {
          requestId: request.id,
          updateId,
          update: updatePayload ?? null,
        },
        sourceKind: "request_update",
        sourceId: updateId,
        now,
      });
      return;
    }
    if (
      kind === "cancelled" &&
      this.support.isConsumedClarificationWait(request)
    ) {
      return;
    }
    if (
      (kind === "cancelled" || kind === "superseded") &&
      this.support.agentSurvives(request.recipient_agent_id)
    ) {
      this.createActivation({
        projectId: request.project_id,
        agentId: request.recipient_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
          request.conversation_id,
          request.recipient_agent_id,
        ),
        kind: `coordination_${kind}`,
        priority: PRIORITY.urgent,
        ...(kind === "cancelled"
          ? { dispatchPolicy: "steer_or_run" as const }
          : {}),
        dedupeKey: `request:${request.id}:${kind}`,
        payload: {
          requestId: request.id,
          state: nextState,
          update: updatePayload ?? null,
        },
        sourceKind: "request",
        sourceId: request.id,
        now,
      });
      return;
    }
    const requestPayload = JSON.parse(request.payload_json) as {
      completionMode?: unknown;
    } | null;
    const recordOnly = requestPayload?.completionMode === "record";
    const replyAuthority = request.reply_authority_json
      ? JSON.parse(
        request.reply_authority_json,
      ) as CoordinationReplyAuthority
      : undefined;
    if (
      TERMINAL_REQUEST_STATES.has(nextState) &&
      !joined &&
      !recordOnly &&
      request.requester_agent_id &&
      this.support.agentSurvives(request.requester_agent_id)
    ) {
      this.createActivation({
        projectId: request.project_id,
        agentId: request.requester_agent_id,
        scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
          request.conversation_id,
          request.requester_agent_id,
        ),
        kind: "coordination_outcome",
        priority: nextState === "completed"
          ? PRIORITY.satisfied
          : PRIORITY.actionable,
        dedupeKey: `request:${request.id}:terminal`,
        payload: {
          requestId: request.id,
          state: nextState,
          updateId,
          update: updatePayload ?? null,
          ...(replyAuthority ? { replyAuthority } : {}),
        },
        sourceKind: "request",
        sourceId: request.id,
        now,
      });
    }
  }

  private createJoinActivation(
    join: JoinRow,
    state: CoordinationJoinState,
    now: string,
    progressRequestId?: string,
  ): void {
    const outcomes = this.sqlite.prepare(`
      SELECT request.id AS request_id, request.state,
        request.payload_json AS request_payload_json,
        request.reply_authority_json, update_record.id AS update_id,
        update_record.kind AS update_kind,
        update_record.payload_json AS update_payload_json,
        update_record.created_at AS update_created_at
      FROM coordination_join_members member
      JOIN coordination_requests request
        ON request.id = member.request_id
      LEFT JOIN coordination_request_updates update_record
        ON update_record.request_id = request.id
        AND update_record.resulting_version = request.version
      WHERE member.join_id = ?
      ORDER BY member.position
    `).all(join.id) as Array<{
      request_id: string;
      state: CoordinationRequestState;
      request_payload_json: string;
      reply_authority_json: string | null;
      update_id: string | null;
      update_kind: CoordinationRequestUpdateKind | null;
      update_payload_json: string | null;
      update_created_at: string | null;
    }>;
    const continuations = (
      JSON.parse(join.continuation_request_ids_json) as string[]
    ).map((requestId) => {
      const request = this.support.getRequestRow(requestId);
      return {
        requestId: request.id,
        state: request.state,
        direction:
          request.recipient_agent_id === join.owner_agent_id
            ? "inbound"
            : "outbound_question",
        ...(
          request.recipient_agent_id === join.owner_agent_id ||
          !request.open_question_update_id
            ? {}
            : { inReplyToUpdateId: request.open_question_update_id }
        ),
        request: JSON.parse(request.payload_json) as unknown,
      };
    });
    const terminalCount = outcomes.filter((outcome) =>
      TERMINAL_REQUEST_STATES.has(outcome.state)).length;
    const replyAuthorityJson = outcomes.map(
      (outcome) => outcome.reply_authority_json,
    );
    const inheritedReplyAuthority =
      replyAuthorityJson.length > 0 &&
      replyAuthorityJson.every((value) => value !== null) &&
      new Set(replyAuthorityJson).size === 1
        ? JSON.parse(
          replyAuthorityJson[0]!,
        ) as CoordinationReplyAuthority
        : undefined;
    const visibleOutcomes = progressRequestId
      ? outcomes.filter(
        (outcome) => outcome.request_id === progressRequestId,
      )
      : outcomes;
    const progress = {
      terminal: terminalCount,
      total: outcomes.length,
      remaining: outcomes.length - terminalCount,
      ...(progressRequestId
        ? { newlyTerminalRequestIds: [progressRequestId] }
        : {}),
    };
    const isProgress = state === "open" && Boolean(progressRequestId);
    const activationId = this.createActivation({
      projectId: join.project_id,
      agentId: join.owner_agent_id,
      scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
        join.conversation_id,
        join.owner_agent_id,
      ),
      kind: isProgress
        ? "coordination_join_progress"
        : `coordination_join_${state}`,
      priority: state === "satisfied"
        ? PRIORITY.satisfied
        : PRIORITY.actionable,
      dedupeKey: isProgress
        ? `join:${join.id}:progress:${progressRequestId}`
        : `join:${join.id}:terminal`,
      payload: {
        joinId: join.id,
        state,
        wakePolicy: join.wake_policy,
        progress,
        ...(inheritedReplyAuthority
          ? { replyAuthority: inheritedReplyAuthority }
          : {}),
        outcomes: visibleOutcomes.map((outcome) => ({
          requestId: outcome.request_id,
          state: outcome.state,
          request: JSON.parse(
            outcome.request_payload_json,
          ) as unknown,
          ...(outcome.update_id
            ? {
              update: {
                id: outcome.update_id,
                kind: outcome.update_kind,
                payload: JSON.parse(
                  outcome.update_payload_json ?? "null",
                ) as unknown,
                createdAt: outcome.update_created_at,
              },
            }
            : {}),
        })),
        ...(continuations.length
          ? {
            continuations,
            continuationInstruction: [
              isProgress
                ? "Act on the newly returned outcome while other aggregate " +
                  "work continues. Do not terminally update an inbound " +
                  "continuation while this Join remains open."
                : "Integrate the joined outcomes, then terminally update " +
                  "every nonterminal inbound continuation before ending " +
                  "this Run.",
              continuations.some(
                (continuation) =>
                  continuation.direction === "outbound_question",
              )
                ? "For every outbound_question still awaiting an answer, " +
                  "reply using its exact inReplyToUpdateId. Never terminally " +
                  "update work assigned to another Agent."
                : "",
              isProgress
                ? "When no independent work remains, end this Run to " +
                  "return to durable waiting."
                : "Sending a message does not fulfill a correlated request.",
            ].filter(Boolean).join(" "),
          }
          : {}),
      },
      sourceKind: "join",
      sourceId: join.id,
      now,
    });
    this.questionAuthority.attachQuestionDependencyToActivation(
      activationId,
      "join",
      join.id,
      now,
      state !== "open",
    );
  }
}
