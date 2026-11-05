import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStore} from '@ponderosa/agents';
import {CAPABILITY_IDS,AGENT_PACKAGE_MAX_BYTES,AGENT_PACKAGE_METADATA_MAX_BYTES} from '@ponderosa/core';
import {pushPayload} from '../../apps/server/dist/web-push-delivery.js';
import {withFixture,until} from '../shared/fixture.mjs';

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

test('HTTP unsigned Branch webhook intake preserves canonical deduplication, Origin checks and reviewed pause/resume',async t=>{
 let store;
 await withFixture(t,async f=>{
  const owner=await branch(f,'Webhook'),configuration={};
  const deployed=f.ok(await f.api('POST','/api/branches/deploy',{chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:randomUUID(),definition:{schema:'ponderosa.branch.v1',name:'Webhook',trigger:{kind:'webhook',configRef:'source'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('verified');"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},triggers:{source:{sourceConfig:configuration,enabled:true}}}}));
  assert.equal(deployed.webhookSecret,undefined);const trigger=f.ok(await f.api('GET',`/api/branches/${owner.id}/trigger`));assert.equal(trigger.enabled,true);assert.equal(trigger.secretFingerprint,undefined);
  const paused=f.ok(await f.api('PATCH',`/api/branches/${owner.id}/trigger`,{enabled:false,reviewedTrigger:trigger}));assert.equal(paused.enabled,false);
  assert.equal((await f.api('PATCH',`/api/branches/${owner.id}/trigger`,{enabled:true,reviewedTrigger:trigger})).status,409);
  f.ok(await f.api('PATCH',`/api/branches/${owner.id}/trigger`,{enabled:true,reviewedTrigger:paused}));
  const raw='{ "operatorManual":true, "recipientAgentId":"unrelated", "text":"External data" }',event='one-event';
  const headers={'content-type':'application/json','x-ponderosa-event-id':event},url=`/api/trigger-webhooks/${trigger.id}`;
  const accepted=await f.api('POST',url,raw,headers);assert.equal(accepted.status,202,JSON.stringify(accepted));
  const execution=store.sqlite.prepare('SELECT admission_source FROM branch_executions WHERE id=(SELECT branch_execution_id FROM trigger_occurrences WHERE id=?)').get(accepted.body.occurrenceId);assert.equal(execution.admission_source,'automatic');
  assert.equal((await f.api('POST',url,raw,headers)).status,200);
  assert.equal((await f.api('POST',url,JSON.stringify(JSON.parse(raw)),headers)).status,200,'Equivalent canonical JSON replays the same occurrence');
  assert.equal((await f.api('POST',url,{text:'changed'},headers)).status,409);
  assert.equal((await f.api('POST',url,raw,{'content-type':'application/json'})).status,400);
  assert.equal((await f.api('POST',url,'invalid',headers)).status,400);
  assert.equal((await f.api('POST',url,'x'.repeat(1024*1024+1),headers)).status,413);
  assert.equal((await f.api('POST',url,raw,{...headers,'x-ponderosa-timestamp':'0','x-ponderosa-signature':'invalid'})).status,200,'Obsolete network authentication headers do not gate intake');
  assert.equal((await f.api('POST',url,raw,{...headers,authorization:''})).status,200,'Webhook replay needs no operator authentication');
  assert.equal((await f.api('POST',url,raw,{...headers,origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await f.api('POST',url,raw,{...headers,host:'untrusted.invalid'})).status,200);
  for(const eventId of ['second-event','third-event']){
   assert.equal((await f.api('POST',url,raw,{...headers,'x-ponderosa-event-id':eventId})).status,202);
  }
  await f.reopen();const ids=[];let before;
  do{const page=f.ok(await f.api('GET',`/api/branches/${owner.id}/trigger/occurrences?limit=1${before?'&before='+before:''}`));assert.ok(page.every(item=>item.triggerId===trigger.id));ids.push(...page.map(item=>item.id));before=page.length?page.at(-1).id:undefined;}while(before);
  assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);assert.ok(ids.includes(accepted.body.occurrenceId));
  assert.equal((await f.api('GET',`/api/branches/${owner.id}/trigger/occurrences?limit=101`)).status,400);
  assert.equal((await f.api('GET',`/api/branches/${owner.id}/trigger/occurrences?before=${randomUUID()}`)).status,400);
  assert.equal((await f.api('GET',`/api/branches/missing/trigger/occurrences?before=${ids[0]}`)).status,404);
  const portable=f.ok(await f.api('GET',`/api/branches/${owner.id}/package?mode=template`));
  const plan=f.ok(await f.api('POST','/api/branches/install-preview',{package:portable,bindings:{agents:{},directories:{workspace:f.root},triggers:{source:{enabled:true,sourceConfig:{}}}}}));
  const installed=f.ok(await f.api('POST',`/api/branches/installations/${plan.id}/confirm`,{}));assert.equal(installed.state,'completed',installed.error);
  const installedTrigger=f.ok(await f.api('GET',`/api/branches/${installed.branchId}/trigger`));assert.equal(installedTrigger.enabled,true,'Package installation needs no generated secret');
  assert.equal((await f.api('POST',installedTrigger.webhookPath,{text:'installed'},{'x-ponderosa-event-id':'installed-event'})).status,202);
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

test('BR004 canonical Workflow use drives complete organized metadata and generation-fenced Recent pages',async t=>{
 let store;
 await withFixture(t,async f=>{
  // The mandatory Assistant owns an initial workflow before user workflows exist.
  // Include all initial workflows in the ordinary paged directory assertions.
  const initialResponse=await f.api('GET','/api/branches');
  const initial=f.ok(initialResponse);
  assert.equal(initialResponse.headers['x-collection-has-more'],'false');
  assert.equal(Number(initialResponse.headers['x-total-count']),initial.length);
  assert.ok(initial.some(row=>row.name==='Assistant'),'The default Assistant workflow is visible');
  const owners=[];for(let i=0;i<125;i++)owners.push(await branch(f,'Recent '+String(i).padStart(3,'0')));
  const expectedIds=new Set([...initial,...owners].map(row=>row.id));
  assert.equal(expectedIds.size,initial.length+owners.length);
  const prefs=f.ok(await f.api('GET','/api/branches/engine/workspace/preferences'));
  f.ok(await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchSort:'last_used',branchFolders:[{id:randomUUID(),name:'Complete',expanded:false,branchIds:owners.map(row=>row.id)}],branchFoldersRevision:prefs.revision,starredResourceIds:['branch:'+owners[0].id]}));
  const use=async owner=>f.ok(await f.api('POST','/api/branches/engine/workspace/recent-resources/use',{kind:'branch',resourceId:owner.id}));
  const exact=f.ok(await f.api('GET','/api/branches?search=Recent%200'));assert.equal(exact.length,100);
  const exactResponse=await f.api('GET','/api/branches?search=Recent%200');assert.equal(exactResponse.headers['x-collection-has-more'],'false');
  for(const query of ['search=a&search=b','chatId=a&chatId=b','cursor=a&cursor=b'])assert.equal((await f.api('GET','/api/branches?'+query)).status,400);
  const used=await use(owners[0]);
  const read=async cursor=>f.api('GET','/api/branches'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
  let first=await read();assert.equal(first.status,200);assert.equal(first.body.length,100);assert.equal(first.body[0].id,owners[0].id);assert.equal(first.body[0].lastUsedAt,used.lastUsedAt);assert.equal(Number(first.headers['x-total-count']),expectedIds.size);
  assert.equal((await f.api('GET','/api/branches?before='+owners[0].id)).status,400,'Obsolete cursors must fail visibly instead of repeating page one');
  const cursor=first.headers['x-next-cursor'];assert.ok(cursor);
  const next=await read(cursor);assert.equal(next.status,200);assert.equal(next.body.length,expectedIds.size-100);assert.deepEqual(new Set([...first.body,...next.body].map(row=>row.id)),expectedIds);
  const complete=f.ok(await f.api('GET','/api/branches?section=organized'));assert.equal(complete.length,125);assert.equal(complete.find(row=>row.id===owners[0].id).lastUsedAt,used.lastUsedAt);
  await use(owners[1]);assert.equal((await read(cursor)).status,409);
  first=await read();assert.equal(first.body[0].id,owners[1].id);
  const beforeCreate=first.headers['x-next-cursor'];await branch(f,'New draft');assert.equal((await read(beforeCreate)).status,409);
  first=await read();store.sqlite.prepare('UPDATE branches SET name=? WHERE id=?').run('Renamed',owners[5].id);assert.equal((await read(first.headers['x-next-cursor'])).status,409);
  first=await read();store.sqlite.prepare('UPDATE branches SET deleting=1 WHERE id=?').run(owners[6].id);assert.equal((await read(first.headers['x-next-cursor'])).status,409);assert.ok(!f.ok(await f.api('GET','/api/branches?section=organized')).some(row=>row.id===owners[6].id));
  assert.equal((await f.api('GET','/api/branches?search=not-matching&cursor='+encodeURIComponent(beforeCreate))).status,400);
  await use(owners[1]);const beforeRestart=(await read()).headers['x-next-cursor'];await f.reopen();assert.equal((await read()).body[0].id,owners[1].id);assert.equal((await read(beforeRestart)).status,409);
  f.ok(await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchSort:'alphabetical'}));first=await read();await use(owners[3]);assert.equal((await read(first.headers['x-next-cursor'])).status,200);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('one-click Branch Chats resolve Settings once and replay exact receipts across defaults/provider changes and restart',async t=>{
 let store,installed=true;
 await withFixture(t,async f=>{
  const owner=await branch(f,'One-click owner'),key=randomUUID(),input={label:'New Chat',defaultEngine:'codex'},url=`/api/branches/${owner.id}/chats`,headers={'idempotency-key':key};
  f.ok(await f.api('PATCH','/api/workspace/preferences',{engineDefaults:{codex:{model:'first',effort:'medium'}}}));
  const [a,b]=await Promise.all([f.api('POST',url,input,headers),f.api('POST',url,input,headers)]),created=f.ok(a);assert.equal(f.ok(b).id,created.id);assert.equal(created.branchId,owner.id);assert.equal(created.title,'New Chat');
  const project=store.getChatContext(created.id);assert.equal(project.defaultModel,'first');assert.equal(project.defaultEffort,'medium');assert.equal(created.defaultSpeed,'fast');
  f.ok(await f.api('PATCH','/api/workspace/preferences',{engineDefaults:{codex:{model:'second',effort:'high'}}}));
  assert.equal(f.ok(await f.api('POST',url,input,headers)).id,created.id);assert.equal(store.getChatContext(created.id).defaultModel,'first');
  const next=f.ok(await f.api('POST',url,input,{'idempotency-key':randomUUID()}));assert.equal(store.getChatContext(next.id).defaultModel,'second');assert.equal(store.getChatContext(next.id).defaultEffort,'high');
  const other=await branch(f,'Other owner');assert.equal((await f.api('POST',`/api/branches/${other.id}/chats`,input,headers)).status,409);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branch_versions WHERE branch_id=?').get(owner.id).n,0);
  installed=false;await f.reopen();assert.equal(f.ok(await f.api('POST',url,input,headers)).id,created.id);assert.equal(f.ok(await f.api('GET',`${url}?limit=100`)).length,2);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),providerInstalled:()=>installed,modelCatalog:async()=>({models:[{id:'first',label:'First',kind:'alias',source:'provider-probe',efforts:[{id:'medium',label:'Medium'}],defaultEffort:'medium',serviceTiers:[{id:'fast',label:'Fast'}],defaultServiceTier:'fast'},{id:'second',label:'Second',kind:'alias',source:'provider-probe',efforts:[{id:'high',label:'High'}],defaultEffort:'high'}],cliVersion:'fixture',configurationKey:'fixture'})});
});

test('BR010 Chat picker searches before paging, keeps exact ownership and fences Recent cursors after use',async t=>{
 let store;
 await withFixture(t,async f=>{
  const owner=await branch(f,'Picker'),other=await branch(f,'Foreign'),rows=[];
  for(let n=0;n<103;n++){const project=store.createProject({label:n===0?'Oldest target':n<3?'Duplicate':n===3?'Literal %_ title':`Chat ${n}`,chatOwned:true,branchId:owner.id,hostPath:f.root,defaultEngine:'codex'});rows.push(store.getConversation(project.lastConversationId));}
  store.createProject({label:'Oldest target',chatOwned:true,branchId:other.id,hostPath:f.root,defaultEngine:'codex'});
  const base=`/api/branches/${owner.id}/chats`,first=await f.api('GET',base+'?limit=100');f.ok(first);assert.equal(first.body.length,100);assert.equal(first.headers['x-total-count'],'103');assert.ok(!first.body.some(chat=>chat.id===rows[0].id));
  const cursor=first.headers['x-next-cursor'],next=f.ok(await f.api('GET',base+'?limit=100&cursor='+encodeURIComponent(cursor)));assert.equal(next.length,3);assert.equal(new Set([...first.body,...next].map(chat=>chat.id)).size,103);
  assert.deepEqual(f.ok(await f.api('GET',base+'?search=oldest%20TARGET')).map(chat=>chat.id),[rows[0].id]);assert.equal(f.ok(await f.api('GET',base+'?search=Duplicate')).length,2);assert.deepEqual(f.ok(await f.api('GET',base+'?search=%25_')).map(chat=>chat.id),[rows[3].id]);assert.equal(f.ok(await f.api('GET',base+'?search=no-match')).length,0);
  assert.equal((await f.api('GET',base+'?search=target&cursor='+encodeURIComponent(cursor))).status,400);assert.equal((await f.api('GET',`/api/branches/${other.id}/chats?cursor=`+encodeURIComponent(cursor))).status,400);assert.equal((await f.api('GET',base+'?search='+('x'.repeat(201)))).status,400);
  f.ok(await f.api('POST','/api/branches/engine/workspace/recent-resources/use',{kind:'conversation',resourceId:rows[0].id}));assert.equal((await f.api('GET',base+'?cursor='+encodeURIComponent(cursor))).status,409);assert.equal(f.ok(await f.api('GET',base+'?limit=1'))[0].id,rows[0].id);
  assert.equal(f.ok(await f.api('GET',`/api/branches/contexts/${rows[0].id}`)).branchId,owner.id);await f.reopen();assert.equal(f.ok(await f.api('GET',base+'?limit=1'))[0].id,rows[0].id);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('publication issues preserve canonical messages and stable step/edge identities without publishing',async t=>{
 let store;
 await withFixture(t,async f=>{
  const owner=await branch(f,'Issue navigation');
  const script=(id,cwdRef='root')=>({id,label:'Duplicate Name',kind:'script',runtime:'node',source:'',cwdRef,timeoutMs:5000});
  const definition={schema:'ponderosa.branch.v1',name:'Issue navigation',trigger:{kind:'manual'},entry:'first',steps:[script('first'),script('second')],controls:[],edges:[{id:'next',from:'first',to:'second',on:'success'}],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
  const payload={chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:randomUUID(),definition,bindings:{agents:{},directories:{root:f.root}}};
  const versionCount=store.sqlite.prepare('SELECT COUNT(*) n FROM branch_versions').get().n;
  const temporary=d=>{d.steps[1]={id:'second',label:'Duplicate Name',kind:'agent',target:{kind:'ephemeral_agent',templateRef:'temp'},instructions:''};d.templates={temp:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Team',rootRef:'root',agents:[{ref:'root',title:'Agent',engine:'default',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]}};return d.templates.temp.agents[0]};
  const cases=[
   {change:d=>{temporary(d).title=''},nodeId:'second',section:'agent_setup',field:'title',templateMemberRef:'root',message:/Invalid template Agent title/},
   {change:d=>{temporary(d).initialInstructions=42},nodeId:'second',section:'agent_setup',field:'initialInstructions',templateMemberRef:'root',message:/Branch text must be a string/},
   {change:d=>{temporary(d).managerRef='root'},nodeId:'second',section:'agent_setup',field:'managerRef',templateMemberRef:'root',message:/Template root cannot have a manager/},
   {change:d=>{d.steps[1].failure={action:'retry',maxAttempts:0,delayMs:0}},nodeId:'second',section:'failure',field:'failure.maxAttempts',message:/retry attempts must be a whole number/},
   {change:d=>{d.steps[1].failure={action:'retry',maxAttempts:3,delayMs:-1}},nodeId:'second',section:'failure',field:'failure.delayMs',message:/retry delay must be a whole number/},
   {change:d=>{d.steps[1]={id:'second',label:'Duplicate Name',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:42}},nodeId:'second',section:'task',field:'instructions',message:/Branch text must be a string/},
   {change:d=>{d.edges[0].to='missing'},nodeId:'first',edgeId:'next',section:'connections',field:'to',message:/Invalid graph edge/},
   {change:d=>{d.edges[0].input={kind:'literal',text:42}},nodeId:'first',edgeId:'next',section:'advanced',field:'input',message:/Branch text must be a string/},
   {change:d=>{d.edges[0].loop='yes'},nodeId:'first',edgeId:'next',section:'advanced',field:'loop',message:/Invalid loop edge/},
   {change:d=>{d.steps[1]={id:'second',label:'Duplicate Name',kind:'branch_call',branchRef:'missing'}},nodeId:'second',section:'task',field:'branchRef',message:/Called Branch is missing or unavailable/},
   {change:(d,b)=>{d.steps[1].failure={action:'recover',agentRef:'repair',maxAttempts:1};b.agents.repair=''},nodeId:'second',section:'failure',field:'failure.agentRef',message:/Agent is required/},
   {change:d=>{d.policy.failure={action:'retry',maxAttempts:0,delayMs:0}},section:'settings',field:'failure.maxAttempts',message:/retry attempts must be a whole number/},
   {change:(d,b)=>{d.steps[1].cwdRef='second';b.directories.second=''},nodeId:'second',section:'advanced',field:'cwdRef',message:/Working directory is required/},
   {change:(d,b)=>{d.steps[1].cwdRef='second';b.directories.second=f.root+'/missing-directory'},nodeId:'second',section:'advanced',field:'cwdRef',message:/Working directory does not resolve/},
   {change:d=>{d.steps[1]={id:'second',label:'Duplicate Name',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:''}},nodeId:'second',section:'task',field:'target',message:/Branch Agent is unavailable/},
  ];
  for(const expected of cases){
   const input=structuredClone(payload);expected.change(input.definition,input.bindings);
   for(const endpoint of ['preview','deploy']){
    const result=await f.api('POST',`/api/branches/${endpoint}`,input);
    assert.equal(result.status,400,JSON.stringify(result));assert.match(result.body.error,expected.message);
    const issue=result.body.issues?.[0];assert.ok(issue,'Canonical validation supplies navigation context');
    assert.equal(result.body.issues.length,1);assert.equal(issue.message,result.body.error);
    for(const key of ['nodeId','edgeId','section','field','templateMemberRef'])assert.equal(issue[key],expected[key],`${key}: ${result.body.error}`);
   }
  }
  assert.equal((await f.api('POST','/api/branches/preview',payload)).status,200,'Existing empty Script acceptance is unchanged');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM branch_versions').get().n,versionCount);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('Agent picker team and Chat context comes from canonical membership outside filtered pages',async t=>{
 await withFixture(t,async f=>{
  const owner=await branch(f,'Picker owner'),owned=await chat(f,owner),foreign=await branch(f,'Other owner'),other=await chat(f,foreign);
  const create=async(chat,title,managerAgentId)=>f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title,engine:'codex',conversationId:chat.id,managerAgentId,idempotencyKey:randomUUID()}));
  const lead=await create(owned,'Unique lead'),member=await create(owned,'Different member',lead.id);await create(other,'Foreign Agent');
  const leads=f.ok(await f.api('GET',`/api/branches/${owner.id}/agents?limit=1&search=Unique`));
  assert.equal(leads.length,1);assert.equal(leads[0].id,lead.id);assert.equal(leads[0].hasTeam,true);assert.equal(leads[0].chatTitle,owned.title);
  const members=f.ok(await f.api('GET',`/api/branches/${owner.id}/agents?limit=1&search=Different`));
  assert.equal(members[0].id,member.id);assert.equal(members[0].managerTitle,lead.title);assert.equal(members[0].hasTeam,false);
  assert.equal(f.ok(await f.api('GET',`/api/branches/${owner.id}/agents?search=Foreign`)).length,0);
 });
});

test('Assistant bootstrap is single-flight, persistent, editable and disabled until explicit re-enable after role removal',async t=>{
 let store;
 await withFixture(t,async f=>{
  const enable=()=>f.api('POST','/api/branches/assistant',{initialize:true});
  const [one,two]=await Promise.all([enable(),enable()]);const first=f.ok(one),second=f.ok(two);
  assert.equal(first.enabled,true,JSON.stringify(first));assert.equal(first.app.agentId,second.app.agentId);
  const app=first.app,agent=store.getAgent(app.agentId),history=f.ok(await f.api('GET',`/api/branches/engine/agents/${app.agentId}`)).messages;
  assert.equal(app.url,`/apps/${app.agentId}`);assert.equal(app.everyMs,600000);assert.equal(app.automatic,true);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branches').get().n,1);
  const renamed=f.ok(await f.api('PATCH',`/api/branches/engine/agents/${app.agentId}`,{title:'My Assistant',model:'fixture'}));assert.equal(renamed.id,app.agentId);
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,app.agentId);
  assert.deepEqual(f.ok(await f.api('GET',`/api/branches/engine/agents/${app.agentId}`)).messages,history);
  await f.reopen();assert.equal(f.ok(await enable()).app.agentId,app.agentId);
  const schedule=f.ok(await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,expectedSettingsRevision:app.settingsRevision,automatic:false,everyMs:1200000}));
  assert.equal(schedule.automatic,false);assert.equal(schedule.everyMs,1200000);
  assert.equal(f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`)).sourceConfig.whenRunning,'run_latest','everyday schedule settings preserve the existing busy policy');
  assert.equal((await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,expectedSettingsRevision:app.settingsRevision,automatic:true,everyMs:60000})).status,409);
  f.ok(await f.api('PUT',`/api/branches/output-apps/${app.agentId}`,{enabled:false}));
  assert.equal(f.ok(await enable()).enabled,false,'ordinary initialization never restores a removed speaker');
  assert.equal((await f.api('GET',`/api/branches/output-apps/${app.agentId}`)).status,404);
  const fresh=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));assert.equal(fresh.enabled,true);assert.notEqual(fresh.app.agentId,app.agentId);
  assert.equal(store.getAgent(app.agentId).id,agent.id,'old user-owned workflow/Agent are retained');
  store.sqlite.exec("CREATE TEMP TRIGGER refuse_assistant_pause BEFORE UPDATE OF enabled ON trigger_definitions BEGIN SELECT RAISE(ABORT,'Controlled pause failure'); END");
  assert.equal((await f.api('POST','/api/branches/assistant',{enabled:false})).status,409);
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,true,'a failed pause must not claim Assistant disabled');
  store.sqlite.exec('DROP TRIGGER refuse_assistant_pause');
  const disabled=f.ok(await f.api('POST','/api/branches/assistant',{enabled:false}));assert.equal(disabled.enabled,false);
  const kept=f.ok(await f.api('GET',`/api/branches/output-apps/${fresh.app.agentId}`));assert.equal(kept.automatic,false,'disable pauses proactive intake');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('output roles reject foreign/ephemeral Agents and duplicate speakers; imports cannot carry installation role authority',async t=>{
 let store;
 await withFixture(t,async f=>{
  const ordinary=await f.createChat('Ordinary'),ordinaryAgent=await f.createAgent(ordinary,'Ordinary Agent');
  assert.equal((await f.api('PUT',`/api/branches/output-apps/${ordinaryAgent.id}`,{enabled:true})).status,409);
  const assistant=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true}));
  const owner=await branch(f,'Another app'),owned=await chat(f,owner);
  const other=f.ok(await f.api('POST',`/api/branches/engine/projects/${owned.projectId}/agents`,{title:'Other output',engine:'codex',conversationId:owned.id,idempotencyKey:randomUUID()}));
  const output=f.ok(await f.api('PUT',`/api/branches/output-apps/${other.id}`,{enabled:true}));assert.equal(output.app.speaker,false);
  assert.equal((await f.api('PUT',`/api/branches/output-apps/${other.id}`,{enabled:true,speaker:true})).status,409);
  assert.equal((await f.api('PATCH','/api/branches/engine/workspace/preferences',{outputApps:{agentIds:[other.id],speakerAgentId:other.id,initialized:true}})).status,400);
  const pkg=f.ok(await f.api('GET',`/api/branches/engine/agents/${assistant.app.agentId}/export?mode=template`));
  assert.equal(JSON.stringify(pkg).includes('speakerAgentId'),false);
  f.ok(await f.api('PUT',`/api/branches/output-apps/${assistant.app.agentId}`,{enabled:true,speaker:false}));
  assert.equal(f.ok(await f.api('PUT',`/api/branches/output-apps/${other.id}`,{enabled:true,speaker:true})).app.speaker,true);
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,other.id);
  await f.reopen();assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,other.id);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('output URL Agent receives a real controlled-provider direct message and attachment through existing canonical routes',async t=>{
 await withFixture(t,async f=>{
  const status=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true})),app=status.app;
  const detail=f.ok(await f.api('GET',`/api/branches/engine/agents/${app.agentId}`)),previous=detail.runs.map(run=>run.id);
  f.plans.set(app.agentId,[{run:async session=>assert.equal((await session.tool('ponderosa_message',{text:'OUTPUT_APP_REPLY'})).success,true)}]);
  const asset=f.ok(await f.api('POST',`/api/branches/engine/agents/${app.agentId}/attachments`,Buffer.from('Output app fixture attachment'),{'content-type':'application/octet-stream','x-ponderosa-filename':'output.txt','x-ponderosa-media-type':'text/plain'}));
  f.ok(await f.api('POST',`/api/branches/engine/agents/${app.agentId}/messages`,{text:'Reply from this output app',attachmentIds:[asset.id],idempotencyKey:randomUUID()}));
  await until(async()=>{const detail=f.ok(await f.api('GET',`/api/branches/engine/agents/${app.agentId}`));return detail.runs.some(run=>!previous.includes(run.id)&&['completed','failed','interrupted'].includes(run.status))&&detail.messages.some(message=>message.text==='OUTPUT_APP_REPLY');},'output app controlled reply');
  const final=f.ok(await f.api('GET',`/api/branches/engine/agents/${app.agentId}`));
  assert.ok(final.messages.some(message=>message.text==='OUTPUT_APP_REPLY'));
  assert.ok(f.turns.some(turn=>turn.agentId===app.agentId));
 });
});

test('deleting the speaker disables Assistant without automatic recreation and malformed role/schedule inputs leave it intact',async t=>{
 await withFixture(t,async f=>{
  const status=f.ok(await f.api('POST','/api/branches/assistant',{enabled:true})),app=status.app;
  for(const body of [{enabled:'yes'},{enabled:true,speaker:'yes'},{enabled:true,extra:'scope'}])assert.equal((await f.api('PUT',`/api/branches/output-apps/${app.agentId}`,body)).status,409);
  for(const everyMs of [0,1000,60000.5])assert.equal((await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,expectedSettingsRevision:app.settingsRevision,automatic:true,everyMs})).status,409);
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).app.agentId,app.agentId);
  const preview=f.ok(await f.api('POST',`/api/branches/engine/projects/${app.projectId}/agent-deletions/preview`,{rootAgentIds:[app.agentId]}));
  f.ok(await f.api('POST',`/api/branches/engine/projects/${app.projectId}/agent-deletions/commit`,{rootAgentIds:[app.agentId],previewHash:preview.previewHash}));
  assert.equal(f.ok(await f.api('GET','/api/branches/assistant')).enabled,false);
  await f.reopen();assert.equal(f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).enabled,false);
 });
});

test('a retry pins the original Assistant import payload even if workspace model defaults change',async()=>{
 const {OutputAgentApps}=await import('../../apps/server/dist/output-agent-apps.js');
 let preferences={engineDefaults:{codex:{model:'original',effort:'medium'}}};const attempts=[];
 const workspace={cursor:()=>0,getPreferences:()=>preferences,updatePreferences:patch=>(preferences={...preferences,...patch})};
 const branches={create:()=>({id:'owned-branch',createdAt:'2026-10-29T00:00:00.000Z'})};
 const importer={validateAgent(){},async importAgent(project,chat,pkg,mapping,key){attempts.push({pkg,mapping,key});throw Error('Controlled interrupted import');}};
 const create=()=>new OutputAgentApps({},branches,workspace,async()=>({id:'chat',projectId:'project'}),importer,()=> 'codex');
 await assert.rejects(create().initialize(true),/Controlled interrupted/);
 preferences.engineDefaults.codex.model='changed';
 await assert.rejects(create().initialize(true),/Controlled interrupted/);
 assert.deepEqual(attempts[1],attempts[0],'retry must not change the tracked import hash/key or silently adopt new defaults');
});

// Public-client regressions are authored for the later consolidated run.
test('public Branches client uses only encoded HTTP routes, stable mutation keys and visible errors',async()=>{
 const {BranchesClient,BranchesHttpError}=await import('../../packages/core/dist/branches-client.js');const calls=[];
 const client=new BranchesClient('http://fixture.invalid',async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({error:'Exact conflict'}),{status:409,headers:{'content-type':'application/json'}});});
 await assert.rejects(client.invoke('workflow/one','state','stable-key'),error=>error instanceof BranchesHttpError&&error.status===409&&error.message==='Exact conflict');
 assert.equal(calls.length,1,'Mutations are never automatically retried');assert.equal(calls[0].url,'http://fixture.invalid/api/branches/workflow%2Fone/executions');assert.deepEqual(JSON.parse(calls[0].init.body),{input:'state',occurrenceKey:'stable-key'});
});

test("public state example creates its Branch and runs its graph through HTTP",{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const {BranchesClient}=await import("../../packages/core/dist/branches-client.js");
  const {createStateApplication}=await import("../../examples/branches-capabilities/state.ts");
  const client=new BranchesClient(await f.listen()),input={directory:f.root,commandKey:randomUUID()};
  const app=await createStateApplication(client,input),again=await createStateApplication(client,input);
  assert.equal(again.workflow.id,app.workflow.id,"deployment retry reuses its Branch");
  const execution=await app.start("synthetic input","state-example");
  const result=await until(async()=>{const detail=await client.state(execution.id);return detail.execution.state==="completed"&&detail;},"state example completion",20000);
  assert.equal(result.execution.state,"completed");
  const state=await app.read(execution.id);
  assert.deepEqual([...state.values.observations].sort(),[2,3]);
  assert.equal(state.values.total,5);
  assert.deepEqual(state.values.summary,{maximum:3,total:5});
  assert.equal(state.revision,3);
  // Only effect-free Script/control checkpoints are selected; no uncertain Agent effect is replayed.
  const checkpoints=await client.checkpoints(app.workflow.id,execution.id);
  const selected=checkpoints.find(checkpoint=>checkpoint.restoreSupported&&checkpoint.eligibility==="script_control_frontier");
  assert.ok(selected,"expected a supported Script/control checkpoint");
  const selection={checkpointId:selected.id,expectedHash:selected.contentHash,commandKey:"state-rewind"};
  const restored=await client.rewind(app.workflow.id,execution.id,"historical",selection);
  assert.equal((await client.rewind(app.workflow.id,execution.id,"historical",selection)).id,restored.id);
  await until(async()=>{const detail=await client.state(restored.id);return detail.execution.state==="completed"&&detail;},"restored state completion",20000);
  const restoredState=await app.read(restored.id);
  assert.deepEqual(restoredState.values,state.values);assert.equal(restoredState.revision,state.revision);
  assert.deepEqual((await app.read(execution.id)).values,state.values);
 });
});

test("public research example uses explicitly owned Agents and reaches human review",{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const create=async name=>{
   const owner=f.ok(await f.api("POST","/api/branches",{name,idempotencyKey:randomUUID()}));
   const chat=f.ok(await f.api("POST",`/api/branches/${owner.id}/chats`,{label:name,defaultEngine:"codex"},{"idempotency-key":randomUUID()}));
   const agent=f.ok(await f.api("POST",`/api/branches/engine/projects/${chat.projectId}/agents`,{title:name,engine:"codex",conversationId:chat.id,idempotencyKey:randomUUID()}));
   return {owner,agent};
  };
  const research=await create("Synthetic researcher"),parent=await create("Synthetic critic");
  const {BranchesClient}=await import("../../packages/core/dist/branches-client.js");
  const {createReviewApplication}=await import("../../examples/branches-capabilities/application.ts");
  const client=new BranchesClient(await f.listen());
  const input={researchBranchId:research.owner.id,researchVersionId:research.owner.versionId,parentBranchId:parent.owner.id,parentVersionId:parent.owner.versionId,researcherId:research.agent.id,criticId:parent.agent.id,commandKey:randomUUID()};
  await assert.rejects(createReviewApplication(client,{...input,researcherId:parent.agent.id,commandKey:randomUUID()}),/Persistent Agents must belong to a persistent Chat in this Branch/);
  const app=await createReviewApplication(client,input),again=await createReviewApplication(client,input);
  assert.equal(again.subgraph.id,app.subgraph.id);assert.equal(again.workflow.id,app.workflow.id);
  const execution=await app.start("Synthetic question","review-example");
  const gate=await until(async()=>{const snapshot=await app.inspect(execution.id);return snapshot.actions.items.find(item=>item.kind==="gate")?.gate;},"human review gate",20000);
  await app.resolve(execution.id,gate.id,{commandKey:"approve",expectedRevision:gate.revision,decision:"approve",output:"Synthetic approved answer"});
  const done=await until(async()=>{const detail=await client.state(execution.id);return detail.execution.state==="completed"&&detail;},"review completion",20000);
  assert.equal(done.execution.state,"completed");
 });
});

test('public Branches SSE client preserves chunked UTF-8, CR/LF boundaries, reset and exact cursor while closing on return',async()=>{
 const {BranchesClient}=await import('../../packages/core/dist/branches-client.js');const bytes=new TextEncoder().encode(': heartbeat\r\nevent: agent_status\r\nid: 7\r\ndata: {"reset":true,"label":"é"}\r\n\r\nevent: event\nid: 8\ndata: {"event":{"executionId":"exact-run","text":"chunk"}}\n\n');
 let canceled=false,request,requestedUrl;
 const client=new BranchesClient('http://fixture.invalid',async(url,init)=>{requestedUrl=String(url);request=init;return new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));},cancel(){canceled=true;}}),{headers:{'content-type':'text/event-stream'}});});
 const stream=client.streamAgent('agent/one',{lastEventId:'6'}),first=(await stream.next()).value,second=(await stream.next()).value;
 assert.equal(requestedUrl,'http://fixture.invalid/api/branches/engine/agents/agent%2Fone/stream');assert.equal(request.headers['last-event-id'],'6');assert.deepEqual(first,{event:'agent_status',id:'7',data:{reset:true,label:'é'}});assert.equal(second.id,'8');assert.equal(second.data.event.executionId,'exact-run');await stream.return();assert.equal(canceled,true);
});

test('output settings reject same-version trigger drift and a fresh snapshot can save the intended schedule',async t=>withFixture(t,async f=>{
 const app=f.ok(await f.api('GET','/api/branches/assistant')).app;assert.ok(app);
 const trigger=f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`));
 f.ok(await f.api('PATCH',`/api/branches/${app.branchId}/trigger`,{enabled:false,reviewedTrigger:trigger}));
 const current=f.ok(await f.api('GET',`/api/branches/output-apps/${app.agentId}`));assert.equal(current.versionId,app.versionId);assert.notEqual(current.settingsRevision,app.settingsRevision);
 const request={expectedVersionId:app.versionId,expectedSettingsRevision:app.settingsRevision,automatic:true,everyMs:600000};
 assert.equal((await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,request)).status,409);
 assert.equal(f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`)).enabled,false);
 const saved=f.ok(await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{...request,expectedSettingsRevision:current.settingsRevision}));assert.equal(saved.automatic,true);
}));

// Exercise the same standalone settings endpoint used by /apps/:id and /assistant.
for(const [kind,sourceConfig] of [
 ['manual',undefined],
 ['schedule',{scheduleKind:'interval',everyMs:120000,startsAt:'2099-01-01T00:00:00.000Z',whenRunning:'queue_all'}],
 ['schedule',{scheduleKind:'cron',expression:'15 9 * * 1-5',timezone:'America/New_York',whenRunning:'run_latest'}],
 ['schedule',{scheduleKind:'once',at:'2099-01-01T00:00:00.000Z'}],
 ['webhook',{}],
 ['filesystem',{include:['**/*.txt'],exclude:['private/**'],quietMs:500,maxWindowMs:5000}],
])test(`output automatic control preserves ${kind}/${sourceConfig?.scheduleKind??'event'} and enables ordinary disabled workflows`,async t=>{
 let store;await withFixture(t,async f=>{
  const app=f.ok(await f.api('GET','/api/branches/assistant')).app;
  const {BranchStore,CoordinationV3Store}=await import('@ponderosa/agents'),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const definition=branches.version(app.branchId,app.versionId).definition,bindings=branches.localConfiguration(app.branchId);
  f.ok(await f.api('POST','/api/branches/deploy',{chatId:'',branchId:app.branchId,expectedVersionId:app.versionId,idempotencyKey:randomUUID(),definition:{...definition,trigger:kind==='manual'?{kind}:{kind,configRef:'source'}},bindings:{...bindings,directories:{...bindings.directories,workspace:f.root},triggers:sourceConfig?{source:{sourceConfig,enabled:true}}:{}}}));
  const url=`/api/branches/output-apps/${app.agentId}`,read=async()=>f.ok(await f.api('GET',url));
  const save=async(automatic,extra={})=>{const current=await read();return f.api('PUT',url+'/schedule',{expectedVersionId:current.versionId,expectedSettingsRevision:current.settingsRevision,automatic,...extra});};
  const before=await read(),original=branches.trigger(app.branchId),versionId=before.versionId,bindingRevisionId=before.bindingRevisionId;
  assert.equal(before.triggerKind,kind);assert.equal(before.everyMs,sourceConfig?.scheduleKind==='interval'?sourceConfig.everyMs:undefined);
  if(kind==='schedule')assert.deepEqual(before.schedule,original.sourceConfig);else assert.equal(before.schedule,undefined);
  f.ok(await save(false));assert.equal((await read()).automatic,false);
  if(original){assert.deepEqual(branches.trigger(app.branchId).sourceConfig,original.sourceConfig);assert.equal(branches.trigger(app.branchId).nextFireAt,original.nextFireAt);}
  assert.equal((await read()).versionId,versionId);assert.equal((await read()).bindingRevisionId,bindingRevisionId);
  f.ok(await f.api('PUT',`/api/branches/${app.branchId}/availability`,{enabled:false}));
  const disabled=await read();assert.equal(disabled.automatic,false);
  if(kind==='manual'){
   assert.equal((await save(true)).status,409,'A manual workflow needs an explicitly selected interval');
   f.ok(await save(true,{everyMs:180000}));assert.equal((await read()).everyMs,180000);assert.equal((await read()).triggerKind,'schedule');
  }else{
   f.ok(await save(true));const enabled=await read();assert.equal(enabled.versionId,versionId);assert.equal(enabled.bindingRevisionId,bindingRevisionId);
   assert.deepEqual(branches.trigger(app.branchId).sourceConfig,original.sourceConfig);assert.equal(branches.trigger(app.branchId).id,original.id);
   if(kind!=='schedule')assert.equal((await save(false,{everyMs:600000})).status,409,'An event source cannot acquire a timer');
  }
  assert.equal(branches.getBranch(app.branchId).enabled,true);assert.equal((await read()).automatic,true);
  // Availability drift is covered by the same optimistic settings snapshot.
  assert.equal((await f.api('PUT',url+'/schedule',{expectedVersionId:disabled.versionId,expectedSettingsRevision:disabled.settingsRevision,automatic:false})).status,409);
  assert.equal((await read()).automatic,true);
  store.sqlite.prepare('UPDATE branches SET deleting=1 WHERE id=?').run(app.branchId);
  assert.equal((await f.api('PUT',url+'/schedule',{expectedVersionId:versionId,expectedSettingsRevision:before.settingsRevision,automatic:true})).status,409);
  store.sqlite.prepare('UPDATE branches SET deleting=0 WHERE id=?').run(app.branchId);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('output pause preserves an elapsed one-time schedule; resume refuses to invent another occurrence',async t=>{
 let store;await withFixture(t,async f=>{
  const app=f.ok(await f.api('GET','/api/branches/assistant')).app;
  const {BranchStore,CoordinationV3Store}=await import('@ponderosa/agents'),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)),trigger=branches.trigger(app.branchId);
  const config={scheduleKind:'once',at:'2000-01-01T00:00:00.000Z'};
  branches.triggers.updateTriggerDefinition(trigger.id,{sourceConfig:config,nextFireAt:null,enabled:false});
  const url=`/api/branches/output-apps/${app.agentId}`,current=()=>f.api('GET',url).then(f.ok);
  const save=async automatic=>{const snapshot=await current();return f.api('PUT',url+'/schedule',{expectedVersionId:snapshot.versionId,expectedSettingsRevision:snapshot.settingsRevision,automatic});};
  f.ok(await save(false));assert.deepEqual(branches.trigger(app.branchId).sourceConfig,config);assert.equal(branches.trigger(app.branchId).nextFireAt,undefined);
  const refused=await save(true);assert.equal(refused.status,409);assert.match(refused.body.error,/one-time schedule must be in the future/);assert.equal(branches.trigger(app.branchId).enabled,false);
  assert.deepEqual(branches.trigger(app.branchId).sourceConfig,config);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('output automatic enable rolls back trigger changes if ordinary workflow availability fails',async t=>{
 let store;await withFixture(t,async f=>{
  const app=f.ok(await f.api('GET','/api/branches/assistant')).app,url=`/api/branches/output-apps/${app.agentId}`;
  const trigger=f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`));
  f.ok(await f.api('PATCH',`/api/branches/${app.branchId}/trigger`,{enabled:false,reviewedTrigger:trigger}));
  f.ok(await f.api('PUT',`/api/branches/${app.branchId}/availability`,{enabled:false}));
  const before=f.ok(await f.api('GET',url)),paused=f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`));
  store.sqlite.exec("CREATE TEMP TRIGGER refuse_output_enable BEFORE UPDATE OF enabled ON branches WHEN NEW.enabled=1 BEGIN SELECT RAISE(ABORT,'Controlled availability failure'); END");
  const refused=await f.api('PUT',url+'/schedule',{expectedVersionId:before.versionId,expectedSettingsRevision:before.settingsRevision,automatic:true});
  assert.equal(refused.status,409);assert.match(refused.body.error,/Controlled availability failure/);
  assert.deepEqual(f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`)),paused);assert.equal(f.ok(await f.api('GET',url)).settingsRevision,before.settingsRevision);
  store.sqlite.exec('DROP TRIGGER refuse_output_enable');
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('Output model saves compare the original full runtime settings without changing identity or history on conflict',async t=>{
 await withFixture(t,async f=>{
  const app=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app;
  const path='/api/branches/engine/agents/'+app.agentId;
  const history=f.ok(await f.api('GET',path)).messages;
  assert.equal(app.runtimeSettings.activeEngine,app.engine);assert.equal(app.runtimeSettings.model,app.model??null);
  const changedModel=app.model==='fixture'?null:'fixture';
  f.ok(await f.api('PATCH',path,{model:changedModel,expectedRuntimeSettings:app.runtimeSettings}));
  const current=f.ok(await f.api('GET','/api/branches/output-apps/'+app.agentId));
  const stale=await f.api('PATCH',path,{model:app.model??null,expectedRuntimeSettings:app.runtimeSettings});
  assert.equal(stale.status,409);assert.match(stale.body.error,/Model settings changed/);
  assert.equal(f.ok(await f.api('GET',path)).agent.model??null,changedModel);
  assert.deepEqual(f.ok(await f.api('GET',path)).messages,history);
  assert.equal((await f.api('PATCH',path,{model:null,expectedRuntimeSettings:{...current.runtimeSettings,extra:true}})).status,400);
  f.ok(await f.api('PATCH',path,{model:null,expectedRuntimeSettings:current.runtimeSettings}));
  assert.equal(f.ok(await f.api('GET','/api/branches/output-apps/'+app.agentId)).runtimeSettings.model,null);
 });
});

test('malformed workflow import diagnostic does not reveal file contents', async t=>{
 await withFixture(t,async f=>{
  const malformed='{"token":"SYNTHETIC_SECRET_NOT_FOR_OUTPUT",\n"definition": }';
  const response=await f.api('POST','/api/branches/import-preview',malformed,{'content-type':'application/json'});
  assert.equal(response.status,400);assert.match(response.body.error,/Could not parse the workflow JSON/);
  assert.doesNotMatch(JSON.stringify(response.body),/SYNTHETIC_SECRET_NOT_FOR_OUTPUT/);
  const empty=await f.api('POST','/api/branches/import-preview','',{'content-type':'application/json'});
  assert.equal(empty.status,400);assert.match(empty.body.error,/workflow file is empty/i);
  const unsupported=await f.api('POST','/api/branches/import-preview','{"__proto__":{"secret":"SYNTHETIC_SECRET_NOT_FOR_OUTPUT"}}',{'content-type':'application/json'});
  assert.equal(unsupported.status,400);assert.match(unsupported.body.error,/unsupported object keys/);assert.doesNotMatch(JSON.stringify(unsupported.body),/SYNTHETIC_SECRET_NOT_FOR_OUTPUT/);
  const media=await f.api('POST','/api/branches/import-preview','data',{'content-type':'application/x-unknown'});
  assert.equal(media.status,415,'unrelated Fastify errors keep their existing status');
  const oversized=await f.api('POST','/api/branches/import-preview','{}',{'content-type':'application/json','content-length':String(AGENT_PACKAGE_MAX_BYTES+AGENT_PACKAGE_METADATA_MAX_BYTES+2)});
  assert.equal(oversized.status,413,'oversized requests keep their existing status');
 });
});


test('Output schedule response remains bound to its own commit across another edit during source refresh',async t=>{
 const {BranchTriggerSourceService}=await import('../../apps/server/dist/branch-trigger-service.js');
 await withFixture(t,async f=>{
  const app=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app,url='/api/branches/output-apps/'+app.agentId;
  let release,reached,paused=false;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>reached=resolve);
  const original=BranchTriggerSourceService.prototype.applyDefinitionChange;
  t.mock.method(BranchTriggerSourceService.prototype,'applyDefinitionChange',async function(previous,next){
   if(!paused&&next?.branchId===app.branchId){paused=true;reached();await gate;}
   return original.call(this,previous,next);
  });
  const first=f.api('PUT',url+'/schedule',{expectedVersionId:app.versionId,expectedSettingsRevision:app.settingsRevision,automatic:false});
  try{
   await entered;
   const own=f.ok(await f.api('GET',url));assert.equal(own.automatic,false);
   const other=f.ok(await f.api('PUT',url+'/schedule',{expectedVersionId:own.versionId,expectedSettingsRevision:own.settingsRevision,automatic:true}));
   assert.equal(other.automatic,true);release();
   const response=f.ok(await first);assert.equal(response.automatic,false);assert.equal(response.settingsRevision,own.settingsRevision);
   const current=f.ok(await f.api('GET',url));assert.equal(current.automatic,true);assert.equal(current.settingsRevision,other.settingsRevision);
   assert.equal((await f.api('PUT',url+'/schedule',{expectedVersionId:response.versionId,expectedSettingsRevision:response.settingsRevision,automatic:false})).status,409,'The first editor cannot overwrite the second editor with its committed baseline');
  }finally{release();await first;}
 });
});

test('public Branch example streams live Agent output',{timeout:45000},async t=>{
 const {BranchesClient}=await import('../../packages/core/dist/branches-client.js');
 const {createReviewApplication}=await import('../../examples/branches-capabilities/application.ts');
 let criticId;
 await withFixture(t,async f=>{
  const create=async name=>{
   const owner=f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
   const chat=f.ok(await f.api('POST',`/api/branches/${owner.id}/chats`,{label:name,defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
   const agent=f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:name,engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
   return {owner,agent};
  };
  const research=await create('Synthetic researcher'),parent=await create('Synthetic critic');criticId=parent.agent.id;
  const client=new BranchesClient(await f.listen());
  const unrelatedChat=await f.createChat('Synthetic unrelated product'),unrelated=await f.createIdleAgent(unrelatedChat,'Other product');
  await assert.rejects(client.streamAgent(unrelated.id).next(),error=>error.status===404&&error.message==='Resource is unavailable in this product');
  await assert.rejects(client.fullOutput(unrelated.id,1),error=>error.status===404&&error.message==='Resource is unavailable in this product');
  const app=await createReviewApplication(client,{researchBranchId:research.owner.id,researchVersionId:research.owner.versionId,parentBranchId:parent.owner.id,parentVersionId:parent.owner.versionId,researcherId:research.agent.id,criticId,commandKey:'q11-stream'});
  const execution=await app.start('Synthetic streaming question','q11-stream-run');
  const live=await until(async()=>{const d=await client.state(execution.id);return d.liveOutputs?.find(x=>x.agentId===criticId);},'live critic output',20000);
  const session=await until(()=>f.sessions.get(criticId),'controlled critic session',10000);
  await assert.rejects(client.fullOutput(criticId,99999999),error=>error.status===404&&error.message==='run output segment not found');
  await assert.rejects(app.stream(execution.id,criticId,randomUUID()).next(),/Output is not current/);
  const stream=app.stream(execution.id,criticId,live.runId);
  const observed=[];
  try{
   const first=await Promise.race([stream.next(),delay(10000,undefined,{ref:false}).then(()=>{throw Error("Timed out waiting for initial SSE output");})]);
   assert.equal(first.done,false);observed.push(first.value);
   assert.match(JSON.stringify(first.value),/Ordinary fixture execution output/);
   let next=stream.next();
   session.events.push({type:"text",delta:"Q11 first live chunk"});
   session.events.push({type:"text",delta:"Q11 second live chunk"});
   const deadline=Date.now()+10000;
   while(Date.now()<deadline && !JSON.stringify(observed).includes('Q11 second live chunk')){
    const item=await Promise.race([next,delay(10000,undefined,{ref:false}).then(()=>{throw Error('Timed out waiting for SSE output');})]);
    assert.equal(item.done,false);observed.push(item.value);
    if(!JSON.stringify(observed).includes('Q11 second live chunk'))next=stream.next();
   }
   const text=JSON.stringify(observed);
   assert.match(text,/Q11 first live chunk/);assert.match(text,/Q11 second live chunk/);
   assert.ok(text.indexOf('Q11 first live chunk')<text.indexOf('Q11 second live chunk'));
   const response=await session.tool('ponderosa_update_request',{text:'Controlled critic result'});
   assert.equal(response.success,true,response.text);session.finish();
   const segment=await until(async()=>{const detail=await client.agent(criticId);return detail.runOutput.find(item=>item.text.includes('Q11 first live chunk'));},'saved output segment',10000);
   const full=await client.fullOutput(criticId,segment.seq);
   assert.match(full.text,/Q11 first live chunk/);
  } finally { await stream.return(); }
  console.log(JSON.stringify({transport:'loopback HTTP SSE',source:'controlled Agent Run',events:observed.map(item=>({event:item.event,id:item.id,type:item.data?.event?.type,text:item.data?.event?.text??item.data?.event?.delta})),wrongRunRefused:true,fullOutputRetrieved:true}));
 },{providerRunPlan:({agentId})=>agentId===criticId?{hold:true}:undefined});
});
