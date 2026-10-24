import type Database from "better-sqlite3";
import {REQUEST_SOURCE_LINEAGE_CTE} from "@ponderosa/agents";
import type { BranchExecutionDto, BranchOperationalSummaryDto } from "@ponderosa/core";

type Row = Record<string, any>;
export interface ProviderIntakeStatus {
  enabled?: boolean;
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
  execution: Pick<BranchExecutionDto, "id" | "state" | "budgetWait">,
  providerStatus?: ProviderStatus,
  includeAgentWaits = true,
): Promise<BranchOperationalSummaryDto> {
  const now = new Date().toISOString();
  // Aggregate in SQLite; materialize only the visible page and provider/state groups.
  const steps = db.prepare(`SELECT
    SUM(state='completed') completed,SUM(state IN ('running','leased')) running,
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
  const waitCte = `${REQUEST_SOURCE_LINEAGE_CTE}, waits AS (
    SELECT a.id,a.updated_at,r.id request_id,r.state request_state,r.created_at request_created_at,
      r.recipient_agent_id agent_id,ag.title agent_title,ag.active_engine engine_id,
      EXISTS(SELECT 1 FROM request_source_lineage source
        JOIN scheduler_run_activations attached ON attached.activation_id=source.activation_id
        JOIN scheduler_runs sr ON sr.id=attached.run_id
        WHERE source.request_id=r.id AND sr.agent_id=r.recipient_agent_id
          AND sr.status IN ('leased','running') AND sr.terminal_at IS NULL
          AND sr.side_effects_fenced_at IS NULL AND sr.lease_expires_at>:now) attached_run,
      EXISTS(SELECT 1 FROM scheduler_runs sr WHERE sr.agent_id=r.recipient_agent_id
        AND sr.status IN ('leased','running') AND sr.terminal_at IS NULL
        AND sr.side_effects_fenced_at IS NULL AND sr.lease_expires_at>:now) active_run,
      (SELECT activation.id FROM request_source_lineage source
        JOIN agent_activations activation ON activation.id=source.activation_id
        WHERE source.request_id=r.id AND activation.agent_id=r.recipient_agent_id
          AND activation.state='retry_pending' ORDER BY activation.available_at,activation.id LIMIT 1) retry_id
    FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id
    JOIN coordination_requests r ON r.id=a.request_id LEFT JOIN agents ag ON ag.id=r.recipient_agent_id
    WHERE s.execution_id=:executionId AND :activeExecution=1 AND a.state='waiting'
      AND NOT EXISTS(SELECT 1 FROM branch_attempts newer WHERE newer.step_execution_id=a.step_execution_id AND newer.number>a.number)
  ), evidence AS (
    SELECT waits.*,retry.available_at retry_at,retry.provider_failure_category,
      CASE WHEN request_state='awaiting_answer' THEN 'waiting_human'
        WHEN request_state='waiting_dependency' THEN 'waiting_dependency'
        WHEN attached_run THEN 'agent_running' WHEN active_run THEN 'agent_busy'
        ELSE 'waiting_agent' END base_state
    FROM waits LEFT JOIN agent_activations retry ON retry.id=waits.retry_id
  )`;
  const bindings={executionId:execution.id,activeExecution:Number(activeExecution),now};
  const waitingAttempts = includeAgentWaits
    ? db.prepare(`${waitCte} SELECT * FROM evidence ORDER BY request_created_at,request_id LIMIT 100`).all(bindings) as Row[]
    : [];
  const groups = db.prepare(`${waitCte} SELECT engine_id,base_state,COUNT(*) total,
    retry_id IS NOT NULL retry_pending,provider_failure_category FROM evidence
    GROUP BY engine_id,base_state,retry_id IS NOT NULL,provider_failure_category`).all(bindings) as Row[];
  const engineIds=[...new Set(groups.map(row=>row.engine_id).filter((id):id is string=>typeof id==='string'))];
  const engines=new Map(await Promise.all(engineIds.map(async id=>{
    try{return [id,await providerStatus?.(id)] as const;}
    catch{return [id,{authentication:'error' as const,intakeReady:false}] as const;}
  })));
  const classify=(a:Row)=>{
    const provider=engines.get(a.engine_id);
    let state:BranchOperationalSummaryDto['agentWaits'][number]['state']=a.base_state;
    let label=state==='waiting_human'?'Agent needs an answer':state==='waiting_dependency'?'Agent waiting on another task':state==='agent_running'?'Agent work in progress':state==='agent_busy'?'Agent busy - queued':'Waiting for Agent';
    let reason:string|undefined=state==='agent_busy'?'Another Run is active for this Agent.':undefined;
    let nextRetryAt:string|undefined;
    if(state==='waiting_agent'){
      if(provider?.enabled===false){state='provider_attention';label='Provider paused';reason='Provider intake is disabled in settings.';}
      else if(provider?.resourceAdmission?.state==='held'){state='provider_unavailable';label='Waiting for host resources';reason=provider.availabilityDetail||'Accepted work remains queued until host resources recover.';}
      else if(provider?.authentication==='checking'){label='Waiting for provider sign-in check';reason='The check is pending; accepted work remains queued.';}
      else if(provider&&provider.authentication!=='authenticated'){state='provider_attention';label='Provider needs attention';reason='Check provider sign-in and configuration in Settings.';}
      else if(a.retry_id||a.retry_pending){
        state=['rate_limit','capacity'].includes(a.provider_failure_category)?'provider_retry':'retry_pending';
        label=state==='provider_retry'?'Provider retry scheduled':'Retry scheduled';nextRetryAt=a.retry_at;
        reason=a.provider_failure_category==='rate_limit'?'Provider quota is unavailable; the Request remains queued for retry.':a.provider_failure_category==='capacity'?'Provider capacity is unavailable; the Request remains queued for retry.':'This Request remains queued for retry.';
      }else if(provider&&!provider.intakeReady){state='provider_unavailable';label='Provider unavailable - queued for recovery';reason=provider.availabilityDetail||'The Request remains queued until provider access recovers.';}
    }
    return {state,label,...(reason?{reason}:{}),...(nextRetryAt?{nextRetryAt}:{})};
  };
  const classifiedWaits=waitingAttempts.map(a=>({requestId:a.request_id as string,agentId:a.agent_id as string,
    agentName:a.agent_title||'Agent',engineId:a.engine_id||undefined,since:a.request_created_at||a.updated_at,...classify(a)}));
  const classifications=groups.map(group=>({...classify(group),total:Number(group.total)}));
  const unknown=Number(attempts.unknown??0),retrying=Number(attempts.retrying??0),scheduledRetries=Number(attempts.scheduled??0);
  const humanRequests=classifications.filter(row=>row.state==='waiting_human').reduce((n,row)=>n+row.total,0);
  const totalWaits=classifications.reduce((n,row)=>n+row.total,0);
  const counts={completed:Number(steps.completed??0),running:Number(steps.running??0),retrying,failed:Number(steps.failed??0),
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
  else if (classifications.some(wait => wait.state === "provider_attention")) { state = "provider_attention"; label = "Provider needs attention"; }
  else if (classifications.some(wait => wait.state === "provider_unavailable")) { state = "provider_unavailable"; label = "Provider unavailable"; }
  else if (pendingGates || humanRequests) { state = "waiting_human"; label = "Waiting on a person"; }
  else if (classifications.some(wait => wait.state === "provider_retry" || wait.state === "retry_pending") || scheduledRetries) { state = "retrying"; label = "Retry scheduled"; }
  else if (counts.running || classifications.some(wait=>wait.state==='agent_running')) { state = "running"; label = "Work in progress"; }
  else if (totalWaits && classifications.every(wait=>wait.state==='waiting_dependency')) { state='blocked';label='Waiting for dependent work'; }
  else if (totalWaits) { state = "waiting_agent"; label = "Waiting for Agent"; }
  else if (execution.state === "queued") { state = "queued"; label = execution.budgetWait ? "Waiting for automatic execution budget" : "Queued"; }
  else { state = "blocked"; label = "Waiting for other work"; }
  const agentWaits = classifiedWaits.slice(0, 100);
  return { executionId: execution.id, state, label, observedAt: now, counts, agentWaits, additionalAgentWaits: Math.max(0, totalWaits - agentWaits.length) };
}
