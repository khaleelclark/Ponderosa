import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AgentStore,CapabilityPolicyStore} from '@ponderosa/agents';
import {BUILT_IN_CAPABILITIES,CAPABILITY_IDS,PONDEROSA_BROWSER_TOOLS} from '@ponderosa/core';
import {withFixture,until} from '../shared/fixture.mjs';
import {BrowserSessionManager} from '../../apps/server/dist/browser-session-manager.js';

test('every hosted browser tool has exactly one intended capability classification',()=>{
 const expected={
  [CAPABILITY_IDS.browserRead]:['ponderosa_browser_open','ponderosa_browser_inspect','ponderosa_browser_screenshot','ponderosa_browser_console','ponderosa_browser_recording_start','ponderosa_browser_recording_stop'],
  [CAPABILITY_IDS.browserInteract]:['ponderosa_browser_navigate','ponderosa_browser_new_page','ponderosa_browser_switch_page','ponderosa_browser_close_page','ponderosa_browser_upload','ponderosa_browser_act','ponderosa_browser_take_control','ponderosa_browser_close'],
 };
 const classified=[];
 for(const [id,names] of Object.entries(expected)){
  const descriptor=BUILT_IN_CAPABILITIES.find(capability=>capability.id===id);
  assert.ok(descriptor,`missing ${id} descriptor`);
  assert.deepEqual([...descriptor.runtimeToolNames].sort(),[...names].sort());
  classified.push(...descriptor.runtimeToolNames);
 }
 assert.equal(new Set(classified).size,classified.length,'each browser tool is classified exactly once');
 assert.deepEqual(classified.sort(),PONDEROSA_BROWSER_TOOLS.map(tool=>tool.name).sort());
});

test('tightening a live policy refuses previously admitted tool calls, including the management create backdoor, while explicit user communication remains usable',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Policy boundary'),agent=await f.createIdleAgent(chat,'Policy owner'),session=await f.hold(agent.id),policies=new CapabilityPolicyStore(store.sqlite);
  const before=store.listAgents(chat.projectId).map(a=>a.id);
  const plan=f.ok(await f.tool(session,'ponderosa_manage',{action:'plan',idempotencyKey:'prepared-create',operations:[{kind:'create_agent',ref:'child',title:'Planned child'}]}));
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate,CAPABILITY_IDS.browserRead,CAPABILITY_IDS.hostFileImport]});
  for(const [name,args]of [['ponderosa_create_managed_agent',{idempotencyKey:'blocked-child',title:'Blocked',text:'Do nothing',lifetime:{kind:'indefinite'}}],['ponderosa_manage',{action:'apply',planId:plan.planId}],['ponderosa_manage',{action:'plan',idempotencyKey:'new-create',operations:[{kind:'create_agent',ref:'another',title:'Blocked'}]}],['ponderosa_browser_open',{url:'https://example.invalid'}],['ponderosa_import_file',{path:'does-not-exist.txt'}]]){
    const result=await f.tool(session,name,args);assert.equal(result.status,403,`${name}: ${JSON.stringify(result.body)}`);
  }
  const described=f.ok(await f.tool(session,'ponderosa_manage',{action:'describe'}));assert.equal(described.permissions.autonomous.includes('create_agent'),false);
  store.sqlite.prepare("UPDATE capability_policies SET restricted_capability_ids_json='{}' WHERE scope_kind='agent' AND scope_id=?").run(agent.id);
  assert.equal((await f.tool(session,'ponderosa_browser_open',{url:'https://example.invalid'})).status,403);
  assert.deepEqual(store.listAgents(chat.projectId).map(a=>a.id),before);
  f.ok(await f.tool(session,'ponderosa_message',{intent:'direct_to_user',text:'Policy refusal verified'}));session.finish();await f.settled(agent.id);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('new restricted sessions omit blocked tools and changing policy forces a new provider session rather than reusing broader authority',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Fresh policy'),agent=await f.createIdleAgent(chat,'Worker'),first=await f.hold(agent.id),policies=new CapabilityPolicyStore(store.sqlite);
  f.ok(await f.tool(first,'ponderosa_message',{intent:'direct_to_user',text:'First result'}));first.finish();await f.settled(agent.id);const previous=(await f.detail(agent.id)).runs.map(r=>r.id);
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate,CAPABILITY_IDS.browserRead]});
  const second=await f.hold(agent.id);assert.notEqual(second.engineAgentId,first.engineAgentId);
  const blocked=await second.tool('ponderosa_create_managed_agent',{idempotencyKey:'missing-tool',title:'Blocked',text:'Do nothing',lifetime:{kind:'indefinite'}});assert.equal(blocked.success,false);assert.match(blocked.text,/Unavailable Ponderosa tool/);
  f.ok(await f.tool(second,'ponderosa_message',{intent:'direct_to_user',text:'Second result'}));second.finish();await f.settled(agent.id,previous);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('regular Settings, Chat and Agent policy routes persist restriction-only inheritance without affecting Branches',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Normal policy'),agent=await f.createIdleAgent(chat,'Normal owner');
  const normal='/api/workspace/capabilities',chatUrl=`/api/conversations/${chat.id}/capabilities`,agentUrl=`/api/agents/${agent.id}/capabilities`;
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Separate policy',idempotencyKey:randomUUID()}));
  const branchChat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Separate',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const changed=f.ok(await f.api('PUT',normal,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]}));
  assert.equal(changed.policy.scopeKind,'product');assert.equal(changed.policy.scopeId,'interactive');
  f.ok(await f.api('PUT',chatUrl,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.browserRead]}));
  f.ok(await f.api('PUT',agentUrl,{revision:0,restrictedCapabilityIds:[]}));
  let detail=f.ok(await f.api('GET',agentUrl));assert.ok(detail.effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.hostFileImport));assert.ok(detail.effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.browserRead));
  assert.equal(detail.effective.restrictionSources[CAPABILITY_IDS.hostFileImport].scopeKind,'product');assert.equal(detail.effective.restrictionSources[CAPABILITY_IDS.browserRead].scopeId,chat.id);
  assert.deepEqual(f.ok(await f.api('GET',`/api/branches/${branch.id}/chats/${branchChat.id}/capabilities`)).effective.restrictedCapabilityIds,[]);
  assert.equal((await f.api('PUT',normal,{revision:0,restrictedCapabilityIds:[]})).status,409);assert.equal(f.ok(await f.api('GET',normal)).policy.revision,1);
  for(const url of [`/api/conversations/${branchChat.id}/capabilities`,`/api/branches/engine/conversations/${chat.id}/capabilities`,`/api/branches/engine/agents/${agent.id}/capabilities`])assert.equal((await f.api('GET',url)).status,404);
  assert.equal((await f.api('PUT',agentUrl,{revision:1,restrictedCapabilityIds:['unknown.permission']})).status,400);
  await f.reopen();detail=f.ok(await f.api('GET',agentUrl));assert.equal(detail.policy.revision,1);assert.ok(detail.effective.restrictedCapabilityIds.includes(CAPABILITY_IDS.hostFileImport));
 });
});

test('permission catalogs reuse tool definitions, scope connectors by engine, and retain unavailable restrictions',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  f.capabilities.mcpServers=[{name:'fixture-service',configured:true,initialization:'initialized',usable:true,toolsDiscovered:true,toolCount:1,health:'unknown',tools:[{name:'lookup_record',description:'Look up a record from the connected service.'}]}];
  const chat=await f.createChat('Catalog'),agent=await f.createIdleAgent(chat,'Codex catalog'),url=`/api/agents/${agent.id}/capabilities`;
  let result=f.ok(await f.api('GET',url));assert.equal(result.catalog.some(c=>c.categoryId==='workflow'),false);
  const memory=result.catalog.find(c=>c.id===CAPABILITY_IDS.memoryRead);assert.equal(memory.available,false);assert.match(memory.unavailableReason,/not configured/);
  const imports=result.catalog.find(c=>c.id===CAPABILITY_IDS.hostFileImport);assert.equal(imports.includedTools[0].name,'ponderosa_import_file');assert.match(imports.includedTools[0].description,/host/);
  const managed=result.catalog.find(c=>c.id===CAPABILITY_IDS.managedAgentCreate);assert.ok(managed.includedTools.some(tool=>tool.name==='ponderosa_manage'&&tool.description.includes('Only its create_agent operation')));
  assert.ok(result.catalog.some(c=>c.id==='connector:codex:fixture-service'&&c.includedTools[0].description.includes('Look up')));assert.equal(result.catalog.some(c=>c.id.startsWith('connector:claude:')),false);
  const orphan='connector:claude:disconnected';result=f.ok(await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[orphan]}));const unavailable=result.catalog.find(c=>c.id===orphan);assert.equal(unavailable.available,false);assert.ok(unavailable.unavailableReason);
  result=f.ok(await f.api('PUT',url,{revision:1,restrictedCapabilityIds:[orphan,CAPABILITY_IDS.hostFileImport]}));assert.ok(result.policy.restrictedCapabilityIds.includes(orphan),'Editing a visible permission preserves an unavailable saved restriction');
  const global=f.ok(await f.api('GET','/api/workspace/capabilities'));assert.ok(global.catalog.some(c=>c.id==='connector:claude:fixture-service'));
 },{diagnosticProvider:true});
});

test('operator permission updates fence the old Run and retain unfinished work while fresh restricted sessions keep user communication',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Live operator policy'),agent=await f.createIdleAgent(chat,'Live owner'),first=await f.hold(agent.id),url=`/api/agents/${agent.id}/capabilities`;
  const active=store.sqlite.prepare("SELECT id,fencing_token FROM scheduler_runs WHERE agent_id=? AND status='running'").get(agent.id);
  assert.ok(active);const agentsBefore=store.listAgents(chat.projectId).map(a=>a.id);
  const plan=f.ok(await f.tool(first,'ponderosa_manage',{action:'plan',idempotencyKey:'operator-prepared-create',operations:[{kind:'create_agent',ref:'child',title:'Prepared child'}]}));
  f.ok(await f.api('PUT','/api/workspace/capabilities',{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]}));
  f.ok(await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate,CAPABILITY_IDS.browserRead,CAPABILITY_IDS.filesystemWrite]}));
  for(const [name,args]of [['ponderosa_manage',{action:'apply',planId:plan.planId}],['ponderosa_browser_open',{url:'https://example.invalid'}],['ponderosa_import_file',{path:'does-not-exist.txt'}],['ponderosa_message',{intent:'direct_to_user',text:'Stale capability cannot publish'}]])assert.equal((await f.tool(first,name,args)).status,401,name+' uses the fenced old Run capability');
  assert.equal((await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[]},{authorization:'Bearer obsolete-operator-token'})).status,409);
  const paused=await until(()=>store.sqlite.prepare("SELECT run_id,state,checkpoint_json FROM agent_run_pauses WHERE agent_id=? ORDER BY paused_at DESC LIMIT 1").get(agent.id),'durable access revocation pause');
  assert.equal(paused.run_id,active.id);assert.equal(paused.state,'paused');
  const checkpoint=JSON.parse(paused.checkpoint_json);assert.equal(checkpoint.accessRevocationHold,true);assert.match(JSON.stringify(checkpoint.sourceActivations),/Controlled held task/);
  const fenced=store.sqlite.prepare('SELECT status,fencing_token,side_effects_fenced_at FROM scheduler_runs WHERE id=?').get(active.id);
  assert.equal(fenced.status,'cancelled');assert.ok(fenced.fencing_token>active.fencing_token);assert.ok(fenced.side_effects_fenced_at);
  assert.deepEqual(store.listAgents(chat.projectId).map(a=>a.id),agentsBefore,'stale prepared management plan creates no Agent');
  assert.ok(!JSON.stringify(store.readEvents(agent.id)).includes('Stale capability cannot publish'),'revoked Run publishes no reply');
  await f.reopen();
  assert.equal(store.sqlite.prepare('SELECT state FROM agent_run_pauses WHERE run_id=?').get(active.id).state,'paused');
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs WHERE agent_id=?').get(agent.id).n,1,'restart does not replay retained work');
  const fresh=await f.createIdleAgent(chat,'Restricted fresh owner');
  f.ok(await f.api('PUT',`/api/agents/${fresh.id}/capabilities`,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate,CAPABILITY_IDS.browserRead,CAPABILITY_IDS.filesystemWrite]}));
  const second=await f.hold(fresh.id);assert.notEqual(second.engineAgentId,first.engineAgentId);
  assert.equal((await second.tool('ponderosa_create_managed_agent',{title:'Blocked',text:'Do nothing',lifetime:{kind:'indefinite'},idempotencyKey:'blocked-new-session'})).success,false);
  f.ok(await f.tool(second,'ponderosa_message',{intent:'direct_to_user',text:'User communication is allowed under the current restricted policy'}));second.finish();await f.settled(fresh.id);
 },{authToken:'operator-permission-fixture',storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});


test('Chat catalogs preserve distinct working folders for otherwise identical Agent runtimes',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Folder-specific services'),first=await f.createIdleAgent(chat,'First folder'),second=await f.createIdleAgent(chat,'Second folder');
  const {mkdir}=await import('node:fs/promises'),path=await import('node:path'),alternate=path.join(f.root,'alternate');await mkdir(alternate);
  const original=store.getAgent(second.id).workingCopy;store.sqlite.prepare('UPDATE agents SET working_copy_json=? WHERE id=?').run(JSON.stringify({...original,rootPath:alternate}),second.id);
  f.ok(await f.api('GET',`/api/conversations/${chat.id}/capabilities`));
  assert.ok(f.capabilityDiscoveries.some(selection=>selection.cwd===alternate),'A second Agent folder must not disappear behind the first matching engine/model');
  assert.ok(f.capabilityDiscoveries.some(selection=>selection.cwd!==alternate),'The original Chat/Agent folder remains represented');
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});


test('aggregated connected-tool details have one response-wide bound without dropping permission identities',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Bounded aggregate'),second=await f.createIdleAgent(chat,'Second inventory');
  const {mkdir}=await import('node:fs/promises'),path=await import('node:path'),alternate=path.join(f.root,'alternate');await mkdir(alternate);
  store.sqlite.prepare('UPDATE agents SET working_copy_json=? WHERE id=?').run(JSON.stringify({...store.getAgent(second.id).workingCopy,rootPath:alternate}),second.id);
  const result=f.ok(await f.api('GET',`/api/conversations/${chat.id}/capabilities`)),connectors=result.catalog.filter(row=>row.id.startsWith('connector:'));
  assert.equal(connectors.length,2,'Both working-folder services remain controllable');assert.ok(connectors.every(row=>row.available));
  assert.ok(connectors.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.includedTools)),0)<64*1024);assert.match(result.catalogNotice,/tool details are omitted/);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir)),capabilityCatalog:cwd=>({steering:true,persistentSessions:true,commands:[],composerCapabilities:[],mcpServers:[{name:cwd.endsWith('alternate')?'second-service':'first-service',configured:true,initialization:'initialized',usable:true,toolsDiscovered:true,toolCount:100,health:'unknown',tools:Array.from({length:100},(_,i)=>({name:`tool_${i}`,description:'d'.repeat(400)}))}]})});
});

test('cold permission reads and saves survive the ordinary socket idle limit while provider discovery finishes',{timeout:30000},async t=>{
 for(const method of ['GET','PUT'])await withFixture(t,async f=>{
  const chat=await f.createChat('Slow catalog'),agent=await f.createIdleAgent(chat,'Slow discovery'),origin=await f.listen(),url=method==='GET'?'/api/workspace/capabilities':`/api/agents/${agent.id}/capabilities`;
  const response=await fetch(origin+url,{method,...(method==='PUT'?{headers:{'content-type':'application/json'},body:JSON.stringify({revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]})}:{})});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.policy.revision,method==='PUT'?1:0);if(method==='PUT')assert.ok(result.policy.restrictedCapabilityIds.includes(CAPABILITY_IDS.hostFileImport));
 },{socketIdleTimeoutMs:50,capabilityCatalog:async()=>{await new Promise(resolve=>setTimeout(resolve,150));return {steering:true,persistentSessions:true,commands:[],mcpServers:[],composerCapabilities:[]}}});
});

test('operator permission history retains before/after, rejects stale writes, and survives restart for both products',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Permission audit'),agent=await f.createIdleAgent(chat,'Audit owner');
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Audited branch',idempotencyKey:randomUUID()}));
  for(const url of [`/api/agents/${agent.id}/capabilities`,`/api/branches/${branch.id}/capabilities`]){
   assert.deepEqual(f.ok(await f.api('GET',`${url}/history`)).changes,[]);
   f.ok(await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]}));
   f.ok(await f.api('PUT',url,{revision:1,restrictedCapabilityIds:[]}));
   assert.equal((await f.api('PUT',url,{revision:1,restrictedCapabilityIds:[CAPABILITY_IDS.browserRead]})).status,409);
   let history=f.ok(await f.api('GET',`${url}/history`));
   assert.deepEqual(history.changes.map(c=>[c.revision,c.before,c.after,c.actor]),[
    [2,[CAPABILITY_IDS.hostFileImport],[],'operator'],[1,[],[CAPABILITY_IDS.hostFileImport],'operator']]);
   assert.ok(history.changes.every(c=>c.reason.includes('Human updated')&&!Number.isNaN(Date.parse(c.changedAt))));
   assert.deepEqual(f.ok(await f.api('GET',`${url}/history?beforeRevision=2`)).changes.map(c=>c.revision),[1]);
   assert.equal((await f.api('GET',`${url}/history?beforeRevision=bad`)).status,400);
   await f.reopen();assert.deepEqual(f.ok(await f.api('GET',`${url}/history`)),history);
  }
  assert.equal((await f.api('GET',`/api/branches/${branch.id}/agents/${agent.id}/capabilities/history`)).status,404);
 });
});


test('browser new-page creation follows the live interaction restriction',{timeout:30000},async t=>{
 let store,ownerId,created=0;
 const previousGet=BrowserSessionManager.prototype.get,previousNewPage=BrowserSessionManager.prototype.newPage;
 BrowserSessionManager.prototype.get=function(id){
  if(id===ownerId)return {id:'controlled-browser',status:'ready',controlEpoch:9,activePageId:'old',pages:[]};
  return previousGet.call(this,id);
 };
 BrowserSessionManager.prototype.newPage=async function(scope,epoch,owner){
  assert.equal(scope.agentId,ownerId);assert.equal(epoch,9);assert.equal(owner,'agent');created++;
  return {id:'controlled-browser',status:'ready',controlEpoch:9,activePageId:'new',pages:[{pageId:'new',url:'about:blank',title:'',active:true,isNew:true,closable:true}]};
 };
 t.after(()=>{BrowserSessionManager.prototype.get=previousGet;BrowserSessionManager.prototype.newPage=previousNewPage;});
 await withFixture(t,async f=>{
  const chat=await f.createChat('New-page capability'),agent=await f.createIdleAgent(chat,'Worker');ownerId=agent.id;
  const session=await f.hold(agent.id),policies=new CapabilityPolicyStore(store.sqlite);
  const allowed=await f.tool(session,'ponderosa_browser_new_page',{});
  assert.equal(allowed.status,200,'interaction-authorized new page reaches the owned browser route');
  assert.equal(created,1);
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.browserInteract]});
  const denied=await f.tool(session,'ponderosa_browser_new_page',{});
  assert.equal(denied.status,403,'the current Run is denied after interaction is restricted');
  assert.equal(created,1,'denied call never reaches the browser manager');
  // Reading and interacting are separate capabilities. A read restriction
  // alone does not revoke already-authorized interactions.
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:1,restrictedCapabilityIds:[CAPABILITY_IDS.browserRead]});
  const interactionStillAllowed=await f.tool(session,'ponderosa_browser_new_page',{});
  assert.equal(interactionStillAllowed.status,200);
  assert.equal(created,2);
  session.finish();await f.settled(agent.id);
  const fresh=await f.createIdleAgent(chat,'Restricted worker');ownerId=fresh.id;
  policies.put({scopeKind:'agent',scopeId:fresh.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.browserInteract]});
  const restricted=await f.hold(fresh.id);
  const unavailable=await restricted.tool('ponderosa_browser_new_page',{});
  assert.equal(unavailable.success,false);
  assert.match(unavailable.text,/Unavailable Ponderosa tool/,'a newly admitted restricted Run never receives the tool');
  assert.equal(created,2,'restricted Run never reaches the browser manager');
  restricted.finish();await f.settled(fresh.id);
 },{storeFactory:p=>(store=new AgentStore(p))});
});
