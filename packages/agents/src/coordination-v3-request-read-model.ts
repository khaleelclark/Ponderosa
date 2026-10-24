import type Database from "better-sqlite3";
import { TEAM_DIRECTORY_LIMITS, TERMINAL_REQUEST_STATES, type TeamDirectoryCaller, type TeamDirectoryWorkDto } from "@ponderosa/core";
import type { CoordinationRequestState } from "@ponderosa/core";
import type { RequestRow } from "./coordination-v3-store-support.js";
import type {
  CoordinationRequestDeliveryView,
  CoordinationRequestV3View,
} from "./coordination-v3-types.js";
import { REQUEST_SOURCE_LINEAGE_CTE } from "./coordination-v3-request-lineage.js";

export class CoordinationV3RequestReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  /** On demand, no cache. The SQL audience predicate is the canonical requester/
   * recipient rule also used by agentCanReadRequest and Request artifacts. It
   * applies before payloads, relationships, progress, LIMIT or omission counts. */
  directoryWork(input: { projectId: string; conversationId?: string; agentId: string; caller: TeamDirectoryCaller }): TeamDirectoryWorkDto {
    const { caller } = input;
    if (caller.kind === "agent" && (caller.projectId !== input.projectId ||
      caller.conversationId !== input.conversationId)) throw new Error("directory caller scope mismatch");
    const params = { projectId: input.projectId, conversationId: input.conversationId ?? null,
      agentId: input.agentId, operator: caller.kind === "operator" ? 1 : 0,
      callerAgentId: caller.kind === "agent" ? caller.agentId : null,
      textLimit: TEAM_DIRECTORY_LIMITS.textCharacters,
      fetchLimit: TEAM_DIRECTORY_LIMITS.assignmentsPerAgent + 1 };
    const scope = `r.project_id = @projectId AND (@conversationId IS NULL OR r.conversation_id = @conversationId)
      AND r.recipient_agent_id = @agentId`;
    const access = `(@operator = 1 OR r.requester_agent_id = @callerAgentId OR r.recipient_agent_id = @callerAgentId)`;
    const active = `r.state IN ('open', 'in_progress', 'waiting_dependency', 'awaiting_answer')`;
    const existence = this.sqlite.prepare(`SELECT
      EXISTS(SELECT 1 FROM coordination_requests r WHERE ${scope} AND ${active}) AS tracked,
      EXISTS(SELECT 1 FROM coordination_requests r WHERE ${scope} AND ${active} AND ${access}) AS authorized
    `).get(params) as { tracked: number; authorized: number };
    const rows = this.sqlite.prepare(`${REQUEST_SOURCE_LINEAGE_CTE}
      SELECT r.id, r.requester_agent_id, r.state,
        CASE WHEN json_type(r.payload_json, '$.text') = 'text'
          THEN substr(json_extract(r.payload_json, '$.text'), 1, @textLimit) END AS summary,
        (SELECT u.id FROM coordination_request_updates u WHERE u.request_id = r.id
          AND u.kind = 'progress' AND u.actor_kind = 'agent' AND u.actor_id = r.recipient_agent_id
          ORDER BY u.created_at DESC, u.id DESC LIMIT 1) AS progress_id,
        (SELECT sr.status FROM request_source_lineage source
          JOIN scheduler_run_activations ra ON ra.activation_id = source.activation_id
          JOIN scheduler_runs sr ON sr.id = ra.run_id AND sr.agent_id = r.recipient_agent_id AND sr.project_id = r.project_id
          WHERE source.request_id = r.id
          ORDER BY sr.created_at DESC, sr.id DESC LIMIT 1) AS execution_state,
        (SELECT j.state FROM coordination_joins j
          WHERE j.project_id = r.project_id AND j.owner_agent_id = r.recipient_agent_id
            AND (@operator = 1 OR j.owner_agent_id = @callerAgentId)
            AND EXISTS(SELECT 1 FROM json_each(j.continuation_request_ids_json) WHERE value = r.id)
          ORDER BY j.created_at DESC, j.id DESC LIMIT 1) AS dependency_state
      FROM coordination_requests r WHERE ${scope} AND ${access}
      ORDER BY CASE WHEN ${active} THEN 0 ELSE 1 END, r.updated_at DESC, r.id DESC LIMIT @fetchLimit
    `).all(params) as Array<{ id: string; requester_agent_id: string | null; state: CoordinationRequestState;
      summary: string | null; progress_id: string | null; execution_state: string | null;
      dependency_state: NonNullable<TeamDirectoryWorkDto["assignments"][number]["dependencyState"]> | null }>;
    const assignments = rows.slice(0, TEAM_DIRECTORY_LIMITS.assignmentsPerAgent).map(row => {
      const progress = row.progress_id ? this.sqlite.prepare(`SELECT
        CASE WHEN json_type(payload_json, '$.text') = 'text'
          THEN substr(json_extract(payload_json, '$.text'), 1, ?) END AS text, created_at
        FROM coordination_request_updates WHERE id = ? AND request_id = ?
      `).get(TEAM_DIRECTORY_LIMITS.textCharacters, row.progress_id, row.id) as { text: string | null; created_at: string } | undefined : undefined;
      return { requestId: row.id, ...(row.summary ? { summary: row.summary } : {}),
        ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
        requestState: row.state, deliveryState: this.requestDelivery(row.id)!.deliveryState,
        ...(row.execution_state ? { executionState: row.execution_state } : {}),
        ...(row.dependency_state ? { dependencyState: row.dependency_state } : {}),
        ...(progress?.text ? { progress: { text: progress.text, createdAt: progress.created_at } } : {}) };
    });
    return { assignments, hasMoreAssignments: rows.length > TEAM_DIRECTORY_LIMITS.assignmentsPerAgent,
      activeAssignmentDetails: existence.authorized ? "available" : existence.tracked ? "restricted" : "none" };
  }

  requestForUpdate(updateId: string): CoordinationRequestV3View | undefined {
    const row = this.sqlite.prepare(`
      SELECT request_id FROM coordination_request_updates WHERE id = ?
      UNION ALL SELECT request_id FROM coordination_request_late_results WHERE id = ?
      LIMIT 1
    `).get(updateId, updateId) as { request_id: string } | undefined;
    return row ? this.getRequest(row.request_id) : undefined;
  }

  getRequest(requestId: string): CoordinationRequestV3View | undefined {
    const row = this.sqlite.prepare(`SELECT * FROM coordination_requests WHERE id = ?`).get(requestId) as RequestRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
      recipientAgentId: row.recipient_agent_id,
      state: row.state,
      version: row.version,
      payload: JSON.parse(row.payload_json) as unknown,
      ...(row.superseded_by_request_id
        ? { recoverySuccessorRequestId: row.superseded_by_request_id }
        : {}),
    };
  }

  requestDelivery(requestId: string): CoordinationRequestDeliveryView | undefined {
    const row = this.sqlite.prepare(`
      SELECT request.state AS request_state, request.recipient_agent_id,
        activation.state AS activation_state
      FROM coordination_requests request
      LEFT JOIN agent_activations activation
        ON activation.id = (
          SELECT source.activation_id
          FROM activation_sources source
          JOIN agent_activations candidate ON candidate.id = source.activation_id
          WHERE source.source_kind = 'request' AND source.source_id = request.id
            AND candidate.kind = 'coordination_request'
            AND candidate.agent_id = request.recipient_agent_id
          LIMIT 1
        )
      WHERE request.id = ?
      LIMIT 1
    `).get(requestId) as {
      request_state: CoordinationRequestState;
      recipient_agent_id: string;
      activation_state: string | null;
    } | undefined;
    if (!row) return undefined;
    let deliveryState: CoordinationRequestDeliveryView["deliveryState"];
    if (TERMINAL_REQUEST_STATES.has(row.request_state)) {
      deliveryState = "request_terminal";
    } else if (row.activation_state === "attached") {
      deliveryState = "attached_to_run";
    } else if (row.activation_state === "consumed") {
      deliveryState = "delivered_to_run";
    } else if (row.activation_state === "failed") {
      deliveryState = "delivery_failed";
    } else if (row.activation_state === "outcome_unknown") {
      deliveryState = "delivery_uncertain";
    } else if (row.activation_state === "cancelled") {
      deliveryState = "delivery_cancelled";
    } else {
      const recipientBusy = Boolean(this.sqlite.prepare(`
        SELECT 1 FROM scheduler_runs
        WHERE agent_id = ? AND status IN ('leased', 'running')
        LIMIT 1
      `).get(row.recipient_agent_id));
      deliveryState = recipientBusy ? "queued_behind_active_run" : "queued_for_next_run";
    }
    return {
      requestId,
      recipientAgentId: row.recipient_agent_id,
      requestState: row.request_state,
      deliveryState,
      interruptsActiveRun: false,
    };
  }

  requestIsOperatorRecovery(requestId: string): boolean {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM coordination_requests current
      JOIN coordination_idempotency receipt ON receipt.project_id = current.project_id
        AND receipt.actor_scope = 'user:local-operator' AND receipt.operation = 'coordinate'
      WHERE current.id = ? AND current.origin_run_id IS NULL AND EXISTS (SELECT 1 FROM coordination_requests predecessor WHERE predecessor.superseded_by_request_id = current.id)
        AND EXISTS (SELECT 1 FROM json_each(receipt.result_json, '$.requestIds') WHERE value = current.id)
      LIMIT 1
    `).get(requestId));
  }

  getJoin(id: string): { projectId: string; conversationId?: string; ownerAgentId: string; state: string } | undefined {
    const row = this.sqlite.prepare(`
      SELECT project_id, conversation_id, owner_agent_id, state FROM coordination_joins WHERE id = ?
    `).get(id) as { project_id: string; conversation_id: string | null; owner_agent_id: string; state: string } | undefined;
    return row ? { projectId: row.project_id, ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      ownerAgentId: row.owner_agent_id, state: row.state } : undefined;
  }

  requestRetryStatus(requestId: string): {
    successorRequestId?: string;
    successorState?: CoordinationRequestState;
    recoveryState?: CoordinationRequestState;
  } {
    const row = this.sqlite.prepare(`
      SELECT id, state FROM coordination_requests
      WHERE id = (
        SELECT superseded_by_request_id FROM coordination_requests
        WHERE id = ?
      )
      ORDER BY created_at DESC, id DESC
    `).get(requestId) as { id: string; state: CoordinationRequestState } | undefined;
    const latest = row ? this.sqlite.prepare(`
      WITH RECURSIVE lineage(id) AS (
        SELECT ? UNION SELECT r.superseded_by_request_id FROM coordination_requests r JOIN lineage ON r.id = lineage.id WHERE r.superseded_by_request_id IS NOT NULL
      ) SELECT r.state FROM coordination_requests r JOIN lineage ON lineage.id = r.id
      WHERE r.superseded_by_request_id IS NULL LIMIT 1
    `).get(row.id) as {state:CoordinationRequestState}|undefined : undefined;

    return row ? { successorRequestId: row.id, successorState: row.state, ...(latest ? { recoveryState: latest.state } : {}) } : {};
  }

}
