import test from 'node:test';import assert from 'node:assert/strict';import {sendQualificationTask,readLeasedRun} from '../shared/ui-load-fixture.mjs';
test('normal asset maintenance retry uses one idempotency key and retains the actual refusal',async()=>{
 const attempts=[],keys=[];const f={api:async(_method,_path,body)=>{keys.push(body.idempotencyKey);return keys.length===1?{status:409,body:{error:'Agent asset maintenance is in progress; retry safely'}}:{status:200,body:{accepted:true}};},ok:response=>{assert.equal(response.status,200);return response.body;}};
 assert.deepEqual(await sendQualificationTask(f,'/api','agent','task',row=>attempts.push(row)),{accepted:true});assert.equal(new Set(keys).size,1);assert.equal(attempts[0].status,409);assert.equal(attempts[1].status,200);
});
test('an unrelated refusal never becomes a retry or a successful task',async()=>{
 let calls=0;const f={api:async()=>{calls++;return {status:409,body:{error:'Other refusal'}};},ok:()=>{throw Error('Other refusal');}};await assert.rejects(sendQualificationTask(f,'/api','agent','task'),/Other refusal/);assert.equal(calls,1);
});
test('lease binding requires exact Agent, live expiry, fencing and provider session',()=>{
 const row={id:'run',agent_id:'agent',status:'running',lease_owner:'owner',lease_expires_at:new Date(Date.now()+60000).toISOString(),fencing_token:7,provider_session_id:'session'};
 const store={sqlite:{prepare:()=>({get:id=>id==='run'?row:undefined})}};
 assert.equal(readLeasedRun(store,'agent','run','session'),row);assert.throws(()=>readLeasedRun(store,'foreign','run','session'));assert.throws(()=>readLeasedRun(store,'agent','run','foreign'));row.fencing_token=0;assert.throws(()=>readLeasedRun(store,'agent','run','session'));row.fencing_token=7;row.lease_expires_at='2000-01-01';assert.throws(()=>readLeasedRun(store,'agent','run','session'));
});
