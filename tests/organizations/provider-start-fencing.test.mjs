// Synthetic source-contract races; the original resource-admission test separately uses real inert children.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {spawnContainedCli} from '../../packages/engines/dist/contained-spawn.js';
import {runtimeProcessHandle} from '../../packages/engines/dist/process-termination.js';
import {ProviderStartAuthority} from '../../apps/server/dist/provider-start-authority.js';
import {ProviderProcessAuthority} from '../../apps/server/dist/provider-process-authority.js';
import {enableProviderStartCoverage,recordProviderStartCoverage,admitProviderStart,sealProviderNeverStarted} from '../../packages/agents/dist/provider-start-journal.js';
import {readProviderExitEvidence,verifyRetainedProviderExitEvidence} from '../../packages/agents/dist/provider-exit-evidence.js';
import {payloadHash,stableJson} from '../../packages/agents/dist/coordination-v3-canonical-json.js';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {withFixture} from '../shared/fixture.mjs';
const Database=createRequire(new URL('../../apps/server/package.json',import.meta.url))('better-sqlite3');
function fixture(t,{legacy=false}={}){
 const root=mkdtempSync(path.join(tmpdir(),'provider-start-contract-')),file=path.join(root,'test.db');let db=new Database(file);
 for(const name of ['0002_provider_process_authority.sql','0022_provider_scope_authority.sql','0040_lifecycle_reconciliation.sql'])db.exec(readFileSync(new URL(`../../packages/agents/src/schema/${name}`,import.meta.url),'utf8'));
 db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT);CREATE TABLE agents(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT,deleted_at TEXT);CREATE TABLE scheduler_runs(id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,status TEXT,fencing_token INTEGER,lease_owner TEXT,side_effects_fenced_at TEXT);CREATE TABLE branch_resources(execution_id TEXT,step_execution_id TEXT,generation INTEGER,chat_id TEXT);INSERT INTO branch_resources VALUES('execution','step',0,'chat');INSERT INTO conversations VALUES('chat','project');`);
 enableProviderStartCoverage(db,'worker');
 db.transaction(()=>{for(const agentId of ['agent','unused']){db.prepare('INSERT INTO agents VALUES(?,?,?,NULL)').run(agentId,'project','chat');if(!legacy)recordProviderStartCoverage(db,{agentId,projectId:'project',conversationId:'chat'});}}).immediate();
 const processes=new ProviderProcessAuthority(db,'worker'),starts=new ProviderStartAuthority(db,'worker',processes);
 let alive=true,failClose=false;
 const handle={processIdentity:{pid:424242,pgid:424242,birthMarker:'synthetic-birth'},isAlive:()=>alive,close:async()=>{if(failClose)throw Error('controlled failed close');alive=false;}};
 processes.recover=()=>handle;
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const put=(kind,identity,v)=>{const bytes=stableJson(v);db.prepare('INSERT INTO host_lifecycle_commits VALUES(?,?,?,?,?)').run(kind,identity,bytes,bytes,payloadHash(v));};
 function fence(){const input={executionId:'execution',stepExecutionId:'step',generation:0,projectId:'project',conversationId:'chat',agentIds:['agent','unused']},identity=payloadHash({executionId:'execution',stepExecutionId:'step',generation:0}),v={schema:'branch-generation-exit-fence.v1',input,resource:{},members:input.agentIds.map(agent_id=>({agent_id}))},bytes=stableJson(v);db.transaction(()=>db.prepare('INSERT INTO host_lifecycle_commits VALUES(?,?,?,?,?)').run('branch-generation-exit-fence',identity,stableJson(input),bytes,payloadHash(v))).immediate();}
 const input={projectId:'project',conversationId:'chat',participants:[{agentId:'agent',runIds:[]},{agentId:'unused',runIds:[]}]};
 const options={agentId:'agent',onRuntimeSpawned:()=>{if(input.participants[0].runIds.length)processes.register(handle,{purpose:'fixture Run',agentId:'agent',projectId:'project',runId:'run',runFence:1});}};
 return {get db(){return db;},processes,starts,handle,fence,input,options,put,failClose:v=>{failClose=v;},startedRun:()=>{db.exec("INSERT INTO scheduler_runs(id,project_id,agent_id,status,fencing_token) VALUES('run','project','agent','completed',1)");input.participants[0].runIds=['run'];},seal:()=>sealProviderNeverStarted(db,'worker',['agent','unused']),reopen:()=>{db.close();db=new Database(file);return db;}};
}
test('all-never-started v2 is immutable, exact, retained through cleanup/reopen and rejects later activity',async t=>{
 const f=fixture(t);assert.throws(f.seal,/fence/);f.fence();await f.starts.drain(['agent','unused']);f.seal();
 const e=readProviderExitEvidence(f.db,f.input);assert.equal(e.schema,'provider-exit-evidence.v2');assert.equal(e.neverStarted.length,2);assert.equal(e.receipts.length,0);assert.equal(e.runs.length,0);
 f.seal();assert.deepEqual(readProviderExitEvidence(f.db,{...f.input,expectedRevision:e.revision}),e);
 assert.throws(()=>admitProviderStart(f.db,'new-worker','unused','openSession'),/fenced/);
 assert.throws(()=>f.db.prepare("DELETE FROM host_lifecycle_commits WHERE kind='provider-never-started'").run(),/immutable/);
 for(const mutate of [v=>v.neverStarted[0].receipt.generation++,v=>v.neverStarted[0].receipt.agentId='foreign',v=>v.neverStarted[0].receipt.fence.sha256='tampered',v=>v.neverStarted.push(v.neverStarted[0])]){
  const bad=structuredClone(e);mutate(bad);const {revision,...body}=bad;bad.revision=payloadHash(body);assert.throws(()=>verifyRetainedProviderExitEvidence(f.db,bad));
 }
 f.db.exec("INSERT INTO scheduler_runs(id,project_id,agent_id,status,fencing_token) VALUES('later','project','unused','completed',1)");assert.throws(()=>verifyRetainedProviderExitEvidence(f.db,e),/activity/);f.db.exec("DELETE FROM scheduler_runs WHERE id='later'");
 f.db.exec('DELETE FROM agents;DELETE FROM conversations;');verifyRetainedProviderExitEvidence(f.reopen(),e);
});
test('legacy missing creation coverage refuses; no retrospective certification',async t=>{
 const f=fixture(t,{legacy:true});f.fence();await f.starts.drain(['agent','unused']);assert.throws(f.seal,/Legacy/);assert.throws(()=>readProviderExitEvidence(f.db,f.input),/Run inventory/);
});
test('admission-before-fence late adapter return drains actual registered lifetimes; mixed member is never relabelled',async t=>{
 const f=fixture(t);f.startedRun();let publish,entered;
 const ready=new Promise(r=>entered=r),release=new Promise(r=>publish=r);
 const adapter=f.starts.wrap({async openSession(o){entered();await release;o.onRuntimeSpawned(f.handle);return f.handle;}});
 const pending=adapter.openSession(f.options);await ready;assert.equal(f.db.prepare("SELECT count(*) n FROM host_lifecycle_commits WHERE kind='provider-start-admission'").get().n,1);
 f.fence();const drain=f.starts.drain(['agent','unused']);publish();await pending;await drain;f.seal();
 const e=readProviderExitEvidence(f.db,f.input);assert.equal(e.neverStarted.length,1);assert.equal(e.neverStarted[0].identity,'unused');assert.equal(e.receipts.length,1);assert.equal(e.runs.length,1);verifyRetainedProviderExitEvidence(f.db,e);
 assert.throws(()=>admitProviderStart(f.db,'worker','agent','recovery'),/fenced/);
 f.db.exec('DELETE FROM scheduler_runs;DELETE FROM agents;DELETE FROM conversations;');verifyRetainedProviderExitEvidence(f.reopen(),e);
});
test('fence-before-admission rejects open and both lazy one-shot entries before invoking adapter',async t=>{
 const f=fixture(t);f.fence();let calls=0;const a=f.starts.wrap({async openSession(){calls++;},async *seed(){calls++;},async *continue(){calls++;}});
 await assert.rejects(a.openSession(f.options),/fenced/);for(const name of ['seed','continue'])await assert.rejects(a[name](f.options)[Symbol.asyncIterator]().next(),/fenced/);assert.equal(calls,0);
});
test('rejected or successful-without-handle starts stay unknown across worker loss/reopen',async t=>{
 for(const fail of [true,false]){const f=fixture(t);const a=f.starts.wrap({async openSession(){if(fail)throw Error('unknown open');return {};}});if(fail)await assert.rejects(a.openSession(f.options),/unknown/);else await a.openSession(f.options);f.fence();await f.starts.drain(['agent','unused']);assert.throws(f.seal,/unsettled|unknown/);const db=f.reopen();assert.throws(()=>sealProviderNeverStarted(db,'new-worker',['agent','unused']),/unsettled|unknown/);}
});
test('failed close holds, retry can observe exit without inventing never-started coverage',async t=>{
 const f=fixture(t);f.startedRun();await f.starts.wrap({async openSession(o){o.onRuntimeSpawned(f.handle);return f.handle;}}).openSession(f.options);f.fence();f.failClose(true);await assert.rejects(f.starts.drain(['agent','unused']),/pending|drain/);assert.throws(f.seal,/unobserved/);f.failClose(false);await f.starts.drain(['agent','unused']);f.seal();assert.equal(readProviderExitEvidence(f.db,f.input).neverStarted.length,1);
});
test('later out-of-contract callback holds a settled admission permanently',async t=>{
 const f=fixture(t);f.startedRun();let late;
 await f.starts.wrap({async openSession(o){late=o.onRuntimeSpawned;o.onRuntimeSpawned(f.handle);return f.handle;}}).openSession(f.options);
 f.fence();await f.starts.drain(['agent','unused']);f.seal();assert.throws(()=>late(f.handle),/settled|rebound/);assert.throws(()=>readProviderExitEvidence(f.db,f.input),/unknown|rebound/);
});

test('failed registration persistence retains the real opening handle for drain and preserves unknown hold',async t=>{
 const f=fixture(t);let closes=0;const close=f.handle.close;f.handle.close=async()=>{closes++;return close();};
 f.db.exec("CREATE TRIGGER reject_registration BEFORE INSERT ON host_lifecycle_commits WHEN NEW.kind='provider-process-registration' BEGIN SELECT RAISE(ABORT,'controlled registration disk failure');END");
 await assert.rejects(f.starts.wrap({async openSession(o){o.onRuntimeSpawned(f.handle);return f.handle;}}).openSession(f.options),/disk failure/);
 f.fence();f.failClose(true);await assert.rejects(f.starts.drain(['agent','unused']),/drain/);assert.ok(closes>1);
 f.failClose(false);f.db.exec('DROP TRIGGER reject_registration');await f.starts.drain(['agent','unused']);assert.equal(f.handle.isAlive(),false);assert.throws(f.seal,/unknown/);
});

test('pre-fence admission whose inert OS process opens after the fence is drained with observed lifetime evidence',async t=>{
 const f=fixture(t);f.startedRun();delete f.processes.recover;let release,entered,handle;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const adapter=f.starts.wrap({async openSession(o){entered();await gate;
  const owned=spawnContainedCli({bin:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:tmpdir(),env:process.env,stdin:'ignore'});
  await once(owned.child,'spawn');handle=runtimeProcessHandle(owned.child,{label:'inert late-admission fixture',termGraceMs:200,killConfirmationMs:1000},owned.authority);
  o.onRuntimeSpawned(handle);return handle;
 }});
 const opening=adapter.openSession({...f.options,onRuntimeSpawned:h=>f.processes.register(h,{purpose:'inert fixture Run',projectId:'project',agentId:'agent',runId:'run',runFence:1})});
 t.after(async()=>{if(handle)await handle.close();});
 await ready;f.fence();const draining=f.starts.drain(['agent','unused']);release();await opening;await draining;f.seal();
 assert.equal(handle.isAlive(),false);const e=readProviderExitEvidence(f.db,f.input);assert.equal(e.runs.length,1);assert.equal(e.neverStarted.length,1);assert.equal(e.receipts.length,1);assert.equal(e.receipts[0].receipt.result,'observed_exited');
});

test('Run-bound starts record exact admission and tracked lifetime for persistent and one-shot calls',async t=>{
 for(const method of ['openSession','seed','continue']){
  const f=fixture(t);f.startedRun();f.db.exec("UPDATE scheduler_runs SET status='running',lease_owner='worker' WHERE id='run'");
  let seen;
  const register=f.processes.register.bind(f.processes);
  f.processes.register=(handle,scope,owner)=>{if(scope.purpose==='admitted provider start')seen={scope,owner};return register(handle,scope,owner);};
  const fake=method==='openSession'
   ? {async openSession(o){o.onRuntimeSpawned(f.handle);return f.handle;}}
   : {[method]:async function*(o){o.onRuntimeSpawned(f.handle);yield {type:'turn_done'};}};
  const wrapped=f.starts.wrap(fake),opts={...f.options,providerRun:{runId:'run',fence:1}};
  if(method==='openSession')await wrapped.openSession(opts);else for await(const ignored of wrapped[method](opts)){}
  assert.equal(seen.scope.runId,'run');assert.equal(seen.scope.runFence,1);assert.equal(seen.owner,f.handle);
  const admission=JSON.parse(f.db.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission'").get().receipt_json);
  const reg=JSON.parse(f.db.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.purpose')='admitted provider start'").get().receipt_json);
  const settlement=JSON.parse(f.db.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-settlement'").get().receipt_json);
  assert.equal(admission.runId,'run');assert.equal(admission.runFence,1);
  assert.equal(reg.runId,'run');assert.equal(reg.runFence,1);assert.deepEqual(settlement.registrations,[reg.authorityId]);
 }
});
test('stale, foreign, fenced or completed Run cannot start a provider',async t=>{
 for(const mutation of [
  "UPDATE scheduler_runs SET fencing_token=2",
  "UPDATE scheduler_runs SET lease_owner='other-worker'",
  "UPDATE scheduler_runs SET side_effects_fenced_at='fenced'",
  "UPDATE scheduler_runs SET status='completed'",
  "UPDATE scheduler_runs SET project_id='other-project'",
  "UPDATE scheduler_runs SET agent_id='unused'"
 ]){
  const f=fixture(t);f.startedRun();f.db.exec("UPDATE scheduler_runs SET status='running',lease_owner='worker' WHERE id='run'");f.db.exec(mutation);let calls=0;
  const wrapped=f.starts.wrap({async openSession(){calls++;}});
  await assert.rejects(wrapped.openSession({...f.options,providerRun:{runId:'run',fence:1}}),/Run ownership differs/);
  assert.equal(calls,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM host_lifecycle_commits WHERE kind='provider-start-admission'").get().n,0);
 }
});
test('unbound legacy starts remain supported and cannot be misattributed to a Run',async t=>{
 const f=fixture(t);await f.starts.wrap({async openSession(o){o.onRuntimeSpawned(f.handle);return f.handle;}}).openSession(f.options);
 const row=JSON.parse(f.db.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission'").get().receipt_json);
 assert.equal(row.runId,undefined);assert.equal(row.runFence,undefined);
});
test('native Job-style tracked registration settles against its own exact Run scope',async t=>{
 const f=fixture(t);f.startedRun();f.db.exec("UPDATE scheduler_runs SET status='running',lease_owner='worker' WHERE id='run'");
 let captured;
 f.processes.register=(handle,scope,owner)=>{
  captured={handle,scope,owner};const value={schema:'provider-process-registration.v1',authorityId:'native-lifetime',workerId:'worker',process:{kind:'native-job',lifetimeId:'native-lifetime'},purpose:scope.purpose,projectId:'project',agentId:'agent',conversationId:'chat',runId:scope.runId,runFence:scope.runFence};
  f.put('provider-process-registration','native-lifetime:'+payloadHash(value),value);return 'native-lifetime';
 };
 await f.starts.wrap({async openSession(o){o.onRuntimeSpawned(f.handle);return f.handle;}}).openSession({...f.options,onRuntimeSpawned:()=>{},providerRun:{runId:'run',fence:1}});
 assert.equal(captured.owner,f.handle);assert.equal(captured.scope.runId,'run');assert.equal(captured.scope.runFence,1);
 assert.deepEqual(JSON.parse(f.db.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-settlement'").get().receipt_json).registrations,['native-lifetime']);
});

test('Run-bound settlement rejects a mismatched tracked registration',async t=>{
 const f=fixture(t);f.startedRun();f.db.exec("UPDATE scheduler_runs SET status='running',lease_owner='worker' WHERE id='run'");
 f.processes.register=(handle,scope,owner)=>{
  const v={schema:'provider-process-registration.v1',authorityId:'different-fence',workerId:'worker',process:{kind:'native-job',lifetimeId:'different-fence'},purpose:scope.purpose,projectId:'project',agentId:'agent',conversationId:'chat',runId:'run',runFence:2};
  f.put('provider-process-registration','different-fence:'+payloadHash(v),v);return 'different-fence';
 };
 await assert.rejects(f.starts.wrap({async openSession(o){o.onRuntimeSpawned(f.handle);return f.handle;}}).openSession({...f.options,onRuntimeSpawned:()=>{},providerRun:{runId:'run',fence:1}}),/registration missing or Run differs/);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM host_lifecycle_commits WHERE kind='provider-start-settlement'").get().n,0);
});

test('real scheduler passes each Run fence to its tracked provider', {timeout:30000}, async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Attribution fixture'),agent=await f.createAgent(chat,'Attribution agent');
  const rows=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId')=?").all(agent.id);
  assert.equal(rows.length,1);
  const admission=JSON.parse(rows[0].receipt_json);
  const run=store.sqlite.prepare("SELECT id,fencing_token,lease_owner FROM scheduler_runs WHERE id=?").get(admission.runId);
  assert.ok(run);assert.equal(admission.runFence,run.fencing_token);assert.equal(admission.workerId,run.lease_owner);
  const settlement=JSON.parse(store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-settlement' AND identity=?").get(admission.identity).receipt_json);
  const lifetime=settlement.registrations[0];
  const regs=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=?").all(lifetime).map(r=>JSON.parse(r.receipt_json));
  assert.ok(regs.some(r=>r.runId===run.id&&r.runFence===run.fencing_token&&r.workerId===run.lease_owner));
  const before=(await f.detail(agent.id)).runs.map(r=>r.id);await f.send(agent.id,'Second task in the same session');await f.settled(agent.id,before);
  const all=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId')=?").all(agent.id).map(r=>JSON.parse(r.receipt_json));
  assert.ok(all.length>=1);
  for(const start of all) {
   const owner=store.sqlite.prepare("SELECT fencing_token,lease_owner FROM scheduler_runs WHERE id=?").get(start.runId);
   assert.ok(owner);assert.equal(start.runFence,owner.fencing_token);assert.equal(start.workerId,owner.lease_owner);
   const settled=JSON.parse(store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-settlement' AND identity=?").get(start.identity).receipt_json);
   const registered=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.authorityId')=?").all(settled.registrations[0]).map(r=>JSON.parse(r.receipt_json));
   assert.ok(registered.some(r=>r.runId===start.runId&&r.runFence===start.runFence&&r.workerId===start.workerId));
  }
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('warm retained provider lifetime remains bound to each exact Run without fabricating starts', {timeout:30000}, async t=>{
 const previous=process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
 process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS='1';
 let store;
 try {
  await withFixture(t,async f=>{
   const chat=await f.createChat('Retained provider attribution'),agent=await f.createIdleAgent(chat,'Worker');
   await f.send(agent.id,'First task');await f.settled(agent.id);
   const before=(await f.detail(agent.id)).runs.map(run=>run.id);
   await f.send(agent.id,'Second task');await f.settled(agent.id,before);
   const turns=f.turns.filter(turn=>turn.agentId===agent.id);
   assert.equal(turns.length,2);
   assert.ok(typeof turns[0].sessionId==="string" && turns[0].sessionId.length>0);
   assert.equal(turns[1].sessionId,turns[0].sessionId,"Both turns report the same provider session");
   const runs=(await f.detail(agent.id)).runs;
   const registrations=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-process-registration' AND json_extract(receipt_json,'$.agentId')=?").all(agent.id).map(row=>JSON.parse(row.receipt_json));
   const bound=runs.map(run=>{
    const canonical=store.sqlite.prepare('SELECT id,fencing_token,lease_owner FROM scheduler_runs WHERE id=?').get(run.id);
    const matches=registrations.filter(row=>row.runId===run.id);
    assert.ok(matches.length,"Exact process registration missing for Run "+run.id);
    assert.ok(matches.every(row=>row.runFence===canonical.fencing_token&&row.workerId===canonical.lease_owner),"Every registration has the exact Run fence and worker");
    const ids=[...new Set(matches.map(row=>row.authorityId))];
    assert.equal(ids.length,1,"Each Run has exactly one provider lifetime");
    return {runId:run.id,ids};
   });
   assert.equal(bound.length,2);
   assert.equal(bound[0].ids[0],bound[1].ids[0],"Both Runs use the same observed retained lifetime");
   const starts=store.sqlite.prepare("SELECT receipt_json FROM host_lifecycle_commits WHERE kind='provider-start-admission' AND json_extract(receipt_json,'$.agentId')=?").all(agent.id).map(row=>JSON.parse(row.receipt_json));
   assert.equal(starts.length,1,'Reusing the live lifetime does not create a new start admission');
   assert.ok(bound.some(row=>row.runId===starts[0].runId));
  },{storeFactory:dir=>(store=new AgentStore(dir))});
 } finally {
  if(previous===undefined)delete process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS;
  else process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS=previous;
 }
});
