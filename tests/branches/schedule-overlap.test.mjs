import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {fixture as serverFixture,until} from '../shared/fixture.mjs';

function setup(t,policy,{agentStep=false}={}){
 const root=mkdtempSync(path.join(tmpdir(),'branch-scheduled-overlap-'));let store,branches,coordination,passed=false;
 const open=()=>{store=new AgentStore(root);coordination=new CoordinationV3Store(store.sqlite,{canonicalTaskDecisions:()=>[]});branches=new BranchStore(store.sqlite,coordination)};open();
 t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained scheduled fixture: ${root}`)});
 let clock=new Date().toISOString();const now=clock,config={scheduleKind:'interval',everyMs:60000,startsAt:now,...(policy?{whenRunning:policy}:{})};
 const owner=agentStep?{name:'Scheduled document review'}:branches.create('Scheduled document review','create'),project=agentStep?store.createProject({label:'Scheduled reviews',hostPath:root,defaultEngine:'codex'}):undefined,chat=project?store.createConversation(project.id,{title:'Scheduled review team'}):undefined,agent=chat?store.createAgent(project.id,{title:'Document Reviewer',engine:'codex',conversationId:chat.id}):undefined;
 const definition={schema:'ponderosa.branch.v1',name:owner.name,trigger:{kind:'schedule',configRef:'source'},entry:'review',steps:[agentStep?{id:'review',kind:'agent',label:'Review Document',target:{kind:'persistent_agent',ref:'worker'},instructions:'Review the document and report the result'}:{id:'review',kind:'human_gate',label:'Review Document',prompt:'Approve the latest document',editable:true}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const bindings={agents:agent?{worker:agent.id}:{},directories:{},triggers:{source:{enabled:true,sourceConfig:config}}};
 let branch=branches.deploy({...(agentStep?{}:{branchId:owner.id,expectedVersionId:''}),chatId:chat?.id??'',idempotencyKey:'publish',definition,bindings},now,{sourceConfig:config,nextFireAt:now});
 return {agent,chat,project,get now(){return clock},get store(){return store},get branches(){return branches},get coordination(){return coordination},get branch(){return branch},definition,bindings,
  tick(){const source=branches.trigger(branch.id),at=source.nextFireAt,next=new Date(Date.parse(at)+60000).toISOString();clock=at;return branches.triggers.recordScheduledTriggerOccurrence({triggerId:source.id,occurrenceKey:`schedule:${at}:${at}`,expectedNextFireAt:at,nextFireAt:next,lastFiredAt:at,payload:{scheduledTimes:[at],missedCount:1},provenance:{source:'schedule',evaluatedAt:at},now:at})},
  advance(){branches.advance(clock)},
  start(){branches.advance(clock);const lease=coordination.leaseNextRun({workerId:'schedule-test',now:clock,leaseMs:3600000});assert.ok(lease);coordination.markRunStarted(lease.runId,lease.fencingToken,clock);coordination.preparePromptInjection({injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken,prompt:'Original review',now:clock});coordination.markPromptSubmitted({...lease,now:clock});coordination.acknowledgePromptInjection({...lease,now:clock});return lease},
  claimUpdate(){const lease=coordination.leaseNextSteering({workerId:'schedule-test',now:clock});assert.ok(lease);coordination.preparePromptInjection({...lease,prompt:'Latest scheduled input',now:clock});return lease},
  completeAgent(lease,id){const attempt=branches.detail(id).attempts.find(a=>a.requestId);coordination.updateRequest({requestId:attempt.requestId,updateId:randomUUID(),kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'Review completed'},now:clock});coordination.completeRun(lease.runId,lease.fencingToken,clock);branches.advance(clock)},
  finish(id){const gate=branches.detail(id).gates.find(g=>g.state==='waiting');assert.ok(gate);branches.resolveGate(gate.id,{commandKey:randomUUID(),expectedRevision:gate.revision,decision:'approve'},clock);branches.advance(clock)},
  reopen(){store.close();open()},
  change(policy){const config={...branches.trigger(branch.id).sourceConfig,whenRunning:policy};branch=branches.deploy({branchId:branch.id,expectedVersionId:branch.versionId,chatId:'',idempotencyKey:randomUUID(),definition,bindings:{...bindings,triggers:{source:{enabled:true,sourceConfig:config}}}},new Date().toISOString(),{sourceConfig:config,nextFireAt:branches.trigger(branch.id).nextFireAt});return branch},
  runs(){return store.sqlite.prepare('SELECT id,state,input_text FROM branch_executions WHERE branch_id=? ORDER BY rowid').all(branch.id)},
  pending(){return branches.triggers.listTriggerOccurrences(branch.triggerId).filter(e=>e.state==='pending')},pass(){passed=true}};
}

test('existing repeating schedules preserve Queue Every Run; each tick retains a separate accepted occurrence',t=>{
 const f=setup(t);for(let i=0;i<4;i++)f.tick();assert.equal(f.runs().length,4);assert.equal(f.pending().length,0);assert.ok(f.runs().every(r=>r.state==='queued'));assert.equal(f.branches.trigger(f.branch.id).sourceConfig.whenRunning,undefined);f.pass();
});

test('latest scheduled checks survive reopening, combine immutably, and release exactly one latest Run after unfinished work',t=>{
 const f=setup(t,'run_latest');f.tick();assert.equal(f.runs().length,0,'A held check is not yet an execution');f.advance();const first=f.runs()[0];assert.equal(first.state,'waiting');
 const second=f.tick(),original=f.branches.triggers.getTriggerOccurrence(second.occurrenceId);f.tick();assert.equal(f.runs().length,1);assert.equal(f.pending().length,1);const latest=f.pending()[0];assert.equal(latest.schedule.eventCount,2);assert.equal(latest.schedule.firstScheduledAt,original.schedule.firstScheduledAt);
 const combined=f.branches.triggers.getTriggerOccurrence(original.id);assert.equal(combined.schedule.delivery,'combined');assert.equal(combined.schedule.combinedIntoOccurrenceId,latest.id);assert.deepEqual(combined.payload,original.payload);assert.deepEqual(combined.triggerSnapshot,original.triggerSnapshot);assert.equal(combined.inputHash,original.inputHash);
 f.reopen();for(let i=0;i<5;i++)f.advance();assert.equal(f.runs().length,1);assert.equal(f.pending().length,1);f.finish(first.id);for(let i=0;i<3;i++)f.advance();const runs=f.runs();assert.equal(runs.length,2);assert.equal(runs[0].state,'completed');assert.equal(runs[1].state,'waiting');assert.deepEqual(JSON.parse(runs[1].input_text).payload,latest.payload);assert.equal(f.pending().length,0);for(let i=0;i<5;i++)f.advance();assert.equal(f.runs().length,2);f.pass();
});

test('policy changes preserve the queued backlog and manual Runs remain separate without changing the schedule',t=>{
 const f=setup(t);for(let i=0;i<4;i++)f.tick();const ids=f.runs().map(r=>r.id),nextFire=f.branches.trigger(f.branch.id).nextFireAt;const review=f.branches.preview({branchId:f.branch.id,expectedVersionId:f.branch.versionId,chatId:'',idempotencyKey:'preview',definition:f.definition,bindings:{...f.bindings,triggers:{source:{enabled:true,sourceConfig:{...f.bindings.triggers.source.sourceConfig,whenRunning:'run_latest'}}}}});assert.ok(review.notes.some(text=>/4 already queued Runs remain/.test(text)));f.change('run_latest');assert.equal(f.branches.trigger(f.branch.id).nextFireAt,nextFire);assert.deepEqual(f.runs().map(r=>r.id),ids);
 f.tick();f.tick();assert.equal(f.runs().length,4);assert.equal(f.pending().length,1);const beforeManual=f.branches.trigger(f.branch.id),manual=f.branches.accept(f.branch.id,'separate-manual','Manual input — résumé 😀');assert.equal(manual.admissionSource,'manual');assert.equal(f.runs().length,5);assert.deepEqual(f.branches.trigger(f.branch.id),beforeManual);
 for(let i=0;i<5;i++){f.advance();const active=f.runs().find(r=>r.state==='waiting');assert.ok(active);f.finish(active.id)}for(let i=0;i<3;i++)f.advance();assert.equal(f.runs().length,6);assert.equal(f.pending().length,0);assert.ok(ids.every(id=>f.runs().find(r=>r.id===id).state==='completed'));f.pass();
});

test('Update Current Run retains one latest check behind an approval and never starts provider work to simulate steering',t=>{
 const f=setup(t,'update_current');f.tick();f.advance();f.tick();f.tick();for(let i=0;i<5;i++)f.advance();assert.equal(f.runs().length,1);assert.equal(f.pending().length,1);assert.equal(f.pending()[0].schedule.eventCount,2);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);f.finish(f.runs()[0].id);for(let i=0;i<2;i++)f.advance();assert.equal(f.runs().length,2);f.pass();
});

test('schedule policy-only publication preserves the exact fire cursor',async t=>{
 const f=await serverFixture();let passed=false;t.after(async()=>{await f.dispose(passed)});const owner=f.ok(await f.api('POST','/api/branches',{name:'Cadence',idempotencyKey:randomUUID()}));
 const config={scheduleKind:'interval',everyMs:60000,startsAt:new Date(Date.now()+600000).toISOString()},definition={schema:'ponderosa.branch.v1',name:'Cadence',trigger:{kind:'schedule',configRef:'source'},entry:'review',steps:[{id:'review',kind:'human_gate',prompt:'Review',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings={agents:{},directories:{},triggers:{source:{enabled:true,sourceConfig:config}}};
 let input={branchId:owner.id,expectedVersionId:'',chatId:'',idempotencyKey:randomUUID(),definition,bindings},branch=f.ok(await f.api('POST','/api/branches/deploy',input));const before=f.ok(await f.api('GET',`/api/branches/${branch.id}/trigger`));
 input={...input,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),bindings:{...bindings,triggers:{source:{enabled:true,sourceConfig:{...config,whenRunning:'run_latest'}}}}};branch=f.ok(await f.api('POST','/api/branches/deploy',input));const after=f.ok(await f.api('GET',`/api/branches/${branch.id}/trigger`));assert.equal(after.nextFireAt,before.nextFireAt);assert.equal(after.sourceConfig.whenRunning,'run_latest');passed=true;
});


test('a rejected in-flight update combines into the newer latest check and cannot release two Runs',t=>{
 const f=setup(t,'update_current',{agentStep:true});f.tick();f.advance();const original=f.runs()[0],lease=f.start();f.tick();f.advance();const update=f.claimUpdate();f.tick();assert.equal(f.pending().length,2);
 f.coordination.deferSteering({...update,preserveSteering:true,waitReason:'provider_unsupported',now:f.now});for(let i=0;i<3;i++)f.advance();assert.equal(f.pending().length,1);assert.equal(f.pending()[0].schedule.eventCount,2);assert.equal(f.runs().length,1);const latest=f.pending()[0];f.reopen();for(let i=0;i<3;i++)f.advance();assert.equal(f.pending().length,1);assert.equal(f.pending()[0].id,latest.id);f.completeAgent(lease,original.id);for(let i=0;i<3;i++)f.advance();assert.equal(f.runs().length,2);assert.equal(f.pending().length,0);assert.deepEqual(JSON.parse(f.runs()[1].input_text).payload,latest.payload);f.pass();
});

test('completion before the rejected update is revisited cannot admit the newer check first',t=>{
 const f=setup(t,'update_current',{agentStep:true});
 f.tick();f.advance();const original=f.runs()[0],lease=f.start();
 f.tick();f.advance();const update=f.claimUpdate();f.tick();
 f.coordination.deferSteering({...update,preserveSteering:true,waitReason:'provider_unsupported',now:f.now});
 // The scan cursor is past A. B is seen first while A still owns delivery.
 f.completeAgent(lease,original.id);
 assert.equal(f.runs().length,1);
 for(let i=0;i<4;i++)f.advance();
 assert.equal(f.runs().length,2);assert.equal(f.pending().length,0);
 const checks=f.branches.triggers.listTriggerOccurrences(f.branch.triggerId);
 const replacement=checks.find(check=>check.branchExecutionId===f.runs()[1].id);
 assert.equal(replacement.schedule.eventCount,2);
 f.reopen();for(let i=0;i<3;i++)f.advance();assert.equal(f.runs().length,2);f.pass();
});

test('final workflow deletion retires unresolved checks only after cleanup and preserves uncertainty evidence',t=>{
 const f=setup(t,'update_current',{agentStep:true});
 f.tick();f.advance();const original=f.runs()[0],lease=f.start();
 f.tick();f.advance();const update=f.claimUpdate();
 f.coordination.markPromptSubmitted({...update,now:f.now});
 f.coordination.markSteeringOutcomeUnknown({...update,now:f.now});f.advance();
 const unknown=f.pending().find(check=>check.schedule.delivery==='unconfirmed');assert.ok(unknown);
 assert.throws(()=>f.branches.deleteBranch(f.branch.id),/Cancel and drain/);
 assert.equal(f.branches.triggers.getTriggerOccurrence(unknown.id).state,'pending');
 f.completeAgent(lease,original.id);f.branches.beginDeletion(f.branch.id);f.branches.publishAudit(()=>{});
 f.branches.deleteBranch(f.branch.id);
 const retired=f.branches.triggers.getTriggerOccurrence(unknown.id);
 assert.equal(retired.state,'cancelled');assert.equal(retired.schedule.delivery,'unconfirmed');
 assert.match(retired.lastError,/unconfirmed delivery remains/);
 assert.equal(f.store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(update.injectionId).state,'outcome_unknown');
 f.reopen();for(let i=0;i<3;i++)f.advance();assert.equal(f.pending().length,0);assert.equal(f.runs().length,0);f.pass();
});

for(const applied of [true,false])test(`unknown update reconciliation (${applied?'applied':'not applied'}) survives restart and replays its exact decision once`,t=>{
 const f=setup(t,'update_current',{agentStep:true});f.tick();f.advance();const original=f.runs()[0],lease=f.start();f.tick();f.advance();const update=f.claimUpdate();f.coordination.markPromptSubmitted({...update,now:f.now});f.coordination.markSteeringOutcomeUnknown({...update,now:f.now});f.advance();const unknown=f.pending().find(e=>e.schedule.delivery==='unconfirmed');assert.ok(unknown);f.tick();f.advance();assert.equal(f.runs().length,1);assert.equal(f.pending().length,2);assert.equal(f.branches.currentActions(original.id).items[0].kind,'schedule_update');
 f.reopen();f.advance();const current=f.branches.execution(original.id),intent={commandKey:randomUUID(),expectedRevision:current.revision,action:'resolve_schedule_update',occurrenceId:unknown.id,externalEffectsReconciled:true,updateApplied:applied,reason:'Inspected the provider input and resulting work'};
 assert.throws(()=>f.branches.intervene(original.id,{...intent,externalEffectsReconciled:false}),/Reconcile/);assert.throws(()=>f.branches.intervene(original.id,{...intent,occurrenceId:'foreign'}),/no longer/);
 const first=f.branches.intervene(original.id,intent),replay=f.branches.intervene(original.id,intent);assert.deepEqual(replay,first);assert.equal(f.pending().length,1);assert.equal(f.pending()[0].schedule.eventCount,applied?1:2);assert.equal(f.store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(update.injectionId).state,'outcome_unknown','Historical uncertainty remains in audit');
 assert.ok(!f.branches.currentActions(original.id).items.some(x=>x.kind==='schedule_update'));f.advance();if(applied){const next=f.claimUpdate();assert.equal(next.runId,lease.runId);f.coordination.markPromptSubmitted({...next,now:f.now});f.coordination.acknowledgePromptInjection({...next,now:f.now});f.advance();assert.equal(f.pending().length,0)}else{f.completeAgent(lease,original.id);for(let i=0;i<3;i++)f.advance();assert.equal(f.runs().length,2);assert.equal(f.pending().length,0)}f.pass();
});

for(const engine of ['codex','claude'])test(`scheduled updates use the existing ${engine} dispatch, exact Run, and operator uncertainty reconciliation`,async t=>{
 let store,loseAcknowledgement=false;const f=await serverFixture({diagnosticProvider:true,steeringResponse:()=>{if(loseAcknowledgement)throw new Error('Controlled lost steering acknowledgement');return {status:'accepted'}},storeFactory:dir=>(store=new AgentStore(dir))});let passed=false;t.after(async()=>{if(!passed)t.diagnostic(JSON.stringify({root:f.root,events:store.sqlite.prepare('SELECT state,last_error,activation_config_json FROM trigger_occurrences').all(),activations:store.sqlite.prepare('SELECT kind,state,last_delivery_error FROM agent_activations').all(),injections:store.sqlite.prepare('SELECT state,prompt_hash FROM scheduler_prompt_injections').all()}));await f.dispose(passed)});
 const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)),owner=f.ok(await f.api('POST','/api/branches',{name:`Scheduled ${engine} review`,idempotencyKey:randomUUID()})),chat=f.ok(await f.api('POST',`/api/branches/${owner.id}/chats`,{label:'Review team',defaultEngine:engine},{'idempotency-key':randomUUID()})),agent=f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:'Reviewer',engine,conversationId:chat.id,idempotencyKey:randomUUID()}));
 f.plans.set(agent.id,[{hold:true,output:false}]);const config={scheduleKind:'interval',everyMs:60000,startsAt:new Date(Date.now()+86400000).toISOString(),whenRunning:'update_current'},definition={schema:'ponderosa.branch.v1',name:`Scheduled ${engine} review`,trigger:{kind:'schedule',configRef:'source'},entry:'review',steps:[{id:'review',kind:'agent',target:{kind:'persistent_agent',ref:'reviewer'},instructions:'Review the latest document and report the canonical outcome'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const branch=f.ok(await f.api('POST','/api/branches/deploy',{branchId:owner.id,expectedVersionId:'',chatId:'',idempotencyKey:randomUUID(),definition,bindings:{agents:{reviewer:agent.id},directories:{},triggers:{source:{enabled:true,sourceConfig:config}}}})),run=f.ok(await f.api('POST',`/api/branches/${branch.id}/executions`,{occurrenceKey:randomUUID(),input:'Original document'}));await until(()=>f.turns.some(x=>x.agentId===agent.id)&&f.sessions.has(agent.id),'actual controlled provider Run');
 const originalRun=store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agent.id).id;
 const tick=text=>{const now=new Date().toISOString();branches.triggers.updateTriggerDefinition(branch.triggerId,{nextFireAt:now});return branches.triggers.recordScheduledTriggerOccurrence({triggerId:branch.triggerId,expectedNextFireAt:now,nextFireAt:new Date(Date.now()+86400000).toISOString(),lastFiredAt:now,occurrenceKey:randomUUID(),payload:{scheduledTimes:[now],missedCount:1,text},provenance:{source:'schedule',evaluatedAt:now},now})};
 const first=tick('Latest complete input — café 🌲');await until(()=>branches.triggers.getTriggerOccurrence(first.occurrenceId).state==='activated','provider steering acknowledged',10000);assert.equal(f.steers.length,1);assert.ok(JSON.stringify(f.steers[0].input).includes('Latest complete input — café 🌲'));assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions WHERE branch_id=?').get(branch.id).n,1);assert.equal(store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agent.id).id,originalRun);
 assert.deepEqual(f.ok(await f.api('GET',`/api/branches/${branch.id}/lifecycle`)).runCounts,{running:1,waiting:0,queued:0});
 loseAcknowledgement=true;const second=tick('Check after acknowledgement loss');await until(()=>branches.triggers.getTriggerOccurrence(second.occurrenceId).schedule.delivery==='unconfirmed','durable unconfirmed steering',10000);const actions=f.ok(await f.api('GET',`/api/branch-executions/${run.id}/actions`));assert.equal(actions.items[0].kind,'schedule_update');const intent={commandKey:randomUUID(),expectedRevision:branches.execution(run.id).revision,action:'resolve_schedule_update',occurrenceId:second.occurrenceId,externalEffectsReconciled:true,updateApplied:true,reason:'Controlled fixture confirms this scheduled input was applied once'};f.ok(await f.api('POST',`/api/branch-executions/${run.id}/intervene`,intent));f.ok(await f.api('POST',`/api/branch-executions/${run.id}/intervene`,intent));loseAcknowledgement=false;
 assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_steering_recoveries').get().n,0);assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions WHERE branch_id=?').get(branch.id).n,1);
 const third=tick('Next distinct scheduled check');await until(()=>branches.triggers.getTriggerOccurrence(third.occurrenceId).state==='activated','steering resumes after explicit reconciliation',10000);assert.equal(f.steers.length,3);assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n,1);passed=true;
});
