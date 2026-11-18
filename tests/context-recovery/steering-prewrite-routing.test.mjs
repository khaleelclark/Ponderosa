import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore, CoordinationV3Store } from '../../packages/agents/dist/index.js';
import { SteeringAuthorityChangedError, steeringPreflight } from '../../packages/engines/dist/steering-preflight.js';
import { withFixture, until } from '../shared/fixture.mjs';

test('a proven pre-write refusal uses the existing scheduler queue', {timeout:15000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Prewrite refusal'),agent=await f.createIdleAgent(chat,'Worker');
  await f.hold(agent.id);
  const run=(await f.detail(agent.id)).runs[0].id;
  const message=await f.send(agent.id,'Later user direction',{activeRunDelivery:'steer'});
  const receipt=await until(async()=>{
    const r=(await f.detail(agent.id)).messages.find(m=>m.communicationEventId===message.communicationEventId)?.deliveryReceipts?.[0];
    return r?.steeringWaitReason==='provider_not_ready'&&r;
  },'known refusal waits for provider');
  assert.equal(receipt.providerAcknowledged,undefined);
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(receipt.activationId).state,'retry_pending');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_prompt_injections WHERE run_id=? AND state='outcome_unknown'").get(run).n,0);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_steering_recoveries WHERE run_id=?").get(run).n,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async()=>{
   const current=steeringPreflight({assertCurrent(){throw new SteeringAuthorityChangedError('controlled');}});
   return {status:current?'accepted':'not_active'};
 }});
});

test('a pre-write refusal arriving after Run recovery stays conservatively held',{timeout:15000},async t=>{
 let store,sourceRun;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Revoked prewrite'),agent=await f.createIdleAgent(chat,'Worker');
  await f.hold(agent.id);
  sourceRun=(await f.detail(agent.id)).runs[0].id;
  const message=await f.send(agent.id,'Later user direction',{activeRunDelivery:'steer'});
  const receipt=await until(async()=>{
    const r=(await f.detail(agent.id)).messages.find(m=>m.communicationEventId===message.communicationEventId)?.deliveryReceipts?.[0];
    return r?.state==='unconfirmed'&&r;
  },'recovered Run remains uncertain');
  assert.notEqual(receipt.canRetry,true);
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(sourceRun).status,'outcome_unknown');
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) n FROM scheduler_prompt_injections WHERE run_id=? AND kind='steer' AND state='outcome_unknown'").get(sourceRun).n,1);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),steeringResponse:async({input})=>{
   store.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(sourceRun);
   new CoordinationV3Store(store.sqlite).recoverExpiredRuns(new Date().toISOString());
   const current=steeringPreflight(input);
   assert.equal(current,false);
   return {status:'not_active'};
 }});
});
