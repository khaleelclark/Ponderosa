import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHmac} from 'node:crypto';
import {AgentStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {pushPayload} from '../../apps/server/dist/web-push-delivery.js';
import {withFixture} from '../shared/fixture.mjs';

const branch=async(f,name)=>f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
const chat=async(f,owner,key=randomUUID())=>f.ok(await f.api('POST',`/api/branches/${owner.id}/chats`,{label:owner.name,defaultEngine:'codex'},{'idempotency-key':key}));

test('Branch Chat creation reuses canonical managed folders and idempotency without granting execution ownership or starting a Run',async t=>{
 let store;
 await withFixture(t,async f=>{
  const first=await branch(f,'First'),second=await branch(f,'Second'),key=randomUUID(),created=await chat(f,first,key);
  assert.equal(created.branchId,first.id);assert.equal(created.executionId,undefined);assert.equal((await chat(f,first,key)).id,created.id);
  const foreign=await f.api('POST',`/api/branches/${second.id}/chats`,{label:first.name,defaultEngine:'codex'},{'idempotency-key':key});assert.ok([400,409].includes(foreign.status),JSON.stringify(foreign));assert.equal(store.getConversation(created.id).branchId,first.id);
  const missing=await f.api('POST','/api/branches/missing/chats',{label:'Missing',defaultEngine:'codex'},{'idempotency-key':randomUUID()});assert.equal(missing.status,404);
  assert.equal(f.ok(await f.api('GET',`/api/branches/${first.id}/chats`)).length,1);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
  await f.reopen();assert.equal(store.getConversation(created.id).branchId,first.id);assert.equal(f.ok(await f.api('GET',`/api/branches/${first.id}/chats`))[0].id,created.id);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('Branch capability routes refuse another Branch and inactive installation resources',async t=>{
 let store;
 await withFixture(t,async f=>{
  const first=await branch(f,'Owned'),second=await branch(f,'Foreign'),owned=await chat(f,first),agent=await f.ok(await f.api('POST',`/api/branches/engine/projects/${owned.projectId}/agents`,{title:'Policy owner',engine:'codex',conversationId:owned.id,idempotencyKey:randomUUID()}));
  const route=`/api/branches/${first.id}/agents/${agent.id}/capabilities`;
  assert.equal((await f.api('GET',route)).status,200);assert.equal((await f.api('GET',`/api/branches/${second.id}/agents/${agent.id}/capabilities`)).status,404);
  const changed=f.ok(await f.api('PUT',route,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]}));assert.ok(changed.effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.managedAgentCreate));
  const before=store.sqlite.prepare('SELECT count(*) n FROM capability_policies').get().n;
  const owner=store.sqlite.prepare('SELECT local_id FROM branch_installation_resources WHERE local_id=?').get(agent.id);
  assert.equal(owner,undefined);
  store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES(?,?,'chat','agent',?,'staging')").run(first.id,'qualification-package',agent.id);
  assert.equal((await f.api('GET',route)).status,404);
  store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE local_id=?").run(agent.id);
  assert.equal((await f.api('GET',route)).status,200);
  store.sqlite.prepare("UPDATE branches SET deleting=1 WHERE id=?").run(first.id);
  assert.equal((await f.api('GET',route)).status,404);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM capability_policies').get().n,before);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('Branch favorites and folders reuse canonical preferences, reject stale edits and survive reopening',async t=>{
 await withFixture(t,async f=>{
  const owner=await branch(f,'Favorite'),preferences=f.ok(await f.api('GET','/api/branches/engine/workspace/preferences')),folder={id:'favorites',name:'Favorites',branchIds:[owner.id],expanded:true,starred:true};
  const changed=f.ok(await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchFolders:[folder],branchFoldersRevision:preferences.revision,branchOrder:[owner.id],branchSort:'custom',starredResourceIds:[`branch:${owner.id}`]}));
  assert.deepEqual(changed.branchFolders,[folder]);
  assert.equal((await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchFolders:[],branchFoldersRevision:preferences.revision})).status,409);
  assert.equal((await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchFolders:[folder,{...folder,id:'duplicate'}],branchFoldersRevision:changed.revision})).status,400);
  assert.equal((await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchFolders:[{...folder,branchIds:['missing']}],branchFoldersRevision:changed.revision})).status,400);
  assert.equal((await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchSort:'invalid'})).status,400);
  f.ok(await f.api('POST','/api/branches/engine/workspace/recent-resources/use',{kind:'branch',resourceId:owner.id}));
  await f.reopen();const replay=f.ok(await f.api('GET','/api/branches/engine/workspace/preferences'));assert.deepEqual(replay.branchFolders,[folder]);assert.deepEqual(replay.starredResourceIds,[`branch:${owner.id}`]);assert.equal(replay.branchSort,'custom');
  const organized=f.ok(await f.api('GET','/api/branches?section=organized'));assert.equal(organized[0]?.id??organized.items?.[0]?.id,owner.id);
 });
});

test('HTTP Branch webhook intake verifies exact bytes, survives replay, and requires the reviewed snapshot for pause/resume',async t=>{
 let store;
 await withFixture(t,async f=>{
  const owner=await branch(f,'Webhook'),configuration={replayWindowSeconds:300};
  const deployed=f.ok(await f.api('POST','/api/branches/deploy',{chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:randomUUID(),definition:{schema:'ponderosa.branch.v1',name:'Webhook',trigger:{kind:'webhook',configRef:'source'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('verified');"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},triggers:{source:{sourceConfig:configuration,enabled:true}}}}));
  assert.equal(typeof deployed.webhookSecret,'string');const trigger=f.ok(await f.api('GET',`/api/branches/${owner.id}/trigger`));assert.equal(JSON.stringify(trigger).includes(deployed.webhookSecret),false);
  const paused=f.ok(await f.api('PATCH',`/api/branches/${owner.id}/trigger`,{enabled:false,reviewedTrigger:trigger}));assert.equal(paused.enabled,false);
  assert.equal((await f.api('PATCH',`/api/branches/${owner.id}/trigger`,{enabled:true,reviewedTrigger:trigger})).status,409);
  f.ok(await f.api('PATCH',`/api/branches/${owner.id}/trigger`,{enabled:true,reviewedTrigger:paused}));
  const raw='{ "operatorManual":true, "recipientAgentId":"unrelated", "text":"External data" }',timestamp=String(Math.floor(Date.now()/1000)),event='one-event';
  const headers={'content-type':'application/json','x-ponderosa-event-id':event,'x-ponderosa-timestamp':timestamp,'x-ponderosa-signature':'v1='+createHmac('sha256',deployed.webhookSecret).update(`${timestamp}.${event}.`).update(raw).digest('hex')},url=`/api/trigger-webhooks/${trigger.id}`;
  const accepted=await f.api('POST',url,raw,headers);assert.equal(accepted.status,202,JSON.stringify(accepted));
  const execution=store.sqlite.prepare('SELECT admission_source FROM branch_executions WHERE id=(SELECT branch_execution_id FROM trigger_occurrences WHERE id=?)').get(accepted.body.occurrenceId);assert.equal(execution.admission_source,'automatic');
  assert.equal((await f.api('POST',url,raw,headers)).status,200);
  assert.equal((await f.api('POST',url,JSON.stringify(JSON.parse(raw)),headers)).status,401,'Parsing and reserializing must not satisfy a signature over different bytes');
  assert.equal((await f.api('POST',url,raw,{...headers,authorization:''})).status,401,'A webhook signature does not replace operator authentication');
  assert.equal((await f.api('POST',url,raw,{...headers,origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await f.api('POST',url,raw,{...headers,host:'untrusted.invalid'})).status,421);
  for(const eventId of ['second-event','third-event']){
   const signature='v1='+createHmac('sha256',deployed.webhookSecret).update(`${timestamp}.${eventId}.`).update(raw).digest('hex');
   assert.equal((await f.api('POST',url,raw,{...headers,'x-ponderosa-event-id':eventId,'x-ponderosa-signature':signature})).status,202);
  }
  await f.reopen();const ids=[];let before;
  do{const page=f.ok(await f.api('GET',`/api/branches/${owner.id}/trigger/occurrences?limit=1${before?'&before='+before:''}`));assert.ok(page.every(item=>item.triggerId===trigger.id));ids.push(...page.map(item=>item.id));before=page.length?page.at(-1).id:undefined;}while(before);
  assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.ok(ids.includes(accepted.body.occurrenceId));
  assert.equal((await f.api('GET',`/api/branches/${owner.id}/trigger/occurrences?limit=101`)).status,400);
  assert.equal((await f.api('GET',`/api/branches/${owner.id}/trigger/occurrences?before=${randomUUID()}`)).status,400);
  assert.equal((await f.api('GET',`/api/branches/missing/trigger/occurrences?before=${ids[0]}`)).status,404);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),authToken:'controlled-webhook-regression-auth'});
});


test('push destinations retain canonical Branch ownership, nested Chat focus and execution identity',()=>{
 const item={id:'notification',title:'Result',body:'Done',projectId:'p',conversationId:'c',communicationEventId:'message#Build-Coordinator'};
 const owners={getConversation:id=>id==='c'?{branchId:'b',executionId:'e'}:undefined,getAgent:()=>undefined};
 const url=new URL(pushPayload(item,owners).url,'https://example.test');
 assert.equal(url.pathname,'/branches');assert.equal(url.searchParams.get('branch'),'b');assert.equal(url.searchParams.get('execution'),'e');assert.equal(url.searchParams.get('chat'),'c');
 const workspace=new URL(url.searchParams.get('workspace'),'https://example.test');
 assert.equal(workspace.pathname,'/projects/p/chats/c');assert.equal(workspace.searchParams.get('message'),item.communicationEventId);
 assert.equal(pushPayload(item).url,'/projects/p/chats/c?message=message%23Build-Coordinator');
 const gate=new URL(pushPayload({...item,projectId:undefined,conversationId:undefined,branchId:'b',branchExecutionId:'e'}).url,'https://example.test');assert.equal(gate.searchParams.get('tab'),'executions');assert.equal(gate.searchParams.get('execution'),'e');
});


test('portable installation import is canonically validated before opening a form without creating installation plans', async t => {
 let store;
 await withFixture(t, async f => {
  const pkg={schema:'ponderosa.branch-installation.v1',packageId:randomUUID(),mode:'template',exportedAt:new Date().toISOString(),definition:{schema:'ponderosa.branch.v1',name:'Import validation',trigger:{kind:'manual'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('done')"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[],agentBindings:{}};
  const count=()=>store.sqlite.prepare('SELECT count(*) n FROM branch_installation_plans').get().n;
  const before=count();
  assert.equal((await f.api('POST','/api/branches/import-preview',pkg)).status,200);
  const node={ref:'worker',title:'Worker',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}};
  const agent={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',rootRef:'worker',exportedAt:new Date().toISOString(),sourceLabel:'Worker',agents:[node]};
  const invalidAgents={...pkg,chats:[{ref:'chat',title:'Chat',agents:[{ref:'worker',definition:{...agent,agents:{length:1,0:node}}}]}]};
  for(const invalid of [{schema:pkg.schema},{...pkg,definition:undefined},{...pkg,chats:[null]},invalidAgents]) {
   const response=await f.api('POST','/api/branches/import-preview',invalid);
   assert.equal(response.status,400,JSON.stringify(response));
   assert.equal(count(),before);
  }
  const valid={...pkg,chats:[{ref:'chat',title:'Chat',agents:[{ref:'worker',definition:agent}]}]};
  assert.equal((await f.api('POST','/api/branches/import-preview',valid)).status,200);
  assert.equal(count(),before);
 }, {storeFactory:dir=>(store=new AgentStore(dir))});
});
