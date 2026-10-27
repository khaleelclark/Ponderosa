import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { TERMINAL_REQUEST_STATES } from "@ponderosa/core";
import { PRIORITY } from "./coordination-v3-activation.js";
import {
  payloadHash,
  stableJson,
} from "./coordination-v3-canonical-json.js";
import type { CreateActivationV3Input } from "./coordination-v3-runtime-communication-authority.js";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type { CoordinationV3RuntimeAttachmentAuthority } from "./coordination-v3-runtime-attachment-authority.js";
import { isIso } from "./coordination-v3-runtime-validation.js";
import { REQUEST_SOURCE_LINEAGE_CTE } from "./coordination-v3-request-lineage.js";
import { taskOriginRunIds } from "./coordination-v3-task-lineage.js";
import type { CoordinationV3StoreSupport } from "./coordination-v3-store-support.js";
import type { CoordinationV3RequestRecoveryAuthority } from "./coordination-v3-request-recovery-authority.js";
import type {
  CoordinateV3Input,
  CoordinateV3Result,
  EnqueueMessageActivationInput,
  UpdateRequestV3Input,
} from "./coordination-v3-types.js";

/** Creates correlated requests and aggregate joins in one idempotent intake. */
export class CoordinationV3CoordinateAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly support: CoordinationV3StoreSupport,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly runtimeAttachmentAuthority: CoordinationV3RuntimeAttachmentAuthority,
    private readonly requestRecoveryAuthority: CoordinationV3RequestRecoveryAuthority,
    private readonly createActivation: (input: CreateActivationV3Input) => string,
    private readonly insertQuestionSuspensions: (
      requestIds: string[],
      ownerAgentId: string,
      dependencyKind: "decision" | "join",
      dependencyId: string,
      now: string,
    ) => void,
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
    private readonly reevaluateRequestJoins: (
      requestId: string,
      now: string,
    ) => void,
    private readonly questionDependencyContinuations: (
      dependencyKind: "decision" | "join",
      dependencyId: string,
    ) => Array<{ requestId: string; inReplyToUpdateId: string }>,
    private readonly attachQuestionDependencyToActivation: (
      activationId: string,
      dependencyKind: "decision" | "join",
      dependencyId: string,
      now: string,
      resolve: boolean,
    ) => void,
  ) {}

  private requestHash(input: CoordinateV3Input): string {
    const join = input.join
      ? (({ continuationRequestIds: _serverDerived, ...submitted }) => ({
          ...submitted,
          id: input.join?.id ?? null,
        }))(input.join)
      : null;
    return payloadHash({
      projectId: input.projectId,
      conversationId: input.conversationId ?? null,
      requesterAgentId: input.requesterAgentId,
      actorScope: input.actorScope,
      idempotencyKey: input.idempotencyKey,
      rolloverRecoveryForRequestId:
        input.rolloverRecoveryForRequestId ?? null,
      requests: input.requests.map((request) => ({
        ...request,
        requestId: request.requestId ?? null,
      })),
      join,
    });
  }

  replayCoordinate(input: CoordinateV3Input): CoordinateV3Result | undefined {
    if (!input.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    if (input.requests.length === 0 && !input.join?.requestIds?.length) {
      throw new Error("at least one new or existing request is required");
    }
    return this.sqlite.transaction(() => {
      const replay = this.support.idempotentReplay<CoordinateV3Result>(
        input.projectId,
        input.actorScope,
        "coordinate",
        input.idempotencyKey,
        this.requestHash(input),
      );
      if (replay) return { ...replay, replayed: true };
      if (input.runAuthorization) {
        this.support.requireAuthorizedRun(
          input.runAuthorization,
          input.conversationId ? `conversation:${input.conversationId}` : undefined,
        );
      }
      return undefined;
    })();
  }

  coordinate(
    input: CoordinateV3Input,
    now = new Date().toISOString(),
  ): CoordinateV3Result {
    if (!input.idempotencyKey.trim()) {
      throw new Error("idempotencyKey is required");
    }
    if (input.requests.length === 0 && !input.join?.requestIds?.length) {
      throw new Error("at least one new or existing request is required");
    }
    const hash = this.requestHash(input);

    return this.sqlite.transaction(() => {
      const replay = this.support.idempotentReplay<CoordinateV3Result>(
        input.projectId,
        input.actorScope,
        "coordinate",
        input.idempotencyKey,
        hash,
      );
      if (replay) return { ...replay, replayed: true };
      if (input.runAuthorization) {
        this.support.requireAuthorizedRun(
          input.runAuthorization,
          input.conversationId
            ? `conversation:${input.conversationId}`
            : undefined,
        );
      }
      this.support.requireProject(input.projectId);
      if (input.requesterAgentId) {
        this.support.requireAgent(
          input.projectId,
          input.requesterAgentId,
        );
      }
      if (input.runAuthorization && !input.conversationId) {
        throw new Error("provider coordination requires a Team Chat scope");
      }
      if (input.runAuthorization && input.requesterAgentId !== input.runAuthorization.agentId) {
        throw new Error("delegation origin must be the authorized Run's Agent");
      }
      if (input.rolloverRecoveryForRequestId) {
        const retry = input.requests[0];
        if (
          input.actorScope !== "user:local-operator" ||
          input.requests.length !== 1 ||
          retry?.recoveryOfRequestId !== input.rolloverRecoveryForRequestId
        ) {
          throw new Error("context rollover recovery requires one matching operator retry");
        }
      }
      if (input.conversationId) {
        this.support.requireConversation(
          input.projectId,
          input.conversationId,
        );
        if (input.requesterAgentId) {
          this.support.requireConversationMember(
            input.conversationId,
            input.requesterAgentId,
          );
        }
      }
      const requestIds: string[] = [];
      const requestActivationIds = new Map<string, string>();
      for (const request of input.requests) {
        this.support.requireAgent(
          input.projectId,
          request.recipientAgentId,
        );
        if (input.conversationId) {
          this.support.requireConversationMember(
            input.conversationId,
            request.recipientAgentId,
          );
        }
        this.support.validateLifetime(request.lifetime, now);
        const replyAuthority = request.replyAuthority
          ? {
            intent: request.replyAuthority.intent,
            ...(request.replyAuthority.recipientAgentIds
              ? {
                recipientAgentIds: [
                  ...request.replyAuthority.recipientAgentIds,
                ].sort(),
              }
              : {}),
          }
          : undefined;
        if (replyAuthority) {
          const recipients = replyAuthority.recipientAgentIds ?? [];
          if (
            !(
              replyAuthority.intent === "broadcast" ||
              replyAuthority.intent === "direct_to_user" ||
              replyAuthority.intent === "collaboration"
            ) ||
            (
              replyAuthority.intent === "collaboration"
                ? recipients.length === 0
                : recipients.length > 0
            ) ||
            new Set(recipients).size !== recipients.length ||
            recipients.some(
              (agentId) =>
                typeof agentId !== "string" || !agentId.trim(),
            )
          ) {
            throw new Error("request reply authority is invalid");
          }
        }
        const requestId = request.requestId ?? randomUUID();
        this.sqlite.prepare(`
          INSERT INTO coordination_requests (
            id, project_id, conversation_id, requester_agent_id,
            recipient_agent_id, communication_event_id, payload_json,
            reply_authority_json, state, version, lifetime_kind, deadline_at,
            created_at, updated_at, origin_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, ?)
        `).run(
          requestId,
          input.projectId,
          input.conversationId ?? null,
          input.requesterAgentId ?? null,
          request.recipientAgentId,
          request.communicationEventId ?? null,
          stableJson(request.payload ?? null),
          replyAuthority ? stableJson(replyAuthority) : null,
          request.lifetime.kind,
          request.lifetime.kind === "deadline"
            ? request.lifetime.at
            : null,
          now,
          now,
          input.runAuthorization?.runId ?? null,
        );
        if (request.recoveryOfRequestId) {
          this.requestRecoveryAuthority.bind({
            predecessorRequestId: request.recoveryOfRequestId,
            successorRequestId: requestId,
            actorScope: input.actorScope,
            ...(input.runAuthorization
              ? { actorAgentId: input.runAuthorization.agentId }
              : {}),
          });
        }
        requestIds.push(requestId);
        const activationId = this.createActivation({
          projectId: input.projectId,
          agentId: request.recipientAgentId,
          scopeKey: this.runtimeScopeAuthority.coordinationScopeKey(
            input.conversationId ?? null,
            request.recipientAgentId,
          ),
          kind: "coordination_request",
          priority: PRIORITY.request,
          dedupeKey: `request:${requestId}:created`,
          payload: {
            requestId,
            requesterAgentId: input.requesterAgentId ?? null,
            request: request.payload ?? null,
          },
          sourceKind: "request",
          sourceId: requestId,
          externalIntake: true,
          now,
        });
        requestActivationIds.set(requestId, activationId);
      }

      if (input.rolloverRecoveryForRequestId) {
        const retryRequestId = requestIds[0]!;
        const retryActivationId = requestActivationIds.get(retryRequestId)!;
        const original = this.support.getRequestRow(
          input.rolloverRecoveryForRequestId,
        );
        const retry = this.support.getRequestRow(retryRequestId);
        if (
          original.project_id !== input.projectId ||
          retry.project_id !== original.project_id ||
          retry.recipient_agent_id !== original.recipient_agent_id ||
          retry.requester_agent_id !== original.requester_agent_id ||
          retry.conversation_id !== original.conversation_id
        ) {
          throw new Error("context rollover recovery request lineage is invalid");
        }
        const recovery = this.sqlite.prepare(`
          ${REQUEST_SOURCE_LINEAGE_CTE}
          SELECT rollover.id
          FROM context_rollovers rollover
          JOIN request_source_lineage lineage
            ON lineage.activation_id = rollover.continuation_activation_id
          JOIN coordination_requests lineage_request
            ON lineage_request.id = lineage.request_id
          WHERE rollover.project_id = ?
            AND rollover.agent_id = ?
            AND rollover.state IN ('failed','outcome_unknown')
            AND rollover.handoff_event_id IS NOT NULL
            AND rollover.failure_signal IS NOT 'seed_overflow'
            AND lineage_request.id = ?
            AND lineage_request.project_id = rollover.project_id
            AND lineage_request.recipient_agent_id = rollover.agent_id
            AND NOT EXISTS (
              SELECT 1 FROM activation_sources claimed
              WHERE claimed.source_kind = 'context_rollover_recovery'
                AND claimed.source_id = rollover.id
            )
          ORDER BY rollover.terminal_at DESC, rollover.updated_at DESC,
            rollover.id DESC
          LIMIT 1
        `).get(
          input.projectId,
          retry.recipient_agent_id,
          input.rolloverRecoveryForRequestId,
        ) as { id: string } | undefined;
        if (recovery) {
          this.sqlite.prepare(`
            INSERT INTO activation_sources (
              activation_id, source_kind, source_id
            ) VALUES (?, 'context_rollover_recovery', ?)
          `).run(retryActivationId, recovery.id);
        }
      }

      let joinId: string | undefined;
      if (input.join) {
        if (!input.requesterAgentId) {
          throw new Error("a join requires an agent requester");
        }
        const existingMemberRequestIds: string[] = [];
        const newRecipientIds = new Set(
          input.requests.map((request) => request.recipientAgentId),
        );
        for (const requestId of input.join.requestIds ?? []) {
          const existing = this.sqlite.prepare(`
            SELECT project_id, conversation_id, requester_agent_id
            FROM coordination_requests WHERE id = ?
          `).get(requestId) as {
            project_id: string;
            conversation_id: string | null;
            requester_agent_id: string | null;
          } | undefined;
          if (
            existing?.project_id === input.projectId &&
            existing.requester_agent_id === input.requesterAgentId &&
            existing.conversation_id === (input.conversationId ?? null)
          ) {
            existingMemberRequestIds.push(requestId);
            continue;
          }
          if (newRecipientIds.has(requestId)) continue;
          throw new Error(
            "every existing join request must be owned by the requester in this project",
          );
        }
        const memberRequestIds = [
          ...new Set([...requestIds, ...existingMemberRequestIds]),
        ];
        const continuationRequestIds = [
          ...new Set(input.join.continuationRequestIds ?? []),
        ];
        for (const requestId of continuationRequestIds) {
          const continuation = this.support.getRequestRow(requestId);
          const isInbound =
            continuation.recipient_agent_id === input.requesterAgentId &&
            !TERMINAL_REQUEST_STATES.has(continuation.state);
          const isOutboundQuestion =
            continuation.requester_agent_id === input.requesterAgentId &&
            continuation.state === "awaiting_answer" &&
            continuation.open_question_update_id !== null;
          if (
            continuation.project_id !== input.projectId ||
            continuation.conversation_id !==
              (input.conversationId ?? null) ||
            (!isInbound && !isOutboundQuestion)
          ) {
            throw new Error(
              "every join continuation must be nonterminal work assigned to the owner or an attached outbound question",
            );
          }
        }
        joinId = input.join.id ?? randomUUID();
        const mode = input.join.mode;
        const quorum = mode === "all"
          ? memberRequestIds.length
          : mode === "any"
            ? 1
            : input.join.quorum ?? 0;
        if (quorum < 1 || quorum > memberRequestIds.length) {
          throw new Error("join quorum is outside request membership");
        }
        const satisfying = input.join.satisfyingOutcomes ?? ["completed"];
        const wakePolicy = input.join.wakePolicy ?? "final_only";
        if (
          satisfying.length === 0 ||
          satisfying.some((state) => !TERMINAL_REQUEST_STATES.has(state))
        ) {
          throw new Error(
            "join satisfying outcomes must be terminal request states",
          );
        }
        if (
          input.join.deadlineAt &&
          (
            !isIso(input.join.deadlineAt) ||
            input.join.deadlineAt <= now
          )
        ) {
          throw new Error("join deadline must be a future ISO timestamp");
        }
        const definitionHash = payloadHash({
          conversationId: input.conversationId ?? null,
          requestIds: [...memberRequestIds].sort(),
          mode,
          quorum,
          satisfyingOutcomes: [...new Set(satisfying)].sort(),
          wakePolicy,
          deadlineAt: input.join.deadlineAt ?? null,
          continuationRequestIds: [...continuationRequestIds].sort(),
          ...(input.runAuthorization ? { taskOrigins: (() => {
            const roots = (this.sqlite.prepare(`SELECT source_activation_id FROM required_reply_obligations
              WHERE run_id = ? AND json_extract(reply_authority_json, '$.intent') IN ('broadcast','direct_to_user')
              ORDER BY source_activation_id`).all(input.runAuthorization.runId) as Array<{ source_activation_id: string }>);
            return roots.length ? roots.map(r => r.source_activation_id) : [`run:${input.runAuthorization.runId}`];
          })() } : {}),
        });
        const equivalent = this.sqlite.prepare(`
          SELECT id FROM coordination_joins
          WHERE project_id = ? AND owner_agent_id = ? AND definition_hash = ?
            AND ((origin_run_id IS NULL AND ? IS NULL) OR origin_run_id IN (SELECT value FROM json_each(?)))
            AND state IN ('open', 'satisfied', 'impossible')
          ORDER BY created_at LIMIT 1
        `).get(
          input.projectId,
          input.requesterAgentId,
          definitionHash,
          input.runAuthorization?.runId ?? null,
          JSON.stringify(input.runAuthorization ? taskOriginRunIds(this.sqlite, input.runAuthorization.runId) : []),
        ) as { id: string } | undefined;
        if (equivalent) {
          joinId = equivalent.id;
          const result: CoordinateV3Result = {
            requestIds,
            joinId,
            replayed: false,
          };
          this.support.recordIdempotency(
            input.projectId,
            input.actorScope,
            "coordinate",
            input.idempotencyKey,
            hash,
            result,
            now,
          );
          return result;
        }
        this.sqlite.prepare(`
          INSERT INTO coordination_joins (
            id, project_id, conversation_id, owner_agent_id, mode,
            wake_policy, quorum, satisfying_outcomes_json, state, deadline_at,
            definition_hash, continuation_request_ids_json,
            created_at, updated_at, origin_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
        `).run(
          joinId,
          input.projectId,
          input.conversationId ?? null,
          input.requesterAgentId,
          mode,
          wakePolicy,
          quorum,
          stableJson([...new Set(satisfying)]),
          input.join.deadlineAt ?? null,
          definitionHash,
          stableJson(continuationRequestIds),
          now,
          now,
          input.runAuthorization?.runId ?? null,
        );
        const insertMember = this.sqlite.prepare(`
          INSERT INTO coordination_join_members (
            join_id, request_id, position
          ) VALUES (?, ?, ?)
        `);
        memberRequestIds.forEach((requestId, position) =>
          insertMember.run(joinId, requestId, position));
        const outboundQuestionIds = continuationRequestIds.filter(
          (requestId) => {
            const continuation = this.support.getRequestRow(requestId);
            return (
              continuation.requester_agent_id === input.requesterAgentId &&
              continuation.state === "awaiting_answer" &&
              continuation.open_question_update_id !== null
            );
          },
        );
        this.insertQuestionSuspensions(
          outboundQuestionIds,
          input.requesterAgentId,
          "join",
          joinId,
          now,
        );
        for (const requestId of continuationRequestIds) {
          const continuation = this.support.getRequestRow(requestId);
          if (
            continuation.state === "open" ||
            continuation.state === "in_progress"
          ) {
            this.updateRequest({
              requestId,
              updateId: `join:${joinId}:waiting:${requestId}`,
              kind: "waiting_dependency",
              actor: { kind: "agent", id: input.requesterAgentId },
              payload: { joinId, reason: "waiting_for_join" },
              now,
            });
          }
        }
        this.reevaluateRequestJoins(memberRequestIds[0]!, now);
      }

      const result: CoordinateV3Result = {
        requestIds,
        ...(joinId ? { joinId } : {}),
        replayed: false,
      };
      this.support.recordIdempotency(
        input.projectId,
        input.actorScope,
        "coordinate",
        input.idempotencyKey,
        hash,
        result,
        now,
      );
      return result;
    })();
  }

  protectMessageAttachments(input: Pick<EnqueueMessageActivationInput, "projectId" | "agentId" | "messageId" | "payload">): unknown {
    const prepared = this.runtimeAttachmentAuthority.bindRuntimeAttachments(input.projectId, input.payload, [input.agentId]);
    if (!prepared.bindings.length) return prepared.payload;
    return this.sqlite.transaction(() => {
      this.support.requireProject(input.projectId);
      this.support.requireAgent(input.projectId, input.agentId);
      this.runtimeAttachmentAuthority.reserveRuntimeCommunication(input.messageId, prepared.bindings);
      this.runtimeAttachmentAuthority.revalidateRuntimeAttachments(input.projectId, prepared.bindings);
      return prepared.payload;
    })();
  }

  enqueueMessageActivation(input: EnqueueMessageActivationInput): string {
    const now = input.now ?? new Date().toISOString();
    return this.sqlite.transaction(() => {
      this.support.requireProject(input.projectId);
      this.support.requireAgent(input.projectId, input.agentId);
      const continuationQuestions = input.questionDependency
        ? this.questionDependencyContinuations(
          input.questionDependency.kind,
          input.questionDependency.id,
        )
        : [];
      const payload =
        continuationQuestions.length &&
        input.payload &&
        typeof input.payload === "object" &&
        !Array.isArray(input.payload)
          ? {
            ...input.payload,
            continuationQuestions,
            continuationInstruction:
              "Answer each correlated question with its exact " +
              "inReplyToUpdateId before ending this Run.",
          }
          : input.payload;
      const activationId = this.createActivation({
        projectId: input.projectId,
        agentId: input.agentId,
        scopeKey: input.scopeKey ?? `agent:${input.agentId}`,
        kind: `${input.kind}_message`,
        priority: input.kind === "human"
          ? PRIORITY.human
          : input.kind === "urgent"
            ? PRIORITY.urgent
            : PRIORITY.ordinary,
        dispatchPolicy:
          input.dispatchPolicy ??
          (input.kind === "ordinary" ? "next_run" : "steer_or_run"),
        promptClass:
          input.promptClass ??
          (
            input.kind === "human"
              ? "human"
              : input.kind === "urgent"
                ? "blocker"
                : "ordinary"
          ),
        dedupeKey: `message:${input.messageId}`,
        payload: this.protectMessageAttachments({ ...input, payload }),
        sourceKind: "message",
        sourceId: input.messageId,
        externalIntake: !input.bypassCapacity,
        now,
      });
      if (input.questionDependency) {
        this.attachQuestionDependencyToActivation(
          activationId,
          input.questionDependency.kind,
          input.questionDependency.id,
          now,
          true,
        );
      }
      return activationId;
    })();
  }
}
