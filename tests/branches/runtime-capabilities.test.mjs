import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AgentStore,CapabilityPolicyStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {withFixture} from '../shared/fixture.mjs';

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

test('operator permission updates block a live regular Agent on host boundaries and rotate its next session',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Live operator policy'),agent=await f.createIdleAgent(chat,'Live owner'),first=await f.hold(agent.id),url=`/api/agents/${agent.id}/capabilities`;
  const plan=f.ok(await f.tool(first,'ponderosa_manage',{action:'plan',idempotencyKey:'operator-prepared-create',operations:[{kind:'create_agent',ref:'child',title:'Prepared child'}]}));
  f.ok(await f.api('PUT','/api/workspace/capabilities',{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]}));
  f.ok(await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate,CAPABILITY_IDS.browserRead,CAPABILITY_IDS.filesystemWrite]}));
  for(const [name,args]of [['ponderosa_manage',{action:'apply',planId:plan.planId}],['ponderosa_browser_open',{url:'https://example.invalid'}],['ponderosa_import_file',{path:'does-not-exist.txt'}]])assert.equal((await f.tool(first,name,args)).status,403,name);
  assert.equal((await f.api('PUT',url,{revision:0,restrictedCapabilityIds:[]},{authorization:'Bearer obsolete-operator-token'})).status,409);
  f.ok(await f.tool(first,'ponderosa_message',{intent:'direct_to_user',text:'User communication survives permission changes'}));first.finish();await f.settled(agent.id);
  const previous=(await f.detail(agent.id)).runs.map(r=>r.id),second=await f.hold(agent.id);assert.notEqual(second.engineAgentId,first.engineAgentId);assert.equal((await second.tool('ponderosa_create_managed_agent',{title:'Blocked',text:'Do nothing',lifetime:{kind:'indefinite'},idempotencyKey:'blocked-new-session'})).success,false);
  second.finish();await f.settled(agent.id,previous);
 },{authToken:'operator-permission-fixture'});
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
