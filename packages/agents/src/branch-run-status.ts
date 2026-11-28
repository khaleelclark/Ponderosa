import { runExitUnprovenSql } from "./coordination-v3-transition-unsubmitted.js";
export { runExitUnprovenSql };
import { BRANCH_FINISHED_STATES } from "@ponderosa/core";
export { BRANCH_EFFECTIVE_STATUSES } from "@ponderosa/core";
import type Database from 'better-sqlite3';
import type {BranchEffectiveStatus,BranchLiveOutputDto,BranchRunCountsDto,BranchRunStatus} from '@ponderosa/core';
import {settingsTransitionActivationHoldSql,settingsTransitionRecoveryInProgressSql} from './coordination-v3-settings-transition-hold.js';
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
function branchStartedRequestRunsSql(requestAlias:'request'|'r'):string {
  return `SELECT scheduler.id FROM request_source_lineage source
    CROSS JOIN scheduler_run_activations attached ON attached.activation_id=source.activation_id
    CROSS JOIN scheduler_runs scheduler ON scheduler.id=attached.run_id AND scheduler.agent_id=${requestAlias}.recipient_agent_id AND scheduler.project_id=${requestAlias}.project_id
      AND scheduler.scope_key=CASE WHEN ${requestAlias}.conversation_id IS NOT NULL THEN 'conversation:'||${requestAlias}.conversation_id ELSE 'agent:'||${requestAlias}.recipient_agent_id END
    WHERE source.request_id=${requestAlias}.id AND ${requestAlias}.state IN ('open','in_progress') AND ${requestAlias}.terminal_at IS NULL
      AND scheduler.status='running' AND scheduler.started_at IS NOT NULL
      AND scheduler.terminal_at IS NULL AND scheduler.side_effects_fenced_at IS NULL
      AND scheduler.lease_expires_at>:now`;
}

export function branchStartedRequestRunSql(requestAlias:'request'|'r'):string {
  return `EXISTS(${branchStartedRequestRunsSql(requestAlias)})`;
}

/** Presentation identity only; text still comes from the canonical Agent stream.
 * Restrict this read to the already bounded detail page, never Agent-wide recency. */
export function readBranchLiveOutputs(db:Database.Database,executionId:string,attemptIds:readonly string[],now=new Date().toISOString()):BranchLiveOutputDto[] {
  if(!attemptIds.length)return [];
  return db.prepare(`${BRANCH_LIVE_REQUEST_LINEAGE_CTE}
    SELECT DISTINCT attempt.id attemptId,step.step_id stepId,request.recipient_agent_id agentId,
      request.project_id projectId,scheduler.id runId
    FROM branch_executions execution
    JOIN branch_step_executions step ON step.execution_id=execution.id
    JOIN branch_paths path ON path.id=step.path_id AND path.execution_id=execution.id AND path.step_execution_id=step.id
    JOIN branch_attempts attempt ON attempt.step_execution_id=step.id
    JOIN coordination_requests request ON request.id=attempt.request_id
    JOIN scheduler_runs scheduler ON scheduler.id IN (${branchStartedRequestRunsSql('request')})
    WHERE execution.id=:executionId AND execution.state IN ('running','waiting') AND execution.cancel_requested=0
      AND attempt.id IN (SELECT value FROM json_each(:attemptIds)) AND attempt.state='waiting' AND attempt.cancel_requested=0
      AND path.state NOT IN ('arrived','canceled','completed','skipped')
      AND NOT EXISTS(SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=step.id AND newer.number>attempt.number)
    ORDER BY attempt.id,scheduler.id`).all({executionId,attemptIds:JSON.stringify(attemptIds),now}) as BranchLiveOutputDto[];
}

/** An unrelated Agent Run, a queued lease, or authored progress is not proof
 * that this workflow's current Step has started. */
const workingSteps = `
  current_branch_attempts AS (
    SELECT run.id execution_id,step.id step_id,attempt.id attempt_id,
      attempt.state,attempt.lease_owner,attempt.lease_until,attempt.available_at,
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

/** A held Stop/Skip that can no longer finish by itself: a terminal Run whose exit
 * is unproven while no live authority remains to observe it. Settlement uses the
 * same proof (runExitUnprovenSql), so Stopping never waits on something it cannot see. */
export function branchStopBlockedSql(executionId:string):string {
  return `EXISTS(SELECT 1 FROM branch_step_executions blocked_step
    JOIN branch_attempts blocked ON blocked.step_execution_id=blocked_step.id AND blocked.cancel_requested=1 AND blocked.state='outcome_unknown'
    JOIN activation_sources blocked_source ON blocked_source.source_kind='request' AND blocked_source.source_id=blocked.request_id
    JOIN scheduler_run_activations blocked_attached ON blocked_attached.activation_id=blocked_source.activation_id
    JOIN scheduler_runs blocked_run ON blocked_run.id=blocked_attached.run_id AND blocked_run.status NOT IN ('leased','running')
    WHERE blocked_step.execution_id=${executionId}
      AND NOT EXISTS(SELECT 1 FROM scheduler_cancellation_receipts receipt JOIN provider_operation_outbox operation ON operation.run_id=receipt.run_id
        AND operation.idempotency_key='cancel:'||receipt.agent_id||':'||receipt.idempotency_key AND operation.operation='interrupt' AND operation.state='completed'
        WHERE receipt.run_id=blocked_run.id AND receipt.accepted=1)
      AND ${runExitUnprovenSql('blocked_run.id','blocked_run.prompt_injection_state')}
      AND NOT EXISTS(SELECT 1 FROM provider_process_authority live WHERE live.run_id=blocked_run.id OR live.id IN (
        SELECT json_extract(registration.receipt_json,'$.authorityId') FROM host_lifecycle_commits registration
        WHERE registration.kind='provider-process-registration' AND json_extract(registration.receipt_json,'$.runId')=blocked_run.id)))`;
}

/** The one effective-status projection for header counts, history rows, filters
 * and selected detail. Precedence: an accepted Stop/Skip, then unresolved
 * outcomes, then proven work, a real future retry, startup queue, valid waits. */
function classifiedBranchRunsCte(scope:string):string {
  return `${BRANCH_LIVE_REQUEST_LINEAGE_CTE},active_branch_runs AS (
    SELECT id,branch_id,state,cancel_requested FROM branch_executions WHERE ${scope} AND state IN ('queued','running','waiting')
  ),${workingSteps}, attention_runs AS (
    SELECT DISTINCT current.execution_id FROM current_branch_attempts current
    LEFT JOIN coordination_requests request ON request.id=current.request_id
    WHERE current.state='outcome_unknown' OR current.state='waiting' AND (
      request.state IN ('outcome_unknown','superseded','recipient_unavailable') OR
      request.state IN ('open','in_progress') AND EXISTS (
        SELECT 1 FROM activation_sources source JOIN agent_activations activation ON activation.id=source.activation_id
        WHERE source.source_kind='request' AND source.source_id=request.id
          AND activation.agent_id=request.recipient_agent_id AND activation.project_id=request.project_id
          AND activation.state IN ('pending','retry_pending') AND ${settingsTransitionActivationHoldSql('activation')}
          AND NOT ${settingsTransitionRecoveryInProgressSql('activation')}
      ))
  ), retry_runs AS (
    SELECT DISTINCT current.execution_id FROM current_branch_attempts current
    WHERE current.state='prepared' AND current.available_at>:now
      OR current.state='waiting' AND EXISTS(SELECT 1 FROM coordination_requests request
        JOIN activation_sources source ON source.source_kind='request' AND source.source_id=request.id
        JOIN agent_activations activation ON activation.id=source.activation_id
        WHERE request.id=current.request_id AND request.state IN ('open','in_progress')
          AND activation.state='retry_pending' AND activation.available_at>:now
          AND NOT ${settingsTransitionActivationHoldSql('activation')}
          AND NOT ${settingsTransitionRecoveryInProgressSql('activation')})
  ), classified AS (
    SELECT run.id,run.branch_id,CASE
      WHEN run.cancel_requested=1 THEN CASE WHEN ${branchStopBlockedSql('run.id')} THEN 'needs_attention' ELSE 'stopping' END
      WHEN run.id IN (SELECT execution_id FROM attention_runs) THEN 'needs_attention'
      WHEN EXISTS(SELECT 1 FROM working_branch_steps work WHERE work.execution_id=run.id) THEN 'running'
      WHEN run.id IN (SELECT execution_id FROM retry_runs) THEN 'retrying'
      WHEN run.state='queued' THEN 'queued' ELSE 'waiting' END state
    FROM active_branch_runs run
  )`;
}

const emptyCounts=():BranchRunCountsDto=>({running:0,waiting:0,queued:0,retrying:0,stopping:0,needsAttention:0});

/** One bounded aggregate read for a directory page or one lifecycle owner.
 * Every nonterminal Run belongs to exactly one bucket; history filters and
 * pagination never participate in these counts. No provider probes are needed. */
export function readBranchRunCounts(db:Database.Database,branchIds:readonly string[],now=new Date().toISOString()):Map<string,BranchRunCountsDto> {
  const ids=[...new Set(branchIds)],counts=new Map(ids.map(id=>[id,emptyCounts()]));
  if(!ids.length)return counts;
  const rows=db.prepare(`${classifiedBranchRunsCte('branch_id IN (SELECT value FROM json_each(:branchIds))')}
    SELECT branch_id,SUM(state='running') running,SUM(state='waiting') waiting,SUM(state='queued') queued,SUM(state='retrying') retrying,
      SUM(state='stopping') stopping,SUM(state='needs_attention') needsAttention FROM classified GROUP BY branch_id`).all({branchIds:JSON.stringify(ids),now}) as Array<{branch_id:string}&Record<keyof BranchRunCountsDto,number>>;
  for(const {branch_id,...row} of rows)counts.set(branch_id,Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)])) as unknown as BranchRunCountsDto);
  return counts;
}

/** Effective status for one bounded history page: one query, never one per row. */
export function readBranchEffectiveStatuses(db:Database.Database,executionIds:readonly string[],now=new Date().toISOString()):Map<string,BranchEffectiveStatus> {
  if(!executionIds.length)return new Map();
  const rows=db.prepare(`${classifiedBranchRunsCte('id IN (SELECT value FROM json_each(:ids))')} SELECT id,state FROM classified`).all({ids:JSON.stringify(executionIds),now}) as Array<{id:string;state:BranchEffectiveStatus}>;
  return new Map(rows.map(row=>[row.id,row.state]));
}

/** History filter membership uses the exact count predicate across every page. */
export function branchStatusPage(db:Database.Database,branchId:string,statuses:readonly BranchRunStatus[],beforeRowid:number,now:string):string[] {
  const finished=BRANCH_FINISHED_STATES.filter(state=>statuses.includes(state));
  return (db.prepare(`${classifiedBranchRunsCte('branch_id=:branchId AND rowid<:before')}
    SELECT execution.id,execution.rowid position FROM classified
    JOIN branch_executions execution ON execution.id=classified.id
    WHERE classified.state IN (SELECT value FROM json_each(:statuses))
    UNION ALL
    SELECT id,rowid position FROM branch_executions WHERE branch_id=:branchId AND rowid<:before
      AND state IN (SELECT value FROM json_each(:finished))
    ORDER BY position DESC LIMIT 100`).all({branchId,before:beforeRowid,statuses:JSON.stringify(statuses),finished:JSON.stringify(finished),now}) as Array<{id:string}>).map(row=>row.id);
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
