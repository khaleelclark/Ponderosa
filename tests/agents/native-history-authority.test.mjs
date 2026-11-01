// Deferred regression source. Does not invoke a provider or replay source work.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { NativeHistoryAuthority } from '../../apps/server/dist/native-history-authority.js';
const boundary={agentId:'a',projectId:'p',conversationId:'c',engine:'claude',sessionId:'s',runId:'r',fence:7,toolContractHash:'h',rootPath:'/owned'};
function fixture(t){
  const sqlite=new Database(':memory:');t.after(()=>sqlite.close());
  sqlite.exec(`CREATE TABLE coordination_idempotency(project_id TEXT,actor_scope TEXT,operation TEXT,idempotency_key TEXT,payload_hash TEXT,result_json TEXT,created_at TEXT,PRIMARY KEY(actor_scope,operation,idempotency_key))`);
  return new NativeHistoryAuthority({sqlite});
}
test('native mutation reservation persists exact key replay and blocks another key',t=>{
  const a=fixture(t),input={checkpointId:'cp'};
  const first=a.reserve(boundary,'once','rewind',input);
  assert.equal(first.receipt.state,'started');assert.equal(a.held('a'),true);
  assert.deepEqual(a.reserve(boundary,'once','rewind',input),{receipt:first.receipt,replayed:true});
  assert.throws(()=>a.reserve(boundary,'different','rewind',input));
  assert.throws(()=>a.reserve(boundary,'once','rewind',{checkpointId:'different'}));
  assert.throws(()=>a.cancel('a','once'));
  assert.equal(a.read('a','once').state,'started');
});
test('only unstarted fork can release preparation; opened result cannot replay fork',t=>{
  const a=fixture(t);
  const r=a.reserve(boundary,'fork','fork',{throughId:'cut'},{targetAgentId:'b'}).receipt;
  assert.equal(a.held('a'),true);assert.equal(a.held('b'),true);
  assert.equal(a.cancel('a','fork').state,'cancelled');
  assert.equal(a.held('a'),false);assert.equal(a.held('b'),false);
  const next=a.reserve(boundary,'other-fork','fork',{throughId:'cut'},{targetAgentId:'b'}).receipt;
  const opened=a.save(next,'opened',{nativeSessionId:'fresh'},{newSessionId:'fresh'});
  assert.equal(opened.newSessionId,'fresh');assert.throws(()=>a.cancel('a','other-fork'));
  assert.equal(a.read('a','other-fork').state,'opened');
});
