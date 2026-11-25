import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore,readBranchRunCounts} from '@ponderosa/agents';
import {CoordinationV3Scheduler} from '../../apps/server/dist/coordination-v3-scheduler.js';
import {branchOperationalSummary} from '../../apps/server/dist/branch-operations.js';
import {previewBranchExecutionActions} from '../../apps/server/dist/branch-detail-preview.js';
import {registerBranchRoutes} from '../../apps/server/dist/routes/branches.js';

const healthy={authentication:'authenticated',intakeReady:true};
function fixture(t,width=1){
 const root=mkdtempSync(path.join(tmpdir(),'branch-operations-current-')),store=new AgentStore(root),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Operations',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Workflow'}),agent=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id}),other=store.createAgent(project.id,{title:'Other provider',engine:'claude',conversationId:chat.id});
 const steps=[{id:'work',kind:'agent',target:{kind:'persistent_organization',ref:'worker'},instructions:'Return findings'},...(width>1?[{id:'otherWork',kind:'agent',target:{kind:'persistent_organization',ref:'other'},instructions:'Return findings'}]:[])];
 const controls=width===1?[]:[{id:'fork',kind:'fork',joinId:'outerJoin'},{id:'outerJoin',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['left','right']},
   {id:'leftMap',kind:'map',joinId:'leftJoin',workerId:'work',source:'list',maxItems:120,maxConcurrentItems:120},{id:'leftJoin',kind:'join',forkId:'leftMap',mode:'all',remainder:'finish',inputOrder:[]}];
 const edges=width===1?[]:[{id:'left',from:'fork',to:'leftMap',on:'selected'},{id:'right',from:'fork',to:'otherWork',on:'selected'},
   {id:'item',from:'leftMap',to:'work',on:'selected'},{id:'return',from:'work',to:'leftJoin',on:'success'},{id:'finish',from:'leftJoin',to:'outerJoin',on:'success'},{id:'otherFinish',from:'otherWork',to:'outerJoin',on:'success'}];
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Operations',trigger:{kind:'manual'},entry:width===1?'work':'fork',steps,controls,edges,policy:{maxConcurrentExecutions:1,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'stop'}}},bindings:{agents:{worker:agent.id,other:other.id},directories:{}}});
 branches.configure(branch.id,{...branches.configuration(branch.id),limits:{...branches.configuration(branch.id).limits,maxTraversals:1000}},0);
 let passed=false;t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained operations fixture: ${root}`)});
 const execution=branches.accept(branch.id,'input',width===1?'Review':JSON.stringify(Array.from({length:120},(_,i)=>`Item ${i}`)));
 return {root,store,coordination,branches,project,chat,agent,other,execution,pass(){passed=true},summary:provider=>branchOperationalSummary(store.sqlite,branches.execution(execution.id),provider??(async()=>healthy))};
}

test('Branch status requires an exact unfenced live Run; a Request progress update or payload text alone cannot prove execution',async t=>{
 const f=fixture(t);f.branches.advance();const request=f.branches.detail(f.execution.id).attempts[0].requestId;
 f.coordination.updateRequest({requestId:request,updateId:'progress',kind:'progress',actor:{kind:'agent',id:f.agent.id},payload:{text:'Working'}});
 assert.equal((await f.summary()).agentWaits[0].state,'waiting_agent');
 const lease=f.coordination.leaseNextRun({workerId:'controlled-scheduler'});assert.ok(lease);f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 // Authored payload is not attachment authority. The immutable source relation is.
 f.store.sqlite.prepare("UPDATE agent_activations SET payload_json='{}' WHERE id IN(SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?)").run(request);
 const active=await f.summary(async()=>({...healthy,intakeReady:false}));assert.equal(active.state,'running');assert.equal(active.agentWaits[0].state,'agent_running');
 f.coordination.updateRequest({requestId:request,updateId:'dependency',kind:'waiting_dependency',actor:{kind:'agent',id:f.agent.id},payload:{text:'Waiting for a peer'}});
 const waiting=await f.summary();assert.equal(waiting.state,'blocked');assert.equal(waiting.agentWaits[0].state,'waiting_dependency');
 f.coordination.updateRequest({requestId:request,updateId:'resumed',kind:'progress',actor:{kind:'agent',id:f.agent.id},payload:{text:'Resumed'}});
 f.coordination.fenceRunSideEffects(lease.runId,lease.fencingToken,'controlled-scheduler');
 assert.equal((await f.summary(async()=>({...healthy,intakeReady:false}))).agentWaits[0].state,'provider_unavailable');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,1);f.pass();
});

test('unrelated work is queued behind the same Agent and only an exact Request retry changes its provider status',async t=>{
 const f=fixture(t);
 f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'other-task',requests:[{recipientAgentId:f.agent.id,lifetime:{kind:'indefinite'},payload:{text:'Other task'}}]});
 const lease=f.coordination.leaseNextRun({workerId:'controlled-scheduler'});assert.ok(lease);
 f.branches.advance();const request=f.branches.detail(f.execution.id).attempts[0].requestId;
 assert.equal((await f.summary()).agentWaits[0].state,'agent_busy');
 f.coordination.fenceRunSideEffects(lease.runId,lease.fencingToken,'controlled-scheduler');
 f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',provider_failure_category='rate_limit' WHERE id IN(SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id!=?)").run(request);
 assert.equal((await f.summary()).agentWaits[0].state,'waiting_agent');
 const due=new Date(Date.now()+60000).toISOString();
 f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',provider_failure_category='rate_limit',available_at=? WHERE id IN(SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?)").run(due,request);
 const summary=await f.summary();assert.equal(summary.state,'retrying');assert.equal(summary.agentWaits[0].state,'provider_retry');assert.equal(summary.agentWaits[0].nextRetryAt,due);f.pass();
});

test('an answered Request keeps its exact provider retry visible without claiming active work',async t=>{
 const f=fixture(t);f.branches.advance();
 const requestId=f.branches.detail(f.execution.id).attempts[0].requestId;
 const lease=f.coordination.leaseNextRun({workerId:'question-fixture'});
 f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 f.coordination.preparePromptInjection({...lease,prompt:'Review this document'});
 f.coordination.markPromptSubmitted(lease);f.coordination.acknowledgePromptInjection(lease);
 f.coordination.updateRequest({requestId,updateId:'question',kind:'question',actor:{kind:'agent',id:f.agent.id},payload:{text:'Which document?'}});
 f.coordination.completeRun(lease.runId,lease.fencingToken);
 f.coordination.updateRequest({requestId,updateId:'answer',kind:'answer',inReplyToUpdateId:'question',actor:{kind:'user'},payload:{text:'The quarterly update'}});
 const due=new Date(Date.now()+60000).toISOString();
 const retry=f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',provider_failure_category='capacity',available_at=? WHERE id IN(SELECT activation_id FROM activation_sources WHERE source_kind='request_update' AND source_id='answer')").run(due);
 assert.equal(retry.changes,1);
 const summary=await f.summary();assert.equal(summary.state,'retrying');assert.equal(summary.counts.running,0);
 assert.equal(summary.agentWaits[0].state,'provider_retry');assert.equal(summary.agentWaits[0].nextRetryAt,due);
 assert.deepEqual(f.branches.listBranches().find(branch=>branch.id===f.execution.branchId).runCounts,{running:0,waiting:1,queued:0,retrying:0,stopping:0,needsAttention:0});
 f.pass();
});

test('large Branch status materializes at most one bounded Agent page, retains exact counts, and sees provider attention beyond that page',async t=>{
 const f=fixture(t,120);for(let i=0;i<12;i++){f.branches.advance();await f.branches.unitSaver.drain();}
 f.store.sqlite.prepare("UPDATE coordination_requests SET created_at='9999-01-01T00:00:00.000Z' WHERE recipient_agent_id=?").run(f.other.id);
 const queryRows=[],db={prepare(sql){const statement=f.store.sqlite.prepare(sql);return {get:(...args)=>statement.get(...args),all(...args){const rows=statement.all(...args);queryRows.push(rows.length);return rows}}}};
 const probes=[];const summary=await branchOperationalSummary(db,f.branches.execution(f.execution.id),async id=>{probes.push(id);return id==='claude'?{authentication:'unauthenticated',intakeReady:false}:healthy});
 assert.equal(summary.state,'provider_attention');assert.ok(summary.agentWaits.every(row=>row.engineId==='codex'));assert.equal(summary.counts.waitingAgent,121);assert.equal(summary.agentWaits.length,100);assert.equal(summary.additionalAgentWaits,21);
 assert.ok(queryRows.every(n=>n<=100),JSON.stringify(queryRows));assert.deepEqual(probes.sort(),['claude','codex']);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('Branch waits explain host pressure and pending checks without telling signed-in users to sign in again',async t=>{
 const f=fixture(t);f.branches.advance();
 const held=await f.summary(async()=>({authentication:'checking',intakeReady:false,resourceAdmission:{state:'held'},availabilityDetail:'Waiting for host resources.'}));
 assert.equal(held.state,'provider_unavailable');assert.match(held.agentWaits[0].label,/host resources/i);assert.doesNotMatch(held.agentWaits[0].reason,/sign.in|configuration/i);
 const checking=await f.summary(async()=>({authentication:'checking',intakeReady:false}));
 assert.equal(checking.state,'waiting_agent');assert.match(checking.agentWaits[0].label,/checking provider sign.in/i);assert.doesNotMatch(checking.agentWaits[0].reason,/sign.in and configuration/i);
 const signedOut=await f.summary(async()=>({authentication:'unauthenticated',intakeReady:false}));
 assert.equal(signedOut.state,'provider_attention');assert.match(signedOut.agentWaits[0].reason,/sign.in/);f.pass();
});

test('focused Run actions retain old pending gates beyond newer resolved history and bind bounded cursors to the Run revision',async t=>{
 const f=fixture(t),width=122,values=Array.from({length:width},(_,i)=>`Complete proposal ${i}`);
 const definition={schema:'ponderosa.branch.v1',name:'Many decisions',trigger:{kind:'manual'},entry:'map',steps:[{id:'worker',kind:'agent',label:'Review Item',target:{kind:'persistent_organization',ref:'worker'},instructions:'Return the item result'}],
  controls:[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:200,maxConcurrentItems:200},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],
  edges:[{id:'item',from:'map',to:'worker',on:'selected'},{id:'return',from:'worker',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'ask_human'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'gate-pages',definition,bindings:{agents:{worker:f.agent.id},directories:{}}});
 f.branches.configure(branch.id,{...f.branches.configuration(branch.id),limits:{...f.branches.configuration(branch.id).limits,maxTraversals:1000}},0);
 const execution=f.branches.accept(branch.id,'many-gates',JSON.stringify(values));
 for(let i=0;i<10;i++){f.branches.advance();await f.branches.unitSaver.drain();}
 const requests=f.store.sqlite.prepare('SELECT a.request_id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? ORDER BY a.rowid').all(execution.id);
 assert.equal(requests.length,width);for(const [index,{request_id:requestId}] of requests.entries())f.coordination.updateRequest({requestId,updateId:`failed_${index}`,kind:'failed',actor:{kind:'agent',id:f.agent.id},payload:{text:values[index]}});
 for(let i=0;i<10;i++){f.branches.advance();await f.branches.unitSaver.drain();}
 const gates=f.store.sqlite.prepare('SELECT g.* FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? ORDER BY g.rowid').all(execution.id);
 assert.equal(gates.length,width);
 const first=f.branches.currentActions(execution.id);assert.equal(first.items.length,100);assert.ok(first.nextCursor);assert.ok(first.items.every(item=>item.kind==='gate'));
 const second=f.branches.currentActions(execution.id,first.nextCursor);assert.equal(second.items.length,22);assert.equal(second.nextCursor,undefined);
 assert.equal(new Set([...first.items,...second.items].map(item=>item.gate.id)).size,width);
 assert.ok(first.items[0].gate.openedAt);assert.equal(first.items[0].step.executionId,execution.id);
 assert.throws(()=>f.branches.currentActions(f.execution.id,first.nextCursor),/cursor/i);
 for(const gate of gates.slice(2))f.branches.resolveGate(gate.id,{commandKey:`reject_${gate.id}`,expectedRevision:gate.revision,decision:'reject'});
 await f.branches.unitSaver.drain();
 assert.throws(()=>f.branches.currentActions(execution.id,first.nextCursor),/changed/i);
 const app=Fastify();registerBranchRoutes(app,{store:f.store,workspace:{decisionsForRuns:()=>[],getDecision:()=>undefined},branches:f.branches,installations:{setPublisher(){}},sources:{},createChat:()=>{throw Error('Read-only actions must not create Chats')},notify:()=>{throw Error('Read-only actions must not publish work')}});
 try{const stale=await app.inject({url:`/api/branch-executions/${execution.id}/actions?cursor=${encodeURIComponent(first.nextCursor)}`});assert.equal(stale.statusCode,409,stale.body);assert.match(stale.json().error,/changed/);}finally{await app.close()}
 const ordinary=f.branches.detail(execution.id);assert.ok(!ordinary.gates.some(gate=>gate.id===gates[0].id),'The original bounded audit window omits the oldest unresolved gate');
 const focused=f.branches.currentActions(execution.id),pending=focused.items.filter(item=>item.kind==='gate');assert.deepEqual(pending.map(item=>item.gate.id),gates.slice(0,2).map(gate=>gate.id));
 assert.deepEqual(pending.map(item=>item.gate.proposal),values.slice(0,2));assert.ok(pending.every(item=>item.gate.state==='waiting'));
 for(const cursor of ['broken',Buffer.from(JSON.stringify({executionId:execution.id,revision:focused.revision,rank:9,position:1})).toString('base64url')])assert.throws(()=>f.branches.currentActions(execution.id,cursor),/cursor/i);
 assert.equal(f.branches.currentActions('missing'),undefined);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('focused Run actions preserve exact uncertain Request ownership and existing intervention fences',t=>{
 const f=fixture(t);f.branches.advance();const attempt=f.branches.detail(f.execution.id).attempts[0];
 const prior=f.branches.currentActions(f.execution.id);
 f.coordination.updateRequest({requestId:attempt.requestId,updateId:'uncertain',kind:'outcome_unknown',actor:{kind:'supervisor'}});
 const before=f.store.sqlite.prepare('SELECT total_changes() n').get().n,page=f.branches.currentActions(f.execution.id);
 assert.equal(f.store.sqlite.prepare('SELECT total_changes() n').get().n,before,'Action inspection is read-only');
 assert.equal(page.items.length,1);const item=page.items[0];assert.equal(item.kind,'attempt');assert.equal(item.current,true);assert.equal(item.attempt.id,attempt.id);assert.equal(item.attempt.state,'waiting');assert.equal(item.attempt.requestOutcomeUnknown,true);
 assert.equal(page.revision,prior.revision);assert.notEqual(page.generation,prior.generation,'An independent Request update must invalidate the action observation without a Run-state change');
 f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'unrelated-actions-generation',requests:[{recipientAgentId:f.other.id,lifetime:{kind:'indefinite'}}]});
 assert.equal(f.branches.currentActions(f.execution.id).generation,page.generation,'Unrelated work must not invalidate the selected Run');
 const command={commandKey:'retry-uncertain',expectedRevision:page.revision,action:'retry',attemptId:attempt.id,reason:'Reviewed the existing external effects'};
 assert.throws(()=>f.branches.intervene(f.execution.id,{...command,externalEffectsReconciled:false}),/Reconcile/);
 assert.throws(()=>f.branches.intervene(f.execution.id,{...command,expectedRevision:page.revision-1,externalEffectsReconciled:true}),/revision/);
 f.branches.intervene(f.execution.id,{...command,externalEffectsReconciled:true});
 const after=f.branches.currentActions(f.execution.id);assert.equal(after.items.length,0,'A superseded attempt must not remain a current action');assert.notEqual(after.generation,page.generation);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('Pinecone regression: explicit Skip of an outcome_unknown execution holds until the exact Run exit is observed, then skips and preserves the unknown result',t=>{
 const f=fixture(t);f.branches.advance();const attempt=f.branches.detail(f.execution.id).attempts[0];
 const lease=f.coordination.leaseNextRun({workerId:'lost-worker'});f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 const commit=(kind,identity,value)=>{const json=JSON.stringify(value);f.store.sqlite.prepare('INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES(?,?,?,?,?)').run(kind,identity,json,json,'test')};
 commit('provider-process-registration','lifetime:reg',{schema:'provider-process-registration.v1',authorityId:'lifetime',runId:lease.runId,runFence:lease.fencingToken,agentId:f.agent.id});
 f.coordination.recoverOrphanedRuns('restarted-worker');
 assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(lease.runId).status,'outcome_unknown');
 assert.equal(f.store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(attempt.requestId).state,'outcome_unknown');
 f.branches.advance();
 const skip=()=>f.branches.intervene(f.execution.id,{commandKey:'skip',expectedRevision:f.branches.execution(f.execution.id).revision,action:'skip',reason:'Skipped by user'});
 skip();for(let i=0;i<3;i++)f.branches.advance();
 assert.equal(f.branches.execution(f.execution.id).state,'waiting','an unobserved provider lifetime keeps the Skip held');
 commit('provider-process-exit','lifetime',{schema:'provider-process-exit.v1',authorityId:'lifetime',result:'observed_exited',observation:'os-not-alive'});
 f.branches.advance();
 const detail=f.branches.detail(f.execution.id);
 assert.equal(detail.execution.state,'skipped');
 assert.equal(detail.attempts[0].state,'canceled');assert.match(detail.attempts[0].error,/remains unknown/);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(attempt.requestId).state,'outcome_unknown');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='agent_cleanup_observed'").get(f.execution.id).n,1);
 f.pass();
});
test('UI030: Skip after a started-but-never-injected Run settles only when no provider start was ever admitted for that exact Run',t=>{
 for(const admitted of [false,true]){
  const f=fixture(t);f.branches.advance();
  const lease=f.coordination.leaseNextRun({workerId:'lost-worker'});f.coordination.markRunStarted(lease.runId,lease.fencingToken);
  if(admitted){const v=JSON.stringify({schema:'provider-start-admission.v1',identity:'start',runId:lease.runId,runFence:lease.fencingToken,agentId:f.agent.id});
   f.store.sqlite.prepare("INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES('provider-start-admission','start',?,?,'test')").run(v,v);}
  f.coordination.recoverOrphanedRuns('restarted-worker');
  const run=f.store.sqlite.prepare('SELECT status,prompt_injection_state FROM scheduler_runs WHERE id=?').get(lease.runId);
  assert.notEqual(run.status,'running');assert.equal(run.prompt_injection_state,'not_injected');
  assert.equal(f.coordination.canRetryUninjectedRun(lease.runId),false,'the strict replay guard stays unchanged');
  f.branches.advance();
  f.branches.intervene(f.execution.id,{commandKey:'skip',expectedRevision:f.branches.execution(f.execution.id).revision,action:'skip',reason:'Skipped by user'});
  for(let i=0;i<3;i++)f.branches.advance();
  assert.equal(f.branches.execution(f.execution.id).state,admitted?'waiting':'skipped',admitted?'an admitted start without settlement stays held':'nothing could have started');
  if(admitted)assert.equal(f.branches.detail(f.execution.id).execution.effectiveStatus,'needs_attention','an unsettled start nothing can observe is Needs Attention, not Stopping forever');
  f.pass();
 }
});
test('UI031: a Run that finishes without its Branch Request result gets bounded result-only redelivery, never new work',t=>{
 for(const reports of [true,false]){
  const f=fixture(t);f.branches.advance();const requestId=f.branches.detail(f.execution.id).attempts[0].requestId;
  const finish=()=>{const lease=f.coordination.leaseNextRun({workerId:'worker'});assert.ok(lease,'the Request is delivered again');f.coordination.markRunStarted(lease.runId,lease.fencingToken);f.coordination.preparePromptInjection({...lease,prompt:'input'});f.coordination.markPromptSubmitted(lease);f.coordination.acknowledgePromptInjection(lease);return lease};
  const request=()=>f.store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(requestId).state;
  const repairs=()=>f.store.sqlite.prepare("SELECT json_extract(a.payload_json,'$.resultRepair.attempt') attempt FROM activation_sources s JOIN agent_activations a ON a.id=s.activation_id WHERE s.source_kind='request' AND s.source_id=? AND json_extract(a.payload_json,'$.resultRepair.sourceRunId') IS NOT NULL ORDER BY a.rowid").all(requestId).map(r=>r.attempt);
  let lease=finish();f.coordination.completeRun(lease.runId,lease.fencingToken);
  assert.notEqual(request(),'outcome_unknown');assert.deepEqual(repairs(),[1]);
  lease=finish();
  if(reports){
   f.coordination.updateRequest({requestId,updateId:'repaired',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Findings'}});
   f.coordination.completeRun(lease.runId,lease.fencingToken);f.branches.advance();
   assert.equal(f.branches.execution(f.execution.id).state,'completed');assert.deepEqual(repairs(),[1]);
  }else{
   f.coordination.completeRun(lease.runId,lease.fencingToken);assert.deepEqual(repairs(),[1,2]);
   lease=finish();f.coordination.completeRun(lease.runId,lease.fencingToken);
   assert.equal(request(),'outcome_unknown','repair is bounded');assert.deepEqual(repairs(),[1,2]);
   assert.equal(f.coordination.leaseNextRun({workerId:'worker'}),undefined,'nothing is replayed after exhaustion');
  }
  f.pass();
 }
});
test('UI031: header counts, history filter, row and detail share one status; an unknown result outranks a stale retry and Skip reads as Stopping',async t=>{
 const f=fixture(t);f.branches.advance();const requestId=f.branches.detail(f.execution.id).attempts[0].requestId;
 const lease=f.coordination.leaseNextRun({workerId:'lost-worker'});f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 f.coordination.preparePromptInjection({...lease,prompt:'input'});f.coordination.markPromptSubmitted(lease);
 f.coordination.recoverOrphanedRuns('restarted-worker');f.branches.advance();
 f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',available_at='2999-01-01T00:00:00.000Z' WHERE id IN(SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?)").run(requestId);
 const agree=async expected=>{
  const id=f.execution.id,branchId=f.branches.execution(id).branchId,counts=readBranchRunCounts(f.store.sqlite,[branchId]).get(branchId);
  assert.equal(counts[expected==='needs_attention'?'needsAttention':expected],1,JSON.stringify(counts));
  assert.equal(Object.entries(counts).reduce((n,[,v])=>n+v,0),1,'exactly one bucket');
  assert.deepEqual(f.branches.listExecutions(branchId,undefined,expected).map(run=>run.id),[id]);
  for(const other of ['queued','running','waiting','retrying','stopping','needs_attention'].filter(s=>s!==expected))assert.deepEqual(f.branches.listExecutions(branchId,undefined,other),[]);
  assert.equal(f.branches.listExecutions(branchId)[0].effectiveStatus,expected);assert.equal(f.branches.detail(id).execution.effectiveStatus,expected);
 };
 await agree('needs_attention');
 const summary=await f.summary();assert.equal(summary.state,'needs_reconciliation');assert.ok(summary.agentWaits.every(wait=>!wait.nextRetryAt&&wait.state==='needs_reconciliation'),JSON.stringify(summary.agentWaits));
 f.branches.intervene(f.execution.id,{commandKey:'skip',expectedRevision:f.branches.execution(f.execution.id).revision,action:'skip',reason:'Skipped by user'});
 await agree('needs_attention');
 assert.match(f.branches.detail(f.execution.id).execution.stopping.blocked,/cannot finish stopping automatically/,'an injected Run with no lifetime evidence cannot be observed');
 const registration=JSON.stringify({schema:'provider-process-registration.v1',authorityId:'lifetime',runId:lease.runId,runFence:lease.fencingToken,agentId:f.agent.id});
 f.store.sqlite.prepare("INSERT INTO host_lifecycle_commits(kind,identity,input_json,receipt_json,receipt_sha256) VALUES('provider-process-registration','lifetime:reg',?,?,'test')").run(registration,registration);
 f.store.sqlite.prepare("INSERT INTO provider_process_authority(id,worker_id,purpose,project_id,agent_id,run_id,pid,pgid,birth_marker,created_at) VALUES('lifetime','worker','provider',?,?,?,1,1,'birth',?)").run(f.project.id,f.agent.id,lease.runId,new Date().toISOString());
 await agree('stopping');assert.equal(f.branches.detail(f.execution.id).execution.stopping.blocked,undefined,'a live tracked lifetime can still be observed exiting');
 f.pass();
});
test('UI031: a Branch Request parked on its Join is not woken for result repair before the Join resolves',t=>{
 const f=fixture(t,1);f.branches.advance();const requestId=f.branches.detail(f.execution.id).attempts[0].requestId;
 const lease=f.coordination.leaseNextRun({workerId:'worker'});f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 f.coordination.preparePromptInjection({...lease,prompt:'input'});f.coordination.markPromptSubmitted(lease);f.coordination.acknowledgePromptInjection(lease);
 f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,requesterAgentId:f.agent.id,actorScope:'controlled-fixture',idempotencyKey:'fan-out',
  requests:[{recipientAgentId:f.other.id,lifetime:{kind:'indefinite'},payload:{text:'Child task'}}],join:{mode:'all',wakePolicy:'each_result',continuationRequestIds:[requestId]}});
 f.coordination.completeRun(lease.runId,lease.fencingToken);
 assert.notEqual(f.store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(requestId).state,'outcome_unknown');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM agent_activations WHERE json_extract(payload_json,'$.resultRepair.sourceRunId') IS NOT NULL").get().n,0,'the parked continuation keeps waiting for its Join');
 f.pass();
});
test('focused Run failure evidence survives the latest-history window, uses bounded previews and retains exact full evidence',async t=>{
 const f=fixture(t),values=Array.from({length:112},(_,i)=>`Full input ${i} `+(i===0?'🌲'.repeat(500):''));
 const definition={schema:'ponderosa.branch.v1',name:'Older failure',trigger:{kind:'manual'},entry:'map',steps:[{id:'script',kind:'script',label:'Transform item',runtime:'node',source:'process.stdout.write("unused")',cwdRef:'workspace',timeoutMs:1000}],
  controls:[{id:'map',kind:'map',joinId:'join',workerId:'script',source:'list',maxItems:200,maxConcurrentItems:200},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],
  edges:[{id:'item',from:'map',to:'script',on:'selected'},{id:'return',from:'script',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'old-failure',definition,bindings:{agents:{},directories:{workspace:f.project.hostPath}}});
 f.branches.configure(branch.id,{...f.branches.configuration(branch.id),limits:{...f.branches.configuration(branch.id).limits,maxTraversals:1000}},0);
 const execution=f.branches.accept(branch.id,'old-failure',JSON.stringify(values));for(let i=0;i<8;i++){f.branches.advance();await f.branches.unitSaver.drain();}
 const output='Failure evidence '+ '🌲'.repeat(500);let oldStep;
 for(let i=0;i<values.length;i++){
  const lease=f.branches.claimScript('controlled-no-process');assert.ok(lease,`Prepared script ${i}`);if(i===0)oldStep=f.store.sqlite.prepare('SELECT step_execution_id id FROM branch_attempts WHERE id=?').get(lease.attemptId).id;
  f.branches.settleScript(lease,{failed:i===0,output:i===0?output:'Done'});
  if(i%10===9)await f.branches.unitSaver.drain();
 }
 assert.ok(!f.branches.detail(execution.id).steps.some(step=>step.id===oldStep));
 const page=f.branches.currentActions(execution.id);assert.equal(page.items.length,1);assert.equal(page.items[0].kind,'attempt');assert.equal(page.items[0].current,false);assert.match(page.items[0].attempt.retryBlockedReason,/no longer accepts|already advanced|join has already closed/);
 const preview=previewBranchExecutionActions(page);assert.equal(preview.largeEvidenceOmitted,true);assert.equal(Array.from(preview.items[0].attempt.result.output).length,129);
 const full=f.branches.stepEvidence(execution.id,oldStep);assert.equal(full.attempts[0].result.output,output);assert.equal(full.input,values[0]);
 assert.equal(f.branches.stepEvidence(f.execution.id,oldStep),undefined,'Another Run does not authorize the Step evidence');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('another parallel Script becoming uncertain changes the focused generation while unrelated work keeps the Run running',async t=>{
 const f=fixture(t),steps=['one','two','three'].map(id=>({id,kind:'script',runtime:'node',source:'process.stdout.write("unused")',cwdRef:'workspace',timeoutMs:1000}));
 const definition={schema:'ponderosa.branch.v1',name:'Parallel uncertainty',trigger:{kind:'manual'},entry:'fork',steps,
  controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['one-path','two-path','three-path']}],
  edges:steps.flatMap(step=>[{id:`${step.id}-path`,from:'fork',to:step.id,on:'selected'},{id:`${step.id}-return`,from:step.id,to:'join',on:'success'}]),policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'parallel-uncertain',definition,bindings:{agents:{},directories:{workspace:f.project.hostPath}}}),execution=f.branches.accept(branch.id,'uncertain','');
 f.branches.advance();await f.branches.unitSaver.drain();const first=f.branches.claimScript('controlled-no-process'),second=f.branches.claimScript('controlled-no-process'),third=f.branches.claimScript('controlled-no-process');assert.ok(first);assert.ok(second);assert.ok(third);
 f.branches.scriptCleanupFailed(first.attemptId,'Controlled uncertain effect');const before=f.branches.currentActions(execution.id);
 f.branches.scriptCleanupFailed(second.attemptId,'Controlled uncertain effect');const after=f.branches.currentActions(execution.id);
 assert.equal(after.revision,before.revision,'The operational Run state did not change');assert.notEqual(after.generation,before.generation,'Existing process fences must invalidate a newly uncertain action page');
 assert.equal(before.items.filter(item=>item.kind==='attempt').length,1);assert.equal(after.items.filter(item=>item.kind==='attempt').length,2);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('a saved document and its reuse share one download while the exact downstream step waits, needs sign-in, then fails',async t=>{
 const f=fixture(t);
 const packetSource=`
  import {readFileSync, writeFileSync} from 'node:fs';
  import {createHash} from 'node:crypto';
  const report = {id:'document-1', summary:'A private workflow result'};
  const bytes = JSON.stringify(report, null, 2) + '\\n';
  let saved = 'created';
  try { writeFileSync('result.json', bytes, {flag:'wx'}); }
  catch (error) { if(error.code !== 'EEXIST') throw error; saved = 'reused'; }
  const sha256 = createHash('sha256').update(readFileSync('result.json')).digest('hex');
  process.stdout.write(JSON.stringify({id:report.id, saved, sha256, report}));
 `;
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'packet-projection',definition:{schema:'ponderosa.branch.v1',name:'Readable results',trigger:{kind:'manual'},entry:'save',controls:[],
  steps:[{id:'save',kind:'script',label:'Save report',runtime:'node',source:packetSource,cwdRef:'workspace',timeoutMs:1000},
   {id:'browser',kind:'agent',label:'Check in browser',target:{kind:'persistent_organization',ref:'worker'},instructions:'Check the private fixture'}],
  edges:[{id:'next',from:'save',to:'browser',on:'success'}],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},
  bindings:{agents:{worker:f.agent.id},directories:{workspace:f.root}}});
 let provider={authentication:'checking',intakeReady:false};
 const app=Fastify();
 registerBranchRoutes(app,{store:f.store,workspace:{decisionsForRuns:()=>[],getDecision:()=>undefined},branches:f.branches,installations:{setPublisher(){}},sources:{},providerStatus:async()=>provider});
 t.after(()=>app.close());
 const summaries=[];
 for(const key of ['first','second']){
  const execution=f.branches.accept(branch.id,key,'input');
  f.branches.advance();
  const lease=f.branches.claimScript('result-projection-test');
  assert.equal(lease.executionId,execution.id);
  const output=execFileSync(process.execPath,['--input-type=module','-e',lease.source],{cwd:f.root,encoding:'utf8'});
  f.branches.settleScript(lease,{failed:false,output});
  f.branches.advance();
  const route='/api/branch-executions/'+execution.id;
  const detail=(await app.inject({url:route})).json();
  const step=detail.steps.find(step=>step.stepId==='save');
  const browser=detail.steps.find(step=>step.stepId==='browser');
  assert.equal(step.state,'completed');
  assert.equal(step.publishedResult.label,'Report');
  assert.equal(step.publishedResult.reused,key==='second');
  assert.equal(browser.state,'waiting');
  assert.equal(browser.result,undefined);
  assert.equal(detail.waits.find(wait=>wait.stepExecutionId===browser.id).stepId,'browser');
  summaries.push({route,step,browser,request:detail.attempts.find(attempt=>attempt.stepExecutionId===browser.id).requestId});
 }
 assert.equal(readdirSync(f.root).filter(name=>name==='result.json').length,1);
 const digest=summaries[0].step.publishedResult.sha256;
 assert.equal(summaries[1].step.publishedResult.sha256,digest);
 const download=await app.inject({url:'/api/branches/'+branch.id+'/results/'+digest});
 assert.equal(download.statusCode,200,download.body);
 assert.equal(download.json().summary,'A private workflow result');
 assert.equal((await app.inject({url:'/api/branches/'+f.execution.branchId+'/results/'+digest})).statusCode,404);
 assert.equal((await app.inject({url:'/api/branches/'+branch.id+'/results/'+'0'.repeat(64)})).statusCode,404);

 const {route,request,browser}=summaries[1],due=new Date(Date.now()+60000).toISOString();
 f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',available_at=? WHERE id IN(SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?)").run(due,request);
 const checking=(await app.inject({url:route+'/operations'})).json();
 const wait=checking.agentWaits.find(wait=>wait.requestId===request);
 assert.equal(checking.state,'retrying');assert.equal(wait.stepExecutionId,browser.id);assert.equal(wait.nextRetryAt,due);
 assert.match(wait.label,/Checking provider sign-in/);
 provider={authentication:'unauthenticated',intakeReady:false};
 const attention=(await app.inject({url:route+'/operations'})).json();
 assert.equal(attention.state,'provider_attention');assert.match(attention.agentWaits[0].reason,/The step can resume/);

 f.coordination.updateRequest({requestId:request,updateId:'failure-after-retry',kind:'failed',actor:{kind:'agent',id:f.agent.id},payload:{reason:'Provider retry timed out'}});
 f.branches.advance();
 const terminal=(await app.inject({url:route})).json();
 assert.equal(terminal.execution.state,'failed');
 assert.equal(terminal.waits.length,0);
 assert.equal(terminal.steps.find(step=>step.stepId==='save').publishedResult.sha256,digest);
 const failed=(await app.inject({url:route+'/actions'})).json();
 assert.equal(failed.items.find(item=>item.kind==='attempt').attempt.error,'Provider retry timed out');
 f.pass();
});

test('a held overdue retry reports its exact step and resumes the same Request after reopening, once',async t=>{
 const f=fixture(t);f.branches.advance();
 const attempt=f.branches.detail(f.execution.id).attempts[0];
 const requestId=attempt.requestId;
 const old=f.coordination.leaseNextRun({workerId:'pre-send'});
 assert.equal(f.coordination.failRun({...old,workerId:'pre-send',sameRunResumable:false,retryDelayMs:0}),'retry');
 const activationId=f.store.sqlite.prepare("SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?").get(requestId).activation_id;
 f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(activationId);
 f.store.sqlite.prepare("INSERT INTO activation_sources VALUES(?,'settings_transition_reservation_wait','test-hold')").run(activationId);
 assert.equal(f.coordination.peekNextRunnable(),undefined);
 const reopened=new AgentStore(f.root);
 const coordination=new CoordinationV3Store(reopened.sqlite),branches=new BranchStore(reopened.sqlite,coordination);
 const current=branches.detail(f.execution.id);
 assert.equal(current.execution.effectiveStatus,'needs_attention');
 const app=Fastify();
 registerBranchRoutes(app,{store:reopened,coordination,branches,installations:{setPublisher(){}},sources:{},notify(){}});
 try{
  const summary=(await app.inject('/api/branch-executions/'+f.execution.id+'/operations')).json();
  assert.equal(summary.state,'blocked');
  const wait=summary.agentWaits[0];
  assert.equal(wait.state,'context_blocked');
  assert.equal(wait.stepExecutionId,attempt.stepExecutionId);
  assert.equal(wait.nextRetryAt,undefined);
  assert.equal(wait.contextRetryActivationId,activationId);
  const url='/api/branch-executions/'+f.execution.id+'/steps/'+attempt.stepExecutionId+'/retry-context';
  const payload={requestId,activationId,expectedRevision:current.execution.revision,commandKey:'held-step'};
  assert.equal((await app.inject({method:'POST',url,payload:{...payload,activationId:'stale'}})).statusCode,409);
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url,payload})).statusCode,200);
  assert.equal(coordination.peekNextRunnable().activationId,activationId);
  const resumed=coordination.leaseNextRun({workerId:'resumed-step'});
  assert.deepEqual(resumed.activations.map(activation=>activation.id),[activationId]);
  coordination.markRunStarted(resumed.runId,resumed.fencingToken);
  coordination.preparePromptInjection({...resumed,prompt:'Run the original step'});
  coordination.markPromptSubmitted(resumed);
  coordination.acknowledgePromptInjection(resumed);
  coordination.updateRequest({requestId,updateId:'verified-result',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Verified saved result'}});
  coordination.completeRun(resumed.runId,resumed.fencingToken);
  branches.advance();
  const completed=branches.detail(f.execution.id);
  assert.equal(completed.attempts[0].id,attempt.id);
  assert.equal(completed.steps[0].result.output,'Verified saved result');
  assert.equal(reopened.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,1);
 }finally{await app.close();reopened.close()}
 f.pass();
});

test('an unacknowledged provider send does not make a held Branch Request retryable',async t=>{
 const f=fixture(t);f.branches.advance();
 const attempt=f.branches.detail(f.execution.id).attempts[0];
 const lease=f.coordination.leaseNextRun({workerId:'controlled-scheduler'});
 f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 f.coordination.preparePromptInjection({...lease,prompt:'Review this file'});
 f.coordination.markPromptSubmitted(lease);
 const activationId=lease.activations[0].id,db=f.store.sqlite,stamp=new Date().toISOString();
 const scope=db.prepare('SELECT scope_key FROM agent_activations WHERE id=?').get(activationId).scope_key;
 db.prepare("UPDATE agent_activations SET state='retry_pending' WHERE id=?").run(activationId);
 db.prepare("INSERT INTO activation_sources VALUES(?,'settings_transition_reservation_wait','test-hold')").run(activationId);
 db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
   threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,
   source_run_id,source_activation_ids_json,replacement_run_id,scope_key,created_at,updated_at,terminal_at)
   VALUES('failed-rollover',?,?,'failed','old-session','old-session',100,50,1,'event','[]','[]',?,'[]',?,?,?,?,?)`)
  .run(f.project.id,f.agent.id,lease.runId,lease.runId,scope,stamp,stamp,stamp);
 db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,
   dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
   VALUES('handoff',?,?,'context_rollover_handoff',100,'next_run','blocker','cancelled','handoff',?,?,?,?,?)`)
  .run(f.project.id,f.agent.id,JSON.stringify({settingsTransition:{activationId}}),stamp,stamp,stamp,scope);
 db.prepare("INSERT INTO activation_sources VALUES('handoff','context_rollover','failed-rollover')").run();
 const summary=await branchOperationalSummary(db,f.branches.execution(f.execution.id),async()=>healthy,true,f.coordination);
 assert.equal(summary.state,'needs_reconciliation');
 assert.equal(summary.agentWaits[0].state,'context_uncertain');
 assert.equal(summary.agentWaits[0].label,'Step outcome unconfirmed');
 assert.equal(summary.agentWaits[0].contextRetryActivationId,undefined);
 assert.equal(f.coordination.retryHeldSettingsTransitionRequest({projectId:f.project.id,requestId:attempt.requestId,idempotencyKey:'ambiguous',expectedActivationId:activationId}).accepted,false);
 f.pass();
});


test('a leased settings handoff with uncertain submission stays held across reopen and a later Workflow run',async t=>{
 const f=fixture(t);f.branches.advance();
 const attempt=f.branches.detail(f.execution.id).attempts[0],db=f.store.sqlite,stamp=new Date().toISOString(),hash='a'.repeat(64);
 const activation=db.prepare(`SELECT a.id,a.scope_key FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id
  WHERE s.source_kind='request' AND s.source_id=?`).get(attempt.requestId);
 db.prepare('UPDATE agents SET active_session_id=?,active_session_contract_hash=? WHERE id=?').run('old-session',hash,f.agent.id);
 db.prepare(`INSERT INTO scheduler_runs(id,project_id,agent_id,scope_key,status,lease_owner,lease_expires_at,
  fencing_token,prompt_injection_state,provider_session_id,heartbeat_at,created_at,updated_at,terminal_at)
  VALUES('source-run',?,?,?,'completed','fixture',?,1,'injected','old-session',?,?,?,?)`)
  .run(f.project.id,f.agent.id,activation.scope_key,stamp,stamp,stamp,stamp,stamp);
 db.prepare('INSERT INTO scheduler_agent_fences(agent_id,next_fencing_token) VALUES(?,2)').run(f.agent.id);
 db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
   threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,
   source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,cycle_number)
   VALUES('uncertain-settings',?,?,'requested','old-session','old-session',100,50,1,'event','[]','[]','source-run','[]',?,?,?,2)`)
  .run(f.project.id,f.agent.id,activation.scope_key,stamp,stamp);
 db.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
  cycle_number,threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,
  recent_tail_hashes_json,source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,terminal_at)
  SELECT 'settled-preparation',project_id,agent_id,'failed',old_provider_session_id,provider_session_generation,
    1,threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,
    recent_tail_hashes_json,source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,created_at
  FROM context_rollovers WHERE id='uncertain-settings'`).run();
 db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,
   dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
   VALUES('exact-handoff',?,?,'context_rollover_handoff',100,'next_run','blocker','pending','exact-handoff',?,?,?,?,?)`)
  .run(f.project.id,f.agent.id,JSON.stringify({rolloverId:'uncertain-settings',settingsTransition:{
   activationId:activation.id,oldSessionId:'old-session',oldContractHash:hash}}),stamp,stamp,stamp,activation.scope_key);
 db.prepare("INSERT INTO activation_sources VALUES('exact-handoff','context_rollover','uncertain-settings')").run();
 db.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,
   dedupe_key,payload_json,available_at,created_at,updated_at,scope_key,terminal_at)
   SELECT 'safe-older-handoff',project_id,agent_id,kind,priority,dispatch_policy,prompt_class,'failed',
    'safe-older-handoff',json_set(payload_json,'$.settingsTransition.activationId','canceled-old-task'),available_at,created_at,updated_at,scope_key,created_at
   FROM agent_activations WHERE id='exact-handoff'`).run();
 db.prepare("INSERT INTO activation_sources VALUES('safe-older-handoff','context_rollover','settled-preparation')").run();
 const lease=f.coordination.leaseNextRun({workerId:'handoff-owner'});
 assert.deepEqual(lease.activationIds,['exact-handoff']);
 f.coordination.markRunStarted(lease.runId,lease.fencingToken);
 f.coordination.preparePromptInjection({...lease,prompt:'Handoff only'});
 f.coordination.markPromptSubmitted(lease);
 assert.equal(f.coordination.failRun({...lease,workerId:'handoff-owner',sameRunResumable:false}),'outcome_unknown');

 const reopened=new AgentStore(f.root);
 try{
  const coordination=new CoordinationV3Store(reopened.sqlite),branches=new BranchStore(reopened.sqlite,coordination);
  const retry=(requestId,activationId)=>coordination.retryHeldSettingsTransitionRequest({projectId:f.project.id,requestId,
   idempotencyKey:requestId,expectedActivationId:activationId});
  assert.equal(coordination.contextRecovery.reconstructionPredecessor({agentId:f.agent.id,projectId:f.project.id,
   scopeKey:activation.scope_key,providerSessionId:'old-session',sourceFence:lease.fencingToken}),
  'uncertain-settings','safe pre-submission history does not block the existing reconstruction path');
  assert.equal(retry(attempt.requestId,activation.id).accepted,false);
  const summary=await branchOperationalSummary(reopened.sqlite,branches.execution(f.execution.id),async()=>healthy,true,coordination);
  assert.equal(summary.agentWaits[0].state,'context_uncertain');
  branches.cancel(f.execution.id);
  assert.equal(branches.execution(f.execution.id).state,'canceled','the original task was never submitted');
  const later=branches.accept(f.execution.branchId,'new-run','New input');
  branches.advance();
  const requestId=branches.detail(later.id).attempts[0].requestId;
  const laterActivation=db.prepare("SELECT activation_id FROM activation_sources WHERE source_kind='request' AND source_id=?").get(requestId).activation_id;
  // The admission preflight keeps this new task queued behind prior effects.
  assert.equal(coordination.holdUncertainSettingsTransitionReservation({projectId:f.project.id,agentId:f.agent.id,
   activationId:laterActivation,scopeKey:activation.scope_key,fingerprint:'b'.repeat(64)}),true);
  assert.equal(retry(requestId,laterActivation).accepted,false);
  assert.equal(coordination.peekNextRunnable(),undefined);
 }finally{reopened.close();}
 f.pass();
});

test('Branch provider admission rechecks after async preflight and leases the same work once',async t=>{
 const f=fixture(t);f.branches.advance();
 const original=f.coordination.peekNextRunnable();
 let ready=true,preflight=0,dispatches=0;
 const scheduler=new CoordinationV3Scheduler(f.coordination,async lease=>{
  dispatches++;
  assert.deepEqual(lease.activations.map(activation=>activation.id),[original.activationId]);
  f.coordination.markPromptSubmitted(lease);
  f.coordination.acknowledgePromptInjection(lease);
  return {accepted:true};
 },{workerId:'provider-race',
  blockedAgentIds:()=>ready?[]:[f.agent.id],
  prepareRunAdmission:async excluded=>{
   const candidate=f.coordination.peekNextRunnable({excludedAgentIds:excluded});
   await Promise.resolve();
   if(++preflight===1)ready=false;
   return candidate?.activationId??null;
  },
  revalidateRunAdmission:()=>ready});
 await scheduler.drainOnce();
 assert.equal(dispatches,0);
 assert.equal(f.coordination.peekNextRunnable().activationId,original.activationId);
 ready=true;
 await scheduler.drainOnce();
 await scheduler.drainOnce();
 assert.equal(dispatches,1);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,1);
 f.pass();
});

test('a held report can record the exact finished Branch result once across restart',async t=>{
 const f=fixture(t);
 f.branches.advance();
 const {requestId,stepExecutionId}=f.branches.detail(f.execution.id).attempts[0];
 const source=f.coordination.leaseNextRun({workerId:'original'});
 const output='Saved shortlist';
 const executionId='original-provider-execution';
 f.coordination.markRunStarted(source.runId,source.fencingToken);
 f.coordination.preparePromptInjection({...source,prompt:'Original request'});
 f.coordination.recordProviderInput({executionId,schedulerRunId:source.runId,fencingToken:source.fencingToken,
  agentId:f.agent.id,projectId:f.project.id,prompt:'Original request',sourceManifest:{}});
 f.coordination.markPromptSubmitted(source);
 f.coordination.acknowledgePromptInjection(source);
 f.store.appendEvent(f.agent.id,{type:'text',executionId,delta:output});
 f.coordination.completeRun(source.runId,source.fencingToken);
 const report=f.coordination.leaseNextRun({workerId:'report-only'});
 const reportId=report.activations[0].id;
 f.coordination.markRunStarted(report.runId,report.fencingToken);
 f.coordination.preparePromptInjection({...report,prompt:'Report only'});
 f.coordination.recordProviderInput({executionId:'report-provider-execution',schedulerRunId:report.runId,
  fencingToken:report.fencingToken,agentId:f.agent.id,projectId:f.project.id,prompt:'Report only',sourceManifest:{}});
 assert.equal(f.coordination.failRun({...report,workerId:'report-only',sameRunResumable:false,retryDelayMs:0}),'retry');
 f.store.sqlite.prepare("INSERT INTO activation_sources VALUES(?,'settings_transition_reservation_wait','held-report')").run(reportId);
 const opened=new AgentStore(f.root);
 const coordination=new CoordinationV3Store(opened.sqlite),branches=new BranchStore(opened.sqlite,coordination);
 const app=Fastify();
 registerBranchRoutes(app,{store:opened,coordination,branches,installations:{setPublisher(){}},sources:{},notify(){}});
 const url='/api/branch-executions/'+f.execution.id+'/steps/'+stepExecutionId+'/saved-result';
 try{
  const candidate=(await app.inject(url)).json();
  assert.deepEqual(candidate,{available:true,sourceRunId:source.runId,text:output,
   outputHash:createHash('sha256').update(output).digest('hex')});
  const {sourceRunId,outputHash}=candidate;
  const payload={commandKey:'recover-shortlist',expectedRevision:branches.execution(f.execution.id).revision,
   sourceRunId,outputHash,disposition:'completed'};
  assert.equal((await app.inject({method:'POST',url,payload:{...payload,outputHash:'0'.repeat(64)}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url,payload})).statusCode,200);
  const afterCommand=new AgentStore(f.root);
  try{
   const restarted=new BranchStore(afterCommand.sqlite,new CoordinationV3Store(afterCommand.sqlite));
   restarted.advance();
   assert.equal(restarted.execution(f.execution.id).state,'completed');
   assert.equal(restarted.detail(f.execution.id).steps[0].result.output,output);
  }finally{afterCommand.close()}
  assert.equal((await app.inject({method:'POST',url,payload})).statusCode,200);
  assert.equal(opened.sqlite.prepare('SELECT count(*) n FROM coordination_request_updates WHERE request_id=?').get(requestId).n,1);
  assert.equal(opened.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,2);
  assert.equal(coordination.peekNextRunnable(),undefined);
 }finally{await app.close();opened.close()}
 f.pass();
});
