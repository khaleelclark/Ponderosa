import type Database from "better-sqlite3";
import type {
  CoordinationRequestUpdateKind,
} from "@ponderosa/core";
import type { CoordinationV3RuntimeScopeAuthority } from "./coordination-v3-runtime-scope-authority.js";
import type {
  ActivationTerminalOutcome,
  UpdateRequestV3Input,
} from "./coordination-v3-types.js";
import { publicActivationDeliveryError } from "./coordination-v3-provider-failure-projection.js";

/** Settles Activations that can no longer execute and their dependent work. */
export class CoordinationV3ActivationLifecycleAuthority {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly runtimeScopeAuthority: CoordinationV3RuntimeScopeAuthority,
    private readonly updateRequest: (input: UpdateRequestV3Input) => unknown,
    private readonly settleQuestionsForFailedActivations: (
      activationIds: string[],
      now: string,
    ) => void,
  ) {}

  settleUnauthorizedPendingActivations(now: string): number {
    const pending = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, scope_key
      FROM agent_activations
      WHERE state IN ('pending', 'retry_pending')
      ORDER BY rowid
    `).all() as Array<{
      id: string;
      project_id: string;
      agent_id: string;
      scope_key: string;
    }>;
    const fail = this.sqlite.prepare(`
      UPDATE agent_activations
      SET state = 'failed', terminal_outcome = 'recipient_unavailable',
        terminal_at = COALESCE(terminal_at, ?), last_delivery_error = ?,
        updated_at = ?
      WHERE id = ? AND state IN ('pending', 'retry_pending')
    `);
    let settled = 0;
    for (const activation of pending) {
      if (this.runtimeScopeAuthority.recipientAuthorizedForActivationScope(
        activation.project_id,
        activation.agent_id,
        activation.scope_key,
      )) {
        continue;
      }
      const changed = fail.run(
        now,
        "activation recipient is no longer authorized for its scope",
        now,
        activation.id,
      ).changes;
      settled += changed;
      if (changed === 1) {
        this.settleRequestsForFailedActivations([activation.id], now);
      }
    }
    return settled;
  }

  settleRequestsForFailedActivations(
    activationIds: string[],
    now: string,
  ): void {
    if (activationIds.length === 0) return;
    const placeholders = activationIds.map(() => "?").join(", ");
    const requests = this.sqlite.prepare(`
      SELECT DISTINCT request.id, activation.id AS activation_id,
        activation.terminal_outcome, activation.last_delivery_error,
        activation.provider_failure_category
      FROM agent_activations activation
      JOIN activation_sources source
        ON source.activation_id = activation.id
        AND source.source_kind = 'request'
      JOIN coordination_requests request ON request.id = source.source_id
      WHERE activation.id IN (${placeholders})
        AND activation.state = 'failed'
        AND activation.terminal_outcome IS NOT NULL
        AND activation.agent_id = request.recipient_agent_id
        AND request.state IN (
          'open', 'in_progress', 'waiting_dependency', 'awaiting_answer'
        )
      ORDER BY request.created_at, request.id
    `).all(...activationIds) as Array<{
      id: string;
      activation_id: string;
      terminal_outcome: ActivationTerminalOutcome;
      last_delivery_error: string | null;
      provider_failure_category: string | null;
    }>;
    for (const request of requests) {
      const kind: CoordinationRequestUpdateKind =
        request.terminal_outcome === "recipient_unavailable"
          ? "recipient_unavailable"
          : "failed";
      this.updateRequest({
        requestId: request.id,
        updateId:
          `system:activation-terminal:${request.activation_id}:` +
          request.terminal_outcome,
        kind,
        actor: request.terminal_outcome === "recipient_unavailable"
          ? { kind: "system", id: "v3-activation-supervisor" }
          : { kind: "supervisor", id: "v3-activation-supervisor" },
        payload: {
          activationId: request.activation_id,
          activationOutcome: request.terminal_outcome,
          reason: publicActivationDeliveryError({
            lastDeliveryError: request.last_delivery_error,
            providerFailureCategory: request.provider_failure_category,
          }) ?? "activation could not execute",
        },
        now,
      });
    }
    this.settleQuestionsForFailedActivations(activationIds, now);
  }
}
