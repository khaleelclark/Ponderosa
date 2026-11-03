import test from 'node:test';
import assert from 'node:assert/strict';
import { registerNativeControlRoutes } from '../../apps/server/dist/routes/native-controls.js';
import { RuntimeElicitationBroker } from '../../apps/server/dist/runtime-elicitation-broker.js';

function fixture(invokeCommand) {
  const handlers=new Map();const audit=[];const identity={};
  const session={engineAgentId:'session',capabilities:async()=>({commands:[{name:'native-permission-mode',invocation:'runtime',status:'available'}]}),invokeCommand};
  const runtime={identity,session};
  const run={runId:'run',v3SchedulerRunId:'run',v3FencingToken:4,persistentRuntimeIdentity:identity,runtimeSession:session,controller:new AbortController()};
  const activeRuns=new Map([['agent',run]]);
  const context={store:{getAgent:()=>({id:'agent',projectId:'project'}),sqlite:{prepare:sql=>({get:()=>sql.includes("agent_run_pauses")?undefined:{}})},appendEvent:(_id,event)=>audit.push(event)},
    assertRetainedAuthentication:()=>{},
    coordinationV3:{contextRecovery:{active:()=>undefined},activeAgentRun:()=>undefined},activeRuns,
    deletingAgentIds:new Set(),deletingProjectIds:new Set(),persistentRuntimeForTermination:()=>runtime,isClosed:()=>false};
  registerNativeControlRoutes({get:(path,handler)=>handlers.set('GET',handler),post:(path,handler)=>handlers.set('POST',handler)},context);
  const reply={status:200,code(status){this.status=status;return this;},send(value){return value;}};
  return {handlers,reply,run,audit};
}
const body={sessionId:'session',runId:'run',fencingToken:4,operation:'permission-mode',value:'default'};

test('human endpoint binds exact saved session and current fence before native mutation',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {outcome:'completed'};});
  const boundary=await f.handlers.get('GET')({params:{id:'agent'}},f.reply);
  assert.equal(boundary.fencingToken,4);
  for(const invalid of [{...body,sessionId:'foreign'},{...body,fencingToken:3},{...body,runId:'foreign'}]) {
    await f.handlers.get('POST')({params:{id:'agent'},body:invalid},f.reply);
    assert.equal(f.reply.status,409);assert.equal(calls,0);
  }
  assert.deepEqual(await f.handlers.get('POST')({params:{id:'agent'},body},f.reply),{outcome:'completed'});
  assert.equal(calls,1);assert.equal(f.audit[0].type,'work_start');
});

test('fence loss during native acknowledgement never reports successful source work or retries',async()=>{
  let calls=0;let release;const f=fixture(async()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const pending=f.handlers.get('POST')({params:{id:'agent'},body},f.reply);
  await new Promise(resolve=>setImmediate(resolve));
  f.run.v3FencingToken=5;release({outcome:'completed'});
  const result=await pending;assert.equal(result.outcome,'outcome_unknown');assert.equal(calls,1);
});

test('native permission decisions never inherit generic remembered confirmation grants and abort settles the wait',async()=>{
  const broker=new RuntimeElicitationBroker();
  const request={mode:'form',serverName:'native runtime approval',message:'exact',requestedSchema:{type:'object',properties:{}},
    nativeApproval:{requestId:'rpc',sessionId:'session',turnId:'turn',kind:'tool'}};
  assert.equal(broker.canRememberForRun(request),false);
  assert.equal(broker.rememberForRun('run',request),false);
  const controller=new AbortController();const waiting=broker.wait('decision',request,controller.signal);
  controller.abort();assert.deepEqual(await waiting,{action:'cancel'});
  assert.equal(broker.respond('decision',{action:'accept',content:{approve:true}}),false);
});

test('native control failures retain the actual cause in the response and durable work log, with secrets redacted',async()=>{
  let calls=0;
  const f=fixture(async()=>{calls++;throw Error('Claude rejected native control: selected mode is unavailable; api_key=SYNTHETIC_NATIVE_SECRET');});
  const result=await f.handlers.get('POST')({params:{id:'agent'},body},f.reply);
  assert.equal(f.reply.status,409);assert.equal(calls,1);
  assert.match(result.error,/selected mode is unavailable/);
  assert.match(result.error,/Do not automatically retry/);
  const event=f.audit.find(event=>event.type==='tool_result');
  assert.equal(event.isError,true);assert.equal(event.output,result.error);
  assert.doesNotMatch(JSON.stringify({result,audit:f.audit}),/SYNTHETIC_NATIVE_SECRET/);
});
