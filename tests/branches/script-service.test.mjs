import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {recoveredRuntimeProcessHandle} from '@ponderosa/engines';
import {BranchScriptService} from '../../apps/server/dist/branch-script-service.js';
import {CoordinationV3Scheduler} from '../../apps/server/dist/coordination-v3-scheduler.js';

const options={timeout:20000,skip:process.platform==='win32' ? 'Recoverable Branch Scripts currently require POSIX containment' : false};
async function until(read,label){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await read();if(value)return value;await delay(20)}throw Error(`Timed out: ${label}`)}
function fixture(t,source,serviceOptions={}){
 const root=mkdtempSync(path.join(tmpdir(),'branch-script-current-')),store=new AgentStore(root),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const owner=branches.create('Script','script'),branch=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Script',trigger:{kind:'manual'},entry:'script',controls:[],edges:[],steps:[{id:'script',kind:'script',runtime:'node',source,cwdRef:'root',timeoutMs:15000}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root}}});
 const execution=branches.accept(branch.id,'event','a🙂b\n$(do-not-execute)'),service=new BranchScriptService(branches,store,'script-test',serviceOptions);
 let passed=false,scheduler;t.after(async()=>{let clean=false;try{await scheduler?.stop();await service.stop();clean=true}finally{store.close();if(passed&&clean)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)}});
 return {root,store,branches,service,execution,attachScheduler(value){scheduler=value},done(){passed=true}};
}

test('the existing scheduler pauses and resumes workflow work without creating provider Runs',options,async t=>{
 const f=fixture(t,"process.stdout.write('scheduled Script');");
 const scheduler=new CoordinationV3Scheduler(new CoordinationV3Store(f.store.sqlite),async()=>{throw Error('Unexpected provider dispatch')},
  {workerId:'workflow-test',pollMs:10,workflowOperations:f.service});f.attachScheduler(scheduler);
 await scheduler.pauseLeasing();await scheduler.drainOnce();assert.equal(f.branches.execution(f.execution.id).state,'queued');
 scheduler.resumeLeasing();
 await until(()=>f.branches.execution(f.execution.id).state==='completed','scheduler-driven workflow completion');
 await scheduler.stop();assert.equal(f.branches.execution(f.execution.id).output,'scheduled Script');
 assert.equal(scheduler.snapshotMetrics().claimedRuns,0);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);f.done();
});

test('pending workflow provisioning does not block unrelated Run admission or exact-Run cancellation, and pause still waits',options,async t=>{
 let release,entered,passes=0,operations=0;
 const gate=new Promise(resolve=>{release=resolve}),ready=new Promise(resolve=>{entered=resolve});
 const f=fixture(t,"process.stdout.write('unused');"),coordination=new CoordinationV3Store(f.store.sqlite);
 const project=f.store.createProject({label:'Unrelated Chat',hostPath:f.root,defaultEngine:'codex'}),chat=f.store.createConversation(project.id,{title:'Chat'}),agent=f.store.createAgent(project.id,{title:'Independent worker',engine:'codex',conversationId:chat.id});
 const scheduler=new CoordinationV3Scheduler(coordination,async lease=>{
  const injection={injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken};coordination.markPromptSubmitted(injection);coordination.acknowledgePromptInjection(injection);return {accepted:true};
 },{workerId:'resource-independent',workflowOperations:{async tick(){passes++;entered();await gate},requestStop(){release()},async stop(){release()}},dispatchProviderOperation:async()=>{operations++;return {accepted:true}}});
 f.attachScheduler(scheduler);t.after(()=>release());
 coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:test',idempotencyKey:'unrelated-work',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'Unrelated task'}}]});
 const first=scheduler.drainOnce();
 try{
  await ready;await until(()=>scheduler.snapshotMetrics().acceptedRuns===1,'unrelated Run admitted while provisioning waits');
  const run=f.store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agent.id);assert.ok(run);
  coordination.cancelAgentRun({agentId:agent.id,expectedRunId:run.id,idempotencyKey:'exact-cancel'});
  await scheduler.drainOnce();assert.ok(operations>0,'Exact cancellation maintenance must not wait for resource provisioning');assert.equal(passes,1,'Only one workflow pass may be in flight');
  let paused=false;const pause=scheduler.pauseLeasing().then(()=>{paused=true});await Promise.resolve();assert.equal(paused,false,'Pause must observe the outstanding workflow operation');
  release();await pause;assert.equal(paused,true);await first;f.done();
 }finally{release();await first}
});

test('contained Script receives exact stdin and settles one durable result without a provider Run',options,async t=>{
 const f=fixture(t,"let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(text);");
 await f.service.tick(false);assert.equal(f.branches.execution(f.execution.id).state,'queued');
 await f.service.tick(true);
 const result=await until(()=>{const e=f.branches.execution(f.execution.id);return e.state==='completed'&&e},'Script completion');
 assert.equal(result.output,'a🙂b\n$(do-not-execute)');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM branch_checkpoints WHERE kind='script_process_exit'").get().n,1);
 f.done();
});

test('contained Script keeps intentional parameters without inheriting host-only environment',options,async t=>{
 const overrides={PONDEROSA_AGENT_MEMORY_MAX_MIB:'192',PONDEROSA_LAUNCHER_CONTROL_TOKEN:'owned-test-token',NODE_OPTIONS:'--max-old-space-size=128'};
 const previous=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
 try{
  Object.assign(process.env,overrides);
  const f=fixture(t,"process.stdout.write(JSON.stringify({parameters:JSON.parse(process.env.PONDEROSA_PARAMETERS),nodeOptions:process.env.NODE_OPTIONS,memory:process.env.PONDEROSA_AGENT_MEMORY_MAX_MIB,token:process.env.PONDEROSA_LAUNCHER_CONTROL_TOKEN}));");
  await f.service.tick(true);
  const result=await until(()=>{const e=f.branches.execution(f.execution.id);return e.state==='completed'&&e},'Script environment result');
  assert.deepEqual(JSON.parse(result.output),{parameters:{}});
  f.done();
 }finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

test('failed process-authority commit closes the waiting child before any Script effect',options,async t=>{
 const f=fixture(t,"import {writeFileSync} from 'node:fs';writeFileSync('should-not-exist','effect');");
 f.branches.authorizeScript=()=>{throw Error('injected authority commit failure')};
 await f.service.tick(true);
 assert.equal(f.branches.execution(f.execution.id).state,'failed');
 assert.match(f.branches.execution(f.execution.id).output,/injected authority commit failure/);
 assert.equal(existsSync(path.join(f.root,'should-not-exist')),false);
 assert.equal(f.store.sqlite.prepare('SELECT process_identity_json FROM branch_attempts').get().process_identity_json,null);
 f.done();
});

test('shutdown during asynchronous resource work cannot claim or launch a pending Script',options,async t=>{
 let release,entered,stopped=false;
 const ready=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve});
 const resources={async tick(){entered();await gate},requestStop(){stopped=true},async stop(){stopped=true}};
 const f=fixture(t,"import {writeFileSync} from 'node:fs';writeFileSync('late-effect','effect');",{resources});
 const pending=f.service.tick(true);
 try{await ready;f.service.requestStop();assert.equal(stopped,true)}finally{release();await pending}
 assert.equal(existsSync(path.join(f.root,'late-effect')),false);
 const attempt=f.store.sqlite.prepare('SELECT state,process_identity_json,lease_owner,lease_until FROM branch_attempts').get();
 assert.equal(attempt.state,'prepared');assert.equal(attempt.process_identity_json,null);
 assert.equal(attempt.lease_owner,null);assert.equal(attempt.lease_until,null);
 f.done();
});

test('cancellation observes the exact Script process group exit before sealing its canceled result',options,async t=>{
 const f=fixture(t,"import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('started',String(child.pid));setInterval(()=>{},1000);await new Promise(()=>{});");
 await f.service.tick(true);await until(()=>existsSync(path.join(f.root,'started')),'owned process start');
 const childPid=Number(readFileSync(path.join(f.root,'started'),'utf8'));assert.ok(childPid>0);
 const row=f.store.sqlite.prepare('SELECT process_identity_json FROM branch_attempts').get(),identity=JSON.parse(row.process_identity_json);
 const observed=recoveredRuntimeProcessHandle(identity,{label:'Script test exact owner'});assert.equal(observed.isAlive(),true);
 f.branches.cancel(f.execution.id);await f.service.tick(false);
 await until(()=>f.branches.execution(f.execution.id).state==='canceled','exact cancellation settlement');
 assert.equal(observed.isAlive(),false);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 f.done();
});

for(const [label,source,summary,code] of [
 ['thrown error',"throw new Error('PRIVATE_STDERR_SENTINEL');",'Script exited with code 1. Inspect Step evidence for error output.',1],
 ['nonzero stdout',"process.stdout.write('MISLEADING_SUCCESS_SENTINEL');process.stderr.write('PRIVATE_STDERR_SENTINEL');process.exitCode=7;",'Script exited with code 7. Inspect Step evidence for error output.',7],
 ['empty nonzero exit',"process.exit(2);",'Script exited with code 2. Inspect Step evidence for error output.',2],
 ['signal exit',"process.kill(process.pid,'SIGTERM');",'Script terminated without an exit code. Inspect Step evidence for error output.',null],
]) test('Script failure summary uses exit status while preserving separate evidence: '+label,options,async t=>{
 const f=fixture(t,source);await f.service.tick(true);
 const result=await until(()=>{const e=f.branches.execution(f.execution.id);return e.state==='failed'&&e},'failed Script');
 assert.equal(result.output,summary);
 const attempt=f.branches.detail(f.execution.id).attempts[0];
 assert.equal(attempt.result.output,summary);assert.equal(attempt.scriptEvidence.error,summary);assert.equal(attempt.scriptEvidence.code,code);
 assert.doesNotMatch(result.output,/PRIVATE_STDERR_SENTINEL|MISLEADING_SUCCESS_SENTINEL/);
 if(label==='thrown error'||label==='nonzero stdout')assert.match(attempt.scriptEvidence.stderr,/PRIVATE_STDERR_SENTINEL/);
 if(label==='nonzero stdout')assert.equal(attempt.scriptEvidence.stdout,'MISLEADING_SUCCESS_SENTINEL');
 f.done();
});
test('successful Script stderr remains diagnostic and stdout remains the exact result',options,async t=>{
 const f=fixture(t,"process.stderr.write('warning');process.stdout.write('success');");await f.service.tick(true);
 const result=await until(()=>{const e=f.branches.execution(f.execution.id);return e.state==='completed'&&e},'successful Script');
 assert.equal(result.output,'success');const evidence=f.branches.detail(f.execution.id).attempts[0].scriptEvidence;
 assert.equal(evidence.stderr,'warning');assert.equal(evidence.error,undefined);f.done();
});
for(const [label,source,timeoutMs,expected] of [
 ['timeout',"await new Promise(resolve=>setTimeout(resolve,30000));",50,'Script timeout'],
 ['output limit',"process.stdout.write('x'.repeat(50000));",15000,'Script output exceeds inline limit; use managed files'],
]) test('explicit Script failure remains higher priority than exit status: '+label,options,async t=>{
 const f=fixture(t,source);
 const claim=f.branches.claimScript.bind(f.branches);f.branches.claimScript=(...args)=>{const lease=claim(...args);return lease?{...lease,timeoutMs}:lease};
 await f.service.tick(true);const result=await until(()=>{const e=f.branches.execution(f.execution.id);return e.state==='failed'&&e},'explicit Script failure');
 assert.equal(result.output,expected);assert.equal(f.branches.detail(f.execution.id).attempts[0].scriptEvidence.error,expected);f.done();
});
