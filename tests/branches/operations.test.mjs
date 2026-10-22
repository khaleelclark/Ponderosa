import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
import {branchOperationalSummary} from '../../apps/server/dist/branch-operations.js';

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
