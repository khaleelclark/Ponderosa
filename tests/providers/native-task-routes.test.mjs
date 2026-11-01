// Deferred: no tests execute until whole-implementation testing is authorized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const Database=require('better-sqlite3'), Fastify=require('fastify');
import { readFileSync } from 'node:fs';
import { NativeTaskStopAuthority } from '../../packages/agents/dist/index.js';
import { registerNativeTaskRoutes } from '../../apps/server/dist/routes/native-tasks.js';
import { providerSessionFacade } from '../../apps/server/dist/provider-session-facade.js';

async function fixture(t) {
  const sqlite=new Database(':memory:');
  sqlite.exec(`PRAGMA foreign_keys=ON;CREATE TABLE agents(id TEXT PRIMARY KEY);
    INSERT INTO agents VALUES('agent');
    CREATE TABLE scheduler_runs(id TEXT,agent_id TEXT,fencing_token INTEGER,provider_session_id TEXT,status TEXT,
      prompt_injection_state TEXT,side_effects_fenced_at TEXT,lease_expires_at TEXT);
    INSERT INTO scheduler_runs VALUES('source','agent',7,'session','running','injected',NULL,'9999-01-01T00:00:00.000Z');`);
  sqlite.exec(readFileSync(new URL('../../packages/agents/src/schema/0041_native_task_stops.sql',import.meta.url),'utf8'));
  const task={taskKey:'exact-key',taskId:'native-task',taskRunId:'native-run',kind:'local_agent',cancellable:true};
  let stops=0, listHook=()=>{}, stopHook=()=> 'acknowledged';
  const raw={engineAgentId:'session',events:{async *[Symbol.asyncIterator](){}},isAlive:()=>true,close:async()=>{},
    startTurn:async()=>({turnId:'turn'}),steer:async()=>({status:'not_active'}),interrupt:async()=>{},
    listNativeTasks:async()=>{listHook();return [task];},stopNativeTask:async key=>{assert.equal(key,task.taskKey);stops++;return stopHook();}};
  const run={v3SchedulerRunId:'source',v3FencingToken:7,ownershipState:'running',controller:new AbortController(),runtimeSession:providerSessionFacade(raw)};
  const activeRuns=new Map([['agent',run]]), app=Fastify();
  registerNativeTaskRoutes(app,{store:{sqlite,getAgent:id=>id==='agent'?{id}:undefined},activeRuns,unavailable:()=>false});
  await app.ready();t.after(async()=>{await app.close();sqlite.close();});
  const list=()=>app.inject({method:'GET',url:'/api/agents/agent/native-tasks'});
  const input={runId:'source',sourceFence:7,sessionId:'session',taskKey:task.taskKey,idempotencyKey:'human-stop'};
  const stop=(body=input)=>app.inject({method:'POST',url:'/api/agents/agent/native-tasks/stop',payload:body});
  return {sqlite,run,activeRuns,list,stop,input,stops:()=>stops,setList:fn=>listHook=fn,setStop:fn=>stopHook=fn};
}

test('human exact native stop has a durable one-attempt receipt, including after live Run removal',async t=>{
  const f=await fixture(t);
  assert.equal((await f.stop()).statusCode,409,'no guessed unlisted identity');
  assert.equal(f.stops(),0);
  const inventory=(await f.list()).json();assert.equal(inventory.sourceFence,7);assert.equal(inventory.tasks[0].taskRunId,'native-run');
  const result=await f.stop();assert.equal(result.statusCode,200);
  assert.equal(result.json().outcome,'acknowledged');assert.equal(result.json().processDrainObserved,false);
  assert.equal(f.stops(),1);
  assert.equal((await f.stop({...f.input,idempotencyKey:'different-key'})).statusCode,409);
  assert.deepEqual(new NativeTaskStopAuthority(f.sqlite).recorded('agent',f.input),result.json(),'a new host authority reads the durable receipt');
  f.activeRuns.clear();
  assert.deepEqual((await f.stop()).json(),result.json(),'late duplicate reads existing receipt only');
  assert.equal(f.stops(),1);
  assert.equal((await f.stop({...f.input,taskKey:'other-task'})).statusCode,409);
});

test('stale fence, expired lease, cancellation and discovery replacement cannot dispatch a task stop',async t=>{
  const f=await fixture(t);await f.list();
  assert.equal((await f.stop({...f.input,sourceFence:8})).statusCode,409);
  f.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01T00:00:00Z'").run();
  assert.equal((await f.stop()).statusCode,409);
  f.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='9999-01-01T00:00:00Z'").run();
  f.run.controller.abort();assert.equal((await f.stop()).statusCode,409);assert.equal(f.stops(),0);
});

test('changed canonical fence during list cannot publish or authorize stale inventory',async t=>{
  const f=await fixture(t);f.setList(()=>f.sqlite.prepare('UPDATE scheduler_runs SET fencing_token=8').run());
  assert.equal((await f.list()).statusCode,409);assert.equal((await f.stop()).statusCode,409);assert.equal(f.stops(),0);
});

test('unknown native result reserves before dispatch and never retries under a new key',async t=>{
  const f=await fixture(t);await f.list();
  f.setStop(()=>{
    assert.equal(f.sqlite.prepare('SELECT outcome FROM native_task_stops').get().outcome,'unknown');
    throw Error('ack lost');
  });
  assert.equal((await f.stop()).json().outcome,'unknown');
  assert.equal((await f.stop()).json().outcome,'unknown');
  assert.equal((await f.stop({...f.input,idempotencyKey:'try-again'})).statusCode,409);
  assert.equal(f.stops(),1);
});

test('provider task projector refuses accessors without running them',()=>{
  let getter=false;
  const row={taskKey:'key',taskId:'id',kind:'task',cancellable:true};
  Object.defineProperty(row,'taskRunId',{get(){getter=true;throw Error('must not run');}});
  const raw={engineAgentId:'session',events:{async *[Symbol.asyncIterator](){}},isAlive:()=>true,close:async()=>{},
    startTurn:async()=>({turnId:'turn'}),steer:async()=>({status:'not_active'}),interrupt:async()=>{},listNativeTasks:async()=>[row]};
  return assert.rejects(providerSessionFacade(raw).listNativeTasks()).then(()=>assert.equal(getter,false));
});


test('a stalled but still leased original Run retains its human per-task stop control',async t=>{
  const f=await fixture(t);f.run.ownershipState='stalled';
  assert.equal((await f.list()).statusCode,200);
  assert.equal((await f.stop()).json().outcome,'acknowledged');assert.equal(f.stops(),1);
});
