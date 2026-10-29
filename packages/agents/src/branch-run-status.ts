import type Database from 'better-sqlite3';
import type {BranchRunCountsDto} from '@ponderosa/core';
import {requestSourceLineageBody} from './coordination-v3-request-lineage.js';

/** Bound the shared source map by live scheduler authority before mapping
 * direct, answered and joined Requests; never materialize retained history. */
export const BRANCH_LIVE_REQUEST_LINEAGE_CTE=`WITH branch_live_sources AS MATERIALIZED (
  SELECT source.activation_id,source.source_kind,source.source_id FROM scheduler_runs live
  CROSS JOIN scheduler_run_activations attached ON attached.run_id=live.id
  CROSS JOIN activation_sources source ON source.activation_id=attached.activation_id
  WHERE live.status IN ('leased','running') AND live.started_at IS NOT NULL
    AND live.terminal_at IS NULL AND live.side_effects_fenced_at IS NULL AND live.lease_expires_at>:now
),${requestSourceLineageBody('branch_live_sources')}`;

/** Canonical Request attachment, including answer/Join continuations. The
 * alias is restricted to the two existing projection callers. */
export function branchStartedRequestRunSql(requestAlias:'request'|'r'):string {
  return `EXISTS(
    SELECT 1 FROM request_source_lineage source
    CROSS JOIN scheduler_run_activations attached ON attached.activation_id=source.activation_id
    CROSS JOIN scheduler_runs scheduler ON scheduler.id=attached.run_id AND scheduler.agent_id=${requestAlias}.recipient_agent_id AND scheduler.project_id=${requestAlias}.project_id
      AND scheduler.scope_key=CASE WHEN ${requestAlias}.conversation_id IS NOT NULL THEN 'conversation:'||${requestAlias}.conversation_id ELSE 'agent:'||${requestAlias}.recipient_agent_id END
    WHERE source.request_id=${requestAlias}.id AND ${requestAlias}.state IN ('open','in_progress') AND ${requestAlias}.terminal_at IS NULL
      AND scheduler.status='running' AND scheduler.started_at IS NOT NULL
      AND scheduler.terminal_at IS NULL AND scheduler.side_effects_fenced_at IS NULL
      AND scheduler.lease_expires_at>:now
  )`;
}

/** An unrelated Agent Run, a queued lease, or authored progress is not proof
 * that this workflow's current Step has started. */
const workingSteps = `
  current_branch_attempts AS (
    SELECT run.id execution_id,step.id step_id,attempt.id attempt_id,
      attempt.state,attempt.lease_owner,attempt.lease_until,
      attempt.process_identity_json IS NOT NULL process_authorized,attempt.request_id
    FROM active_branch_runs run
    JOIN branch_step_executions step ON step.execution_id=run.id
    JOIN branch_paths path ON path.id=step.path_id AND path.execution_id=run.id AND path.step_execution_id=step.id
    JOIN branch_attempts attempt ON attempt.step_execution_id=step.id
    WHERE run.cancel_requested=0 AND attempt.cancel_requested=0
      AND path.state NOT IN ('arrived','canceled','completed','skipped')
      AND NOT EXISTS(SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=step.id AND newer.number>attempt.number)
  ), working_branch_steps AS (
    SELECT DISTINCT current.execution_id,current.step_id
    FROM current_branch_attempts current
    WHERE (current.state='running' AND current.process_authorized=1
      AND current.lease_owner IS NOT NULL AND current.lease_until>:now)
    OR (current.state='leased' AND current.lease_owner IS NOT NULL AND current.lease_until>:now
      AND EXISTS(SELECT 1 FROM branch_actions action WHERE action.attempt_id=current.attempt_id AND action.state='pending'))
    OR (current.state='waiting' AND EXISTS(
      SELECT 1 FROM coordination_requests request
      WHERE request.id=current.request_id AND ${branchStartedRequestRunSql('request')}
    ))
  )`;

/** One bounded aggregate read for a directory page or one lifecycle owner.
 * Every nonterminal Run belongs to exactly one bucket; history filters and
 * pagination never participate in these counts. No provider probes are needed. */
export function readBranchRunCounts(db:Database.Database,branchIds:readonly string[],now=new Date().toISOString()):Map<string,BranchRunCountsDto> {
  const ids=[...new Set(branchIds)],counts=new Map(ids.map(id=>[id,{running:0,waiting:0,queued:0}]));
  if(!ids.length)return counts;
  const rows=db.prepare(`${BRANCH_LIVE_REQUEST_LINEAGE_CTE},active_branch_runs AS (
    SELECT id,branch_id,state,cancel_requested FROM branch_executions
    WHERE branch_id IN (SELECT value FROM json_each(:branchIds)) AND state IN ('queued','running','waiting')
  ),${workingSteps}, classified AS (
    SELECT run.branch_id,CASE WHEN EXISTS(SELECT 1 FROM working_branch_steps work WHERE work.execution_id=run.id)
      THEN 'running' WHEN run.state='queued' THEN 'queued' ELSE 'waiting' END state FROM active_branch_runs run
  ) SELECT branch_id,SUM(state='running') running,SUM(state='waiting') waiting,SUM(state='queued') queued
    FROM classified GROUP BY branch_id`).all({branchIds:JSON.stringify(ids),now}) as Array<{branch_id:string;running:number;waiting:number;queued:number}>;
  for(const row of rows)counts.set(row.branch_id,{running:Number(row.running),waiting:Number(row.waiting),queued:Number(row.queued)});
  return counts;
}

/** Selected-Run diagnostics reuse the exact batch-count proof, not a second
 * interpretation of branch state or an Agent-wide scheduler lookup. */
export function readBranchWorkingStepCount(db:Database.Database,executionId:string,now=new Date().toISOString()):number {
  const row=db.prepare(`${BRANCH_LIVE_REQUEST_LINEAGE_CTE},active_branch_runs AS (
    SELECT id,branch_id,state,cancel_requested FROM branch_executions
    WHERE id=:executionId AND state IN ('queued','running','waiting')
  ),${workingSteps} SELECT COUNT(*) count FROM working_branch_steps`).get({executionId,now}) as {count:number};
  return Number(row.count);
}
