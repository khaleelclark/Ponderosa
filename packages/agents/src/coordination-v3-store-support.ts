import type Database from "better-sqlite3";
import {
  REQUEST_UPDATE_AUTHORIZATION,
  type CoordinationActorClass,
  type CoordinationRequestState,
  type CoordinationRequestUpdateKind,
  type RequestLifetime,
} from "@ponderosa/core";
import { stableJson } from "./coordination-v3-canonical-json.js";
import { isIso } from "./coordination-v3-runtime-validation.js";
import type {
  Actor,
  RunAuthorizationV3,
} from "./coordination-v3-types.js";

export interface RequestRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  requester_agent_id: string | null;
  recipient_agent_id: string;
  state: CoordinationRequestState;
  version: number;
  lifetime_kind: RequestLifetime["kind"];
  deadline_at: string | null;
  open_question_update_id: string | null;
  payload_json: string;
  reply_authority_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Shared entity, fencing, authorization, and idempotency invariants. */
export class CoordinationV3StoreSupport {
  constructor(private readonly sqlite: Database.Database) {}

  validateLifetime(lifetime: RequestLifetime, now: string): void {
    if (
      lifetime.kind === "deadline" &&
      (!isIso(lifetime.at) || lifetime.at <= now)
    ) {
      throw new Error("request deadline must be a future ISO timestamp");
    }
  }

  requireProject(projectId: string): void {
    if (!this.sqlite.prepare(
      `SELECT 1 FROM projects WHERE id = ?`,
    ).get(projectId)) {
      throw new Error("project not found");
    }
  }

  requireAgent(projectId: string, agentId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM agents
      WHERE id = ? AND project_id = ? AND archived = 0
    `).get(agentId, projectId)) {
      throw new Error("agent not found in project");
    }
  }

  requireConversation(projectId: string, conversationId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM conversations
      WHERE id = ? AND project_id = ? AND archived = 0
    `).get(conversationId, projectId)) {
      throw new Error("Team Chat not found in project");
    }
  }

  requireConversationMember(conversationId: string, agentId: string): void {
    if (!this.sqlite.prepare(`
      SELECT 1 FROM agent_conversation_memberships
      WHERE conversation_id = ? AND agent_id = ?
    `).get(conversationId, agentId)) {
      throw new Error(
        "every coordination participant must be an active member of this Team Chat",
      );
    }
  }

  agentSurvives(agentId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM agents WHERE id = ? AND archived = 0
    `).get(agentId));
  }

  isConsumedClarificationWait(request: RequestRow): boolean {
    if (request.state !== "awaiting_answer") return false;
    return Boolean(this.sqlite.prepare(`
      SELECT 1
      FROM agent_activations activation
      JOIN activation_sources source ON source.activation_id = activation.id
      WHERE source.source_kind = 'request' AND source.source_id = ?
        AND activation.agent_id = ?
        AND activation.kind = 'coordination_request'
        AND activation.state = 'consumed'
        AND NOT EXISTS (
          SELECT 1
          FROM scheduler_runs active_run
          JOIN scheduler_run_activations attached
            ON attached.run_id = active_run.id
          JOIN activation_sources active_source
            ON active_source.activation_id = attached.activation_id
          LEFT JOIN coordination_request_updates active_update
            ON active_source.source_kind = 'request_update'
            AND active_update.id = active_source.source_id
          WHERE active_run.agent_id = ?
            AND active_run.status IN ('leased', 'running')
            AND (
              (
                active_source.source_kind = 'request'
                AND active_source.source_id = ?
              )
              OR active_update.request_id = ?
            )
        )
      LIMIT 1
    `).get(
      request.id,
      request.recipient_agent_id,
      request.recipient_agent_id,
      request.id,
      request.id,
    ));
  }

  getRequestRow(requestId: string): RequestRow {
    const row = this.sqlite.prepare(`
      SELECT * FROM coordination_requests WHERE id = ?
    `).get(requestId) as RequestRow | undefined;
    if (!row) throw new Error("request not found");
    return row;
  }

  authorizeUpdate(
    request: RequestRow,
    kind: CoordinationRequestUpdateKind,
    actor: Actor,
  ): void {
    const authorization: CoordinationActorClass =
      REQUEST_UPDATE_AUTHORIZATION[kind];
    const isRecipient =
      actor.kind === "agent" && actor.id === request.recipient_agent_id;
    const isRequester =
      actor.kind === "agent" && actor.id === request.requester_agent_id;
    const allowed = authorization === "recipient"
      ? isRecipient
      : authorization === "recipient_or_supervisor"
        ? isRecipient || actor.kind === "supervisor"
        : authorization === "requester_or_user"
          ? isRequester || actor.kind === "user"
          : authorization === "system"
            ? actor.kind === "system"
            : actor.kind === "system" ||
              actor.kind === "supervisor" ||
              actor.kind === "user";
    if (!allowed) throw new Error(`actor is not authorized for ${kind}`);
  }

  nextFence(agentId: string): number {
    const row = this.sqlite.prepare(`
      SELECT next_fencing_token
      FROM scheduler_agent_fences WHERE agent_id = ?
    `).get(agentId) as { next_fencing_token: number } | undefined;
    const token = row?.next_fencing_token ?? 1;
    this.sqlite.prepare(`
      INSERT INTO scheduler_agent_fences (agent_id, next_fencing_token)
      VALUES (?, ?)
      ON CONFLICT(agent_id)
      DO UPDATE SET next_fencing_token = excluded.next_fencing_token
    `).run(agentId, token + 1);
    return token;
  }

  requireAuthorizedRun(
    authorization: RunAuthorizationV3,
    expectedScopeKey?: string,
  ): void {
    if (
      !Number.isSafeInteger(authorization.fencingToken) ||
      authorization.fencingToken <= 0
    ) {
      throw new Error("invalid run fencing token");
    }
    const authoritative = this.sqlite.prepare(`
      SELECT scope_key FROM scheduler_runs
      WHERE id = ? AND agent_id = ? AND fencing_token = ?
        AND status IN ('leased', 'running')
        AND side_effects_fenced_at IS NULL
    `).get(
      authorization.runId,
      authorization.agentId,
      authorization.fencingToken,
    ) as { scope_key: string } | undefined;
    if (!authoritative) throw new Error("run is no longer authoritative");
    if (expectedScopeKey && authoritative.scope_key !== expectedScopeKey) {
      throw new Error(
        "mutation scope does not match the authoritative run",
      );
    }
  }

  getFencedRun(runId: string, fence: number): Record<string, unknown> {
    const run = this.sqlite.prepare(`
      SELECT * FROM scheduler_runs WHERE id = ? AND fencing_token = ?
    `).get(runId, fence) as Record<string, unknown> | undefined;
    if (!run) throw new Error("stale run fencing token");
    return run;
  }

  mutateFencedRun(
    runId: string,
    fence: number,
    sql: string,
    values: unknown[],
  ): void {
    const changed = this.sqlite.prepare(sql).run(...values).changes;
    if (changed !== 1) {
      throw new Error(`stale run fencing token for ${runId}:${fence}`);
    }
  }

  idempotentReplay<T>(
    projectId: string,
    actorScope: string,
    operation: string,
    key: string,
    hash: string,
  ): T | undefined {
    const row = this.sqlite.prepare(`
      SELECT payload_hash, result_json FROM coordination_idempotency
      WHERE project_id = ? AND actor_scope = ? AND operation = ?
        AND idempotency_key = ?
    `).get(projectId, actorScope, operation, key) as {
      payload_hash: string;
      result_json: string;
    } | undefined;
    if (!row) return undefined;
    if (row.payload_hash !== hash) {
      throw new Error("idempotency key collision");
    }
    return JSON.parse(row.result_json) as T;
  }

  recordIdempotency(
    projectId: string,
    actorScope: string,
    operation: string,
    key: string,
    hash: string,
    result: unknown,
    now: string,
  ): void {
    this.sqlite.prepare(`
      INSERT INTO coordination_idempotency (
        project_id, actor_scope, operation, idempotency_key,
        payload_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      actorScope,
      operation,
      key,
      hash,
      stableJson(result),
      now,
    );
  }
}
