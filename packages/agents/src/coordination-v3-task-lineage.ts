import { TERMINAL_REQUEST_STATES } from "@ponderosa/core";
import type Database from "better-sqlite3";
import { requestSourceLineageBody } from "./coordination-v3-request-lineage.js";

/** Structural delegation origins, not the callback's incidental reply route.
 * The same-Agent/Project/Chat Run is the authority; payload text is never used. */
function delegationOriginsCte(candidateWhere: string, pending = false): string {
  return `WITH task_wake_candidates AS MATERIALIZED (
      SELECT rowid AS selection_rowid, id, project_id, agent_id, scope_key, kind, priority, created_at FROM agent_activations
      ${pending ? "INDEXED BY agent_activations_agent_scope_runnable" : ""} WHERE ${candidateWhere}
    ), task_wake_sources AS MATERIALIZED (
      SELECT canonical_source.* FROM task_wake_candidates candidate
      CROSS JOIN activation_sources canonical_source WHERE canonical_source.activation_id=candidate.id
    ), ${requestSourceLineageBody("task_wake_sources")},
    delegation_origins(activation_id, origin_run_id) AS (
    SELECT DISTINCT activation.id, origin.id
    FROM task_wake_candidates activation
    JOIN request_source_lineage lineage ON lineage.activation_id = activation.id
    JOIN coordination_requests request ON request.id = lineage.request_id
    JOIN scheduler_runs origin ON origin.id = request.origin_run_id
    WHERE request.requester_agent_id = activation.agent_id
      AND origin.agent_id = activation.agent_id AND origin.project_id = activation.project_id
      AND origin.scope_key = activation.scope_key
    UNION
    SELECT activation.id, origin.run_id FROM task_wake_candidates activation
    CROSS JOIN required_reply_obligations origin
    WHERE origin.recovery_activation_id = activation.id
      AND activation.kind = 'required_reply_recovery' AND origin.agent_id = activation.agent_id
      AND origin.project_id = activation.project_id AND origin.scope_key = activation.scope_key
    UNION
    SELECT DISTINCT activation.id, origin.id
    FROM task_wake_candidates activation
    JOIN task_wake_sources source ON source.activation_id = activation.id AND source.source_kind = 'join'
    JOIN coordination_joins dependency ON dependency.id = source.source_id
    JOIN scheduler_runs origin ON origin.id = dependency.origin_run_id
    WHERE dependency.owner_agent_id = activation.agent_id
      AND origin.agent_id = activation.agent_id AND origin.project_id = activation.project_id
      AND origin.scope_key = activation.scope_key
    UNION
    SELECT activation.id, origin.run_id FROM required_reply_obligations origin
    JOIN task_wake_sources source ON source.source_kind = 'task_decision'
      AND source.source_id = origin.blocking_decision_id
    JOIN task_wake_candidates activation ON activation.id = source.activation_id
    WHERE origin.agent_id = activation.agent_id
      AND origin.project_id = activation.project_id AND origin.scope_key = activation.scope_key
    )`;
}

export function delegationOriginsForActivation(sqlite: Database.Database, activationId: string): string[] {
  return (sqlite.prepare(`${delegationOriginsCte("id=?")}
    SELECT DISTINCT origin_run_id AS id FROM delegation_origins`)
    .all(activationId) as Array<{ id: string }>).map(row => row.id);
}

/** Bound after structural lineage filtering, never after unrelated inbox rows. */
export function pendingTaskWakeIds(sqlite: Database.Database, input: {
  projectId: string; agentId: string; scopeKey: string; originRunIds: string[];
}): string[] {
  if (!input.originRunIds.length) return [];
  return (sqlite.prepare(`${delegationOriginsCte(`project_id=? AND agent_id=? AND scope_key=?
      AND state IN ('pending','retry_pending')
      AND (kind LIKE 'coordination_%' OR kind='required_reply_recovery' OR kind='human_message')`, true)}
    SELECT DISTINCT wake.id FROM task_wake_candidates wake
    JOIN delegation_origins origin ON origin.activation_id=wake.id
    WHERE origin.origin_run_id IN (SELECT value FROM json_each(?))
    ORDER BY wake.priority DESC, wake.created_at, wake.selection_rowid LIMIT 64`)
    .all(input.projectId, input.agentId, input.scopeKey, JSON.stringify(input.originRunIds)) as Array<{ id: string }>).map(row => row.id);
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
            AND request.state NOT IN (SELECT value FROM json_each(?)))
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
  `).get(input.sourceActivationId, input.projectId, input.agentId, input.scopeKey,
    JSON.stringify([...TERMINAL_REQUEST_STATES]), input.runId));
}
