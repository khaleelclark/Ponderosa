import {BranchInstallationService} from '../dist/branch-installation-service.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { AgentStore, CoordinationV3Store, BranchStore, WorkspaceStore } from '@ponderosa/agents';
import { BranchScriptService } from '../dist/branch-script-service.js';
import { CoordinationV3Scheduler } from '../dist/coordination-v3-scheduler.js';
import { registerBranchRoutes } from '../dist/routes/branches.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,source,timeoutMs=5000) {
 const dir=mkdtempSync(join(tmpdir(),'branch-script-'));
 let store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const owner=branches.create('Script','owner');
 const project=store.createProject({label:'Test',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:owner.id}),chat=store.getConversation(project.lastConversationId);
 let worker=new BranchScriptService(branches,store,'test-worker');
 let scheduler=new CoordinationV3Scheduler(coordination,async()=>{throw new Error('Script must never dispatch a provider Run')},{workerId:'test-worker',workflowOperations:worker});
 const app=Fastify();registerBranchRoutes(app,{branches,store,installations:new BranchInstallationService(store,branches,async()=>{},async()=>{}),sources:{async refresh(){},async applyDefinitionChange(){},async reconcileBranch(){}},notify(){}});
 t.after(async()=>{await scheduler.stop();await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const request={chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Script',trigger:{kind:'manual'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',source,cwdRef:'root',timeoutMs}],controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir}}};
 const deployed=await app.inject({method:'POST',url:'/api/branches/deploy',payload:request});assert.equal(deployed.statusCode,200,deployed.body);
 const branch=deployed.json();
 const execution=branches.accept(branch.id,'event','a🙂b\n$(do-not-execute)');
 return {app,get store(){return store},get coordination(){return coordination},get branches(){return branches},get worker(){return worker},get scheduler(){return scheduler},execution,branch,chat,project,dir,
 reopen(){store=new AgentStore(dir);coordination=new CoordinationV3Store(store.sqlite);branches=new BranchStore(store.sqlite,coordination);worker=new BranchScriptService(branches,store,'restarted-worker');scheduler=new CoordinationV3Scheduler(coordination,async()=>{throw new Error('Unexpected provider dispatch')},{workerId:'restarted-worker',workflowOperations:worker});}};
}
async function terminal(f) {
 for(let i=0;i<150;i++){await f.scheduler.drainOnce();const e=f.branches.execution(f.execution.id);if(['completed','failed','canceled','waiting'].includes(e.state))return e;await delay(20)}
 throw new Error('execution did not settle');
}
test('existing scheduler supervises immutable script and exact stdin without a provider Run',async t=>{
 const f=await fixture(t,`let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(text);`);
 const result=await terminal(f);assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(result.output,'a🙂b\n$(do-not-execute)');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE kind='script_process_exit'").get().n,1);
});
test('pause queues scripts; cancel waits for observed exit and fences late result',async t=>{
 const f=await fixture(t,`import {writeFileSync} from 'node:fs';process.stderr.write('cleanup evidence');writeFileSync('started','yes');setInterval(()=>{},1000);await new Promise(()=>{});`,15000);
 await f.scheduler.pauseLeasing();await f.scheduler.drainOnce();assert.equal(f.branches.execution(f.execution.id).state,'queued');
 f.scheduler.resumeLeasing();await f.scheduler.drainOnce();
 for(let i=0;i<100&&!existsSync(join(f.dir,'started'));i++)await delay(20);
 assert.ok(existsSync(join(f.dir,'started')));
 assert.equal(f.branches.detail(f.execution.id).steps[0].state,'running');
 f.branches.cancel(f.execution.id);assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 await f.scheduler.drainOnce();assert.equal(f.branches.execution(f.execution.id).state,'canceled');
 const evidence=f.store.sqlite.prepare("SELECT evidence_json FROM branch_checkpoints WHERE kind='script_process_exit'").get();
 assert.equal(JSON.parse(evidence.evidence_json).stderr,'cleanup evidence');
});
test('Branch-owned Chats require a reviewed removal and execution drain',async t=>{
 const f=await fixture(t,`console.log('done')`);
 assert.throws(()=>f.store.markConversationDeletionPending(f.chat.id),/Branch|drain/);
 await terminal(f);
 assert.throws(()=>f.store.markConversationDeletionPending(f.chat.id),/Branch|drain/);
});

test('output limit fails visibly and does not advance downstream work',async t=>{
 const f=await fixture(t,`process.stdout.write('x'.repeat(100000));`);
 const result=await terminal(f);assert.equal(result.state,'failed');assert.match(result.output,/limit/);
});
test('actual daemon death leaves script outcome unknown and never repeats its external effect',async t=>{
 const {fork}=await import('node:child_process');
 const {readFileSync}=await import('node:fs');
 const f=await fixture(t,`import {appendFileSync} from 'node:fs';appendFileSync('effects','once\\n');setInterval(()=>{},1000);`,15000);
 await f.scheduler.stop();f.store.close();
 const child=fork(new URL('./branch-crash-worker.mjs',import.meta.url),[f.dir],{stdio:['ignore','ignore','inherit','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('worker exited '+code)));});
 for(let i=0;i<100&&!existsSync(join(f.dir,'effects'));i++)await delay(20);
 assert.ok(existsSync(join(f.dir,'effects')));
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;f.reopen();
 await f.worker.tick(true);
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 assert.match(f.branches.execution(f.execution.id).waitReason,/unknown/);
 await f.worker.tick(true);assert.equal(readFileSync(join(f.dir,'effects'),'utf8'),'once\n');
});
test('persistent organization Request result flows into supervised Script and settles once',async t=>{
 const f=await fixture(t,`console.log('unused')`);f.branches.cancel(f.execution.id);
 const agent=f.store.createAgent(f.project.id,{title:'Organization entry',engine:'codex',conversationId:f.chat.id});
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'organization',definition:{schema:'ponderosa.branch.v1',name:'Organization',trigger:{kind:'manual'},entry:'work',controls:[],steps:[{id:'work',kind:'agent',target:{kind:'persistent_organization',ref:'root'},instructions:'Return the summary in the Request result'},{id:'format',kind:'script',runtime:'node',source:`let text='';for await(const c of process.stdin)text+=c;process.stdout.write('Checked: '+text);`,cwdRef:'workspace',timeoutMs:5000}],edges:[{id:'next',from:'work',to:'format',on:'success'}],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},bindings:{agents:{root:agent.id},directories:{workspace:f.dir}}});
 const execution=f.branches.accept(branch.id,'one','source');await f.worker.tick(true);
 const request=f.branches.detail(execution.id).attempts[0].requestId;
 assert.ok(request);assert.equal(f.branches.detail(execution.id).steps.length,1);
 const operations=await f.app.inject({method:"GET",url:`/api/branch-executions/${execution.id}/operations`});
 assert.equal(operations.statusCode,200,operations.body);
 assert.equal(operations.json().state,"waiting_agent");
 assert.equal(operations.json().counts.waitingAgent,1);
 assert.equal(operations.json().agentWaits[0].requestId,request);
 const {branchOperationalSummary}=await import("../dist/branch-operations.js");
 const unavailable=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>({authentication:"authenticated",intakeReady:false,availabilityDetail:"Provider executable unavailable"}));
 assert.equal(unavailable.state,"provider_unavailable");
 assert.match(unavailable.agentWaits[0].reason,/executable unavailable/);
 const attention=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>({authentication:"unauthenticated",intakeReady:false}));
 assert.equal(attention.state,"provider_attention");
 const probeFailure=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>{throw new Error("probe unavailable")});
 assert.equal(probeFailure.state,"provider_attention");
 assert.equal(f.branches.detail(execution.id).attempts[0].requestId,request);
 f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'unrelated-provider-retry',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'unrelated work'}}]});
 const unrelatedRequest=f.store.sqlite.prepare('SELECT id FROM coordination_requests WHERE recipient_agent_id=? AND id!=? ORDER BY rowid DESC LIMIT 1').get(agent.id,request).id;
 const retryDue=new Date(Date.now()+60_000).toISOString();
 const retryActivation=f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',provider_failure_category='rate_limit',available_at=? WHERE kind='coordination_request' AND json_extract(payload_json,'$.requestId')=?").run(retryDue,unrelatedRequest);
 assert.ok(retryActivation.changes);
 const healthy={authentication:'authenticated',intakeReady:true};
 const unrelatedRetry=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>healthy);
 assert.equal(unrelatedRetry.agentWaits[0].state,'waiting_agent');
 f.store.sqlite.prepare("UPDATE agent_activations SET state='retry_pending',provider_failure_category='rate_limit',available_at=? WHERE kind='coordination_request' AND json_extract(payload_json,'$.requestId')=?").run(retryDue,request);
 const exactRetry=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>healthy);
 assert.equal(exactRetry.agentWaits[0].state,'provider_retry');assert.equal(exactRetry.agentWaits[0].nextRetryAt,retryDue);
 f.store.sqlite.prepare("UPDATE agent_activations SET provider_failure_category='unknown' WHERE kind='coordination_request' AND json_extract(payload_json,'$.requestId')=?").run(request);
 const genericRetry=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>healthy);
 assert.equal(genericRetry.state,'retrying');assert.equal(genericRetry.agentWaits[0].state,'retry_pending');assert.equal(genericRetry.agentWaits[0].nextRetryAt,retryDue);
 f.store.sqlite.prepare("UPDATE agent_activations SET state='pending',provider_failure_category=NULL WHERE json_extract(payload_json,'$.requestId') IN (?,?)").run(request,unrelatedRequest);
 f.coordination.updateRequest({requestId:request,updateId:'started',kind:'progress',actor:{kind:'agent',id:agent.id},payload:{text:'Working'}});
 const activeDuringOutage=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>({authentication:'authenticated',intakeReady:false}));
 assert.equal(activeDuringOutage.agentWaits[0].state,'agent_running');
 f.coordination.updateRequest({requestId:request,updateId:'waiting-on-peer',kind:'waiting_dependency',actor:{kind:'agent',id:agent.id},payload:{text:'Waiting for peer'}});
 const dependencyDuringOutage=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>({authentication:'authenticated',intakeReady:false}));
 assert.equal(dependencyDuringOutage.agentWaits[0].state,'waiting_dependency');
 f.coordination.updateRequest({requestId:request,updateId:'finished',kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'three findings'}});
 for(let i=0;i<100&&f.branches.execution(execution.id).state!=='completed';i++){await f.worker.tick(true);await delay(20)}
 assert.equal(f.branches.execution(execution.id).output,'Checked: three findings');
 assert.deepEqual(f.branches.detail(execution.id).steps.map(s=>s.state),['completed','completed']);
 await f.worker.tick(true);assert.equal(f.branches.detail(execution.id).attempts.length,2);
});

test('Script cleanup failure remains visible and retryable while another Branch progresses',async t=>{
 const f=await fixture(t,`console.log('safe')`);
 f.branches.advance();const lease=f.branches.claimScript('old-worker');
 f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'test:never-signal'});
 // Simulate an OS-level close failure without signaling an arbitrary process.
 let fail=true;
 const handle={isAlive:()=>fail,close:async()=>{if(fail)throw new Error('injected cleanup failure')}};
 f.worker.active.set(lease.attemptId,{handle,done:Promise.resolve()});
 const other=f.branches.accept(f.branch.id,'second','other');
 await f.worker.tick(true);
 const detail=f.branches.detail(f.execution.id);
 assert.equal(detail.execution.state,'waiting');assert.match(detail.execution.waitReason,/cleanup required/);
 assert.match(detail.attempts[0].error,/injected cleanup/);
 assert.throws(()=>f.branches.settleScript(lease,{failed:false}),/fenced/);
 assert.throws(()=>f.branches.deleteBranch(f.branch.id),/drain/);
 for(let i=0;i<80&&f.branches.execution(other.id).state!=='completed';i++){await delay(20);await f.worker.tick(true)}
 assert.equal(f.branches.execution(other.id).state,'completed');
 f.branches.cancel(f.execution.id);fail=false;await f.worker.tick(true);
 assert.equal(f.branches.execution(f.execution.id).state,'canceled');
 f.worker.active.delete(lease.attemptId);
});

test('a workflow failure cannot block normal scheduler Agent admission',async t=>{
 const f=await fixture(t,`console.log('unused')`);f.branches.cancel(f.execution.id);
 const agent=f.store.createAgent(f.project.id,{title:'Independent Dev work',engine:'codex',conversationId:f.chat.id});
 f.coordination.coordinate({projectId:f.project.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'dev',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'ordinary Dev work'}}]});
 let dispatched=0;
 const scheduler=new CoordinationV3Scheduler(f.coordination,async()=>{dispatched++;return {accepted:true}},
 {workerId:'dev-worker',workflowOperations:{tick:async()=>{throw new Error('injected workflow failure')},stop:async()=>{}}});
 t.after(()=>scheduler.stop());
 await scheduler.drainOnce();assert.equal(dispatched,1);
 assert.match(scheduler.snapshotMetrics().lastDispatchError,/injected workflow/);
});

test('shutdown rejects failed recovered cleanup and retries the durable process authority',async t=>{
 const f=await fixture(t,`console.log('unused')`);
 f.branches.advance();const lease=f.branches.claimScript('earlier-daemon');
 f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'test:never-signal'});
 let fail=true,calls=0;
 f.worker.active.set(lease.attemptId,{handle:{isAlive:()=>fail,close:async()=>{calls++;if(fail)throw new Error('cannot observe exit')}},done:Promise.resolve()});
 await f.worker.tick(false);
 await assert.rejects(()=>f.worker.stop(),/cleanup remains pending/);
 assert.ok(calls>=2);assert.equal(f.branches.scriptRecoveries('restart').length,1);
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 fail=false;await f.worker.stop();
 assert.equal(f.branches.scriptRecoveries('restart').length,0);
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 assert.match(f.branches.execution(f.execution.id).waitReason,/outcome unknown/);
});

test('shutdown before the first recovery tick drains a real orphaned Script group',async t=>{
 const {fork}=await import('node:child_process');
 const {recoveredRuntimeProcessHandle}=await import('@ponderosa/engines');
 const f=await fixture(t,`import {writeFileSync} from 'node:fs';writeFileSync('started','yes');setInterval(()=>{},1000);`,15000);
 await f.scheduler.stop();f.store.close();
 const child=fork(new URL('./branch-crash-worker.mjs',import.meta.url),[f.dir],{stdio:['ignore','ignore','inherit','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('worker exited '+code)));});
 for(let i=0;i<100&&!existsSync(join(f.dir,'started'));i++)await delay(20);
 assert.ok(existsSync(join(f.dir,'started')));
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;f.reopen();
 const [{identity}]=f.branches.scriptRecoveries('restarted-worker');
 assert.ok(recoveredRuntimeProcessHandle(identity).isAlive());
 await f.worker.stop();
 assert.equal(recoveredRuntimeProcessHandle(identity).isAlive(),false);
 assert.equal(f.branches.execution(f.execution.id).state,'waiting');
 assert.equal(f.branches.scriptRecoveries('restarted-worker').length,0);
});

test('cancel then failed cleanup then successful retry cancels execution, Step and attempt',async t=>{
 const f=await fixture(t,`console.log('unused')`);
 f.branches.advance();const lease=f.branches.claimScript('earlier-daemon');
 f.branches.authorizeScript(lease,{pid:123,pgid:123,birthMarker:'test:never-signal'});
 let fail=true;
 f.worker.active.set(lease.attemptId,{handle:{isAlive:()=>fail,close:async()=>{if(fail)throw new Error('injected cleanup failure')}},done:Promise.resolve()});
 f.branches.cancel(f.execution.id);await f.worker.tick(false);
 assert.equal(f.branches.detail(f.execution.id).steps[0].state,'outcome_unknown');
 fail=false;await f.worker.tick(false);
 const detail=f.branches.detail(f.execution.id);
 assert.equal(detail.execution.state,'canceled');
 assert.equal(detail.steps[0].state,'canceled');
 assert.equal(detail.attempts[0].state,'canceled');
 assert.throws(()=>f.branches.settleScript(lease,{failed:false}),/fenced/);
});


test('notification delivery survives checkpoint failure without duplicating or resurfacing the notification',async t=>{
 const f=await fixture(t,'process.stdout.write("ok")'),workspace=new WorkspaceStore(f.dir);f.branches.cancel(f.execution.id);
 const definition={schema:'ponderosa.branch.v1',name:'Notify',trigger:{kind:'manual'},entry:'notify',steps:[{id:'notify',kind:'action',action:'notify',configRefs:[]}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'action',definition,bindings:{agents:{},directories:{}}}),execution=f.branches.accept(branch.id,'event','Result');
 let deliveries=0;const service=new BranchScriptService(f.branches,f.store,'actions',{notifyAction:input=>{assert.equal(input.branchExecutionId,execution.id);deliveries++;return workspace.createNotification({dedupeKey:input.dedupeKey,projectId:input.projectId,conversationId:input.chatId,kind:'operational',status:'open',category:'system',severity:'info',title:input.title,body:input.body}).id}});

 f.store.sqlite.exec("CREATE TRIGGER reject_action_checkpoint BEFORE UPDATE OF state ON branch_actions WHEN NEW.state='delivered' BEGIN SELECT RAISE(ABORT,'injected checkpoint failure'); END");
 await service.tick(true).catch(e=>{throw new Error(e.stack??String(e))});assert.equal(deliveries,1);
 const first=f.store.sqlite.prepare('SELECT * FROM branch_actions').get();assert.equal(first.state,'pending');assert.match(f.branches.detail(execution.id).attempts[0].error,/checkpoint failure/);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE kind='action_delivery_failed'").get().n,1);const notice=workspace.createNotification({dedupeKey:'branch-action:'+first.attempt_id,projectId:f.project.id,conversationId:f.chat.id,kind:'operational',status:'open',category:'system',severity:'info',title:'Notify',body:'Result'});workspace.setNotificationStatus(notice.id,'dismissed');
 f.store.sqlite.exec('DROP TRIGGER reject_action_checkpoint');f.store.sqlite.prepare("UPDATE branch_attempts SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(first.attempt_id);
 await service.tick(true).catch(e=>{throw new Error(e.stack??String(e))});assert.equal(deliveries,2);assert.equal(f.branches.execution(execution.id).state,'completed');
 const delivered=f.store.sqlite.prepare('SELECT * FROM branch_actions').get();assert.ok(delivered.notification_id);
 const replay=workspace.createNotification({dedupeKey:'branch-action:'+first.attempt_id,projectId:f.project.id,conversationId:f.chat.id,kind:'operational',status:'open',category:'system',severity:'info',title:'Notify',body:'Result'});assert.equal(replay.id,delivered.notification_id);assert.equal(replay.status,'dismissed');await service.stop();
});

test('failed Script inspection retains exit code, both streams, directory and timestamp',async t=>{
 const f=await fixture(t,`console.log('partial output');console.error('missing report input');process.exitCode=7;`);
 assert.equal((await terminal(f)).state,'failed');const evidence=f.branches.detail(f.execution.id).attempts[0].scriptEvidence;
 assert.equal(evidence.code,7);assert.match(evidence.stderr,/missing report input/);assert.match(evidence.stdout,/partial output/);assert.equal(evidence.cwd,f.dir);assert.equal(evidence.runtime,'Node.js');assert.ok(Date.parse(evidence.finishedAt));
});

test('automatic human gates create exact idempotent notifications across retry, resolution and cancellation',async t=>{
 const f=await fixture(t,'process.stdout.write("unused")');f.branches.cancel(f.execution.id);
 const definition={schema:'ponderosa.branch.v1',name:'Automatic review',trigger:{kind:'manual'},entry:'work',steps:[{id:'work',kind:'script',runtime:'node',source:'process.exitCode=1',cwdRef:'root',timeoutMs:5000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'ask_human'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'gate-notifications',definition,bindings:{agents:{},directories:{root:f.dir}}}),execution=f.branches.accept(branch.id,'trigger:automatic-intake','payload');
 const opened=[],resolved=[],workspace=new WorkspaceStore(f.dir);const service=new BranchScriptService(f.branches,f.store,'gate-notifications',{notifyGate:input=>{opened.push(input);workspace.createNotification({...input,kind:'operational',status:'open',category:'decision',severity:'attention',action:{kind:'open_branch',targetId:input.branchId}})},resolveGateNotification:key=>{resolved.push(key);const current=workspace.openOperationalNotification(key);if(current)workspace.setNotificationStatus(current.id,'resolved')}});
 f.branches.advance();f.branches.settleScript(f.branches.claimScript('manual-worker'),{failed:true,output:'Inspect the first failure'});await service.tick(false);
 assert.equal(opened.length,1);assert.equal(opened[0].branchExecutionId,execution.id);assert.equal(opened[0].branchId,branch.id);assert.match(opened[0].body,/revision 0/i);const firstNotice=workspace.openOperationalNotification(`branch-gate:${f.branches.detail(execution.id).gates[0].id}:0`);assert.equal(firstNotice.branchId,branch.id);assert.equal(firstNotice.branchExecutionId,execution.id);assert.equal(firstNotice.severity,'attention');await service.tick(false);assert.equal(opened.length,1,'open notification is idempotent');
 let gate=f.branches.detail(execution.id).gates[0];f.branches.resolveGate(gate.id,{commandKey:'retry-first',expectedRevision:gate.revision,decision:'retry'});await service.tick(false);assert.deepEqual(resolved,[`branch-gate:${gate.id}:0`]);
 f.branches.settleScript(f.branches.claimScript('manual-worker'),{failed:true,output:'Inspect the retry'});await service.tick(false);gate=f.branches.detail(execution.id).gates[0];assert.equal(gate.revision,2);assert.equal(opened.length,2);assert.match(opened[1].body,/revision 2/i);
 f.branches.cancel(execution.id);await service.tick(false);assert.deepEqual(resolved,[`branch-gate:${gate.id}:0`,`branch-gate:${gate.id}:2`]);assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_gate_notifications WHERE state='resolved'").get().n,2);await service.stop();
});

test('automatic approval Steps publish and resolve a Branch-scoped attention notification',async t=>{
 const f=await fixture(t,'process.stdout.write("unused")');f.branches.cancel(f.execution.id);
 const definition={schema:'ponderosa.branch.v1',name:'Release approval',trigger:{kind:'manual'},entry:'approve',steps:[{id:'approve',kind:'human_gate',prompt:'Approve this release?',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'approval-notification',definition,bindings:{agents:{},directories:{}}}),execution=f.branches.accept(branch.id,'trigger:scheduled-release','candidate'),workspace=new WorkspaceStore(f.dir);
 const service=new BranchScriptService(f.branches,f.store,'approval-notification',{notifyGate:input=>{workspace.createNotification({...input,kind:'operational',status:'open',category:'decision',severity:'attention',action:{kind:'open_branch',targetId:input.branchId}})},resolveGateNotification:key=>{const current=workspace.openOperationalNotification(key);if(current)workspace.setNotificationStatus(current.id,'resolved')}});
 await service.tick(true);const gate=f.branches.detail(execution.id).gates[0],key=`branch-gate:${gate.id}:${gate.revision}`,notice=workspace.openOperationalNotification(key);assert.equal(notice.branchId,branch.id);assert.equal(notice.branchExecutionId,execution.id);assert.equal(notice.category,'decision');assert.equal(notice.severity,'attention');assert.match(notice.body,/Approve this release/);
 f.branches.resolveGate(gate.id,{commandKey:'approve-release',expectedRevision:gate.revision,decision:'approve'});await service.tick(false);assert.equal(workspace.openOperationalNotification(key),undefined);assert.equal(workspace.getNotification(notice.id).status,'resolved');await service.stop();
});

test('execution detail previews large evidence and exact Step endpoint restores it without cross-execution access',async t=>{
 const f=await fixture(t,`process.stdout.write('x'.repeat(9000));`);
 const finished=await terminal(f);assert.equal(finished.state,'completed');
 const response=await f.app.inject({method:'GET',url:`/api/branch-executions/${f.execution.id}`});
 assert.equal(response.statusCode,200);assert.ok(Buffer.byteLength(response.body)<6000,response.body.length);
 const detail=response.json();assert.equal(detail.largeEvidenceOmitted,true);
 const step=detail.steps[0];assert.ok(step.result.output.length<600);
 const evidence=await f.app.inject({method:'GET',url:`/api/branch-executions/${f.execution.id}/steps/${step.id}/evidence`});
 assert.equal(evidence.statusCode,200);assert.equal(evidence.json().result.output.length,9000);
 assert.equal(evidence.json().sealedResult.contentHash,detail.sealedResults[0].contentHash);
 const other=f.branches.accept(f.branch.id,'other-run','other');
 const forbidden=await f.app.inject({method:'GET',url:`/api/branch-executions/${other.id}/steps/${step.id}/evidence`});
 assert.equal(forbidden.statusCode,404);
 assert.equal(f.branches.detail(f.execution.id).steps[0].result.output.length,9000);
});

test('pending Map item keeps exact sealed input behind execution-scoped evidence',async t=>{
 const f=await fixture(t,'process.stdout.write("unused")');
 const branch=f.branches.create('Pending item','pending-map-evidence');
 const definition={schema:'ponderosa.branch.v1',name:'Pending item',trigger:{kind:'manual'},entry:'map',steps:[{id:'worker',kind:'script',runtime:'node',source:'process.stdout.write("ok")',cwdRef:'root',timeoutMs:5000}],controls:[{id:'map',kind:'map',joinId:'join',workerId:'worker',source:'list',maxItems:2,maxConcurrentItems:1},{id:'join',kind:'join',forkId:'map',mode:'all',remainder:'finish',inputOrder:[]}],edges:[{id:'item',from:'map',to:'worker',on:'selected'},{id:'return',from:'worker',to:'join',on:'success'}],policy:{maxConcurrentExecutions:1,maxPathInstances:4,maxStepInvocations:4,failure:{action:'stop'}}};
 const deployed=await f.app.inject({method:'POST',url:'/api/branches/deploy',payload:{chatId:'',branchId:branch.id,expectedVersionId:branch.versionId,idempotencyKey:'pending-map-deploy',definition,bindings:{agents:{},directories:{root:f.dir}}}});assert.equal(deployed.statusCode,200,deployed.body);
 const long='prefix-'+('z'.repeat(3000))+'-tail';const execution=f.branches.accept(branch.id,'pending-map-run',JSON.stringify(['short',long]));for(let i=0;i<10&&!f.branches.detail(execution.id).mapItems.length;i++)f.branches.advance();
 const detail=(await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}`})).json();const item=detail.mapItems.find(row=>row.index===1);assert.ok(item);assert.equal(detail.executionInputTruncated,true);assert.ok(detail.execution.input.length<200);const fullInput=await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/input`});assert.match(fullInput.json().input,/tail/);const fullPage=await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/full-detail`});assert.match(fullPage.json().mapItems.find(row=>row.index===1).input,/tail/);assert.ok(item.input.length<200);assert.equal(item.stepExecutionId,undefined);
 const evidence=await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/map-items/${encodeURIComponent(item.id)}/evidence`});assert.equal(evidence.statusCode,200,evidence.body);assert.equal(evidence.json().input,long);assert.equal(evidence.json().inputHash,item.inputHash);
 const search=await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/map-items/search?q=tail`});assert.equal(search.statusCode,200,search.body);assert.deepEqual(search.json().items.map(row=>row.id),[item.id]);assert.ok(search.json().items[0].input.length<200);
 const other=f.branches.accept(branch.id,'another-map-run',JSON.stringify(['one','two']));const denied=await f.app.inject({method:'GET',url:`/api/branch-executions/${other.id}/map-items/${encodeURIComponent(item.id)}/evidence`});assert.equal(denied.statusCode,404);const wrongSearch=await f.app.inject({method:'GET',url:`/api/branch-executions/${other.id}/map-items/search?q=tail`});assert.deepEqual(wrongSearch.json().items,[]);
 for(let i=0;i<150&&!(['completed','failed'].includes(f.branches.execution(execution.id).state));i++){await f.scheduler.drainOnce();await delay(10)}
 assert.equal(f.branches.execution(execution.id).state,'completed');
 const finished=(await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/map-items/${encodeURIComponent(item.id)}/evidence`})).json();
 assert.ok(finished.stepExecutionId);assert.ok(finished.sealedResultId);
 const worker=await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/steps/${finished.stepExecutionId}/evidence`});assert.equal(worker.statusCode,200);assert.equal(worker.json().sealedResult.id,finished.sealedResultId);
 const secondPage=await f.app.inject({method:'GET',url:`/api/branch-executions/${execution.id}/map-items/search?q=tail&offset=1`});assert.deepEqual(secondPage.json().items,[]);
});

test('adapter exception keeps one Branch Request through restart while unrelated Script work progresses',async t=>{
 const f=await fixture(t,`process.stdout.write('independent')`);f.branches.cancel(f.execution.id);
 const agent=f.store.createAgent(f.project.id,{title:'Persistent provider worker',engine:'codex',conversationId:f.chat.id});
 const branch=f.branches.deploy({chatId:f.chat.id,idempotencyKey:'provider-exception',definition:{schema:'ponderosa.branch.v1',name:'Provider exception',trigger:{kind:'manual'},entry:'work',controls:[],steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Return one result'}],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},bindings:{agents:{worker:agent.id},directories:{}}});
 const execution=f.branches.accept(branch.id,'provider-exception-run','source');await f.worker.tick(true);
 const request=f.branches.detail(execution.id).attempts[0].requestId;assert.ok(request);
 const failing=new CoordinationV3Scheduler(f.coordination,async()=>{throw new Error('simulated adapter exception')},{workerId:'failure-matrix',maxConcurrentRuns:1});
 t.after(()=>failing.stop());
 await failing.drainOnce();
 assert.equal(f.branches.detail(execution.id).attempts[0].requestId,request);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM coordination_requests WHERE id=?').get(request).n,1);
 const {branchOperationalSummary}=await import('../dist/branch-operations.js');
 const operations=await branchOperationalSummary(f.store.sqlite,f.branches.execution(execution.id),async()=>({authentication:'authenticated',intakeReady:true}));
 assert.equal(operations.state,'retrying');assert.equal(operations.agentWaits[0].state,'retry_pending');
 const independent=f.branches.accept(f.branch.id,'independent-script','work');
 for(let i=0;i<80&&f.branches.execution(independent.id).state!=='completed';i++){await f.worker.tick(true);await delay(20)}
 assert.equal(f.branches.execution(independent.id).state,'completed');
 await failing.stop();await f.scheduler.stop();f.store.close();f.reopen();
 assert.equal(f.branches.detail(execution.id).attempts[0].requestId,request);
 const recovering=new CoordinationV3Scheduler(f.coordination,async()=>({accepted:true}),{workerId:'recovered-provider',maxConcurrentRuns:1});
 t.after(()=>recovering.stop());
 await delay(600);await recovering.drainOnce();
 f.coordination.updateRequest({requestId:request,updateId:'recovered-answer',kind:'completed',actor:{kind:'agent',id:agent.id},payload:{text:'Recovered once'}});
 for(let i=0;i<80&&f.branches.execution(execution.id).state!=='completed';i++){await f.worker.tick(true);await delay(20)}
 assert.equal(f.branches.execution(execution.id).output,'Recovered once');
 assert.equal(f.branches.detail(execution.id).attempts.length,1);
});
