// Deferred SOURCE: canonical disposition proof validation with synthetic package receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {readGroupCaptureDisposition} from '../../packages/agents/dist/index.js';
const canonical=v=>JSON.stringify(v,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const custody=id=>createHash('sha256').update(id).digest('hex');
test('group disposition validates exhaustive proofs and raw intent after owner removal',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE branch_commands(execution_id TEXT,command_key TEXT,input_hash TEXT,result_json TEXT,created_at TEXT,PRIMARY KEY(execution_id,command_key))');
 const sources=Array.from({length:3},(_,i)=>({checkpointId:`source-${i}`,sourceChatId:`chat-${i}`,agentIds:[`agent-${i}`],intent:{executionId:'owner',resourceStepId:`step-${i}`,resourceGeneration:0,frontierSha256:'a'.repeat(64),bindingSha256:'b'.repeat(64),configurationSha256:'c'.repeat(64)}}));
 const capture={state:'capturing',sources,receipts:[]},bytes=canonical(capture),captureKey=`issued-group-capture:${'d'.repeat(64)}`;
 const input={executionId:'owner',captureKey,commandKey:'abandon',captureSha256:hash(capture),expectedRevision:'e'.repeat(64)};
 const proofs=sources.map(s=>({custodyId:custody(s.checkpointId),sourceSha256:hash(s),revision:'actual-durable-test-revision'}));
 const receipt={schema:'branch-group-custody-abandon.v1',input,sources,receipts:[],originalCaptureRaw:bytes,packageRetirements:proofs,state:'abandoned'};
 const key=`group-custody-abandoned:${hash(captureKey)}`;
 const save=value=>db.prepare('INSERT OR REPLACE INTO branch_commands VALUES(?,?,?,?,?)').run('owner',key,hash(input),canonical(value),'now');save(receipt);
 assert.equal(readGroupCaptureDisposition(db,'owner',captureKey,bytes).state,'abandoned');
 for(const mutate of [v=>v.packageRetirements.pop(),v=>v.packageRetirements[1].sourceSha256='0'.repeat(64),v=>v.packageRetirements[1].custodyId=v.packageRetirements[0].custodyId,v=>v.originalCaptureRaw+=' ',v=>v.input.commandKey='changed']){
  const changed=structuredClone(receipt);mutate(changed);save(changed);assert.throws(()=>readGroupCaptureDisposition(db,'owner',captureKey,bytes));
 }
 save(receipt);assert.equal(readGroupCaptureDisposition(db,'owner',captureKey,bytes).packageRetirements.length,3);db.close();
});
