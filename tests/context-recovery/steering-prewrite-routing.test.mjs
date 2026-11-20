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

test('a refused human Steer starts the same message once after the old Run completes', {timeout:15000}, async t => {
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Refused human Steer');
    const agent = await f.createIdleAgent(chat, 'Worker');
    const oldSession = await f.hold(agent.id);
    const oldRun = (await f.detail(agent.id)).runs[0].id;
    await until(() => store.sqlite.prepare("SELECT 1 FROM scheduler_prompt_injections WHERE run_id=? AND state='acknowledged'").get(oldRun), 'original prompt acknowledged');
    assert.equal((await f.tool(oldSession, 'ponderosa_message', {text:'Original turn finished'})).status, 200);

    const followUp = 'Run this preserved follow-up once';
    const message = await f.send(agent.id, followUp, {activeRunDelivery:'steer'});
    const ref = await until(async () => {
      const receipt = (await f.detail(agent.id)).messages.find(m => m.communicationEventId === message.communicationEventId)?.deliveryReceipts?.[0];
      return receipt?.steeringWaitReason === 'provider_not_ready' && receipt;
    }, 'provider declined the steer');
    assert.equal(ref.providerAcknowledged, undefined);
    f.plans.set(agent.id, [{hold:true}]);
    oldSession.finish();

    await until(() => f.turns.some(turn => turn.input.prompt.includes(followUp)), 'the exact follow-up starts after the refusal');
    const delivery = () => store.sqlite.prepare("SELECT state FROM agent_activations WHERE id=?").get(ref.activationId)?.state;
    await until(() => delivery() === 'attached', 'existing delivery attaches to the next Run');
    const detail = await f.detail(agent.id);
    assert.equal(detail.runs.find(run => run.id === oldRun).status, 'completed');
    assert.equal(f.turns.filter(turn => turn.input.prompt.includes(followUp)).length, 1);
    assert.equal(detail.messages.filter(m => m.communicationEventId === message.communicationEventId).length, 1);
    f.sessions.get(agent.id).finish();
  }, {
    storeFactory: dataDir => (store = new AgentStore(dataDir)),
    steeringResponse: async () => ({status:'not_active'}),
  });
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
