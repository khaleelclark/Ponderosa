import type Database from "better-sqlite3";
import type {
  ActivationPromptClass,
  ActivationTerminalOutcome,
  PendingActivationV3View,
  TerminalActivationV3View,
} from "./coordination-v3-types.js";

export class CoordinationV3ActivationReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  pendingActivations(projectId?: string): PendingActivationV3View[] {
    const rows = this.sqlite.prepare(`
      SELECT id, project_id, agent_id, kind, state, payload_json, created_at
      FROM agent_activations
      WHERE state IN ('pending', 'retry_pending') AND (? IS NULL OR project_id = ?)
      ORDER BY priority DESC, created_at, id
    `).all(projectId ?? null, projectId ?? null) as Array<{
      id: string;
      project_id: string;
      agent_id: string;
      kind: string;
      state: "pending" | "retry_pending";
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      kind: row.kind,
      state: row.state,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
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
        last_delivery_error, terminal_at
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
      terminal_outcome: ActivationTerminalOutcome;
      delivery_failures: number;
      last_delivery_error: string | null;
      terminal_at: string;
    }>;
    return rows.map((row) => ({
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
      outcome: row.terminal_outcome,
      deliveryFailures: row.delivery_failures,
      ...(row.last_delivery_error ? { lastDeliveryError: row.last_delivery_error } : {}),
      terminalAt: row.terminal_at,
    }));
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
          payload: JSON.parse(row.payload_json) as unknown,
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
