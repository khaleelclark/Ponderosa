import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,CapabilityPolicyStore} from '@ponderosa/agents';
import {CAPABILITY_IDS as capabilities} from '@ponderosa/core';

test('private spawner cleanup never widens a surviving descendant, including later ancestor policy changes and restart',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-policy-lineage-'));let store=new AgentStore(root),passed=false;
 t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const project=store.createProject({label:'Lineage',hostPath:root,defaultEngine:'codex'});
 const create=(title,parent)=>store.createAgent(project.id,{title,engine:'codex',conversationId:project.lastConversationId},
  parent ? {agentId:parent.id,executionId:`fixture-${title}`,idempotencyKey:`create-${title}`} : undefined);
 const ancestor=create('Ancestor'),middle=create('Middle',ancestor),leaf=create('Survivor',middle);
 let policies=new CapabilityPolicyStore(store.sqlite);
 const put=(agent,revision,ids)=>policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:revision,restrictedCapabilityIds:ids});
 put(ancestor,0,[capabilities.browserInteract]);put(middle,0,[capabilities.filesystemWrite]);
 const expect=ids=>assert.deepEqual(policies.resolveForAgent(leaf.id).restrictedCapabilityIds,[...ids].sort());
 expect([capabilities.browserInteract,capabilities.filesystemWrite]);
 const remove=agent=>{
  assert.equal(store.deleteAgent(agent.id),true);
  const receipt=store.listPendingAgentDeletionReceipts().find(item=>item.deletedAgentIds.includes(agent.id));assert.ok(receipt);
  store.finishAgentDeletionStorageCleanup(receipt);
  assert.equal(store.getAgent(agent.id),undefined);
  const row=store.sqlite.prepare('SELECT spawned_by_agent_id,spawn_prompt FROM agents WHERE id=?').get(agent.id);
  assert.equal(row.spawned_by_agent_id,null);assert.equal(row.spawn_prompt,null);
 };
 remove(middle);expect([capabilities.browserInteract,capabilities.filesystemWrite]);
 put(ancestor,1,[capabilities.browserInteract,capabilities.hostFileImport]);
 expect([capabilities.browserInteract,capabilities.filesystemWrite,capabilities.hostFileImport]);
 remove(ancestor);expect([capabilities.browserInteract,capabilities.filesystemWrite,capabilities.hostFileImport]);
 assert.ok(store.getAgent(leaf.id));
 store.close();store=new AgentStore(root);policies=new CapabilityPolicyStore(store.sqlite);
 expect([capabilities.browserInteract,capabilities.filesystemWrite,capabilities.hostFileImport]);
 passed=true;
});

test('malformed stored policy fails closed instead of silently restoring capabilities',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-policy-invalid-')),store=new AgentStore(root);let passed=false;
 t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const policies=new CapabilityPolicyStore(store.sqlite);
 policies.put({scopeKind:'global',scopeId:'ponderosa',expectedRevision:0,restrictedCapabilityIds:[capabilities.browserInteract]});
 for(const bytes of ['malformed','{}','[123]','["invented.capability"]']){
  store.sqlite.prepare('UPDATE capability_policies SET restricted_capability_ids_json=?').run(bytes);
  assert.throws(()=>policies.get('global','ponderosa'),/Stored capability restrictions are invalid/);
 }
 passed=true;
});
