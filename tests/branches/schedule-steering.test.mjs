import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';

function fixture(t,{authority=true,parallel=false}={}) {
 const root=mkdtempSync(path.join(tmpdir(),'branch-schedule-steering-')),decisions=[];
 let store=new AgentStore(root);
 let coordination=new CoordinationV3Store(store.sqlite,authority?{canonicalTaskDecisions:()=>decisions}:{}),branches=new BranchStore(store.sqlite,coordination);
 const project=store.createProject({label:'Scheduled checks',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Watch'}),agent=store.createAgent(project.id,{title:'Monitor',engine:'codex',conversationId:chat.id});
 const other=parallel?store.createAgent(project.id,{title:'Second monitor',engine:'claude',conversationId:chat.id}):undefined;
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Check a feed',entry:parallel?'fork':'watch',trigger:{kind:'manual'},steps:[{id:'watch',kind:'agent',target:{kind:'persistent_organization',ref:'monitor'},instructions:'Check for updates'},...(parallel?[{id:'other',kind:'agent',target:{kind:'persistent_organization',ref:'other'},instructions:'Check another feed'}]:[])],controls:parallel?[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['left','right']}]:[],edges:parallel?[{id:'left',from:'fork',to:'watch',on:'selected'},{id:'right',from:'fork',to:'other',on:'selected'},{id:'finishLeft',from:'watch',to:'join',on:'success'},{id:'finishRight',from:'other',to:'join',on:'success'}]:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{monitor:agent.id,...(other?{other:other.id}:{})},directories:{}}});
 const trigger=branches.triggers.createTriggerDefinition({branchId:branch.id,projectId:project.id,conversationId:chat.id,name:'Check every minute',instructions:'Check for updates',sourceKind:'schedule',sourceConfig:{scheduleKind:'interval',intervalMinutes:1},enabled:true});
 const execution=branches.accept(branch.id,'start','Check now');for(let i=0;i<4;i++)branches.advance();
 const attempt=branches.detail(execution.id).attempts[0],now='2030-01-01T00:00:00.000Z';
 const lease=coordination.leaseNextRun({workerId:'controlled-scheduler',now});assert.ok(lease);coordination.markRunStarted(lease.runId,lease.fencingToken,now);
 coordination.preparePromptInjection({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken,prompt:'Initial Request',now});
 coordination.markPromptSubmitted({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken,now});
 coordination.acknowledgePromptInjection({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken,now});
 let passed=false;t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained schedule fixture: ${root}`)});
 const binding={runId:lease.runId,attemptId:attempt.id,fence:lease.fencingToken};
 function occurrence(id='tick',override={}) {
  const config={schedule:{policy:'update_current',firstScheduledAt:now,lastScheduledAt:now,eventCount:1,delivery:'steering'},steering:{...binding,...override}};
  store.sqlite.prepare(`INSERT INTO trigger_occurrences(id,trigger_id,occurrence_key,project_id,branch_id,scope_key,payload_json,provenance_json,trigger_snapshot_json,input_hash,activation_config_json,state,available_at,occurred_at,created_at,updated_at)
   VALUES(?,?,?,?,?,?,'{"check":"Latest café 🌲"}','{"source":"schedule"}','{}','tick',?,'pending',?,?,?,?)`).run(id,trigger.id,id,project.id,branch.id,`branch:${branch.id}`,JSON.stringify(config),now,now,now,now);
  return id;
 }
 function queue(id='tick') {return coordination.queueBranchScheduleUpdate({occurrenceId:id,...binding,now});}
 function steer() {return coordination.leaseNextSteering({workerId:'controlled-scheduler',now});}
 return {get store(){return store},get coordination(){return coordination},get branches(){return branches},reopen(){store.close();store=new AgentStore(root);coordination=new CoordinationV3Store(store.sqlite,authority?{canonicalTaskDecisions:()=>decisions}:{});branches=new BranchStore(store.sqlite,coordination)},project,chat,agent,branch,trigger,execution,attempt,lease,binding,now,decisions,occurrence,queue,steer,pass(){passed=true}};
}

function prepare(f,steer) {
 f.coordination.preparePromptInjection({injectionId:steer.injectionId,runId:steer.runId,fencingToken:steer.fencingToken,prompt:'Latest check',now:f.now});
}

test('scheduled update uses the exact Request-owned Run and durable source/outbox exactly once',t=>{
 const f=fixture(t);assert.deepEqual(f.coordination.branchScheduleUpdateTarget(f.branch.id,f.now),{...f.binding,executionId:f.execution.id});
 const id=f.occurrence(),first=f.queue(),again=f.queue();assert.equal(again.activationId,first.activationId);assert.equal(again.replayed,true);
 assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM activation_outbox WHERE activation_id=?").get(first.activationId).n,1);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,1);
 assert.equal(f.coordination.branchScheduleUpdateStatus(id,f.now).state,'queued');
 const steer=f.steer();assert.equal(steer.runId,f.lease.runId);assert.deepEqual(steer.activationIds,[first.activationId]);assert.equal(steer.activations[0].promptClass,'ordinary');assert.deepEqual(steer.activations[0].payload.occurrence.payload,{check:'Latest café 🌲'});assert.deepEqual(steer.activations[0].payload.occurrence.provenance,{source:'schedule'});
 prepare(f,steer);f.coordination.markPromptSubmitted({...steer,now:f.now});assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate(id,f.now),false);
 f.coordination.acknowledgePromptInjection({...steer,now:f.now});assert.equal(f.coordination.branchScheduleUpdateStatus(id,f.now).state,'acknowledged');
 assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate(id,f.now),false);f.pass();
});

test('no fallback Run or retargeting after the exact workflow Request ends, including ordinary coalescing',t=>{
 const f=fixture(t);f.occurrence();const update=f.queue();
 f.coordination.updateRequest({requestId:f.attempt.requestId,updateId:'done',kind:'completed',actor:{kind:'agent',id:f.agent.id},payload:{text:'Done'},now:f.now});
 f.coordination.completeRun(f.lease.runId,f.lease.fencingToken,f.now);
 assert.equal(f.coordination.branchScheduleUpdateStatus('tick',f.now).state,'not_delivered');
 assert.equal(f.coordination.leaseNextRun({workerId:'controlled-scheduler',now:f.now}),undefined);
 f.coordination.enqueueMessageActivation({projectId:f.project.id,agentId:f.agent.id,scopeKey:`conversation:${f.chat.id}`,messageId:'unrelated',kind:'human',payload:{text:'Other work'},now:f.now});
 const other=f.coordination.leaseNextRun({workerId:'controlled-scheduler',now:f.now});assert.ok(other);assert.ok(!other.activationIds.includes(update.activationId));f.coordination.markRunStarted(other.runId,other.fencingToken,f.now);
 assert.equal(f.steer(),undefined);assert.equal(f.queue().activationId,update.activationId);assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate('tick',f.now),true);f.pass();
});

test('known non-delivery is cancellable; submitted or unknown steering cannot be replayed or automatically recovered',t=>{
 const f=fixture(t);f.occurrence();f.queue();const first=f.steer();prepare(f,first);f.coordination.markPromptSubmitted({...first,now:f.now});
 f.coordination.deferSteering({...first,preserveSteering:true,waitReason:'provider_unsupported',now:f.now});
 assert.equal(f.coordination.branchScheduleUpdateStatus('tick',f.now).state,'not_delivered');assert.equal(f.steer(),undefined,'Known rejection must not auto-steer the same event again');assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate('tick',f.now),true);
 f.occurrence('next');const queued=f.queue('next'),second=f.steer();prepare(f,second);f.coordination.markPromptSubmitted({...second,now:f.now});
 f.coordination.markSteeringOutcomeUnknown({...second,now:f.now});assert.equal(f.coordination.branchScheduleUpdateStatus('next',f.now).state,'outcome_unknown');
 assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate('next',f.now),false);assert.equal(f.queue('next').activationId,queued.activationId);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_steering_recoveries').get().n,0);assert.equal(f.coordination.branchScheduleUpdateTarget(f.branch.id,f.now),undefined);
 assert.equal(f.steer(),undefined);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,1);f.pass();
});

test('schedule steering never shares automatic human recovery, even when coalesced sources target the same Agent',t=>{
 const f=fixture(t);f.occurrence();const queued=f.queue();
 const human=f.coordination.enqueueMessageActivation({projectId:f.project.id,agentId:f.agent.id,scopeKey:`conversation:${f.chat.id}`,messageId:'human',kind:'human',payload:{text:'Human message'},now:f.now});
 const steer=f.steer();assert.ok(steer);assert.ok(!steer.activationIds.includes(queued.activationId));assert.ok(steer.activations.every(a=>a.kind!=='branch_schedule_update'));
 f.coordination.deferSteering({...steer,preserveSteering:true,retryDelayMs:60000,now:f.now});
 const scheduled=f.steer();assert.deepEqual(scheduled.activationIds,[queued.activationId]);prepare(f,scheduled);f.coordination.markSteeringOutcomeUnknown({...scheduled,now:f.now});
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_steering_recoveries').get().n,0);f.pass();
});

test('current ownership, fences, Branch ambiguity, canonical Decisions and approval availability are rechecked before delivery',t=>{
 const f=fixture(t);f.occurrence();f.queue();
 const pending={id:'approval',status:'pending',agentId:f.agent.id,projectId:f.project.id,conversationId:f.chat.id,runId:f.lease.runId};f.decisions.push(pending);
 assert.equal(f.coordination.branchScheduleUpdateTarget(f.branch.id,f.now),undefined);assert.equal(f.steer(),undefined);f.decisions.length=0;
 const steer=f.steer();assert.ok(steer);
 f.decisions.push(pending);assert.throws(()=>prepare(f,steer),/no longer eligible/);f.decisions.length=0;prepare(f,steer);
 f.decisions.push(pending);assert.throws(()=>f.coordination.markPromptSubmitted({...steer,now:f.now}),/no longer eligible/);f.decisions.length=0;
 const another=f.branches.accept(f.branch.id,'second','Existing queued work');assert.ok(another);assert.equal(f.coordination.branchScheduleUpdateTarget(f.branch.id,f.now).runId,f.lease.runId,'Preserved queued backlog does not block the sole working target');
 f.coordination.updateRequest({requestId:f.attempt.requestId,updateId:'blocked',kind:'waiting_dependency',actor:{kind:'agent',id:f.agent.id},payload:{text:'Waiting for dependency'},now:f.now});
 assert.throws(()=>f.coordination.markPromptSubmitted({...steer,now:f.now}),/no longer eligible/);
 f.pass();
});

test('missing canonical approval authority, wrong binding and fenced Runs fail closed',t=>{
 const absent=fixture(t,{authority:false});assert.equal(absent.coordination.branchScheduleUpdateTarget(absent.branch.id,absent.now),undefined);absent.occurrence();assert.throws(()=>absent.queue(),/unavailable/);absent.pass();
 const f=fixture(t);f.occurrence('wrong',{fence:f.binding.fence+1});assert.throws(()=>f.queue('wrong'),/binding changed/);
 f.occurrence();f.queue();f.coordination.fenceRunSideEffects(f.lease.runId,f.lease.fencingToken,'controlled-scheduler',f.now);
 assert.equal(f.steer(),undefined);assert.equal(f.coordination.branchScheduleUpdateStatus('tick',f.now).state,'not_delivered');assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate('tick',f.now),true);f.pass();
});

test('two actually working workflow Agent Runs are ambiguous; queued executions alone are not',t=>{
 const f=fixture(t,{parallel:true});const second=f.coordination.leaseNextRun({workerId:'controlled-scheduler',now:f.now});assert.ok(second);
 f.coordination.markRunStarted(second.runId,second.fencingToken,f.now);assert.equal(f.coordination.branchScheduleUpdateTarget(f.branch.id,f.now),undefined);
 f.pass();
});

test('restart preserves unknown scheduled delivery and never converts a Run fence or completion into an acknowledgement',t=>{
 const f=fixture(t);f.occurrence();const update=f.queue(),steer=f.steer();prepare(f,steer);f.coordination.markPromptSubmitted({...steer,now:f.now});
 f.reopen();const recovered=f.coordination.recoverOrphanedRuns('replacement-scheduler',f.now);assert.equal(recovered.outcomeUnknown,1);
 const status=f.coordination.branchScheduleUpdateStatus('tick',f.now);assert.equal(status.state,'outcome_unknown');assert.equal(status.activationId,update.activationId);
 assert.equal(f.coordination.cancelUndeliveredBranchScheduleUpdate('tick',f.now),false);assert.equal(f.coordination.leaseNextRun({workerId:'replacement-scheduler',now:f.now}),undefined);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_steering_recoveries').get().n,0);f.pass();
});

test('canceling a workflow recognizes its exact already-attached schedule steering',t=>{
 const f=fixture(t);f.occurrence();f.queue();const steering=f.steer();assert.ok(steering);prepare(f,steering);f.coordination.markPromptSubmitted({...steering,now:f.now});f.coordination.acknowledgePromptInjection({...steering,now:f.now});
 f.branches.cancel(f.execution.id,f.now);const [operation]=f.coordination.claimProviderOperations('cleanup',20,f.now);assert.ok(operation);assert.equal(operation.runId,f.lease.runId);
 f.coordination.completeProviderOperation(operation.id,'cleanup',f.now);f.branches.advance(f.now);assert.equal(f.branches.execution(f.execution.id).state,'canceled');f.pass();
});
