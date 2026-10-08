import type Database from 'better-sqlite3';
import type {BranchBindings,BranchDefinition,BranchExecutionDto,BranchWaitDto,BranchDecisionDto} from '@ponderosa/core';
type Row=Record<string,any>;
/** Read-only projections of SQLite authority; never infer runtime decisions from output text. */
export function inspectBranchExecution(db:Database.Database,e:BranchExecutionDto,d:BranchDefinition,b:BranchBindings,checkpoints:Row[]):{waits:BranchWaitDto[];decisions:BranchDecisionDto[]} {
 const rows=(sql:string,...args:any[])=>db.prepare(sql).all(...args) as Row[];
 const row=(sql:string,...args:any[])=>db.prepare(sql).get(...args) as Row|undefined;
 const nodes=[...d.steps,...d.controls],name=(id:string)=>nodes.find(n=>n.id===id)?.label??id;
 const waits:BranchWaitDto[]=[];
 if(['queued','running','waiting'].includes(e.state)){
  if(row('SELECT cancel_requested FROM branch_executions WHERE id=?',e.id)?.cancel_requested)waits.push({kind:'cleanup',message:'Canceling this execution and its children; waiting for owned work and processes to stop.'});
  else {
   if(e.state==='queued')waits.push(e.budgetWait?{kind:'execution_budget',branchId:e.branchId,executionId:e.id,message:'Accepted and saved. Waiting for this Branch’s automatic execution budget; no workflow work has started.'}:{kind:'capacity',message:'Accepted. Waiting for workflow capacity to start.'});
   const attempts=rows(`SELECT a.*,s.step_id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id
    WHERE s.execution_id=? AND a.state IN ('prepared','leased','running','waiting','outcome_unknown') ORDER BY a.rowid LIMIT 100`,e.id);
   for(const a of attempts){
    const step=d.steps.find(n=>n.id===a.step_id);if(!step)continue;
    const add=(wait:BranchWaitDto)=>waits.push({...wait,stepId:step.id});
    if(a.state==='outcome_unknown'){add({kind:'reconciliation',message:`“${name(step.id)}” has an unknown outcome. Its external effect may already have happened; a retry can duplicate it. Inspect process evidence and reconcile the effect before choosing a retry or recording the observed result.`});continue;}
    if(a.available_at&&a.available_at>new Date().toISOString()){add({kind:'retry',message:`“${name(step.id)}” is waiting for its retry time.`,availableAt:a.available_at});continue;}
    if(row("SELECT id FROM branch_gates WHERE attempt_id=? AND state='waiting'",a.id)){add({kind:'approval',message:`“${name(step.id)}” is waiting for your decision.`});continue;}
    if(step.kind==='branch_call'&&a.purpose==='step'){
     const target=b.branches?.[step.branchRef],branch=target?row('SELECT id,name,enabled FROM branches WHERE id=?',target):undefined;
     const child=row('SELECT id,state,budget_wait FROM branch_executions WHERE parent_attempt_id=?',a.id);
     if(child)add({kind:child.state==='queued'&&child.budget_wait?'execution_budget':'child',message:`Waiting for ${branch?.name??'called Branch'} · ${child.id.slice(0,8)} (${child.state==='queued'&&child.budget_wait?'waiting for its automatic execution budget':child.state}).`,branchId:target,executionId:child.id});
     else if(branch&&!branch.enabled)add({kind:'disabled_branch',message:`Waiting because Branch “${branch.name}” is disabled. This call resumes when it is enabled.`,branchId:branch.id});
     else add({kind:'capacity',message:`“${name(step.id)}” is waiting to start ${branch?.name??'the called Branch'}.`,branchId:target});
    }else if(a.request_id){
     const request=row('SELECT recipient_agent_id,state FROM coordination_requests WHERE id=?',a.request_id);
     const agent=request?row('SELECT title FROM agents WHERE id=?',request.recipient_agent_id):undefined;
     add({kind:'agent',requestId:a.request_id,message:`“${name(step.id)}” is waiting for ${agent?.title??'its Agent'} to finish the requested work${request?.state==='open'?' (accepted; awaiting Agent execution)':''}.`});
    }else if(step.kind==='agent')add({kind:'capacity',message:`“${name(step.id)}” is waiting for workflow capacity or temporary Agent preparation.`});
    else if(step.kind==='script'&&a.state==='prepared')add({kind:'capacity',message:`“${name(step.id)}” is waiting for Script capacity.`});
    else if(step.kind==='action')add({kind:'operation',message:`“${name(step.id)}” is waiting for notification delivery.`});
   }
   for(const f of rows("SELECT * FROM branch_forks WHERE execution_id=? AND state='open' LIMIT 100",e.id)){
    const map=row('SELECT item_count FROM branch_map_invocations WHERE id=?',f.id);
    if(map){const settled=row('SELECT COUNT(*) n FROM branch_join_arrivals WHERE fork_invocation_id=?',f.id)?.n??0;waits.push({kind:'join',stepId:f.join_id,message:`“${name(f.join_id)}” is waiting for Map items: ${settled} of ${map.item_count} settled.`});}
    else {const pending=rows(`SELECT p.edge_id FROM branch_paths p WHERE p.fork_invocation_id=? AND NOT EXISTS(SELECT 1 FROM branch_join_arrivals a WHERE a.path_id=p.id)`,f.id).map(p=>name(d.edges.find(edge=>edge.id===p.edge_id)?.to??p.edge_id));
    waits.push({kind:'join',stepId:f.join_id,message:`“${name(f.join_id)}” is waiting for ${pending.join(', ')||'selected paths to settle'}.`});}
   }
   if(e.state==='waiting'&&!waits.length)waits.push({kind:'cleanup',message:'Waiting for temporary Agents or owned processes to finish cleanup.'});
  }
 }
 const decisions:BranchDecisionDto[]=checkpoints.flatMap(c=>{
  const evidence=JSON.parse(c.evidence_json),edge=d.edges.find(x=>x.id===evidence.edgeId);let message='',nodeId:string|undefined,failed:boolean|undefined;
  if(c.kind==='condition_selected'&&edge){
   const condition=d.controls.find(n=>n.id===edge.from);nodeId=edge.from;
   const other=d.edges.find(x=>x.from===edge.from&&x.id!==edge.id);
   message=`Condition “${name(edge.from)}”: input equals ${condition?.kind==='condition'?JSON.stringify(condition.predicate.equals):'configured text'} → ${edge.on==='selected'?'true':'false'}. Selected “${name(edge.to)}”${other?`; did not select path to “${name(other.to)}”`:''}.`;
  } else if((c.kind==='route_selected'||c.kind==='route_invalid')&&edge){
   nodeId=edge.from;message=`Route “${name(edge.from)}”: ${c.kind==='route_invalid'?`unrecognized choice ${JSON.stringify(evidence.choice)}; used the otherwise path`:`chose ${JSON.stringify(evidence.choice)}`} → “${name(edge.to)}”.`;
  } else if(c.kind==='map_items_sealed'){
   nodeId=evidence.mapId;message=`For Each “${name(nodeId!)}” sealed ${evidence.count} item(s). The list will not be re-extracted after recovery.`;
  } else if(c.kind==='map_item_started'){
   message=`For Each item ${evidence.index+1} started.`;
  } else if(c.kind==='fork_started'){
   const fork=row('SELECT fork_id FROM branch_forks WHERE id=?',evidence.forkInvocationId);if(fork){nodeId=fork.fork_id;message=`Parallel paths started: ${d.edges.filter(x=>x.from===nodeId).map(x=>name(x.to)).join(', ')}.`;}
  } else if(c.kind==='join_resolved'){
   const fork=row('SELECT join_id FROM branch_forks WHERE id=?',evidence.forkInvocationId);if(fork){nodeId=fork.join_id;failed=Boolean(evidence.result?.failed);const total=row('SELECT COUNT(*) n FROM branch_paths WHERE fork_invocation_id=?',evidence.forkInvocationId)?.n;message=`Join “${name(nodeId!)}” ${evidence.result?.failed?'could not be satisfied':'satisfied'}: ${evidence.selectedPathIds?.length??0} of ${total} paths selected for the result.${evidence.result?.failed&&evidence.result?.output?` Cause: ${evidence.result.output}`:''}`;}
  } else if(c.kind==='join_arrival'){
   const item=row('SELECT item_index FROM branch_map_items WHERE path_id=?',evidence.pathId);
   if(item)message=`For Each item ${item.item_index+1} ${evidence.outcome}; Join arrival recorded.`;
   else {const path=row('SELECT edge_id FROM branch_paths WHERE id=?',evidence.pathId);const start=d.edges.find(x=>x.id===path?.edge_id)?.to;message=`Parallel path “${name(start??'path')}” ${evidence.outcome==='unselected'?'skipped by its condition':evidence.outcome}; Join arrival recorded.`;}
  } else if(c.kind==='loop_traversed'&&edge){nodeId=edge.to;message=`Loop to “${name(edge.to)}”: iteration ${evidence.iteration}.`;}
  else if(c.kind==='limit_exhausted'){nodeId=evidence.nodeId;message=`Traversal stopped at “${name(nodeId??'path')}”: ${evidence.limit} limit ${evidence.configured}, attempted ${evidence.observed}. Earlier completed Steps may already have caused external effects; reconcile before restarting the execution.`;}
  return message?[{id:String(c.id),kind:c.kind,...(nodeId?{nodeId}:{}),...(failed!==undefined?{failed}:{}),message,at:c.created_at}]:[];
 });
 return {waits,decisions};
}
