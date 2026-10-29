import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withFixture,until} from '../shared/fixture.mjs';
import {AgentStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';

for(const stage of ['active','requested refresh','handoff','replacement'])test(`human pause/resume preserves exact work during ${stage}`,{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Pause lifecycle'),agent=await f.createIdleAgent(chat,'Paused worker');
  const manager=await f.createIdleAgent(chat,'Requester'),managerSession=await f.hold(manager.id);
  f.plans.set(agent.id,[{hold:true}]);
  f.ok(await f.tool(managerSession,'ponderosa_coordinate',{recipientAgentId:agent.id,text:'Preserve the original tracked task; marker pause-original'}));
  let session=await until(()=>f.sessions.get(agent.id),'source session');
  if(stage!=='active'){
   session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
   await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'requested refresh');
  }
  if(stage==='handoff'||stage==='replacement'){
   f.plans.set(agent.id,stage==='handoff'?[{hold:true}]:[{output:false,run:async s=>{s.events.push({type:'text',delta:'Continue unfinished tracked task, retaining the exact requester and canonical pending instructions. No external actions completed.'});}},{hold:true}]);
   session.finish();
   await until(()=>f.turns.filter(x=>x.agentId===agent.id).length===(stage==='handoff'?2:3),'target rollover stage');
   session=f.sessions.get(agent.id);
  }
  const coord=new CoordinationV3Store(store.sqlite),run=coord.activeAgentRun(agent.id),before=f.turns.filter(x=>x.agentId===agent.id).length;
  const attached=store.sqlite.prepare('SELECT activation_id FROM scheduler_run_activations WHERE run_id=? ORDER BY activation_id').all(run.id);
  const request=store.sqlite.prepare('SELECT id,state FROM coordination_requests WHERE recipient_agent_id=?').get(agent.id);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:randomUUID(),idempotencyKey:randomUUID()})).status,409);
  const key=randomUUID(),paused=f.ok(await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:run.id,idempotencyKey:key}));
  assert.ok(paused.pauseId);
  assert.equal(f.ok(await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:run.id,idempotencyKey:key})).pauseId,paused.pauseId);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:randomUUID(),idempotencyKey:key})).status,409);
  const late=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden paused publication'});assert.notEqual(late.status,200);
  await until(()=>!session.isAlive(),'paused process drains');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state='completed'").get('pause:'+paused.pauseId),'confirmed cleanup');
  assert.equal(coord.activeAgentRun(agent.id),undefined);
  assert.equal(coord.ownsRun(run.id,run.fencingToken),false);
  assert.equal(store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(request.id).state,request.state);
  assert.deepEqual(store.sqlite.prepare('SELECT activation_id FROM scheduler_run_activations WHERE run_id=? ORDER BY activation_id').all(run.id),attached);
  assert.ok((await f.detail(agent.id)).coordinationV3.pause);
  await f.send(agent.id,'Queued while paused remains future work',{activeRunDelivery:'queue'});
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,before);
  if(stage==='active'){
   await f.reopen();
   assert.ok((await f.detail(agent.id)).coordinationV3.pause,'Pause survives full server restart');
   assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,before);
  }
  f.plans.set(agent.id,[{hold:true}]);
  const resumeKey=randomUUID();
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:paused.pauseId,idempotencyKey:resumeKey}));
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:paused.pauseId,idempotencyKey:resumeKey}));
  await until(()=>f.turns.filter(x=>x.agentId===agent.id).length===before+1,'one resumed turn');
  const resumed=new CoordinationV3Store(store.sqlite).activeAgentRun(agent.id);
  assert.equal(resumed.id,run.id,'Resume continues the exact Run');assert.ok(resumed.fencingToken>run.fencingToken);
  assert.equal(store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(request.id).state,request.state);
  const turn=f.turns.filter(x=>x.agentId===agent.id).at(-1);
  assert.match(JSON.stringify(turn),/human resumed this exact paused Run/);
  assert.equal((await f.detail(agent.id)).messages.filter(x=>x.text==='Forbidden paused publication').length,0);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM agent_run_pauses WHERE agent_id=?").get(agent.id).n,1);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
