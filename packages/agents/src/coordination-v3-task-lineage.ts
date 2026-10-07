import type Database from "better-sqlite3";
import { REQUEST_SOURCE_LINEAGE_CTE } from "./coordination-v3-request-lineage.js";

/** Structural delegation origins, not the callback's incidental reply route.
 * The same-Agent/Project/Chat Run is the authority; payload text is never used. */
export function delegationOriginsForActivation(sqlite: Database.Database, activationId: string): string[] {
  return (sqlite.prepare(`
    ${REQUEST_SOURCE_LINEAGE_CTE}
    SELECT DISTINCT origin.id
    FROM agent_activations activation
    JOIN request_source_lineage lineage ON lineage.activation_id = activation.id
    JOIN coordination_requests request ON request.id = lineage.request_id
    JOIN scheduler_runs origin ON origin.id = request.origin_run_id
    WHERE activation.id = ? AND request.requester_agent_id = activation.agent_id
      AND origin.agent_id = activation.agent_id AND origin.project_id = activation.project_id
      AND origin.scope_key = activation.scope_key
    UNION
    SELECT origin.run_id AS id FROM required_reply_obligations origin
    JOIN agent_activations activation ON activation.id = origin.recovery_activation_id
    WHERE activation.id = ? AND origin.agent_id = activation.agent_id
      AND origin.project_id = activation.project_id AND origin.scope_key = activation.scope_key
    UNION
    SELECT DISTINCT origin.id
    FROM agent_activations activation
    JOIN activation_sources source ON source.activation_id = activation.id AND source.source_kind = 'join'
    JOIN coordination_joins dependency ON dependency.id = source.source_id
    JOIN scheduler_runs origin ON origin.id = dependency.origin_run_id
    WHERE activation.id = ? AND dependency.owner_agent_id = activation.agent_id
      AND origin.agent_id = activation.agent_id AND origin.project_id = activation.project_id
      AND origin.scope_key = activation.scope_key
    UNION
    SELECT origin.run_id AS id FROM required_reply_obligations origin
    JOIN activation_sources source ON source.source_kind = 'task_decision'
      AND source.source_id = origin.blocking_decision_id
    JOIN agent_activations activation ON activation.id = source.activation_id
    WHERE activation.id = ? AND origin.agent_id = activation.agent_id
      AND origin.project_id = activation.project_id AND origin.scope_key = activation.scope_key
  `).all(activationId, activationId, activationId, activationId) as Array<{ id: string }>).map(row => row.id);
}

/** All Runs carrying the same durable task roots, with exact ownership/scope. */
export function taskOriginRunIds(sqlite: Database.Database, runId: string): string[] {
  return (sqlite.prepare(`SELECT id FROM scheduler_runs WHERE id = ?
    UNION SELECT origin.run_id FROM required_reply_obligations current
    JOIN required_reply_obligations origin ON origin.source_activation_id = current.source_activation_id
      AND origin.agent_id = current.agent_id AND origin.project_id = current.project_id
      AND origin.scope_key = current.scope_key
    WHERE current.run_id = ? AND current.delivery_phase = 'final'`)
    .all(runId, runId) as Array<{ id: string }>).map(r => r.id);
}

export function runOwnsAwaitedDelegation(sqlite: Database.Database, runId: string): boolean {
  return Boolean(sqlite.prepare(`SELECT 1 FROM coordination_joins WHERE origin_run_id = ?
    UNION ALL SELECT 1 FROM coordination_requests WHERE origin_run_id = ?
      AND COALESCE(json_extract(payload_json, '$.completionMode'), '') <> 'record' LIMIT 1`)
    .get(runId, runId));
}

/** Replies remain interim while any delegation for this exact authored root
 * is outstanding. Roots survive transfer across Runs without widening scope. */
export function hasOutstandingDelegation(sqlite: Database.Database, input: {
  sourceActivationId: string; projectId: string; agentId: string; scopeKey: string; runId: string;
}): boolean {
  return Boolean(sqlite.prepare(`
    SELECT 1 FROM required_reply_obligations origin
    WHERE origin.source_activation_id = ? AND origin.project_id = ?
      AND origin.agent_id = ? AND origin.scope_key = ? AND (
        EXISTS (SELECT 1 FROM coordination_requests request
          WHERE request.origin_run_id = origin.run_id AND request.requester_agent_id = origin.agent_id
            AND request.project_id = origin.project_id
            AND COALESCE(json_extract(request.payload_json, '$.completionMode'), '') <> 'record'
            AND request.state NOT IN ('completed','failed','cancelled','superseded','expired','outcome_unknown'))
        OR EXISTS (SELECT 1 FROM coordination_joins dependency
          WHERE dependency.origin_run_id = origin.run_id AND dependency.owner_agent_id = origin.agent_id
            AND dependency.project_id = origin.project_id AND dependency.state = 'open')
        OR EXISTS (SELECT 1 FROM agent_activations wake
          JOIN activation_sources source ON source.activation_id = wake.id
          WHERE wake.agent_id = origin.agent_id AND wake.project_id = origin.project_id
            AND wake.scope_key = origin.scope_key AND wake.state IN ('pending','retry_pending','attached')
            AND NOT EXISTS (SELECT 1 FROM scheduler_run_activations attached
              WHERE attached.activation_id = wake.id AND attached.run_id = ?)
            AND ((source.source_kind = 'join' AND EXISTS (SELECT 1 FROM coordination_joins dependency
              WHERE dependency.id = source.source_id AND dependency.origin_run_id = origin.run_id))
              OR (source.source_kind IN ('request','request_update') AND EXISTS (
                SELECT 1 FROM coordination_requests request WHERE request.origin_run_id = origin.run_id
                  AND request.requester_agent_id = origin.agent_id
                  AND (request.id = source.source_id OR EXISTS (SELECT 1 FROM coordination_request_updates update_record
                    WHERE update_record.id = source.source_id AND update_record.request_id = request.id)))))
        )
      ) LIMIT 1
  `).get(input.sourceActivationId, input.projectId, input.agentId, input.scopeKey, input.runId));
}
