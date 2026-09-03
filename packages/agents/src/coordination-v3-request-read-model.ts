import type Database from "better-sqlite3";
import { TERMINAL_REQUEST_STATES } from "@ponderosa/core";
import type { CoordinationRequestState, RequestLifetime } from "@ponderosa/core";
import type {
  CoordinationRequestDeliveryView,
  CoordinationRequestV3View,
} from "./coordination-v3-types.js";

interface RequestRow {
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
  superseded_by_request_id: string | null;
  created_at: string;
  updated_at: string;
}
export class CoordinationV3RequestReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  requestForUpdate(updateId: string): CoordinationRequestV3View | undefined {
    const row = this.sqlite.prepare(`
      SELECT request_id FROM coordination_request_updates WHERE id = ?
      UNION ALL SELECT request_id FROM coordination_request_late_results WHERE id = ?
      LIMIT 1
    `).get(updateId, updateId) as { request_id: string } | undefined;
    return row ? this.getRequest(row.request_id) : undefined;
  }

  getRequest(requestId: string): CoordinationRequestV3View | undefined {
    const row = this.sqlite.prepare(`SELECT * FROM coordination_requests WHERE id = ?`).get(requestId) as (RequestRow & { payload_json: string }) | undefined;
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

  requestRetryStatus(requestId: string): {
    successorRequestId?: string;
    successorState?: CoordinationRequestState;
  } {
    const row = this.sqlite.prepare(`
      SELECT id, state FROM coordination_requests
      WHERE id = (
        SELECT superseded_by_request_id FROM coordination_requests
        WHERE id = ?
      )
      ORDER BY created_at DESC, id DESC
    `).get(requestId) as { id: string; state: CoordinationRequestState } | undefined;
    return row ? { successorRequestId: row.id, successorState: row.state } : {};
  }

}
