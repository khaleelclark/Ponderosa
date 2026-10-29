import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
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
 return {store,coordination,branches,project,chat,agent,other,execution,pass(){passed=true},summary:provider=>branchOperationalSummary(store.sqlite,branches.execution(execution.id),provider??(async()=>healthy))};
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
 assert.deepEqual(f.branches.listBranches().find(branch=>branch.id===f.execution.branchId).runCounts,{running:0,waiting:1,queued:0});
 f.pass();
});

test('large Branch status materializes at most one bounded Agent page, retains exact counts, and sees provider attention beyond that page',async t=>{
 const f=fixture(t,120);for(let i=0;i<12;i++)f.branches.advance();
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
 assert.equal(checking.state,'waiting_agent');assert.match(checking.agentWaits[0].label,/sign.in check/i);assert.doesNotMatch(checking.agentWaits[0].reason,/sign.in and configuration/i);
 const signedOut=await f.summary(async()=>({authentication:'unauthenticated',intakeReady:false}));
 assert.equal(signedOut.state,'provider_attention');assert.match(signedOut.agentWaits[0].reason,/sign.in/);f.pass();
});

test('focused Run actions retain old pending gates beyond newer resolved history and bind bounded cursors to the Run revision',async t=>{
 const f=fixture(t),width=122,values=Array.from({length:width},(_,i)=>`Complete proposal ${i}`);
 const definition={schema:'ponderosa.branch.v1',name:'Many decisions',trigger:{kind:'manual'},entry:'map',steps:[{id:'worker',kind:'agent',label:'Review item',target:{kind:'persistent_organization',ref:'worker'},instructions:'Return the item result'}],
  controls:[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:200,maxConcurrentItems:200},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],
  edges:[{id:'item',from:'map',to:'worker',on:'selected'},{id:'return',from:'worker',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'ask_human'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'gate-pages',definition,bindings:{agents:{worker:f.agent.id},directories:{}}});
 f.branches.configure(branch.id,{...f.branches.configuration(branch.id),limits:{...f.branches.configuration(branch.id).limits,maxTraversals:1000}},0);
 const execution=f.branches.accept(branch.id,'many-gates',JSON.stringify(values));
 for(let i=0;i<10;i++)f.branches.advance();
 const requests=f.store.sqlite.prepare('SELECT a.request_id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? ORDER BY a.rowid').all(execution.id);
 assert.equal(requests.length,width);for(const [index,{request_id:requestId}] of requests.entries())f.coordination.updateRequest({requestId,updateId:`failed_${index}`,kind:'failed',actor:{kind:'agent',id:f.agent.id},payload:{text:values[index]}});
 f.branches.advance();
 const gates=f.store.sqlite.prepare('SELECT g.* FROM branch_gates g JOIN branch_step_executions s ON s.id=g.step_execution_id WHERE s.execution_id=? ORDER BY g.rowid').all(execution.id);
 assert.equal(gates.length,width);
 const first=f.branches.currentActions(execution.id);assert.equal(first.items.length,100);assert.ok(first.nextCursor);assert.ok(first.items.every(item=>item.kind==='gate'));
 const second=f.branches.currentActions(execution.id,first.nextCursor);assert.equal(second.items.length,22);assert.equal(second.nextCursor,undefined);
 assert.equal(new Set([...first.items,...second.items].map(item=>item.gate.id)).size,width);
 assert.ok(first.items[0].gate.openedAt);assert.equal(first.items[0].step.executionId,execution.id);
 assert.throws(()=>f.branches.currentActions(f.execution.id,first.nextCursor),/cursor/i);
 for(const gate of gates.slice(2))f.branches.resolveGate(gate.id,{commandKey:`reject_${gate.id}`,expectedRevision:gate.revision,decision:'reject'});
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

test('focused Run failure evidence survives the latest-history window, uses bounded previews and retains exact full evidence',t=>{
 const f=fixture(t),values=Array.from({length:112},(_,i)=>`Full input ${i} `+(i===0?'🌲'.repeat(500):''));
 const definition={schema:'ponderosa.branch.v1',name:'Older failure',trigger:{kind:'manual'},entry:'map',steps:[{id:'script',kind:'script',label:'Transform item',runtime:'node',source:'process.stdout.write("unused")',cwdRef:'workspace',timeoutMs:1000}],
  controls:[{id:'map',kind:'map',joinId:'join',workerId:'script',source:'list',maxItems:200,maxConcurrentItems:200},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],
  edges:[{id:'item',from:'map',to:'script',on:'selected'},{id:'return',from:'script',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'old-failure',definition,bindings:{agents:{},directories:{workspace:f.project.hostPath}}});
 f.branches.configure(branch.id,{...f.branches.configuration(branch.id),limits:{...f.branches.configuration(branch.id).limits,maxTraversals:1000}},0);
 const execution=f.branches.accept(branch.id,'old-failure',JSON.stringify(values));f.branches.advance();
 const output='Failure evidence '+ '🌲'.repeat(500);let oldStep;
 for(let i=0;i<values.length;i++){
  const lease=f.branches.claimScript('controlled-no-process');assert.ok(lease,`Prepared script ${i}`);if(i===0)oldStep=f.store.sqlite.prepare('SELECT step_execution_id id FROM branch_attempts WHERE id=?').get(lease.attemptId).id;
  f.branches.settleScript(lease,{failed:i===0,output:i===0?output:'Done'});
 }
 assert.ok(!f.branches.detail(execution.id).steps.some(step=>step.id===oldStep));
 const page=f.branches.currentActions(execution.id);assert.equal(page.items.length,1);assert.equal(page.items[0].kind,'attempt');assert.equal(page.items[0].current,false);assert.match(page.items[0].attempt.retryBlockedReason,/no longer accepts|already advanced|join has already closed/);
 const preview=previewBranchExecutionActions(page);assert.equal(preview.largeEvidenceOmitted,true);assert.equal(Array.from(preview.items[0].attempt.result.output).length,129);
 const full=f.branches.stepEvidence(execution.id,oldStep);assert.equal(full.attempts[0].result.output,output);assert.equal(full.input,values[0]);
 assert.equal(f.branches.stepEvidence(f.execution.id,oldStep),undefined,'Another Run does not authorize the Step evidence');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});

test('another parallel Script becoming uncertain changes the focused generation while unrelated work keeps the Run running',t=>{
 const f=fixture(t),steps=['one','two','three'].map(id=>({id,kind:'script',runtime:'node',source:'process.stdout.write("unused")',cwdRef:'workspace',timeoutMs:1000}));
 steps.push({id:'gate',kind:'human_gate',prompt:'Wait for a decision',editable:false});
 const definition={schema:'ponderosa.branch.v1',name:'Parallel uncertainty',trigger:{kind:'manual'},entry:'fork',steps,
  controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['one-path','two-path','three-path','gate-path']}],
  edges:steps.flatMap(step=>[{id:`${step.id}-path`,from:'fork',to:step.id,on:'selected'},{id:`${step.id}-return`,from:step.id,to:'join',on:step.kind==='human_gate'?'approved':'success'}]),policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'parallel-uncertain',definition,bindings:{agents:{},directories:{workspace:f.project.hostPath}}}),execution=f.branches.accept(branch.id,'uncertain','');
 f.branches.advance();const first=f.branches.claimScript('controlled-no-process'),second=f.branches.claimScript('controlled-no-process'),third=f.branches.claimScript('controlled-no-process');assert.ok(first);assert.ok(second);assert.ok(third);
 f.branches.scriptCleanupFailed(first.attemptId,'Controlled uncertain effect');const before=f.branches.currentActions(execution.id);
 f.branches.scriptCleanupFailed(second.attemptId,'Controlled uncertain effect');const after=f.branches.currentActions(execution.id);
 assert.equal(after.revision,before.revision,'The operational Run state did not change');assert.notEqual(after.generation,before.generation,'Existing process fences must invalidate a newly uncertain action page');
 assert.equal(before.items.filter(item=>item.kind==='attempt').length,1);assert.equal(after.items.filter(item=>item.kind==='attempt').length,2);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.pass();
});
