// Deferred source only: run with the whole implementation when authorized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forkCodexTranscript } from '../../packages/engines/dist/codex-transcript-fork.js';

function fixture(overrides = {}) {
  const calls = [];
  return { calls, rpc: { async request(method, params) {
    calls.push({method, params});
    if (method in overrides) return overrides[method](params);
    if (method === 'thread/read') return {thread:{id:'source',status:{type:'idle'}}};
    if (method === 'thread/goal/get') return {goal:null};
    if (method === 'thread/turns/list') return {data:[{id:'cut',status:'completed'}],nextCursor:null};
    if (method === 'thread/fork') return {thread:{id:'fresh',forkedFromId:'source',sessionId:'source',ephemeral:false}};
    throw new Error(method);
  }}};
}
test('fork uses exact completed boundary and fresh thread ID, never adopts root session authority', async () => {
  const f = fixture();
  const result = await forkCodexTranscript(f.rpc,'source','cut',()=>{});
  assert.equal(result.sessionId,'fresh');
  assert.equal(result.contextAccepted,false);
  assert.equal(result.replayAuthorized,false);
  assert.equal(result.outcome,'completed');
  assert.deepEqual(f.calls.at(-1),{method:'thread/fork',params:{threadId:'source',lastTurnId:'cut',excludeTurns:true,ephemeral:false}});
  assert.ok(f.calls.every(c=>!['turn/start','thread/rollback','thread/revert'].includes(c.method)));
});
test('missing or incomplete boundary and native goal refuse before mutation', async () => {
  for (const overrides of [
    {'thread/turns/list':()=>({data:[],nextCursor:null})},
    {'thread/turns/list':()=>({data:[{id:'cut',status:'inProgress'}],nextCursor:null})},
    {'thread/goal/get':()=>({goal:{status:'active'}})},
    {'thread/read':()=>({thread:{id:'other',status:{type:'idle'}}})},
  ]) {
    const f=fixture(overrides);
    await assert.rejects(forkCodexTranscript(f.rpc,'source','cut',()=>{}));
    assert.ok(!f.calls.some(c=>c.method==='thread/fork'));
  }
});
test('lost response or post-dispatch ownership drift stays unknown without resubmission', async () => {
  const f=fixture({'thread/fork':()=>{throw new Error('transport lost');}});
  assert.equal((await forkCodexTranscript(f.rpc,'source','cut',()=>{})).outcome,'outcome_unknown');
  assert.equal(f.calls.filter(c=>c.method==='thread/fork').length,1);
  const g=fixture();
  const result=await forkCodexTranscript(g.rpc,'source','cut',()=>{
    if(g.calls.some(c=>c.method==='thread/fork')) throw new Error('ownership changed');
  });
  assert.equal(result.outcome,'outcome_unknown');
  assert.equal(result.sessionId,'fresh');
});
