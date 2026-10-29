import type Database from "better-sqlite3";
import { REQUEST_SOURCE_LINEAGE_CTE } from "./coordination-v3-request-lineage.js";

export class CoordinationV3RunContextReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  scopeKey(runId: string, agentId: string): string {
    const row = this.sqlite.prepare(`
      SELECT scope_key FROM scheduler_runs WHERE id = ? AND agent_id = ?
    `).get(runId, agentId) as { scope_key: string } | undefined;
    if (!row) throw new Error("run not found");
    return row.scope_key;
  }

  requestIdsAttachedToRun(runId: string, agentId: string): string[] {
    const rows = this.sqlite.prepare(`
      ${REQUEST_SOURCE_LINEAGE_CTE}
      SELECT DISTINCT request.id, request.created_at
      FROM scheduler_runs run
      JOIN scheduler_run_activations attached ON attached.run_id = run.id
      JOIN request_source_lineage lineage
        ON lineage.activation_id = attached.activation_id
      JOIN coordination_requests request ON request.id = lineage.request_id
      WHERE run.id = ? AND run.agent_id = ? AND request.project_id = run.project_id
        AND (
          lineage.source_kind IN ('request', 'request_update')
          OR (
            lineage.source_kind = 'join'
            AND (
              request.recipient_agent_id = run.agent_id
              OR (request.requester_agent_id = run.agent_id
                AND request.state = 'awaiting_answer')
            )
          )
        )
      ORDER BY request.created_at, request.id
    `).all(runId, agentId) as Array<{ id: string; created_at: string }>;
    return rows.map((row) => row.id);
  }

  outboundAwaitingQuestionRequestIdsAttachedToRun(
    runId: string,
    agentId: string,
  ): string[] {
    const attached = this.requestIdsAttachedToRun(runId, agentId);
    if (attached.length === 0) return [];
    const placeholders = attached.map(() => "?").join(", ");
    return (this.sqlite.prepare(`
      SELECT id
      FROM coordination_requests
      WHERE id IN (${placeholders})
        AND requester_agent_id = ?
        AND state = 'awaiting_answer'
        AND open_question_update_id IS NOT NULL
      ORDER BY created_at, id
    `).all(...attached, agentId) as Array<{ id: string }>).map((row) => row.id);
  }

  requesterIdsForRun(runId: string, agentId: string): string[] {
    const requestIds = this.requestIdsAttachedToRun(runId, agentId);
    if (requestIds.length === 0) return [];
    const placeholders = requestIds.map(() => "?").join(", ");
    return (this.sqlite.prepare(`
      SELECT DISTINCT requester_agent_id
      FROM coordination_requests
      WHERE id IN (${placeholders}) AND recipient_agent_id = ?
        AND requester_agent_id IS NOT NULL
      ORDER BY requester_agent_id
    `).all(...requestIds, agentId) as Array<{ requester_agent_id: string }>)
      .map((row) => row.requester_agent_id);
  }

  runStartsNewRecipientRequest(runId: string, agentId: string): boolean {
    const row = this.sqlite.prepare(`
      SELECT 1 AS matched
      FROM scheduler_runs run
      JOIN scheduler_run_activations attached ON attached.run_id = run.id
      JOIN activation_sources source ON source.activation_id = attached.activation_id
      JOIN agent_activations activation ON activation.id = attached.activation_id
      JOIN coordination_requests request
        ON source.source_kind = 'request' AND request.id = source.source_id
      WHERE run.id = ? AND run.agent_id = ? AND request.project_id = run.project_id
        AND request.recipient_agent_id = ? AND activation.kind = 'coordination_request'
      LIMIT 1
    `).get(runId, agentId, agentId) as { matched: number } | undefined;
    return Boolean(row);
  }

  runChangesScope(runId: string, agentId: string): boolean {
    const currentScopeKey = this.scopeKey(runId, agentId);
    const previous = this.sqlite.prepare(`
      SELECT scope_key FROM scheduler_runs
      WHERE agent_id = ? AND id <> ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(agentId, runId) as { scope_key: string } | undefined;
    return Boolean(previous && previous.scope_key !== currentScopeKey);
  }
}
