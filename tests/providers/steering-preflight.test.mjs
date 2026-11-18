import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SteeringAuthorityChangedError } from '../../packages/engines/dist/steering-preflight.js';
import { ClaudeStreamSession } from '../../packages/engines/dist/claude-stream-session.js';
import { CodexAppServerSession } from '../../packages/engines/dist/codex-app-server.js';
import { invokeProviderSteer } from '../../apps/server/dist/provider-session-success.js';
import { providerSessionFacade } from '../../apps/server/dist/provider-session-facade.js';

const input = assertCurrent => ({ prompt:'Follow the later human instruction',kind:'user_message',clientMessageId:'fixture',assertCurrent });
const failAt = n => { let seen=0; return () => { if (++seen===n) throw new SteeringAuthorityChangedError('revoked authority'); }; };

function claude(write) {
  const session=Object.create(ClaudeStreamSession.prototype);
  Object.assign(session,{closed:false,active:true,historyActive:false,fileHistory:{uncertain:false},
    controls:{uncertain:false},opts:{},engineAgentId:'fixture',contextObservations:{submit(){}},
    writeInputFrame:write});
  return session;
}

async function codex() {
  const dir=mkdtempSync(path.join(tmpdir(),'steer-prewrite-'));
  const calls=[];
  const rpc={processIdentity:undefined,request:async(method,params)=>{
    calls.push({method,params});
    return method==='turn/steer' ? {turnId:'turn'} : {turn:{id:'turn'}};
  }};
  const session=new CodexAppServerSession('thread',rpc,dir,false,[],'model',[],undefined,'fixture');
  await session.startTurn({prompt:'Original work',kind:'user_message'});
  calls.length=0;
  return {session,calls,dispose:()=>rmSync(dir,{recursive:true,force:true})};
}

test('Claude rejects each revoked host fence before writing a steering frame',async()=>{
  for(const failedCheck of [1,2]){
    const writes=[];const runtime=claude(async frame=>writes.push(frame));
    const result=await invokeProviderSteer(providerSessionFacade({...runtime,
      engineAgentId:'fixture',isAlive:()=>true,close:async()=>{},startTurn:async()=>({turnId:'turn'}),
      steer:runtime.steer.bind(runtime),interrupt:async()=>{},events:{async *[Symbol.asyncIterator]() {}}}),input(failAt(failedCheck)));
    assert.equal(result.status,'not_active');assert.equal(writes.length,0);
  }
});

test('Codex rejects each revoked host fence before the steering RPC',async()=>{
  for(const failedCheck of [1,2,3]){
    const f=await codex();
    try {
      const result=await f.session.steer(input(failAt(failedCheck)));
      assert.equal(result.status,'not_active');assert.deepEqual(f.calls,[]);
    } finally {f.dispose();}
  }
});

test('a failure after steering transport starts remains ambiguous',async()=>{
  let writes=0;
  const runtime=claude(async()=>{writes++;throw Error('transport outcome unknown');});
  await assert.rejects(runtime.steer(input(()=>{})),/transport outcome unknown/);
  assert.equal(writes,1);
  const f=await codex();
  try {
    f.session.rpc.request=async(method)=>{if(method==='turn/steer'){f.calls.push({method});throw Error('RPC outcome unknown');}return {};};
    await assert.rejects(f.session.steer(input(()=>{})),/RPC outcome unknown/);
    assert.deepEqual(f.calls.map(x=>x.method),['turn/steer']);
  } finally {f.dispose();}
});

test('a custom adapter throwing the host callback after an effect is not treated as a known refusal',async()=>{
  let writes=0;
  const runtime={engineAgentId:'fixture',isAlive:()=>true,close:async()=>{},startTurn:async()=>({turnId:'turn'}),
    steer:async turn=>{writes++;turn.assertCurrent();return {status:'accepted'};},
    interrupt:async()=>{},events:{async *[Symbol.asyncIterator]() {}}};
  await assert.rejects(invokeProviderSteer(providerSessionFacade(runtime),input(()=>{throw new SteeringAuthorityChangedError('revoked');})));
  assert.equal(writes,1);
});

test('an unrelated host validation failure is not classified as a known refusal',async()=>{
  const runtime=claude(async()=>assert.fail('must not submit'));
  await assert.rejects(runtime.steer(input(()=>{throw Error('attachment is missing');})),/attachment is missing/);
  const f=await codex();
  try {
    await assert.rejects(f.session.steer(input(()=>{throw Error('database unavailable');})),/database unavailable/);
    assert.deepEqual(f.calls,[]);
  } finally {f.dispose();}
});
