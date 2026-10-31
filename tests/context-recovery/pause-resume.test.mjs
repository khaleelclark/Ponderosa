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
  const packet=store.sqlite.prepare('SELECT prompt_hash,system_prompt_hash,source_manifest_json,provider_prompt FROM provider_inputs WHERE scheduler_run_id=?').get(run.id);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:randomUUID(),idempotencyKey:randomUUID()})).status,409);
  const key=randomUUID(),paused=f.ok(await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:run.id,idempotencyKey:key}));
  assert.ok(paused.pauseId);
  assert.equal(f.ok(await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:run.id,idempotencyKey:key})).pauseId,paused.pauseId);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:randomUUID(),idempotencyKey:key})).status,409);
  const late=await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Forbidden paused publication'});assert.notEqual(late.status,200);
  await until(()=>!session.isAlive(),'paused process drains');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state='completed'").get('pause:'+paused.pauseId),'confirmed cleanup');
  assert.equal(coord.activeAgentRun(agent.id),undefined);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/provider-commands`,{name:'compact'})).status,409,'native commands cannot bypass the human hold');
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
  assert.notEqual(resumed.id,run.id,'Recovery has a fresh execution identity');
  const recovery=store.sqlite.prepare('SELECT pause_id,run_id,state FROM agent_pause_recoveries WHERE pause_id=?').get(paused.pauseId);
  assert.equal(recovery.run_id,resumed.id);assert.equal(recovery.pause_id,paused.pauseId);assert.equal(recovery.state,'accepted');
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id).status,'cancelled');assert.ok(resumed.fencingToken>run.fencingToken);
  assert.equal(store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(request.id).state,request.state);
  const turn=f.turns.filter(x=>x.agentId===agent.id).at(-1);
  assert.deepEqual(store.sqlite.prepare('SELECT prompt_hash,system_prompt_hash,source_manifest_json,provider_prompt FROM provider_inputs WHERE scheduler_run_id=?').get(run.id),packet,'original packet remains immutable');
  if(stage==='replacement')assert.deepEqual(store.sqlite.prepare('SELECT prompt_hash,system_prompt_hash,source_manifest_json,provider_prompt FROM provider_inputs WHERE scheduler_run_id=?').get(resumed.id),packet,'replacement recovery preserves exact saved packet hashes');
  if(stage!=='replacement')assert.match(JSON.stringify(turn),/INTERRUPTED EXECUTION CHECKPOINT/);
  assert.doesNotMatch(JSON.stringify(turn),/Queued while paused remains future work/);
  assert.equal((await f.detail(agent.id)).messages.filter(x=>x.text==='Forbidden paused publication').length,0);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM agent_run_pauses WHERE agent_id=?").get(agent.id).n,1);
  let completionSession=f.sessions.get(agent.id);
  if(stage==='handoff'){
   f.plans.set(agent.id,[{hold:true}]);
   completionSession.events.push({type:'text',delta:'Continue the original tracked task on its exact requester route. Interrupted execution has no confirmed external actions; inspect uncertain effects before retry. Preserve canonical pending instructions.'});
   completionSession.finish();
   await until(()=>f.turns.filter(x=>x.agentId===agent.id).length===before+2,'one handoff continuation');
   completionSession=f.sessions.get(agent.id);
  }
  f.ok(await f.tool(completionSession,'ponderosa_update_request',{text:'Original paused task completed on its exact route'}));
  f.plans.set(agent.id,[{hold:true}]);
  completionSession.finish();
  await until(()=>store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(request.id).state==='completed','original Request completed');
  const updated=store.sqlite.prepare('SELECT requester_agent_id,recipient_agent_id FROM coordination_requests WHERE id=?').get(request.id);
  assert.equal(updated.requester_agent_id,manager.id);assert.equal(updated.recipient_agent_id,agent.id);
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(paused.pauseId).n,1);
  await until(()=>f.turns.some(x=>x.agentId===agent.id&&JSON.stringify(x).includes('Queued while paused remains future work')),'queued input runs only after recovered task');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

async function pauseHeld(f,store,agent,session){
 const coord=new CoordinationV3Store(store.sqlite),run=coord.activeAgentRun(agent.id);
 const pause=f.ok(await f.api('POST',`/api/agents/${agent.id}/pause`,{targetRunId:run.id,idempotencyKey:randomUUID()}));
 await until(()=>!session.isAlive(),'pause process exit');
 await until(()=>store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state='completed'").get('pause:'+pause.pauseId),'pause cleanup');
 return {coord,run,pause};
}

for(const failure of ['provider input commit','working folder admission'])test(`recovery retains work and immutable receipts on ${failure} rejection`,{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Recovery rejection'),agent=await f.createIdleAgent(chat,'Worker');
  const session=await f.hold(agent.id),{coord,pause}=await pauseHeld(f,store,agent,session);
  const roots=coord.requiredReplyObligationsForRun(store.sqlite.prepare('SELECT run_id FROM agent_run_pauses WHERE id=?').get(pause.pauseId).run_id);
  const before=f.turns.filter(x=>x.agentId===agent.id).length;
  if(failure==='provider input commit')store.sqlite.exec("CREATE TRIGGER controlled_recovery_reject BEFORE INSERT ON provider_inputs BEGIN SELECT RAISE(ABORT,'controlled recovery input rejection'); END");
  // The second case fails before any durable provider claim through the actual working-copy validator.
  const originalWorkingCopy=store.getAgent(agent.id).workingCopy;
  if(failure==='working folder admission')store.sqlite.prepare("UPDATE agents SET working_copy_json=? WHERE id=?").run(JSON.stringify({...originalWorkingCopy,rootPath:'/nonexistent/controlled-pause-working-folder'}),agent.id);
  const key=randomUUID();f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE id=? AND state='paused' AND last_error IS NOT NULL").get(pause.pauseId),'durable rejection');
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,before,'no rejected provider execution');
  let detail=await f.detail(agent.id);assert.ok(detail.coordinationV3.pause.error);
  const attempt=store.sqlite.prepare('SELECT * FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId);
  assert.equal(attempt.state,'rejected');
  for(const root of roots){const moved=coord.requiredReplyObligationsForRun(attempt.run_id).find(x=>x.sourceActivationId===root.sourceActivationId);assert.ok(moved);assert.notEqual(moved.state,'failed');}
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key}));
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,1,'same key does not create another attempt');
  if(failure==='provider input commit')store.sqlite.exec('DROP TRIGGER controlled_recovery_reject');
  else store.sqlite.prepare('UPDATE agents SET working_copy_json=? WHERE id=?').run(JSON.stringify(originalWorkingCopy),agent.id);
  await until(()=>!store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE run_id=? AND state<>'completed'").get(attempt.run_id),'rejected attempt cleanup');
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()}));
  await until(()=>f.turns.filter(x=>x.agentId===agent.id).length===before+1,'explicit corrected retry');
  const current=coord.activeAgentRun(agent.id);assert.notEqual(current.id,attempt.run_id);
  const newRoots=coord.requiredReplyObligationsForRun(current.id);assert.equal(newRoots.length,roots.length);
  for(const root of roots)assert.deepEqual(newRoots.find(x=>x.sourceActivationId===root.sourceActivationId).replyAuthority,root.replyAuthority);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('submitted recovery failure retains uncertainty and cannot automatically retry',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Unknown recovery'),agent=await f.createIdleAgent(chat,'Worker');
  const session=await f.hold(agent.id),{coord,pause}=await pauseHeld(f,store,agent,session);
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()}));
  await until(()=>coord.activeAgentRun(agent.id),'recovery active');
  const run=coord.activeAgentRun(agent.id);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE run_id=? AND state='accepted'").get(run.id),'provider accepted');
  coord.failRun({runId:run.id,fencingToken:run.fencingToken,workerId:store.sqlite.prepare('SELECT lease_owner FROM scheduler_runs WHERE id=?').get(run.id).lease_owner,sameRunResumable:false,error:'controlled post-submission failure'});
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_pause_recoveries WHERE run_id=?').get(run.id).state,'outcome_unknown');
  assert.equal((await f.detail(agent.id)).coordinationV3.pause.state,'paused');
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()})).status,409);
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,1);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

for(const phase of ['queued recovery','accepted recovery'])test(`Stop supersedes ${phase} and every resume key`,{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Stop recovery'),agent=await f.createIdleAgent(chat,'Worker');
  const session=await f.hold(agent.id),{coord,run,pause}=await pauseHeld(f,store,agent,session);
  const key=randomUUID();
  if(phase==='queued recovery'){
   coord.resumeAgentRun({agentId:agent.id,pauseId:pause.pauseId,idempotencyKey:key});
   assert.equal(coord.cancelAgentRun({agentId:agent.id,expectedRunId:run.id,idempotencyKey:randomUUID()}).cancelled,true);
  }else{
   f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key}));
   await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='accepted'").get(pause.pauseId),'recovery accepted');
   const resumed=coord.activeAgentRun(agent.id);
   assert.equal(coord.cancelAgentRun({agentId:agent.id,expectedRunId:resumed.id,idempotencyKey:randomUUID()}).cancelled,true);
   assert.equal(coord.ownsRun(resumed.id,resumed.fencingToken),false);
  }
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_run_pauses WHERE id=?').get(pause.pauseId).state,'stopped');
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key})).status,409);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=? AND state<>'stopped'").get(pause.pauseId).n,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('normal admission skips an excluded oldest recovery and preserves queue isolation',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Recovery fairness'),a=await f.createIdleAgent(chat,'A'),b=await f.createIdleAgent(chat,'B');
  const sa=await f.hold(a.id),pa=await pauseHeld(f,store,a,sa),sb=await f.hold(b.id),pb=await pauseHeld(f,store,b,sb);
  const coord=pa.coord;
  await f.send(b.id,'Private future queue marker',{activeRunDelivery:'queue'});
  coord.resumeAgentRun({agentId:a.id,pauseId:pa.pause.pauseId,idempotencyKey:randomUUID()});
  coord.resumeAgentRun({agentId:b.id,pauseId:pb.pause.pauseId,idempotencyKey:randomUUID()});
  const lease=coord.leaseNextRun({workerId:'controlled-fairness',excludedAgentIds:[a.id]});
  assert.equal(lease.agentId,b.id);assert.equal(lease.activations.length,1);assert.doesNotMatch(JSON.stringify(lease),/Private future queue marker/);
  assert.notEqual(lease.runId,pb.run.id);
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_run_pauses WHERE id=?').get(pb.pause.pauseId).state,'resume_requested','leasing does not release the hold');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('satisfied reply roots remain satisfied through cold recovery',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Satisfied roots'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  f.ok(await f.tool(session,'ponderosa_message',{text:'Already satisfied canonical reply'}));
  const {coord,run,pause}=await pauseHeld(f,store,agent,session),old=coord.requiredReplyObligationsForRun(run.id);
  assert.ok(old.some(x=>x.state==='satisfied'));
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='accepted'").get(pause.pauseId),'accepted recovery');
  const resumed=coord.activeAgentRun(agent.id),roots=coord.requiredReplyObligationsForRun(resumed.id);
  for(const root of old.filter(x=>x.state==='satisfied')){const moved=roots.find(x=>x.sourceActivationId===root.sourceActivationId);assert.equal(moved.state,'satisfied');assert.equal(moved.satisfiedCommunicationId,root.satisfiedCommunicationId);}
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('interrupted effects and submitted steering remain uncertain evidence, never replay activations',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Effect evidence'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const coord=new CoordinationV3Store(store.sqlite),source=coord.activeAgentRun(agent.id);
  const {appendFile,readFile}=await import('node:fs/promises');
  const effectPath=f.root+'/controlled-effect.txt';await appendFile(effectPath,'one-effect-before-pause\n');
  session.events.push({type:'tool_call',id:'controlled-effect',name:'controlled_effect',input:{marker:'one-effect-before-pause'}});
  session.events.push({type:'tool_result',id:'controlled-effect',output:'one-effect-before-pause completed'});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM events WHERE agent_id=? AND payload_json LIKE '%one-effect-before-pause%'").get(agent.id),'effect audit');
  const uncertainId=randomUUID(),now=new Date().toISOString();
  store.sqlite.prepare(`INSERT INTO scheduler_prompt_injections(id,run_id,kind,sequence,state,prompt_hash,activation_ids_json,created_at,updated_at)
    VALUES(?,?,'steer',99,'submitted','controlled','[]',?,?)`).run(uncertainId,source.id,now,now);
  const {pause}=await pauseHeld(f,store,agent,session);
  assert.equal(store.sqlite.prepare('SELECT state FROM scheduler_prompt_injections WHERE id=?').get(uncertainId).state,'outcome_unknown');
  assert.equal(JSON.parse(store.sqlite.prepare('SELECT injection_snapshot_json FROM agent_run_pauses WHERE id=?').get(pause.pauseId).injection_snapshot_json).find(x=>x.id===uncertainId).state,'submitted');
  f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='accepted'").get(pause.pauseId),'recovery accepted');
  const turn=f.turns.filter(x=>x.agentId===agent.id).at(-1);
  assert.match(JSON.stringify(turn),/one-effect-before-pause/);assert.match(JSON.stringify(turn),/Inspect durable outputs and external state before any retry/);
  assert.equal((await readFile(effectPath,'utf8')).trim().split('\n').length,1);
  const newRun=coord.activeAgentRun(agent.id);
  assert.equal(store.sqlite.prepare(`SELECT count(*) AS n FROM scheduler_run_activations original JOIN scheduler_run_activations replacement ON replacement.activation_id=original.activation_id WHERE original.run_id=? AND replacement.run_id=?`).get(source.id,newRun.id).n,0,'original activations are never re-executed');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('restart rejects an abandoned pre-submission recovery without settling original work',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Restart recovery'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const {coord,run,pause}=await pauseHeld(f,store,agent,session),key=randomUUID();
  const checkpoint=store.sqlite.prepare('SELECT checkpoint_json FROM agent_run_pauses WHERE id=?').get(pause.pauseId).checkpoint_json;
  coord.resumeAgentRun({agentId:agent.id,pauseId:pause.pauseId,idempotencyKey:key});
  const lease=coord.leaseNextRun({workerId:'controlled-abandoned-owner'});assert.equal(lease.agentId,agent.id);
  await f.reopen();
  const recovered=new CoordinationV3Store(store.sqlite),attempt=store.sqlite.prepare('SELECT * FROM agent_pause_recoveries WHERE run_id=?').get(lease.runId);
  assert.equal(attempt.state,'rejected');assert.equal((await f.detail(agent.id)).coordinationV3.pause.state,'paused');
  assert.equal(store.sqlite.prepare('SELECT checkpoint_json FROM agent_run_pauses WHERE id=?').get(pause.pauseId).checkpoint_json,checkpoint);
  assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id).status,'cancelled');
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key}));
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,1);
  assert.equal(recovered.activeAgentRun(agent.id),undefined);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('unconfirmed pause cleanup blocks resume and remains visible after restart',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Cleanup recovery'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const {pause}=await pauseHeld(f,store,agent,session);
  store.sqlite.prepare("UPDATE provider_operation_outbox SET state='failed',available_at=? WHERE idempotency_key=?").run('9999-01-01T00:00:00.000Z','pause:'+pause.pauseId);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()})).status,409);
  await f.reopen();
  assert.equal((await f.detail(agent.id)).coordinationV3.pause.state,'paused');
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,0);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()})).status,409);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

for(const shape of ['0029','0028','0027','foreign table','partial pause schema'])test(`pause migration admits only exact supported predecessor: ${shape}`,()=>{
 const root=mkdtempSync(path.join(tmpdir(),'ponderosa-pause-schema-'));let store;
 try{
  store=new AgentStore(root);
  if(shape==='foreign table')store.sqlite.exec('CREATE TABLE unauthorized_schema_change(id TEXT)');
  else if(shape==='partial pause schema')store.sqlite.exec('DROP TABLE agent_pause_recoveries');
  else {
   store.sqlite.exec('DROP TABLE agent_pause_recoveries; DROP TABLE agent_run_pauses');
   store.sqlite.prepare('DELETE FROM _schema_version WHERE name=?').run('0030_agent_run_pauses.sql');
   if(shape==='0028'||shape==='0027'){
    store.sqlite.exec("DROP TRIGGER assistant_status_communication; DROP TRIGGER assistant_status_request; DROP TRIGGER assistant_status_run; DROP TABLE assistant_status_sources; DROP TABLE assistant_report_scan; DROP TABLE assistant_report_sources; DROP TABLE workspace_agent_actions; DELETE FROM sqlite_sequence WHERE name='assistant_status_sources'");
    store.sqlite.prepare('DELETE FROM _schema_version WHERE name=?').run('0029_assistant_workspace.sql');
   }
   if(shape==='0027'){
    store.sqlite.exec('DROP TABLE capability_policy_history');
    store.sqlite.prepare('DELETE FROM _schema_version WHERE name=?').run('0028_capability_policy_history.sql');
   }

  }
  store.close();store=undefined;
  if(shape==='foreign table'||shape==='partial pause schema')assert.throws(()=>new AgentStore(root),/unsupported|schema|admission|incomplete/i);
  else {store=new AgentStore(root);assert.ok(store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_pause_recoveries'").get());}
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});

for(const rejection of ['resource deferral','scope unavailable'])test(`normal ${rejection} keeps the exact recovery held`,{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Admission hold'),agent=await f.createIdleAgent(chat,'Worker'),session=await f.hold(agent.id);
  const {coord,pause}=await pauseHeld(f,store,agent,session),key=randomUUID();
  coord.resumeAgentRun({agentId:agent.id,pauseId:pause.pauseId,idempotencyKey:key});
  const attempt=store.sqlite.prepare('SELECT * FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId);
  if(rejection==='resource deferral'){
   const lease=coord.leaseNextRun({workerId:'controlled-deferral'});assert.equal(lease.agentId,agent.id);
   coord.deferUninjectedRun(lease.runId,lease.fencingToken);
  }else{
   store.sqlite.prepare('UPDATE agent_activations SET scope_key=? WHERE id=?').run('conversation:unavailable-controlled-scope',attempt.activation_id);
   assert.equal(coord.leaseNextRun({workerId:'controlled-scope'}),undefined);
  }
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_pause_recoveries WHERE activation_id=?').get(attempt.activation_id).state,'rejected');
  assert.equal((await f.detail(agent.id)).coordinationV3.pause.state,'paused');
  coord.resumeAgentRun({agentId:agent.id,pauseId:pause.pauseId,idempotencyKey:key});
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,1);
  assert.equal((await f.api('POST',`/api/agents/${agent.id}/compact`,{})).status,409);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('pausing a recovered execution preserves lineage without recursively nesting provider packets',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Repeated pause'),agent=await f.createIdleAgent(chat,'Worker'),initial=await f.hold(agent.id);
  const first=await pauseHeld(f,store,agent,initial);let pause=first.pause;
  const originalRoots=first.coord.requiredReplyObligationsForRun(first.run.id);
  for(let round=0;round<3;round++){
   f.plans.set(agent.id,[{hold:true}]);f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()}));
   await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='accepted'").get(pause.pauseId),'repeated recovery accepted');
   const current=first.coord.activeAgentRun(agent.id),roots=first.coord.requiredReplyObligationsForRun(current.id);
   for(const original of originalRoots)assert.deepEqual(roots.find(x=>x.sourceActivationId===original.sourceActivationId).replyAuthority,original.replyAuthority);
   const packet=store.getProviderInput(current.id,true).exactPrompt;
   assert.equal(packet.split('INTERRUPTED EXECUTION CHECKPOINT').length-1,1,'old recovery prompts are not recursively replayed');
   if(round<2)pause=(await pauseHeld(f,store,agent,f.sessions.get(agent.id))).pause;
  }
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

for(const boundary of ['handoff_committed','session_retiring','continuation_ready'])for(const action of ['resume','restart','stop','packet retry','claim retry','packet restart','claim restart','packet stop','claim stop','packet unknown'])
test(`pause at ${boundary} preserves committed continuation on ${action}`,{timeout:30000},async t=>{
 let store,pause,agentId,handoffRun,frozen,packet,attached;
 const method={handoff_committed:'commitContextRolloverHandoff',session_retiring:'beginContextRolloverRetirement',continuation_ready:'prepareContextRolloverContinuation'}[boundary];
 const original=CoordinationV3Store.prototype[method];
 const snapshot=()=>{
  const row=store.sqlite.prepare(`SELECT handoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,source_activation_ids_json FROM context_rollovers WHERE agent_id=?`).get(agentId);
  return {row,handoff:store.continuationHandoffForRollover(agentId,row.handoff_event_id)};
 };
 CoordinationV3Store.prototype[method]=function(...args){
  const result=original.apply(this,args);
  if(!pause&&result.agentId===agentId){
   handoffRun=store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND status='running' ORDER BY rowid DESC LIMIT 1").get(agentId).id;
   frozen=snapshot();packet=store.sqlite.prepare('SELECT * FROM provider_inputs WHERE scheduler_run_id=?').get(handoffRun);
   attached=store.sqlite.prepare('SELECT activation_id FROM scheduler_run_activations WHERE run_id=?').all(handoffRun);
   pause=this.pauseAgentRun({agentId,runId:handoffRun,idempotencyKey:randomUUID()});
  }
  return result;
 };
 try {await withFixture(t,async f=>{
  const chat=await f.createChat('Committed handoff boundary'),agent=await f.createIdleAgent(chat,'Worker');agentId=agent.id;
  const manager=await f.createIdleAgent(chat,'Requester'),ms=await f.hold(manager.id);
  f.plans.set(agent.id,[{hold:true}]);
  f.ok(await f.tool(ms,'ponderosa_coordinate',{recipientAgentId:agent.id,text:'Tracked original task must retain requester'}));
  const request=store.sqlite.prepare('SELECT id FROM coordination_requests WHERE recipient_agent_id=?').get(agent.id);
  const session=await until(()=>f.sessions.get(agent.id),'source');
  if(/^(packet|claim) /.test(action)){
   await f.send(agent.id,'Acknowledge this completed human check, then keep the original tracked task');
   const steer=await until(()=>f.steers.find(steer=>steer.agentId===agent.id),'human steering accepted');
   f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Human check acknowledged; tracked task continues',steeringInjectionId:steer.input.clientMessageId}));
   const current=new CoordinationV3Store(store.sqlite).activeAgentRun(agent.id);
   assert.ok(new CoordinationV3Store(store.sqlite).requiredReplyObligationsForRun(current.id).some(root=>root.state==='satisfied'));
   await f.send(agent.id,'Keep this second human reply pending with the original tracked task');
   await until(()=>new CoordinationV3Store(store.sqlite).requiredReplyObligationsForRun(current.id).some(root=>root.state==='pending'),'second pending human root');
  }
  session.events.push({type:'context_usage',providerSessionId:session.engineAgentId,providerSessionGeneration:session.engineAgentId,usedTokens:190000,windowTokens:200000});
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id),'requested');
  f.plans.set(agent.id,[{output:false,run:async s=>{s.events.push({type:'text',delta:'Continue unfinished task and preserve canonical reply authority. No external actions were completed. Inspect uncertain effects before retry.'});}}]);
  session.finish();await until(()=>pause,'boundary pause');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state='completed'").get('pause:'+pause.pauseId),'cleanup');
  assert.equal(store.sqlite.prepare('SELECT phase FROM agent_run_pauses WHERE id=?').get(pause.pauseId).phase,'continuation');
  assert.deepEqual(snapshot(),frozen);
  assert.deepEqual(store.sqlite.prepare('SELECT * FROM provider_inputs WHERE scheduler_run_id=?').get(handoffRun),packet);
  const before=f.turns.filter(x=>x.agentId===agent.id).length;
  await f.send(agent.id,'Unrelated queued boundary input',{activeRunDelivery:'queue'});
  if(action==='restart')await f.reopen();
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,before,'hold excludes pending continuation and unrelated work');
  let coord=new CoordinationV3Store(store.sqlite);
  let rejectedPacket,rejectedRoots;
  const rejectsPacket=action.startsWith('packet '),rejectsClaim=action.startsWith('claim ');
  if(rejectsPacket||rejectsClaim){
   const originalCommit=CoordinationV3Store.prototype.recordProviderInputAndCommitContextRolloverReplacement;
   let injected=false;
   if(rejectsPacket)CoordinationV3Store.prototype.recordProviderInputAndCommitContextRolloverReplacement=function(input){
    const result=originalCommit.call(this,input);
    if(!injected&&input.agentId===agent.id){injected=true;throw new Error('Controlled rejection after canonical packet commit');}
    return result;
   };
   if(rejectsClaim)store.sqlite.exec(`CREATE TRIGGER controlled_claim_rejection BEFORE INSERT ON events
     WHEN NEW.agent_id='${agent.id}' AND NEW.type='agent_lifecycle' AND json_extract(NEW.payload_json,'$.status')='running'
     BEGIN SELECT RAISE(ABORT,'Controlled audit rejection before server claim'); END`);
   const rejectedKey=randomUUID();
   try{
    f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:rejectedKey}));
    await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE id=? AND state='paused' AND last_error IS NOT NULL").get(pause.pauseId),'committed packet rejected');
   }finally{
    CoordinationV3Store.prototype.recordProviderInputAndCommitContextRolloverReplacement=originalCommit;
    if(rejectsClaim)store.sqlite.exec('DROP TRIGGER controlled_claim_rejection');
   }
   const rejected=store.sqlite.prepare('SELECT * FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId);
   assert.equal(rejected.state,'rejected');
   rejectedRoots=coord.requiredReplyObligationsForRun(rejected.run_id);
   assert.ok(rejectedRoots.some(root=>root.state==='pending'));
   assert.ok(rejectedRoots.some(root=>root.state==='satisfied'));
   assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,before,'rejected attempt never submitted');
   assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM scheduler_prompt_injections WHERE run_id=? AND state IN ('submitted','acknowledged','outcome_unknown')").get(rejected.run_id).n,0);
   const rollover=store.sqlite.prepare('SELECT state,replacement_run_id FROM context_rollovers WHERE agent_id=?').get(agent.id);
   assert.deepEqual(rollover,{state:'failed',replacement_run_id:rejected.run_id});
   rejectedPacket=store.sqlite.prepare('SELECT prompt_hash,system_prompt_hash,source_manifest_json,provider_prompt FROM provider_inputs WHERE scheduler_run_id=?').get(rejected.run_id);
   assert.ok(rejectedPacket);
   await until(()=>!store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE run_id=? AND state<>'completed'").get(rejected.run_id),'rejected candidate cleanup');
   if(rejectsClaim)await f.reopen(); // Repair the injected audit projection failure before another public command.
   f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:rejectedKey}));
   assert.deepEqual(store.sqlite.prepare('SELECT * FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId),rejected,'rejected receipt remains immutable');
   if(action.endsWith('restart'))await f.reopen();
   assert.deepEqual(snapshot(),frozen);
   coord=new CoordinationV3Store(store.sqlite);
  }
  if(action==='stop'||action.endsWith(' stop')){

   coord.cancelAgentRun({agentId:agent.id,expectedRunId:handoffRun,idempotencyKey:randomUUID()});
   assert.equal(store.sqlite.prepare('SELECT state FROM agent_run_pauses WHERE id=?').get(pause.pauseId).state,'stopped');
   assert.equal(store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(request.id).state,'outcome_unknown');
   assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM required_reply_obligations WHERE agent_id=? AND state='pending'").get(agent.id).n,0);
   assert.equal((await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()})).status,409);
   return;
  }
  f.plans.set(agent.id,[{hold:true}]);const key=randomUUID();
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key}));
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:key}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='accepted'").get(pause.pauseId),'accepted recovery');
  const current=f.sessions.get(agent.id),run=coord.activeAgentRun(agent.id);
  assert.notEqual(run.id,handoffRun);assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,before+1);
  assert.deepEqual(snapshot(),frozen,'handoff and frozen tail remain immutable');
  assert.deepEqual(store.sqlite.prepare('SELECT activation_id FROM scheduler_run_activations WHERE run_id=?').all(handoffRun),attached);
  const activations=coord.activationPayloads(agent.id,coord.activationIdsAttachedToRun(run.id,agent.id),run.id);
  assert.deepEqual(activations.map(x=>x.kind),[rejectedPacket?'agent_pause_recovery':'context_rollover_continuation']);
  if(rejectedPacket)assert.ok(coord.contextRolloverCandidateForRun(run.id,agent.id),'saved packet recovery has exact rollover authority');
  assert.doesNotMatch(JSON.stringify(f.turns.filter(x=>x.agentId===agent.id).at(-1)),/Unrelated queued boundary input|INTERRUPTED EXECUTION CHECKPOINT/);
  for(const root of rejectedRoots??[]){const moved=coord.requiredReplyObligationsForRun(run.id).find(candidate=>candidate.sourceActivationId===root.sourceActivationId);assert.ok(moved);assert.deepEqual(moved.replyAuthority,root.replyAuthority);assert.equal(moved.state,root.state==='satisfied'?'satisfied':'pending');if(root.state==='satisfied')assert.equal(moved.satisfiedCommunicationId,root.satisfiedCommunicationId);}
  if(action.endsWith(' unknown')){
   coord.failRun({runId:run.id,fencingToken:run.fencingToken,workerId:run.leaseOwner,sameRunResumable:false,retryable:false,error:'Controlled failure after acknowledged exact packet'});
   assert.equal(store.sqlite.prepare('SELECT state FROM agent_pause_recoveries WHERE run_id=?').get(run.id).state,'outcome_unknown');
   const count=store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n;
   assert.equal((await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()})).status,409);
   assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,count);
   assert.deepEqual(store.sqlite.prepare('SELECT prompt_hash,system_prompt_hash,source_manifest_json,provider_prompt FROM provider_inputs WHERE scheduler_run_id=?').get(run.id),rejectedPacket);
   coord.cancelAgentRun({agentId:agent.id,expectedRunId:run.id,idempotencyKey:randomUUID()});
   assert.equal(store.sqlite.prepare('SELECT state FROM agent_run_pauses WHERE id=?').get(pause.pauseId).state,'stopped');
   return;
  }
  f.ok(await f.tool(current,'ponderosa_update_request',{text:'Recovered original tracked task'}));
  assert.deepEqual(store.sqlite.prepare('SELECT state,requester_agent_id,recipient_agent_id FROM coordination_requests WHERE id=?').get(request.id),{state:'completed',requester_agent_id:manager.id,recipient_agent_id:agent.id});
  if(rejectedPacket)assert.deepEqual(store.sqlite.prepare('SELECT prompt_hash,system_prompt_hash,source_manifest_json,provider_prompt FROM provider_inputs WHERE scheduler_run_id=?').get(run.id),rejectedPacket,'corrected retry preserves exact rejected packet and manifest');
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM agent_pause_recoveries WHERE pause_id=?').get(pause.pauseId).n,rejectedPacket?2:1);
  assert.equal(store.sqlite.prepare("SELECT count(*) AS n FROM agent_activations WHERE agent_id=? AND kind IN ('context_rollover_continuation','agent_pause_recovery') AND state IN ('pending','retry_pending','attached')").get(agent.id).n,1);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});}finally{CoordinationV3Store.prototype[method]=original;}
});

test('leased unsubmitted source pause retains its original Request and completes once',{timeout:30000},async t=>{
 let store,agentId,pause,sourceRun;
 const method='markRunStarted',original=CoordinationV3Store.prototype[method];
 CoordinationV3Store.prototype[method]=function(runId,...args){
  if(store.sqlite.prepare('SELECT agent_id FROM scheduler_runs WHERE id=?').get(runId)?.agent_id===agentId&&!pause){
   sourceRun=runId;
   assert.equal(store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(sourceRun).status,'leased');
   assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM provider_inputs WHERE scheduler_run_id=?').get(sourceRun).n,0);
   pause=this.pauseAgentRun({agentId,runId:sourceRun,idempotencyKey:randomUUID()});
  }
  return original.call(this,runId,...args);
 };
 try{await withFixture(t,async f=>{
  const chat=await f.createChat('Early source pause'),agent=await f.createIdleAgent(chat,'Worker');agentId=agent.id;
  const requester=await f.createIdleAgent(chat,'Requester'),manager=await f.hold(requester.id);
  f.ok(await f.tool(manager,'ponderosa_coordinate',{recipientAgentId:agent.id,text:'Early original task must complete only once'}));
  await until(()=>pause,'early pause');
  await until(()=>store.sqlite.prepare("SELECT 1 FROM provider_operation_outbox WHERE idempotency_key=? AND state='completed'").get('pause:'+pause.pauseId),'early cleanup');
  const request=store.sqlite.prepare('SELECT id,state FROM coordination_requests WHERE recipient_agent_id=?').get(agent.id);
  assert.equal(request.state,'open');
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,0,'unsubmitted source never ran');
  assert.equal(store.sqlite.prepare('SELECT count(*) AS n FROM provider_inputs WHERE scheduler_run_id=?').get(sourceRun).n,0);
  f.plans.set(agent.id,[{hold:true}]);
  f.ok(await f.api('POST',`/api/agents/${agent.id}/resume`,{pauseId:pause.pauseId,idempotencyKey:randomUUID()}));
  await until(()=>store.sqlite.prepare("SELECT 1 FROM agent_pause_recoveries WHERE pause_id=? AND state='accepted'").get(pause.pauseId),'early recovery accepted');
  assert.equal(f.turns.filter(x=>x.agentId===agent.id).length,1);
  f.ok(await f.tool(f.sessions.get(agent.id),'ponderosa_update_request',{text:'Original early task completed'}));
  assert.deepEqual(store.sqlite.prepare('SELECT state,requester_agent_id FROM coordination_requests WHERE id=?').get(request.id),{state:'completed',requester_agent_id:requester.id});
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});}finally{CoordinationV3Store.prototype[method]=original;}
});
