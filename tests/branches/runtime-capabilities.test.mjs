import assert from 'node:assert/strict';
import test from 'node:test';
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
