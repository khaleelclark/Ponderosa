import assert from 'node:assert/strict';
import test from 'node:test';
import {communicationV3Prompt,communicationV3SessionPrompt,providerToolContractHash,providerDynamicTools} from '../../apps/server/dist/runtime-selection.js';
import {withFixture} from '../shared/fixture.mjs';

test('stable protocol instructions occur once per session; each injection still carries current reply authority',()=>{
 const session=communicationV3SessionPrompt();
 assert.equal(new Set(session).size,session.length);
 for(const route of [undefined,{intent:'direct_to_user',agentId:'fixture'}]){
  const injection=communicationV3Prompt(route);
  assert.equal(injection.length,1);
  assert.equal(injection.some(line=>session.includes(line)),false);
  assert.match(injection[0],route?/one authorized default reply route/:/no authorized default reply route/);
 }
 const text=session.join('\n');
 for(const required of ['ponderosa_update_request','ponderosa_coordinate','ponderosa_decision','ponderosa_create_managed_agent','Prior turns do not confer','terminal Request result','Do not poll or sleep','ponderosa_import_file','voice Direct Message'])assert.ok(text.includes(required),required);
 assert.notEqual(providerToolContractHash(providerDynamicTools(),session),providerToolContractHash(providerDynamicTools(),session.slice(1)),'Protocol changes invalidate provider session reuse');
});

test('actual scheduler prompts retain default route and canonical explicit reply works after removing repeated protocol',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Protocol'),agent=await f.createIdleAgent(chat,'Speaker'),session=await f.hold(agent.id);
  const prompt=f.turns.at(-1).input.prompt;
  const run=(await f.detail(agent.id)).runs[0];
  const recorded=f.ok(await f.api('GET',`/api/runs/${run.id}/provider-input?exact=1`));
  for(const instruction of communicationV3SessionPrompt())assert.equal(recorded.exactSystemPrompt.split(instruction).length-1,1,instruction);
  assert.equal(recorded.exactPrompt.split('one authorized default reply route').length-1,1);
  assert.match(prompt,/one authorized default reply route/);
  assert.equal(prompt.includes('Common delegation: ponderosa_coordinate'),false);
  f.ok(await f.tool(session,'ponderosa_message',{text:'Canonical reply without protocol repetition'}));
  session.finish();await f.settled(agent.id);
  assert.equal((await f.detail(agent.id)).messages.filter(m=>m.text==='Canonical reply without protocol repetition').length,1);
 });
});

test('Branches scheduler records one protocol and preserves its private canonical reply route',{timeout:30000},async t=>{
 const {randomUUID}=await import('node:crypto');
 const {until}=await import('../shared/fixture.mjs');
 await withFixture(t,async f=>{
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Protocol fixture',idempotencyKey:randomUUID()}));
  const chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Protocol Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const prefix='/api/branches/engine';
  const agent=f.ok(await f.api('POST',`${prefix}/projects/${chat.projectId}/agents`,{title:'Protocol speaker',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
  f.plans.set(agent.id,[{hold:true}]);
  f.ok(await f.api('POST',`${prefix}/agents/${agent.id}/messages`,{text:'Controlled private task',idempotencyKey:randomUUID()}));
  await until(()=>f.sessions.get(agent.id),'Branches provider input');
  const session=f.sessions.get(agent.id),detail=()=>f.api('GET',`${prefix}/agents/${agent.id}`).then(f.ok);
  const run=(await detail()).runs[0];
  const recorded=f.ok(await f.api('GET',`${prefix}/runs/${run.id}/provider-input?exact=1`));
  for(const instruction of communicationV3SessionPrompt())assert.equal(recorded.exactSystemPrompt.split(instruction).length-1,1,instruction);
  assert.equal(recorded.exactPrompt.split('one authorized default reply route').length-1,1);
  assert.equal(recorded.exactPrompt.includes('Common delegation: ponderosa_coordinate'),false);
  f.ok(await f.tool(session,'ponderosa_message',{text:'Branches private reply'}));session.finish();
  await until(async()=>!(await detail()).runs.some(r=>['running','preparing'].includes(r.status)),'Branches completed reply');
  assert.equal((await detail()).messages.filter(m=>m.text==='Branches private reply').length,1);
 });
});
