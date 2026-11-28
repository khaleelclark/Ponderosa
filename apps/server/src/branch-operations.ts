import type {CoordinationV3Store} from "@ponderosa/agents";
import type Database from "better-sqlite3";
import {BRANCH_LIVE_REQUEST_LINEAGE_CTE,branchStartedRequestRunSql,readBranchWorkingStepCount,requestSourceLineageBody,settingsTransitionActivationHoldSql,settingsTransitionRecoveryInProgressSql} from "@ponderosa/agents";
import type { BranchExecutionDto, BranchOperationalSummaryDto } from "@ponderosa/core";

type Row = Record<string, any>;
export interface ProviderIntakeStatus {
  enabled?: boolean;
  installed?: boolean;
  authentication: "checking" | "authenticated" | "unauthenticated" | "error";
  intakeReady: boolean;
  reachability?: "unverified" | "checking" | "reachable" | "degraded";
  availabilityCategory?: string;
  availabilityDetail?: string;
  resourceAdmission?: Pick<import("@ponderosa/core").ResourceAdmissionDto, "state">;
}
type ProviderStatus = (engineId: string) => Promise<ProviderIntakeStatus | undefined>;

/** A bounded operator projection of canonical Branch, Request, Run, and provider intake state. */
export async function branchOperationalSummary(
  db: Database.Database,
  execution: Pick<BranchExecutionDto, "id" | "state" | "budgetWait"> & Partial<Pick<BranchExecutionDto, "revision">>,
  providerStatus?: ProviderStatus,
  includeAgentWaits = true,
  coordination?: CoordinationV3Store,
  contextHoldReason?: (activationId: string, projectId: string, agentId: string) => string | undefined,
): Promise<BranchOperationalSummaryDto> {
  const now = new Date().toISOString();
  const running = readBranchWorkingStepCount(db,execution.id,now);
  // Aggregate in SQLite; materialize only the visible page and provider/state groups.
  const steps = db.prepare(`SELECT
    SUM(state='completed') completed,
    SUM(state='failed') failed FROM branch_step_executions WHERE execution_id=?`).get(execution.id) as Row;
  const attempts = db.prepare(`SELECT
    SUM(a.state='outcome_unknown') unknown,
    SUM(a.number>1 AND a.state IN ('prepared','leased','running','waiting')) retrying,
    SUM(a.number>1 AND a.state='prepared' AND a.available_at>?) scheduled
    FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id
    WHERE s.execution_id=? AND NOT EXISTS(SELECT 1 FROM branch_attempts newer
      WHERE newer.step_execution_id=a.step_execution_id AND newer.number>a.number)`).get(now,execution.id) as Row;
  const mapPaths = db.prepare(`SELECT COUNT(*) total,SUM(p.state IN ('arrived','failed','canceled')) settled
    FROM branch_map_items m JOIN branch_map_invocations mi ON mi.id=m.map_invocation_id
    JOIN branch_paths p ON p.id=m.path_id WHERE mi.execution_id=?`).get(execution.id) as Row;
  const pendingGates = (db.prepare(`SELECT COUNT(*) count FROM branch_gates g
    JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? AND g.state='waiting'`).get(execution.id) as Row).count as number;
  const activeExecution = ['queued','running','waiting'].includes(execution.state);
  const waitCte = `${BRANCH_LIVE_REQUEST_LINEAGE_CTE}, waits AS (
    SELECT a.id,a.updated_at,s.id step_execution_id,s.step_id,r.id request_id,r.state request_state,r.created_at request_created_at,
      r.recipient_agent_id agent_id,ag.title agent_title,ag.active_engine engine_id,
      ${branchStartedRequestRunSql('r')} attached_run,
      EXISTS(SELECT 1 FROM scheduler_runs sr WHERE sr.agent_id=r.recipient_agent_id
        AND sr.status IN ('leased','running') AND sr.terminal_at IS NULL
        AND sr.side_effects_fenced_at IS NULL AND sr.lease_expires_at>:now) active_run,
      (WITH branch_retry_sources AS MATERIALIZED (
        SELECT source.* FROM agent_activations activation
        CROSS JOIN activation_sources source ON source.activation_id=activation.id
        WHERE activation.agent_id=r.recipient_agent_id AND activation.project_id=r.project_id
          AND activation.scope_key=CASE WHEN r.conversation_id IS NOT NULL THEN 'conversation:'||r.conversation_id ELSE 'agent:'||r.recipient_agent_id END
          AND activation.state IN ('pending','retry_pending')
      ),${requestSourceLineageBody('branch_retry_sources')}
        SELECT activation.id FROM request_source_lineage source
        JOIN agent_activations activation ON activation.id=source.activation_id
        WHERE source.request_id=r.id AND activation.agent_id=r.recipient_agent_id
          AND activation.state IN ('pending','retry_pending')
          ORDER BY ${settingsTransitionActivationHoldSql('activation')} DESC,
            (activation.state='retry_pending') DESC,activation.available_at,activation.id LIMIT 1) retry_id
    FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id
    JOIN coordination_requests r ON r.id=a.request_id LEFT JOIN agents ag ON ag.id=r.recipient_agent_id
    WHERE s.execution_id=:executionId AND :activeExecution=1 AND a.state='waiting'
      AND s.state NOT IN ('completed','failed','canceled')
      AND NOT EXISTS(SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=a.step_execution_id AND newer.number>a.number)
  ), evidence AS (
    SELECT waits.*,retry.project_id,CASE WHEN retry.state='retry_pending' THEN retry.available_at END retry_at,retry.provider_failure_category,
      CASE WHEN request_state IN ('outcome_unknown','superseded','recipient_unavailable') THEN 'needs_reconciliation'
        WHEN request_state='awaiting_answer' THEN 'waiting_human'
        WHEN request_state='waiting_dependency' THEN 'waiting_dependency'
        WHEN ${settingsTransitionRecoveryInProgressSql('retry')} THEN 'context_recovering'
        WHEN retry.id IS NOT NULL AND ${settingsTransitionActivationHoldSql('retry')} THEN
          CASE WHEN EXISTS(SELECT 1 FROM context_rollovers rollover
            JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=rollover.id
            JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
            WHERE rollover.project_id=retry.project_id AND rollover.agent_id=retry.agent_id AND rollover.scope_key=retry.scope_key
              AND json_extract(handoff.payload_json,'$.settingsTransition.activationId')=retry.id
              AND (rollover.state='outcome_unknown' OR rollover.state='failed' AND rollover.replacement_run_id IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM activation_sources released WHERE released.activation_id=retry.id
                AND released.source_kind='settings_transition_release' AND released.source_id=rollover.id)
          ) THEN 'context_uncertain' ELSE 'context_blocked' END
        WHEN EXISTS(SELECT 1 FROM activation_sources pending WHERE pending.activation_id=retry.id
          AND pending.source_kind='settings_transition_retry_pending') THEN 'context_checking'
        WHEN attached_run THEN 'agent_running' WHEN active_run THEN 'agent_busy'
        ELSE 'waiting_agent' END base_state
    -- A held unknown outcome is never a scheduled retry, whatever stale activation remains.
    FROM waits LEFT JOIN agent_activations retry ON retry.id=waits.retry_id AND waits.request_state IN ('open','in_progress')
  )`;
  const bindings={executionId:execution.id,activeExecution:Number(activeExecution),now};
  const waitingAttempts = includeAgentWaits
    ? db.prepare(`${waitCte} SELECT * FROM evidence ORDER BY request_created_at,request_id LIMIT 100`).all(bindings) as Row[]
    : [];
  const groups = db.prepare(`${waitCte} SELECT engine_id,base_state,COUNT(*) total,
    retry_at IS NOT NULL retry_pending,provider_failure_category FROM evidence
    GROUP BY engine_id,base_state,retry_at IS NOT NULL,provider_failure_category`).all(bindings) as Row[];
  const engineIds=[...new Set(groups.filter(row=>['waiting_agent','context_checking','context_recovering'].includes(row.base_state)).map(row=>row.engine_id).filter((id):id is string=>typeof id==='string'))];
  const engines=new Map(await Promise.all(engineIds.map(async id=>{
    try{return [id,await providerStatus?.(id)] as const;}
    catch{return [id,{authentication:'error' as const,intakeReady:false}] as const;}
  })));
  const classify=(a:Row)=>{
    const provider=engines.get(a.engine_id);
    const checkingSession=a.base_state==='context_checking';
    let state:BranchOperationalSummaryDto['agentWaits'][number]['state']=checkingSession?'context_recovering':a.base_state;
    let label=state==='needs_reconciliation'?'Agent result unknown':state==='waiting_human'?'Agent needs an answer':state==='waiting_dependency'?'Agent waiting on another task':state==='agent_running'?'Agent work in progress':state==='agent_busy'?'Agent busy - queued':'Waiting for Agent';
    let reason:string|undefined=state==='agent_busy'?'Another Run is active for this Agent.':undefined;
    if(state==='context_uncertain')return {state,label:'Step outcome unconfirmed',reason:'The earlier attempt may have run. Check its results and any changes it could have made.'};
    if(state==='context_blocked')return {state,label:'Session recovery required',reason:'Ponderosa could not finish restoring the session. This step is on hold.'};
    const sessionRecovery=state==='context_recovering';
    const retryScheduled=Boolean(a.retry_at||a.retry_pending);
    let nextRetryAt:string|undefined;
    if(state==='waiting_agent'||sessionRecovery){
      if(provider?.enabled===false){state='provider_attention';label='Provider paused';reason='Provider intake is disabled in settings.';}
      else if(provider?.resourceAdmission?.state==='held'){state='provider_unavailable';label='Waiting for host resources';reason=provider.availabilityDetail||'Accepted work remains queued until host resources recover.';}
      else if(provider?.installed===false){state='provider_attention';label='Provider installation required';reason='Install the provider CLI on the Ponderosa host, then select Recheck Sign-In in Provider Settings.';}
      else if(provider?.authentication==='unauthenticated'){state='provider_attention';label='Provider sign-in required';reason='Sign in on the Ponderosa host, then select Recheck Sign-In in Provider Settings. The step can resume when sign-in is verified.';}
      else if(provider?.availabilityCategory==='authentication'){
        state='provider_attention';label='Provider access needs attention';reason='The provider rejected the last access attempt. Recheck Sign-In in Provider Settings.';
      }
      else if(provider?.authentication==='checking'){
        if(sessionRecovery)state='waiting_agent';
        if(retryScheduled){state='retry_pending';nextRetryAt=a.retry_at;}
        label='Checking provider sign-in';reason='The check is pending; accepted work remains queued.';
      }
      else if(retryScheduled&&!sessionRecovery){
        state=['rate_limit','capacity'].includes(a.provider_failure_category)?'provider_retry':'retry_pending';
        label=state==='provider_retry'?'Provider retry scheduled':'Retry scheduled';nextRetryAt=a.retry_at;
        reason=a.provider_failure_category==='rate_limit'?'Provider quota is unavailable; the Request remains queued for retry.':a.provider_failure_category==='capacity'?'Provider capacity is unavailable; the Request remains queued for retry.':'This Request remains queued for retry.';
      }else if(provider&&!provider.intakeReady){state='provider_unavailable';label='Provider unavailable - queued for recovery';reason=provider.availabilityDetail||'The Request remains queued until provider access recovers.';}
    }
    if(state==='context_recovering')return {
      state:'context_recovering' as const,label:checkingSession?'Checking session':'Restoring session',
      reason:checkingSession?'Ponderosa is checking the saved session for this step.':'Ponderosa is restoring context for this step.',
    };
    return {state,label,...(reason?{reason}:{}),...(nextRetryAt?{nextRetryAt}:{})};
  };
  const classifiedWaits=waitingAttempts.map(a=>{
    const status=classify(a);
    const hold=status.state==='context_blocked'
      ? coordination?.settingsTransitionRequestHold({projectId:a.project_id,requestId:a.request_id})
      : undefined;
    const reason=hold&&!hold.retryable&&contextHoldReason?.(hold.activationId,a.project_id,a.agent_id);
    return {requestId:a.request_id as string,agentId:a.agent_id as string,
      stepId:a.step_id as string,stepExecutionId:a.step_execution_id as string,agentName:a.agent_title||'Agent',
      engineId:a.engine_id||undefined,since:a.request_created_at||a.updated_at,...status,...(reason?{reason}:{}),
      ...(hold?.retryable&&hold.activationId===a.retry_id?{contextRetryActivationId:hold.activationId,contextRetryKey:hold.recoveryKey}:{})};
  });
  const classifications=groups.map(group=>({...classify(group),total:Number(group.total)}));
  const unknown=Number(attempts.unknown??0)+classifications.filter(row=>row.state==='needs_reconciliation'||row.state==='context_uncertain').reduce((n,row)=>n+row.total,0),retrying=Number(attempts.retrying??0),scheduledRetries=Number(attempts.scheduled??0);
  const humanRequests=classifications.filter(row=>row.state==='waiting_human').reduce((n,row)=>n+row.total,0);
  const totalWaits=classifications.reduce((n,row)=>n+row.total,0);
  const counts={completed:Number(steps.completed??0),running,retrying,failed:Number(steps.failed??0),
    waitingAgent:totalWaits,waitingHuman:pendingGates+humanRequests,needsReconciliation:unknown,
    mapItems:Number(mapPaths.total),mapSettled:Number(mapPaths.settled??0)};
  let state: BranchOperationalSummaryDto["state"];
  let label: string;
  if (execution.state === "completed") { state = "completed"; label = "Completed"; }
  else if (execution.state === "failed") { state = "failed"; label = "Failed"; }
  else if (execution.state === "canceled") { state = "canceled"; label = "Canceled"; }
  else if (execution.state === "skipped") { state = "skipped"; label = "Skipped"; }
  else if (execution.state === "merged") { state = "merged"; label = "Merged into another execution"; }
  else if (unknown) { state = "needs_reconciliation"; label = "Needs reconciliation"; }
  else if (classifications.some(wait => wait.state === "context_blocked")) { state = "blocked"; label = "Session recovery required"; }
  else if (classifications.some(wait => wait.state === "context_recovering")) { state = "waiting_agent"; label = classifications.some(wait=>wait.label==="Restoring session")?"Restoring session":"Checking session"; }
  else if (classifications.some(wait => wait.state === "provider_attention")) { state = "provider_attention"; label = "Provider needs attention"; }
  else if (classifications.some(wait => wait.state === "provider_unavailable")) { state = "provider_unavailable"; label = "Provider unavailable"; }
  else if (pendingGates || humanRequests) { state = "waiting_human"; label = "Waiting on a person"; }
  else if (classifications.some(wait => wait.state === "provider_retry" || wait.state === "retry_pending") || scheduledRetries) { state = "retrying"; label = "Retry scheduled"; }
  else if (counts.running) { state = "running"; label = "Work in progress"; }
  else if (totalWaits && classifications.every(wait=>wait.state==='waiting_dependency')) { state='blocked';label='Waiting for dependent work'; }
  else if (totalWaits) { state = "waiting_agent"; label = "Waiting for Agent"; }
  else if (execution.state === "queued") { state = "queued"; label = execution.budgetWait ? "Waiting for automatic execution budget" : "Queued"; }
  else { state = "blocked"; label = "Waiting for other work"; }
  const agentWaits = classifiedWaits.slice(0, 100);
  return { executionId: execution.id, revision: execution.revision ?? 0, state, label, observedAt: now, counts, agentWaits, additionalAgentWaits: Math.max(0, totalWaits - agentWaits.length) };
}
