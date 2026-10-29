import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,CoordinationV3Store,BranchStore} from '../../packages/agents/dist/index.js';
import {readBranchRunCounts,readBranchWorkingStepCount} from '../../packages/agents/dist/branch-run-status.js';

function fixture(t,{script=false,parallel=false,action=false}={}){
 const root=mkdtempSync(join(tmpdir(),'branch-run-counts-')),store=new AgentStore(root),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Run counts',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Workflow'}),agent=store.createAgent(project.id,{title:'Worker',engine:'codex',conversationId:chat.id});
 const work=script?{id:'work',kind:'script',runtime:'node',source:'console.log("controlled")',cwdRef:'root',timeoutMs:1000}:action?{id:'work',kind:'action',action:'notify',configRefs:[]}:{id:'work',kind:'agent',target:{kind:'persistent_organization',ref:'worker'},instructions:'Report the canonical result'};
 const definition={schema:'ponderosa.branch.v1',name:'Counts',trigger:{kind:'manual'},entry:parallel?'fork':'work',steps:[work,...(parallel?[{id:'approval',kind:'human_gate',prompt:'Waiting for a person',editable:false}]:[])],controls:parallel?[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['work-path','approval-path']}]:[],edges:parallel?[{id:'work-path',from:'fork',to:'work',on:'selected'},{id:'approval-path',from:'fork',to:'approval',on:'selected'},{id:'work-done',from:'work',to:'join',on:'success'},{id:'approval-done',from:'approval',to:'join',on:'approved'}]:[],policy:{maxConcurrentExecutions:100,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'definition',definition,bindings:{agents:{worker:agent.id},directories:{root}}}),execution=branches.accept(branch.id,'first','input');
 let passed=false;t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic('Retained count fixture: '+root)});
 return {store,coordination,branches,project,chat,agent,branch,execution,counts:()=>readBranchRunCounts(store.sqlite,[branch.id]).get(branch.id),working:()=>readBranchWorkingStepCount(store.sqlite,execution.id),pass(){passed=true}};
}
const expected=(running,waiting,queued)=>({running,waiting,queued});

test('counts require exact started scheduler authority and distinguish accepted, waiting and running workflow Runs',t=>{
 const f=fixture(t);assert.deepEqual(f.counts(),expected(0,0,1));f.branches.advance();assert.deepEqual(f.counts(),expected(0,1,0));
 const requestId=f.branches.detail(f.execution.id).attempts[0].requestId;
 f.coordination.updateRequest({requestId,updateId:'progress',kind:'progress',actor:{kind:'agent',id:f.agent.id},payload:{text:'Running, according to authored prose'}});
 assert.deepEqual(f.counts(),expected(0,1,0));const lease=f.coordination.leaseNextRun({workerId:'test'});assert.ok(lease);assert.deepEqual(f.counts(),expected(0,1,0),'A leased provider Run has not started');
 f.coordination.markRunStarted(lease.runId,lease.fencingToken);assert.deepEqual(f.counts(),expected(1,0,0));assert.equal(f.working(),1);
 f.coordination.updateRequest({requestId,updateId:'dependency',kind:'waiting_dependency',actor:{kind:'agent',id:f.agent.id},payload:{text:'Waiting for related work'}});
 assert.deepEqual(f.counts(),expected(0,1,0),'A dependency wait is not working even before the provider unwinds');
 f.coordination.updateRequest({requestId,updateId:'resumed',kind:'progress',actor:{kind:'agent',id:f.agent.id},payload:{text:'Resume'}});assert.deepEqual(f.counts(),expected(1,0,0));
 f.coordination.fenceRunSideEffects(lease.runId,lease.fencingToken,'test');assert.deepEqual(f.counts(),expected(0,1,0));f.pass();
});

test('an answered question resumes through canonical Request-update lineage, not an Agent-wide guess',t=>{
 const f=fixture(t);f.branches.advance();const requestId=f.branches.detail(f.execution.id).attempts[0].requestId;
 const original=f.coordination.leaseNextRun({workerId:'initial'});f.coordination.markRunStarted(original.runId,original.fencingToken);
 const injection={injectionId:original.injectionId,runId:original.runId,fencingToken:original.fencingToken};f.coordination.preparePromptInjection({...injection,prompt:'Canonical question fixture'});f.coordination.markPromptSubmitted(injection);f.coordination.acknowledgePromptInjection(injection);
 f.coordination.updateRequest({requestId,updateId:'question',kind:'question',actor:{kind:'agent',id:f.agent.id},payload:{text:'Which input should I use?'}});
 assert.deepEqual(f.counts(),expected(0,1,0),'A human answer is required even before the provider exits');
 f.coordination.completeRun(original.runId,original.fencingToken);
 f.coordination.updateRequest({requestId,updateId:'answer',kind:'answer',inReplyToUpdateId:'question',actor:{kind:'user'},payload:{text:'Use the selected input'}});
 const resumed=f.coordination.leaseNextRun({workerId:'resumed'});assert.ok(resumed);assert.notEqual(resumed.runId,original.runId);
 assert.ok(f.store.sqlite.prepare("SELECT 1 FROM scheduler_run_activations attached JOIN activation_sources source ON source.activation_id=attached.activation_id WHERE attached.run_id=? AND source.source_kind='request_update' AND source.source_id='answer'").get(resumed.runId));
 assert.deepEqual(f.counts(),expected(0,1,0),'A resumed lease alone is still pending');f.coordination.markRunStarted(resumed.runId,resumed.fencingToken);
 assert.deepEqual(f.counts(),expected(1,0,0));assert.equal(f.working(),1);f.pass();
});

test('an unrelated started Run on the same Agent does not make the workflow Running',t=>{
 const f=fixture(t);f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'unrelated',requests:[{recipientAgentId:f.agent.id,lifetime:{kind:'indefinite'}}]});
 const other=f.coordination.leaseNextRun({workerId:'test'});f.coordination.markRunStarted(other.runId,other.fencingToken);f.branches.advance();assert.deepEqual(f.counts(),expected(0,1,0));assert.equal(f.working(),0);f.pass();
});

test('a parallel approval cannot hide a current working Script; queued leases and expired authority remain Pending',t=>{
 const f=fixture(t,{script:true,parallel:true});f.branches.advance();assert.ok(f.branches.detail(f.execution.id).gates.some(gate=>gate.state==='waiting'));
 const lease=f.branches.claimScript('controlled-no-process');assert.ok(lease);assert.deepEqual(f.counts(),expected(0,1,0));
 f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'inert-fixture'});assert.deepEqual(f.counts(),expected(1,0,0));assert.equal(f.working(),1);
 const expired=new Date(Date.now()+60000).toISOString();assert.deepEqual(readBranchRunCounts(f.store.sqlite,[f.branch.id],expired).get(f.branch.id),expected(0,1,0));
 f.branches.scriptCleanupFailed(lease.attemptId,'Controlled uncertain outcome');assert.deepEqual(f.counts(),expected(0,1,0));f.pass();
});

test('notification delivery owns a live Step lease and cancellation removes its work authority without losing Pending',t=>{
 const f=fixture(t,{action:true});f.branches.advance();const lease=f.branches.claimAction('delivery');assert.ok(lease);assert.deepEqual(f.counts(),expected(1,0,0));
 f.branches.cancel(f.execution.id);const state=f.branches.execution(f.execution.id).state;if(['queued','running','waiting'].includes(state))assert.deepEqual(f.counts(),expected(0,1,0));else assert.deepEqual(f.counts(),expected(0,0,0));f.pass();
});

test('one aggregate query covers every active Run beyond history pages and keeps zero and terminal outcomes distinct',t=>{
 const f=fixture(t,{script:true});for(let i=1;i<220;i++)f.branches.accept(f.branch.id,'queued-'+i,'input');
 // Canonical acceptance produced all identities. Controlled projection states
 // model retained terminal/waiting rows without launching any processes.
 f.store.sqlite.prepare("UPDATE branch_executions SET state=CASE WHEN occurrence_key='first' THEN 'completed' WHEN occurrence_key='queued-1' THEN 'failed' WHEN occurrence_key='queued-2' THEN 'waiting' ELSE 'queued' END").run();
 let reads=0,materialized=0;const db={prepare(sql){const statement=f.store.sqlite.prepare(sql);reads++;return {all(...args){const rows=statement.all(...args);materialized+=rows.length;return rows}}}};
 const before=f.store.sqlite.prepare('SELECT total_changes() n').get().n,counts=readBranchRunCounts(db,[f.branch.id,'empty-branch',f.branch.id]);assert.deepEqual(counts.get(f.branch.id),expected(0,1,217));assert.deepEqual(counts.get('empty-branch'),expected(0,0,0));assert.equal(reads,1);assert.equal(materialized,1);assert.equal(f.store.sqlite.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.working(),0);assert.deepEqual([...readBranchRunCounts(db,[])],[]);assert.equal(reads,1);f.pass();
});

test('expired, fenced, terminal and noncurrent scheduler evidence cannot count as workflow work',t=>{
 for(const condition of ['expired','terminal','wrong-agent','old-path','canceled-attempt']){
  const f=fixture(t);f.branches.advance();const lease=f.coordination.leaseNextRun({workerId:'test'});f.coordination.markRunStarted(lease.runId,lease.fencingToken);assert.deepEqual(f.counts(),expected(1,0,0));
  if(condition==='expired')f.store.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(lease.runId);
  if(condition==='terminal')f.store.sqlite.prepare("UPDATE scheduler_runs SET terminal_at='2026-01-01T00:00:00Z' WHERE id=?").run(lease.runId);
  if(condition==='wrong-agent'){const other=f.store.createAgent(f.project.id,{title:'Unrelated',engine:'codex',conversationId:f.chat.id});f.store.sqlite.prepare('UPDATE scheduler_runs SET agent_id=? WHERE id=?').run(other.id,lease.runId);}
  if(condition==='old-path')f.store.sqlite.prepare("UPDATE branch_paths SET state='arrived',step_execution_id=NULL WHERE execution_id=?").run(f.execution.id);
  if(condition==='canceled-attempt')f.store.sqlite.prepare('UPDATE branch_attempts SET cancel_requested=1 WHERE request_id IS NOT NULL').run();
  assert.deepEqual(f.counts(),expected(0,1,0),condition);f.pass();
 }
});
