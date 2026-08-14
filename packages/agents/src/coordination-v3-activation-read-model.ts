import type Database from "better-sqlite3";
import { publicProviderFailureSummary } from "@ponderosa/core";
import type {
  ActivationDispatchPolicy,
  ActivationPromptClass,
  ActivationTerminalOutcome,
  CommunicationAttentionActivationCursor,
  CommunicationAttentionActivationV3View,
  PendingActivationV3View,
  TerminalActivationV3View,
} from "./coordination-v3-types.js";
import { publicActivationDeliveryError } from "./coordination-v3-provider-failure-projection.js";

export class CoordinationV3ActivationReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  private publicPayload(activationId: string, payloadJson: string): unknown {
    const providerFailure = this.sqlite.prepare(`
      SELECT request_update.provider_failure_category AS category
      FROM json_tree(CASE WHEN json_valid(?) THEN ? ELSE '{}' END) payload_node
      JOIN coordination_request_updates request_update
        ON payload_node.key = 'updateId' AND payload_node.value = request_update.id
      WHERE request_update.provider_failure_category IS NOT NULL
      LIMIT 1
    `).get(payloadJson, payloadJson) as { category: string } | undefined;
    if (providerFailure) {
      return {
        providerFailure: publicProviderFailureSummary(
          undefined,
          providerFailure.category,
        ) ?? "Provider execution failed.",
      };
    }
    try {
      return JSON.parse(payloadJson) as unknown;
    } catch {
      return { activationId, detail: "Activation payload is unavailable." };
    }
  }

  activation(
    activationId: string,
    projectId: string,
  ): {
    id: string;
    projectId: string;
    agentId: string;
    dispatchPolicy: ActivationDispatchPolicy;
    state: string;
    payload: unknown;
  } | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, dispatch_policy, state, payload_json
      FROM agent_activations
      WHERE id = ? AND project_id = ?
    `).get(activationId, projectId) as {
      id: string;
      project_id: string;
      agent_id: string;
      dispatch_policy: ActivationDispatchPolicy;
      state: string;
      payload_json: string;
    } | undefined;
    return row
      ? {
          id: row.id,
          projectId: row.project_id,
          agentId: row.agent_id,
          dispatchPolicy: row.dispatch_policy,
          state: row.state,
          payload: this.publicPayload(row.id, row.payload_json),
        }
      : undefined;
  }

  pendingActivations(projectId?: string): PendingActivationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, kind, dispatch_policy, state,
        payload_json, created_at
      FROM agent_activations
      WHERE state IN ('pending', 'retry_pending') AND (? IS NULL OR project_id = ?)
      ORDER BY priority DESC, created_at, id
    `).all(projectId ?? null, projectId ?? null) as Array<{
      id: string;
      project_id: string;
      agent_id: string;
      kind: string;
      dispatch_policy: PendingActivationV3View["dispatchPolicy"];
      state: "pending" | "retry_pending";
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      kind: row.kind,
      dispatchPolicy: row.dispatch_policy,
      state: row.state,
      payload: this.publicPayload(row.id, row.payload_json),
      createdAt: row.created_at,
    }));
  }

  terminalActivationDisposition(activationId: string): {
    id: string;
    state: TerminalActivationV3View["state"];
    supersededByRetry: boolean;
  } | undefined {
    const row = this.sqlite.prepare(`
      SELECT id, state,
        EXISTS (
          SELECT 1 FROM activation_delivery_retry_lineage retry
          WHERE retry.predecessor_activation_id = agent_activations.id
        ) AS superseded_by_retry
      FROM agent_activations
      WHERE id = ? AND (
        terminal_outcome IS NOT NULL
        OR state IN ('failed', 'outcome_unknown', 'cancelled')
      )
    `).get(activationId) as {
      id: string;
      state: TerminalActivationV3View["state"];
      superseded_by_retry: number;
    } | undefined;
    return row
      ? {
          id: row.id,
          state: row.state,
          supersededByRetry: Boolean(row.superseded_by_retry),
        }
      : undefined;
  }

  communicationAttentionActivations(
    projectId?: string,
    limit = 100,
    cursor?: CommunicationAttentionActivationCursor,
  ): CommunicationAttentionActivationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT activation.id, activation.project_id, activation.agent_id,
        activation.kind, activation.state, activation.scope_key,
        activation.delivery_failures, activation.last_delivery_error,
        activation.provider_failure_category,
        EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
          WHERE attached.activation_id = activation.id
            AND scheduler.provider_failure_json IS NOT NULL
        ) AS has_provider_failure,
        activation.terminal_outcome, activation.updated_at,
        COALESCE(json_extract(runtime.payload_json, '$.communication.eventId'), runtime.id)
          AS communication_event_id,
        runtime.intent AS communication_intent,
        EXISTS (
          SELECT 1 FROM activation_delivery_retry_lineage retry
          WHERE retry.predecessor_activation_id = activation.id
        ) AS superseded_by_retry
      FROM agent_activations activation
      JOIN activation_sources source
        ON source.activation_id = activation.id AND source.source_kind = 'communication'
      JOIN runtime_communications runtime ON runtime.id = source.source_id
      WHERE activation.state IN ('failed', 'outcome_unknown')
        AND (? IS NULL OR activation.project_id = ?)
        AND activation.kind IN ('human_message', 'urgent_message', 'ordinary_message')
        AND runtime.intent <> 'collaboration'
        AND (
          ? IS NULL
          OR activation.updated_at < ?
          OR (activation.updated_at = ? AND activation.id < ?)
        )
      ORDER BY activation.updated_at DESC, activation.id DESC LIMIT ?
    `).all(
      projectId ?? null,
      projectId ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      Math.max(1, Math.min(limit, 500)),
    ) as Array<{
      id: string;
      project_id: string;
      agent_id: string;
      kind: string;
      state: CommunicationAttentionActivationV3View["state"];
      scope_key: string | null;
      delivery_failures: number;
      last_delivery_error: string | null;
      provider_failure_category: string | null;
      has_provider_failure: number;
      updated_at: string;
      communication_event_id: string;
      communication_intent: string;
      superseded_by_retry: number;
      terminal_outcome: ActivationTerminalOutcome | null;
    }>;
    return rows.map((row) => {
      const lastDeliveryError = publicActivationDeliveryError({
        lastDeliveryError: row.last_delivery_error,
        providerFailureCategory: row.provider_failure_category,
        hasProviderFailure: Boolean(row.has_provider_failure),
      });
      return {
        id: row.id,
        projectId: row.project_id,
        agentId: row.agent_id,
        kind: row.kind,
        state: row.state,
        ...(row.scope_key ? { scopeKey: row.scope_key } : {}),
        communicationEventId: row.communication_event_id,
        communicationIntent: row.communication_intent,
        ...(row.superseded_by_retry ? { supersededByRetry: true } : {}),
        ...(row.terminal_outcome
          ? { terminalOutcome: row.terminal_outcome }
          : {}),
        deliveryFailures: row.delivery_failures,
        ...(lastDeliveryError ? { lastDeliveryError } : {}),
        updatedAt: row.updated_at,
      };
    });
  }

  terminalActivations(projectId?: string, limit = 100): TerminalActivationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, kind, state, scope_key, terminal_outcome, delivery_failures,
        (SELECT COALESCE(json_extract(runtime.payload_json, '$.communication.eventId'), runtime.id)
          FROM activation_sources source
          JOIN runtime_communications runtime ON runtime.id = source.source_id
          WHERE source.activation_id = agent_activations.id AND source.source_kind = 'communication'
          ORDER BY runtime.created_at, runtime.id LIMIT 1) AS communication_event_id,
        (SELECT runtime.intent FROM activation_sources source
          JOIN runtime_communications runtime ON runtime.id = source.source_id
          WHERE source.activation_id = agent_activations.id AND source.source_kind = 'communication'
          ORDER BY runtime.created_at, runtime.id LIMIT 1) AS communication_intent,
        EXISTS (
          SELECT 1 FROM activation_delivery_retry_lineage retry
          WHERE retry.predecessor_activation_id = agent_activations.id
        ) AS superseded_by_retry,
        last_delivery_error, provider_failure_category,
        EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          JOIN scheduler_runs scheduler ON scheduler.id = attached.run_id
          WHERE attached.activation_id = agent_activations.id
            AND scheduler.provider_failure_json IS NOT NULL
        ) AS has_provider_failure,
        terminal_at
      FROM agent_activations
      WHERE terminal_outcome IS NOT NULL AND (? IS NULL OR project_id = ?)
      ORDER BY terminal_at DESC, id DESC LIMIT ?
    `).all(
      projectId ?? null,
      projectId ?? null,
      Math.max(1, Math.min(limit, 500)),
    ) as Array<{
      id: string;
      project_id: string;
      agent_id: string;
      kind: string;
      state: TerminalActivationV3View["state"];
      scope_key: string | null;
      communication_event_id: string | null;
      communication_intent: string | null;
      superseded_by_retry: number;
      terminal_outcome: ActivationTerminalOutcome;
      delivery_failures: number;
      last_delivery_error: string | null;
      provider_failure_category: string | null;
      has_provider_failure: number;
      terminal_at: string;
    }>;
    return rows.map((row) => {
      const lastDeliveryError = publicActivationDeliveryError({
        lastDeliveryError: row.last_delivery_error,
        providerFailureCategory: row.provider_failure_category,
        hasProviderFailure: Boolean(row.has_provider_failure),
      });
      return {
        id: row.id,
        projectId: row.project_id,
        agentId: row.agent_id,
        kind: row.kind,
        state: row.state,
        ...(row.scope_key ? { scopeKey: row.scope_key } : {}),
        ...(row.communication_event_id
          ? { communicationEventId: row.communication_event_id }
          : {}),
        ...(row.communication_intent
          ? { communicationIntent: row.communication_intent }
          : {}),
        ...(row.superseded_by_retry ? { supersededByRetry: true } : {}),
        outcome: row.terminal_outcome,
        deliveryFailures: row.delivery_failures,
        ...(lastDeliveryError ? { lastDeliveryError } : {}),
        terminalAt: row.terminal_at,
      };
    });
  }

  activationPayloads(
    agentId: string,
    activationIds: string[],
    runId?: string,
  ): Array<{ id: string; kind: string; promptClass: ActivationPromptClass; payload: unknown }> {
    if (activationIds.length === 0) return [];
    const placeholders = activationIds.map(() => "?").join(", ");
    const rows = this.sqlite.prepare(`
      SELECT id, kind, prompt_class, payload_json FROM agent_activations
      WHERE agent_id = ? AND id IN (${placeholders})
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM scheduler_run_activations attached
          WHERE attached.activation_id = agent_activations.id AND attached.run_id = ?
        ))
    `).all(agentId, ...activationIds, runId ?? null, runId ?? null) as Array<{
      id: string;
      kind: string;
      prompt_class: ActivationPromptClass;
      payload_json: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    return activationIds.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [{
          id,
          kind: row.kind,
          promptClass: row.prompt_class,
          payload: this.publicPayload(row.id, row.payload_json),
        }]
        : [];
    });
  }

  activationIdsAttachedToRun(runId: string, agentId: string): string[] {
    return (this.sqlite.prepare(`
      SELECT attached.activation_id AS id
      FROM scheduler_run_activations attached
      JOIN scheduler_runs run ON run.id = attached.run_id
      JOIN agent_activations activation ON activation.id = attached.activation_id
      WHERE attached.run_id = ? AND run.agent_id = ? AND activation.agent_id = ?
      ORDER BY attached.attached_at, attached.activation_id
    `).all(runId, agentId, agentId) as Array<{ id: string }>).map((row) => row.id);
  }
}
