import type Database from "better-sqlite3";
import type { CoordinationV3StoreOptions } from "./coordination-v3-types.js";
import { BRANCH_LIVE_REQUEST_LINEAGE_CTE } from "./branch-run-status.js";
import { taskOriginRunIds } from "./coordination-v3-task-lineage.js";

export interface BranchScheduleUpdateTarget {
  runId: string; attemptId: string; fence: number; executionId: string;
}

// A schedule update belongs to an exact current workflow Attempt, not whichever
// task its Agent happens to run later. Reuse the canonical Request source map.
const targetQuery = `${BRANCH_LIVE_REQUEST_LINEAGE_CTE}
  SELECT DISTINCT run.id runId,a.id attemptId,run.fencing_token fence,e.id executionId,
    run.agent_id agentId,run.project_id projectId,run.scope_key scopeKey
  FROM branch_executions e
  JOIN branches branch ON branch.id=e.branch_id AND branch.enabled=1 AND branch.deleting=0
  JOIN branch_step_executions s ON s.execution_id=e.id
  JOIN branch_paths p ON p.id=s.path_id AND p.step_execution_id=s.id
  JOIN branch_attempts a ON a.step_execution_id=s.id
  JOIN coordination_requests request ON request.id=a.request_id
  CROSS JOIN request_source_lineage source ON source.request_id=request.id
  CROSS JOIN scheduler_run_activations attached ON attached.activation_id=source.activation_id
  CROSS JOIN scheduler_runs run ON run.id=attached.run_id
    AND run.agent_id=request.recipient_agent_id AND run.project_id=request.project_id
    AND run.scope_key=CASE WHEN request.conversation_id IS NOT NULL THEN 'conversation:'||request.conversation_id ELSE 'agent:'||request.recipient_agent_id END
  WHERE e.branch_id=:branchId AND e.state IN ('queued','running','waiting') AND e.cancel_requested=0
    AND a.state='waiting' AND a.cancel_requested=0 AND request.state IN ('open','in_progress')
    AND NOT EXISTS(SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=s.id AND newer.number>a.number)
    AND run.status='running' AND run.terminal_at IS NULL AND run.side_effects_fenced_at IS NULL AND run.lease_expires_at>:now
    AND NOT EXISTS(SELECT 1 FROM branch_gates gate JOIN branch_step_executions gated ON gated.id=gate.step_execution_id WHERE gated.execution_id=e.id AND gate.state='waiting')
    AND NOT EXISTS(SELECT 1 FROM branch_attempts uncertain JOIN branch_step_executions owned ON owned.id=uncertain.step_execution_id LEFT JOIN coordination_requests unresolved ON unresolved.id=uncertain.request_id
      WHERE owned.execution_id=e.id AND EXISTS(SELECT 1 FROM branch_paths current_path WHERE current_path.id=owned.path_id AND current_path.step_execution_id=owned.id AND current_path.state NOT IN ('arrived','canceled','completed','skipped')) AND NOT EXISTS(SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=owned.id AND newer.number>uncertain.number) AND (uncertain.state='outcome_unknown' OR unresolved.state IN ('outcome_unknown','awaiting_answer','waiting_dependency')))
    AND NOT EXISTS(SELECT 1 FROM scheduler_prompt_injections unsettled WHERE unsettled.run_id=run.id AND unsettled.state='outcome_unknown' AND EXISTS(SELECT 1 FROM json_each(unsettled.activation_ids_json) member JOIN agent_activations activation ON activation.id=member.value WHERE activation.state='outcome_unknown'))
    AND NOT EXISTS(SELECT 1 FROM scheduler_steering_recoveries recovery WHERE recovery.run_id=run.id AND recovery.state IN ('grace_period','wait_for_run','recovery_queued'))
    AND NOT EXISTS(SELECT 1 FROM context_rollovers rollover WHERE rollover.agent_id=run.agent_id AND rollover.state IN ('requested','handoff_committed','session_retiring','continuation_ready'))`;

type Target = BranchScheduleUpdateTarget & {agentId:string;projectId:string;scopeKey:string};
export function branchScheduleTarget(
  sqlite: Database.Database, branchId: string, now: string,
  decisions: CoordinationV3StoreOptions["canonicalTaskDecisions"],
): Target | undefined {
  if (!decisions) return undefined; // Automatic delivery needs its canonical approval owner.
  const targets=sqlite.prepare(`${targetQuery} LIMIT 2`).all({branchId,now}) as Target[];
  if(targets.length!==1)return undefined;
  const target=targets[0]!;
  const roots=new Set(taskOriginRunIds(sqlite,target.runId));
  if(decisions(roots).some(decision=>decision.status==='pending' && roots.has(decision.coordinationRunId??decision.runId) && decision.agentId===target.agentId && decision.projectId===target.projectId &&
    (decision.conversationId?`conversation:${decision.conversationId}`:`agent:${decision.agentId}`)===target.scopeKey))return undefined;
  return target;
}

export function branchScheduleActivationEligible(
  sqlite: Database.Database, activationId: string, runId: string, now: string,
  decisions: CoordinationV3StoreOptions["canonicalTaskDecisions"],
): boolean {
  const source=sqlite.prepare(`SELECT occurrence.branch_id,occurrence.branch_execution_id,occurrence.state,occurrence.activation_config_json,
      activation.agent_id,activation.project_id,activation.scope_key,activation.payload_json
    FROM activation_sources source JOIN trigger_occurrences occurrence ON occurrence.id=source.source_id
    JOIN agent_activations activation ON activation.id=source.activation_id
    JOIN trigger_definitions trigger ON trigger.id=occurrence.trigger_id AND trigger.branch_id=occurrence.branch_id AND trigger.source_kind='schedule'
    WHERE source.activation_id=? AND source.source_kind='branch_schedule_update'`).get(activationId) as {
      branch_id:string;branch_execution_id:string|null;state:string;activation_config_json:string;
      agent_id:string;project_id:string;scope_key:string;payload_json:string;
    }|undefined;
  if(!source)return !sqlite.prepare("SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind='branch_schedule_update'").get(activationId);
  const config=JSON.parse(source.activation_config_json) as {schedule?:{policy?:string};steering?:BranchScheduleUpdateTarget};
  const immutable=JSON.parse(source.payload_json).steering as {runId?:string;attemptId?:string;fence?:number}|undefined;
  if(immutable?.runId!==config.steering?.runId||immutable?.attemptId!==config.steering?.attemptId||immutable?.fence!==config.steering?.fence)return false;
  if(source.state!=='pending' || config.schedule?.policy!=='update_current' || config.steering?.runId!==runId)return false;
  const target=branchScheduleTarget(sqlite,source.branch_id,now,decisions);
  return !!target && target.runId===runId && target.attemptId===config.steering.attemptId && target.fence===config.steering.fence &&
    (!source.branch_execution_id||source.branch_execution_id===target.executionId) && source.agent_id===target.agentId &&
    source.project_id===target.projectId && source.scope_key===target.scopeKey;
}

export function requireBranchScheduleInjectionEligible(
  sqlite:Database.Database,injectionId:string,runId:string,now:string,
  decisions:CoordinationV3StoreOptions["canonicalTaskDecisions"],
):void {
  const activationIds=sqlite.prepare(`SELECT source.activation_id id FROM scheduler_prompt_injections injection,json_each(injection.activation_ids_json) member
    JOIN activation_sources source ON source.activation_id=member.value AND source.source_kind='branch_schedule_update'
    WHERE injection.id=? AND injection.run_id=?`).all(injectionId,runId) as {id:string}[];
  if(activationIds.some(({id})=>!branchScheduleActivationEligible(sqlite,id,runId,now,decisions)))throw new Error('scheduled update target is no longer eligible');
}
