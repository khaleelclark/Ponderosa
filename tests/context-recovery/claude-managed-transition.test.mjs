import {providerProcessHandleFacade} from '../../apps/server/dist/provider-session-facade.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {ownedChroma} from '../memory/portability-fixture.mjs';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {withFixture,until} from '../shared/fixture.mjs';
import {inertClaudeHandoff} from '../shared/inert-claude-handoff.mjs';

const userFrames=async native=>(await native.frames()).filter(x=>x.kind==='input'&&x.frame.type==='user');
const prompt=x=>JSON.stringify(x.frame.message);

test('Claude transition waits for matching session init and exact input echo',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-receipt-')),native=await inertClaudeHandoff(root,{holdEcho:true});
 let session;t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 let done=false;
 const start=session.startTurn({prompt:'Controlled exact handoff',kind:'collaboration',clientMessageId:'exact-input',requireVerifiedInput:true}).then(()=>{done=true;});
 await until(async()=>(await userFrames(native)).length===1,'input frame');
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(done,false,'unacknowledged handoff must wait');
 await native.releaseEcho();await start;assert.equal(done,true);
});


test('Claude rejects a replay with altered input despite the matching session and UUID',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-input-mismatch-')),native=await inertClaudeHandoff(root,{holdEcho:true});
 let session;t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 const start=session.startTurn({prompt:'Exact input',kind:'collaboration',clientMessageId:'exact-input',requireVerifiedInput:true});
 const rejected=assert.rejects(start,/confirm|replay/i);
 await until(async()=>(await userFrames(native)).length===1,'one input');await native.corruptEcho();await rejected;
 assert.equal((await userFrames(native)).length,1);
});

for(const mode of ['wrong','missing'])test(`Claude transition rejects ${mode} resumed-session confirmation`,{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-invalid-receipt-')),native=await inertClaudeHandoff(root,{resumeInit:mode});
 let session;t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 const start=session.startTurn({prompt:'Controlled exact handoff',kind:'collaboration',clientMessageId:'exact-input',requireVerifiedInput:true});
 if(mode==='missing'){
  await until(async()=>(await userFrames(native)).length===1,'input frame');
  await native.answer('An unconfirmed handoff');
 }
 await assert.rejects(start,/confirm|changed|closed|unavailable/i);
});

test('Claude uncertain input is not repeated when its session closes',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-unknown-receipt-')),native=await inertClaudeHandoff(root,{holdEcho:true});
 let session;t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 const start=session.startTurn({prompt:'Do not repeat',kind:'collaboration',clientMessageId:'once',requireVerifiedInput:true});
 const rejected=assert.rejects(start,/closed|confirm/i);
 await until(async()=>(await userFrames(native)).length===1,'one native input');
 await session.close();await rejected;
 assert.equal((await userFrames(native)).length,1);
});


for(const timing of ['before echo','after echo but before authority recheck'])test(`Claude rejects a native tool ${timing}`,{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-tool-gate-')),native=await inertClaudeHandoff(root,{holdEcho:true});
 let session,callbacks=0,revoke=false;
 t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},
  signal:new AbortController().signal,onRuntimeSpawned(){},handleElicitation:async()=>{callbacks++;return {action:'accept',content:{approve:true}};}});
 const start=session.startTurn({prompt:'No early tools',kind:'collaboration',clientMessageId:'exact-input',requireVerifiedInput:true,
  assertCurrent:()=>{if(revoke)throw Error('Run authority changed');}});
 const rejected=assert.rejects(start,/confirm|authority|work/i);
 await until(async()=>(await userFrames(native)).length===1,'one input');
 if(timing==='before echo')await native.preEchoTool();
 else {revoke=true;await native.echoAndTool();}
 await rejected;await new Promise(resolve=>setTimeout(resolve,100));
 const frames=await native.frames();
 assert.equal(callbacks,0);assert.equal(frames.filter(x=>x.kind==='input'&&x.frame.type==='user').length,1);
 assert.equal(frames.some(x=>x.kind==='input'&&x.frame.type==='control_response'&&x.frame.response?.request_id==='premature-tool'&&x.frame.response?.response?.behavior==='allow'),false);
});


test('Claude rejects an unconfirmed Stop hook before native task effects',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-stop-gate-')),native=await inertClaudeHandoff(root,{holdEcho:true});
 let session;t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 const start=session.startTurn({prompt:'No early work',kind:'collaboration',clientMessageId:'exact-input',requireVerifiedInput:true});
 const rejected=assert.rejects(start,/confirm|work/i);
 await until(async()=>(await userFrames(native)).length===1,'one input');await native.preEchoStop();await rejected;
 const frames=await native.frames();
 assert.equal(frames.filter(x=>x.kind==='input'&&x.frame.type==='user').length,1);
 assert.equal(frames.some(x=>x.kind==='input'&&x.frame.type==='control_response'&&x.frame.response?.request_id==='premature-stop'),false);
});

test('silent Claude confirmation times out as unknown without repeating input',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-confirm-timeout-')),native=await inertClaudeHandoff(root,{holdEcho:true});
 const realTimeout=globalThis.setTimeout;
 globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,ms===45000?300:ms,...args);
 let session;t.after(async()=>{globalThis.setTimeout=realTimeout;await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 const start=session.startTurn({prompt:'Once only',kind:'collaboration',clientMessageId:'once',requireVerifiedInput:true});
 const rejected=assert.rejects(start,/timed out.*unknown/i);
 await until(async()=>(await userFrames(native)).length===1,'one native input');await rejected;
 assert.equal((await userFrames(native)).length,1);
});


test('stalled Claude input write reaches unknown timeout without replay',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-write-timeout-')),native=await inertClaudeHandoff(root,{stallInput:true});
 const realTimeout=globalThis.setTimeout;
 globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,ms===45000?400:ms,...args);
 let session;t.after(async()=>{globalThis.setTimeout=realTimeout;await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:'session-one',history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 await until(async()=>(await native.frames()).some(x=>x.kind==='input'&&x.frame.request?.subtype==='initialize'),'initialization frame');
 await new Promise(resolve=>setTimeout(resolve,50));
 let settled=false;
 const start=session.startTurn({prompt:'x'.repeat(8*1024*1024),kind:'collaboration',clientMessageId:'once',requireVerifiedInput:true});
 void start.then(()=>{settled=true;},()=>{settled=true;});
 const rejected=assert.rejects(start,/timed out.*unknown/i);
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(settled,false,'large write remains blocked before deadline');
 await rejected;
 assert.equal(session.isAlive(),false,'the owned process has exited before the unknown outcome settles');
 assert.equal((await userFrames(native)).length,0,'the stalled provider did not consume or replay a full input');
});

test('Claude model change retains objective through a managed handoff before queued work',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude model transition',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Keep the original objective and completed research.');
  await until(async()=>(await userFrames(native)).length>=1,'first input',20000);
  await native.answer('Initial research complete.');await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'opus'}));
  await f.send(agent.id,'Continue the original objective with the new model.');
  const old=await until(async()=>{const x=await userFrames(native);return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(old[1].session,old[0].session);assert.ok(!prompt(old[1]).includes('Continue the original objective with the new model.'));
  await native.answer('Original objective remains open. Initial research complete.');
  const next=await until(async()=>{const x=await userFrames(native);return x.length>=3?x:undefined;},'replacement confirmation',20000);
  assert.notEqual(next[2].session,old[0].session);assert.ok(prompt(next[2]).includes('Original objective remains open.'));
  assert.ok(!prompt(next[2]).includes('Continue the original objective with the new model.'));
  await native.answer('Continuity context received.');
  const final=await until(async()=>{const x=await userFrames(native);return x.length>=4?x:undefined;},'queued task',20000);
  assert.equal(final[3].session,next[2].session);assert.ok(prompt(final[3]).includes('Continue the original objective with the new model.'));
  await native.answer('The original objective is complete.');await f.settled(agent.id);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root)).adapter});
});


test('Claude voice request preserves context and completes its authorized voice reply',{timeout:90000},async t=>{
 let store,native;
 const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
 const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 await withFixture(t,async f=>{
  await f.listen({host:'127.0.0.1',port});
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude voice transition',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Keep the earlier objective.');
  await until(async()=>(await userFrames(native)).length>=1,'first input',20000);
  await native.answer('Earlier research is complete.');await f.settled(agent.id);
  const voice=f.ok(await f.api('POST',`/api/conversations/${chat.id}/direct-messages`,{text:'Continue the objective aloud.',idempotencyKey:randomUUID(),recipients:[{agentId:agent.id}],activeRunDelivery:'steer',voiceReply:true}));
  const old=await until(async()=>{const x=await userFrames(native);return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(old[1].session,old[0].session);assert.ok(!prompt(old[1]).includes('Continue the objective aloud.'));
  await native.answer('The earlier objective and completed research remain available.');
  const next=await until(async()=>{const x=await userFrames(native);return x.length>=3?x:undefined;},'replacement confirmation',20000);
  assert.notEqual(next[2].session,old[0].session);assert.ok(prompt(next[2]).includes('The earlier objective and completed research remain available.'));
  await native.answer('Continuity context received.');
  const final=await until(async()=>{const x=await userFrames(native);return x.length>=4?x:undefined;},'queued voice task',20000);
  assert.equal(final[3].session,next[2].session);assert.ok(prompt(final[3]).includes('Continue the objective aloud.'));
  await native.voice('The objective continues safely.');
  const receipt=await until(async()=>(await native.frames()).find(x=>x.kind==='voice'),'voice authorization',20000);
  assert.equal(receipt.status,200);
  await f.settled(agent.id);
  const reply=f.ok(await f.api('GET',`/api/conversations/${chat.id}/voice-replies/${voice.message.communicationEventId}/${agent.id}`));
  assert.equal(reply.reply.state,'completed');
 },{agentBaseUrl:`http://127.0.0.1:${port}`,storeFactory:p=>(store=new AgentStore(p)),
  nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root)).adapter,
  localMemoryForRoot:async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'claude_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'memory-policy'),provision:true})});
});

test('interrupted Claude managed handoff preserves queued work without replay',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude uncertain handoff',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await userFrames(native)).length>=1,'first input',20000);
  await native.answer('Earlier research complete.');await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'opus'}));
  await f.send(agent.id,'Continue the original task.');
  await until(async()=>(await userFrames(native)).length>=2,'submitted old-session handoff',20000);
  const rollover=store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id);
  const queued=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending'").get(agent.id);
  assert.ok(rollover);assert.ok(queued);
  await f.reopen();
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state IN ('failed','outcome_unknown')").get(rollover.id),'uncertain handoff held',20000);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await userFrames(native)).length,2,'no handoff or user task is resubmitted');
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(queued.id).state,'pending');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind='context_rollover_handoff' AND json_extract(payload_json,'$.rolloverId')=?").get(rollover.id).n,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root,{holdEcho:true})).adapter});
});

test('silent Claude handoff is held as unknown by the scheduler without replay',{timeout:90000},async t=>{
 let store,native;
 const realTimeout=globalThis.setTimeout;
 globalThis.setTimeout=(callback,ms,...args)=>realTimeout(callback,ms===45000?1000:ms,...args);
 t.after(()=>{globalThis.setTimeout=realTimeout;});
 await withFixture(t,async f=>{
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude silent handoff',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await userFrames(native)).length>=1,'first input',20000);
  await native.answer('Earlier research complete.');await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'opus'}));
  await f.send(agent.id,'Continue the original task.');
  await until(async()=>(await userFrames(native)).length>=2,'submitted old-session handoff',20000);
  const rollover=store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id);
  const queued=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending'").get(agent.id);
  assert.ok(rollover);assert.ok(queued);
  await until(()=>store.sqlite.prepare("SELECT 1 FROM context_rollovers WHERE id=? AND state='outcome_unknown'").get(rollover.id),'unknown handoff hold',20000);
  const handoff=store.sqlite.prepare("SELECT id FROM agent_activations WHERE kind='context_rollover_handoff' AND json_extract(payload_json,'$.rolloverId')=?").get(rollover.id);
  const injection=store.sqlite.prepare(`SELECT i.state,r.status FROM scheduler_prompt_injections i JOIN scheduler_runs r ON r.id=i.run_id,
   json_each(i.activation_ids_json) a WHERE a.value=?`).get(handoff.id);
  assert.deepEqual(injection,{state:'outcome_unknown',status:'outcome_unknown'});
  await f.reopen();await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal((await userFrames(native)).length,2,'unconfirmed input is not replayed after restart');
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(queued.id).state,'pending');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE kind='context_rollover_handoff' AND json_extract(payload_json,'$.rolloverId')=?").get(rollover.id).n,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root,{holdEcho:true})).adapter});
});


test('Claude direct MCP calls wait for verified transition input and resume afterward',{timeout:90000},async t=>{
 let store,native;
 const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
 const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 await withFixture(t,async f=>{
  await f.listen({host:'127.0.0.1',port});
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude MCP input fence',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Keep the original objective.');
  await until(async()=>(await userFrames(native)).length>=1,'ordinary input',20000);
  await native.probe('ordinary');
  const ordinary=await until(async()=>(await native.frames()).find(x=>x.kind==='probe'&&x.phase==='ordinary'),'ordinary directory probe',20000);
  assert.equal(ordinary.results[0].status,200,'ordinary Claude runs keep their existing tool access');
  await native.answer('Earlier research complete.');await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/agents/${agent.id}`,{model:'opus'}));
  await f.send(agent.id,'Continue the original objective.');
  await until(async()=>(await userFrames(native)).length>=2,'unconfirmed handoff input',20000);
  const rollover=store.sqlite.prepare("SELECT id FROM context_rollovers WHERE agent_id=? AND state='requested'").get(agent.id);assert.ok(rollover);
  await native.probe('before');
  const before=await until(async()=>(await native.frames()).find(x=>x.kind==='probe'&&x.phase==='before'),'unconfirmed tool probes',20000);
  assert.deepEqual(before.results.map(x=>[x.name,x.status]),[['message',409],['update',409],['directory',409]]);
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM runtime_communications WHERE payload_json LIKE '%SYNTHETIC_UNCONFIRMED_TOOL_EFFECT%'").get().n,0);
  await native.releaseEcho();
  await until(()=>store.sqlite.prepare(`SELECT 1 FROM scheduler_prompt_injections i,json_each(i.activation_ids_json) a
   JOIN agent_activations x ON x.id=a.value WHERE x.kind='context_rollover_handoff' AND json_extract(x.payload_json,'$.rolloverId')=? AND i.state='acknowledged'`).get(rollover.id),'handoff input confirmed',20000);
  await native.probe('after');
  const after=await until(async()=>(await native.frames()).find(x=>x.kind==='probe'&&x.phase==='after'),'confirmed directory probe',20000);
  assert.equal(after.results[0].status,200,'the exact confirmed Run regains its authorized tools');
  await native.answer('The original objective and research remain available.');
  await until(async()=>(await userFrames(native)).length>=3,'replacement',20000);
  await native.answer('Continuity context received.');
  const final=await until(async()=>{const x=await userFrames(native);return x.length>=4?x:undefined;},'queued task',20000);
  assert.equal(final[3].session,final[2].session,'the original task uses the verified replacement session');
  const queued=store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND payload_json LIKE ?").get(agent.id,'%Continue the original objective.%');
  assert.ok(queued);
  await native.probe('before');
  const queuedProbe=await until(async()=>{const probes=(await native.frames()).filter(x=>x.kind==='probe'&&x.phase==='before');return probes.length>=2?probes[1]:undefined;},'unconfirmed queued task probes',20000);
  assert.deepEqual(queuedProbe.results.map(x=>[x.name,x.status]),[['message',409],['update',409],['directory',409]],'the queued task remains gated before its own echo');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM runtime_communications WHERE payload_json LIKE '%SYNTHETIC_UNCONFIRMED_TOOL_EFFECT%'").get().n,0);
  // The fixture withholds echoes for every resumed process, including the
  // exact queued task. Release its echo before allowing provider work.
  await native.releaseEcho();
  await until(()=>store.sqlite.prepare(`SELECT 1 FROM scheduler_prompt_injections i,json_each(i.activation_ids_json) a
   JOIN scheduler_runs r ON r.id=i.run_id WHERE a.value=? AND r.agent_id=? AND r.provider_session_id=? AND i.state='acknowledged'`)
   .get(queued.id,agent.id,final[3].session),'exact queued input confirmed',20000);
  await native.probe('after');
  const queuedAfter=await until(async()=>{const probes=(await native.frames()).filter(x=>x.kind==='probe'&&x.phase==='after');return probes.length>=2?probes[1]:undefined;},'confirmed queued task probe',20000);
  assert.equal(queuedAfter.results[0].status,200,'the confirmed queued task regains its authorized tools');
  await native.answer('The original objective is complete.');await f.settled(agent.id);
  assert.equal((await userFrames(native)).filter(x=>prompt(x).includes('Continue the original objective.')).length,1,'the original task is submitted once');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,1,'the exact original task attaches once');
 },{agentBaseUrl:`http://127.0.0.1:${port}`,storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root,{holdEcho:true})).adapter});
});


test('Claude same-model guidance change preserves the objective on a verified replacement',{timeout:90000},async t=>{
 let store,native;
 await withFixture(t,async f=>{
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude guidance transition',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Preserve the original objective.');
  await until(async()=>(await userFrames(native)).length>=1,'first input',20000);
  await native.answer('Original research complete.');await f.settled(agent.id);
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{instructions:'Updated synthetic Claude guidance.'}));
  await f.send(agent.id,'Continue the exact original objective.');
  const old=await until(async()=>{const x=await userFrames(native);return x.length>=2?x:undefined;},'old handoff',20000);
  assert.equal(old[1].session,old[0].session);assert.ok(!prompt(old[1]).includes('Continue the exact original objective.'));
  await native.answer('Preserve the original objective and completed research.');
  const next=await until(async()=>{const x=await userFrames(native);return x.length>=3?x:undefined;},'replacement confirmation',20000);
  assert.notEqual(next[2].session,old[0].session);assert.ok(prompt(next[2]).includes('Preserve the original objective and completed research.'));
  const run=await until(()=>store.sqlite.prepare("SELECT id FROM scheduler_runs WHERE agent_id=? AND provider_session_id=? AND prompt_injection_state IN ('injecting','injected')").get(agent.id,next[2].session),'replacement input record',20000);
  assert.ok(store.getProviderInput(run.id,true)?.exactSystemPrompt?.includes('Updated synthetic Claude guidance.'));
  await native.answer('Continuity context received.');
  const final=await until(async()=>{const x=await userFrames(native);return x.length>=4?x:undefined;},'original queued task',20000);
  assert.equal(final[3].session,next[2].session);assert.ok(prompt(final[3]).includes('Continue the exact original objective.'));
  await native.answer('The objective is complete.');await f.settled(agent.id);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM context_rollovers WHERE agent_id=?').get(agent.id).n,1);
 },{storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root)).adapter});
});


test('Claude strict resume opens only after correlated initialization without a user frame',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-resume-ready-')),native=await inertClaudeHandoff(root,{startup:'hold'});
 let session,openingHandle,ready=false;t.after(async()=>{await session?.close();await openingHandle?.close();await rm(root,{recursive:true,force:true});});
 const opening=native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:randomUUID(),history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned:s=>{openingHandle=s;}}).then(s=>{ready=true;return s;});
 await until(async()=>(await native.frames()).some(x=>x.frame?.request?.subtype==='initialize'),'initialize requested');
 assert.equal(ready,false);assert.equal((await userFrames(native)).length,0);
 await native.releaseStartup();session=await opening;
 assert.equal(session.validatesResumeBeforeTurn,true);assert.equal(providerProcessHandleFacade(openingHandle).validatesResumeBeforeTurn,true,'opening facade retains the safe data capability');assert.equal((await userFrames(native)).length,0);
 await session.startTurn({prompt:'Only after readiness.',kind:'user_message'});
 await until(async()=>(await userFrames(native)).length===1,'one post-readiness input');
});

for(const startup of ['error','result','exit','silent'])test('Claude strict resume rejects '+startup+' before any user input and drains',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-resume-refused-')),native=await inertClaudeHandoff(root,{startup});let handle;
 t.after(async()=>{await handle?.close();await rm(root,{recursive:true,force:true});});
 await assert.rejects(native.adapter.openSession({cwd:root,agentId:'controlled',resumeSessionId:randomUUID(),history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned:s=>{handle=s;}}),startup==='error'?/Synthetic saved session load failed/:/initializ|missing|ended|stopped|exit/i);
 assert.equal((await userFrames(native)).length,0);assert.equal(handle.isAlive(),false);
});

for(const restart of ['success','exit'])test('Claude between-task root termination retains native-only context across '+restart+' reopening',{timeout:90000},async t=>{
 const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
 const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 let store,native;await withFixture(t,async f=>{
  await f.listen({host:'127.0.0.1',port});
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude idle restart',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  const objective='Preserve the unfinished relay objective.',finding='Synthetic native-only finding: relay port is violet.';
  await f.send(agent.id,objective);await until(async()=>(await userFrames(native)).length===1,'initial work');
  await native.workResult(finding);await until(async()=>(await native.frames()).some(x=>x.kind==='native-only-result'),'native-only result');
  await until(()=>store.readEvents(agent.id).some(x=>x.event.type==='tool_result'&&x.event.output.includes(finding)),'normalized native-only tool evidence');
  await native.publishAnswer('Progress only; objective unfinished.');await f.settled(agent.id);
  const accepted=store.resumeSessionState(agent.id),before=store.sqlite.prepare('SELECT row_key,text FROM chat_search_messages WHERE project_id=? ORDER BY row_key').all(agent.projectId);
  assert.ok(!JSON.stringify(before).includes(finding));
  assert.ok((await native.frames()).some(x=>x.kind==='publication'&&x.status===200),'actual progress reply resolves this delivery');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(agent.id).n,0,'exit begins from actual canonical idle state');
  const originalRoot=(await native.frames()).find(x=>x.kind==='open');
  const alive=()=>{try{process.kill(originalRoot.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  const alreadyExited=!alive();
  if(!alreadyExited)await native.exitIdle();
  await until(()=>!alive(),'observed owned native root exit');
  t.diagnostic('Between-task root termination: '+(alreadyExited?'already exited after acknowledged reply':'controlled process exit while canonically idle'));
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(agent.id).n,0);
  assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId,'root termination retains the accepted generation');
  if(restart==='exit')await native.setStartup('exit');
  await f.send(agent.id,'Continue the same unfinished relay objective.');
  if(restart==='exit'){
   await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status='failed'").get(agent.id),'failed strict reopening settled',20000);
   assert.equal((await userFrames(native)).length,1,'failed reopening submits no new task or replay');
   assert.equal(store.resumeSessionState(agent.id)?.sessionId,accepted.sessionId,'failed opening retains accepted context');
   assert.equal(store.readEvents(agent.id).filter(x=>x.event.type==='session_reset').length,0);
   return;
  }
  const frames=await until(async()=>{const x=await userFrames(native);return x.length===2?x:undefined;},'same-context resumed input',20000);
  assert.equal(frames[1].session,frames[0].session);assert.equal(frames[1].session,accepted.sessionId);
  const opens=(await native.frames()).filter(x=>x.kind==='open');assert.equal(opens.length,2);assert.equal(opens[1].resume,true);
  const restored=(await native.frames()).find(x=>x.kind==='restored-native-context');assert.equal(restored.finding,finding);assert.ok(JSON.stringify(restored.originalInput).includes(objective));
  assert.equal(store.resumeSessionState(agent.id).sessionId,accepted.sessionId);
  assert.equal(store.readEvents(agent.id).filter(x=>x.event.type==='session_reset').length,0);
  // The provider retained its exact session; host does not republish tool output or replay the first input.
  assert.equal(frames.filter(x=>prompt(x).includes(objective)).length,1);
  await native.publishAnswer('The unfinished relay objective is now complete.');await f.settled(agent.id);
  assert.equal((await userFrames(native)).length,2);
 },{agentBaseUrl:`http://127.0.0.1:${port}`,storeFactory:p=>(store=new AgentStore(p)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root,{expectedOrigin:`http://127.0.0.1:${port}`})).adapter});
});


test('Claude transcript fork does not advertise strict saved-session validation',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'claude-fork-capability-')),native=await inertClaudeHandoff(root);let session;
 t.after(async()=>{await session?.close();await rm(root,{recursive:true,force:true});});
 session=await native.adapter.openSession({cwd:root,agentId:'controlled',transcriptFork:{sourceSessionId:randomUUID(),newSessionId:randomUUID(),throughId:randomUUID()},history:[],environment:{PATH:process.env.PATH},signal:new AbortController().signal,onRuntimeSpawned(){}});
 assert.equal(session.validatesResumeBeforeTurn,false);assert.equal(providerProcessHandleFacade(session).validatesResumeBeforeTurn,false);assert.equal((await userFrames(native)).length,0);
});

for(const update of ['description','schema'])test(`Claude retained tools survive a ${update}-only release update`,{timeout:60000},async t=>{
 const {PONDEROSA_RUNTIME_TOOLS}=await import('@ponderosa/core'),tool=PONDEROSA_RUNTIME_TOOLS.find(value=>value.name==='ponderosa_import_file'),before=structuredClone(tool);let store,native;
 try{await withFixture(t,async f=>{
  const chat=f.ok(await f.api('POST','/api/chats',{label:'Claude saved tools',defaultEngine:'claude'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/agents`,{title:'Worker',engine:'claude',conversationId:chat.id,idempotencyKey:randomUUID()}));
  await f.send(agent.id,'Complete the earlier research.');await until(async()=>(await userFrames(native)).length===1,'initial input');await native.answer('Earlier research is complete.');await f.settled(agent.id);
  const accepted=store.acceptedProviderSessionInput(agent.id),saved=structuredClone(accepted.sourceManifest.normalRuntimeContract.dynamicTools);
  if(update==='description')tool.description+=' Controlled description update.';else tool.inputSchema={...tool.inputSchema,properties:{...tool.inputSchema.properties,ui025_optional_note:{type:'string'}}};
  await f.reopen();await f.send(agent.id,'Continue only the remaining objective.');
  const old=await until(async()=>{const rows=await userFrames(native);return rows.length>=2?rows:undefined;},'old contract handoff',15000);
  assert.equal(old[1].session,old[0].session);assert(!prompt(old[1]).includes('Continue only the remaining objective.'));
  await native.answer('Earlier research is complete; the remaining objective is open.');
  const next=await until(async()=>{const rows=await userFrames(native);return rows.length>=3?rows:undefined;},'new contract confirmation',15000);assert.notEqual(next[2].session,old[0].session);
  await native.answer('Continuity context received.');const final=await until(async()=>{const rows=await userFrames(native);return rows.length>=4?rows:undefined;},'new task exactly once',15000);assert.equal(final.length,4);assert.equal(final[3].session,next[2].session);assert(prompt(final[3]).includes('Continue only the remaining objective.'));
  await native.answer('Remaining work completed.');await f.settled(agent.id);
  assert.deepEqual(store.getProviderInput(accepted.executionId,true).sourceManifest.normalRuntimeContract.dynamicTools,saved,'Old packet is never restamped');
  assert.deepEqual(store.acceptedProviderSessionInput(agent.id).sourceManifest.normalRuntimeContract.dynamicTools.find(value=>value.name===tool.name),tool);
  assert.equal(f.ok(await f.api('GET','/api/notifications')).items.some(item=>item.agentId===agent.id&&['attention','urgent'].includes(item.severity)),false,'Automatic release transition is quiet');
 },{storeFactory:root=>(store=new AgentStore(root)),nativeAdapterForEngine:async root=>(native=await inertClaudeHandoff(root)).adapter});}finally{Object.assign(tool,before);}
});
