import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHmac} from 'node:crypto';
import {AgentStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
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
  assert.equal((await f.api('POST',url,raw,{...headers,authorization:''})).status,200,'Webhook replay needs no operator authentication');
  assert.equal((await f.api('POST',url,raw,{...headers,origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await f.api('POST',url,raw,{...headers,host:'untrusted.invalid'})).status,200);
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

test('BR004 canonical Workflow use drives complete organized metadata and generation-fenced Recent pages',async t=>{
 let store;
 await withFixture(t,async f=>{
  const owners=[];for(let i=0;i<125;i++)owners.push(await branch(f,'Recent '+String(i).padStart(3,'0')));
  const prefs=f.ok(await f.api('GET','/api/branches/engine/workspace/preferences'));
  f.ok(await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchSort:'last_used',branchFolders:[{id:randomUUID(),name:'Complete',expanded:false,branchIds:owners.map(row=>row.id)}],branchFoldersRevision:prefs.revision,starredResourceIds:['branch:'+owners[0].id]}));
  const use=async owner=>f.ok(await f.api('POST','/api/branches/engine/workspace/recent-resources/use',{kind:'branch',resourceId:owner.id}));
  const exact=f.ok(await f.api('GET','/api/branches?search=Recent%200'));assert.equal(exact.length,100);
  const exactResponse=await f.api('GET','/api/branches?search=Recent%200');assert.equal(exactResponse.headers['x-collection-has-more'],'false');
  for(const query of ['search=a&search=b','chatId=a&chatId=b','cursor=a&cursor=b'])assert.equal((await f.api('GET','/api/branches?'+query)).status,400);
  const used=await use(owners[0]);
  const read=async cursor=>f.api('GET','/api/branches'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
  let first=await read();assert.equal(first.status,200);assert.equal(first.body.length,100);assert.equal(first.body[0].id,owners[0].id);assert.equal(first.body[0].lastUsedAt,used.lastUsedAt);assert.equal(Number(first.headers['x-total-count']),125);
  assert.equal((await f.api('GET','/api/branches?before='+owners[0].id)).status,400,'Obsolete cursors must fail visibly instead of repeating page one');
  const cursor=first.headers['x-next-cursor'];assert.ok(cursor);
  const next=await read(cursor);assert.equal(next.status,200);assert.equal(next.body.length,25);assert.equal(new Set([...first.body,...next.body].map(row=>row.id)).size,125);
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
  const schedule=f.ok(await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,automatic:false,everyMs:1200000}));
  assert.equal(schedule.automatic,false);assert.equal(schedule.everyMs,1200000);
  assert.equal(f.ok(await f.api('GET',`/api/branches/${app.branchId}/trigger`)).sourceConfig.whenRunning,'run_latest','everyday schedule settings preserve the existing busy policy');
  assert.equal((await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,automatic:true,everyMs:60000})).status,409);
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
  for(const everyMs of [0,1000,60000.5])assert.equal((await f.api('PUT',`/api/branches/output-apps/${app.agentId}/schedule`,{expectedVersionId:app.versionId,automatic:true,everyMs})).status,409);
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
