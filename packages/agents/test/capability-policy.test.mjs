import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {CAPABILITY_IDS} from "@ponderosa/core";
import {AgentStore,BranchStore,CapabilityPolicyRevisionConflictError,CapabilityPolicyStore,CoordinationV3Store} from "../dist/index.js";

test("Branch, Chat, and Agent restrictions resolve through Chat ownership",t=>{
  const dir=mkdtempSync(join(tmpdir(),"capability-policy-")),store=new AgentStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const project=store.createProject({label:"Scope",hostPath:dir,defaultEngine:"codex"});
  const chat=store.getConversation(project.lastConversationId);
  const agent=store.createAgent(project.id,{title:"Reviewer",engine:"codex",conversationId:chat.id});
  const child=store.createAgent(project.id,{title:"Child",engine:"codex",conversationId:chat.id,managerAgentId:agent.id});
  store.sqlite.prepare("UPDATE agents SET spawned_by_agent_id=? WHERE id=?").run(agent.id,child.id);
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const branch=branches.create("Security review","capability-test");
  store.sqlite.prepare("UPDATE conversations SET branch_id=? WHERE id=?").run(branch.id,chat.id);
  const policies=new CapabilityPolicyStore(store.sqlite);
  const branchPolicy=policies.put({scopeKind:"branch",scopeId:branch.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.browserInteract]});
  policies.put({scopeKind:"chat",scopeId:chat.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]});
  policies.put({scopeKind:"agent",scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.filesystemWrite]});
  assert.equal(branchPolicy.revision,1);
  assert.deepEqual(policies.resolveForAgent(agent.id).restrictedCapabilityIds,[CAPABILITY_IDS.browserInteract,CAPABILITY_IDS.hostFileImport,CAPABILITY_IDS.filesystemWrite].sort());
  assert.deepEqual(policies.resolveForAgent(child.id).restrictedCapabilityIds,[CAPABILITY_IDS.browserInteract,CAPABILITY_IDS.hostFileImport,CAPABILITY_IDS.filesystemWrite].sort());
  store.sqlite.prepare("UPDATE agents SET manager_agent_id=NULL WHERE id=?").run(child.id);
  assert.equal(store.deleteAgent(agent.id),true);
  assert.ok(store.getAgent(child.id));
  assert.deepEqual(policies.resolveForAgent(child.id).restrictedCapabilityIds,[CAPABILITY_IDS.browserInteract,CAPABILITY_IDS.hostFileImport,CAPABILITY_IDS.filesystemWrite].sort());
  assert.throws(()=>policies.put({scopeKind:"branch",scopeId:branch.id,expectedRevision:0,restrictedCapabilityIds:[]}),CapabilityPolicyRevisionConflictError);
});

test("managed descendants retain restrictions beyond one hundred spawner generations",t=>{
  const dir=mkdtempSync(join(tmpdir(),"capability-policy-depth-")),store=new AgentStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const project=store.createProject({label:"Deep lineage",hostPath:dir,defaultEngine:"codex"});
  const root=store.createAgent(project.id,{title:"Root",engine:"codex",conversationId:project.lastConversationId});
  const policies=new CapabilityPolicyStore(store.sqlite);
  policies.put({scopeKind:"agent",scopeId:root.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.filesystemWrite]});
  let parent=root;
  for(let depth=1;depth<=101;depth++){
    parent=store.createAgent(project.id,{
      title:`Child ${depth}`,
      engine:"codex",
      conversationId:project.lastConversationId,
      managerAgentId:parent.id,
    },{
      agentId:parent.id,
      executionId:`run-${depth}`,
      idempotencyKey:`child-${depth}`,
    });
  }
  assert.deepEqual(policies.resolveForAgent(parent.id).restrictedCapabilityIds,[CAPABILITY_IDS.filesystemWrite]);
});

const policyRows=store=>store.sqlite.prepare('SELECT * FROM capability_policies ORDER BY scope_kind,scope_id').all();
test('projection rebuild preserves exact authoritative policy bytes, revisions and retired spawner restrictions',t=>{
 const dir=mkdtempSync(join(tmpdir(),'policy-rebuild-')),store=new AgentStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const p=store.createProject({label:'Rebuild',hostPath:dir,defaultEngine:'codex'}),parent=store.createAgent(p.id,{title:'Spawner',engine:'codex',conversationId:p.lastConversationId});
 const child=store.createAgent(p.id,{title:'Child',engine:'codex',conversationId:p.lastConversationId,managerAgentId:parent.id},{agentId:parent.id,executionId:'legacy-run',idempotencyKey:'child'});
 const policies=new CapabilityPolicyStore(store.sqlite);
 for(const [scopeKind,scopeId] of [['agent',parent.id],['chat',p.lastConversationId],['run','legacy-run']])policies.put({scopeKind,scopeId,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});
 store.sqlite.prepare("UPDATE capability_policies SET revision=7,updated_at='2026-01-01T00:00:00Z',restricted_capability_ids_json='[ \"agents.create_managed\" ]'").run();
 store.updateAgentOrganization(child.id,{managerAgentId:null});store.deleteAgent(parent.id);const before=policyRows(store);
 store.rebuildProjections();assert.deepEqual(policyRows(store),before);assert.ok(policies.resolveForAgent(child.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.managedAgentCreate));
});

test('failed rebuild rolls policy authority back; quarantined Project cannot erase its restrictions',async t=>{
 const {readFileSync,writeFileSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'policy-rollback-')),store=new AgentStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const p=store.createProject({label:'Rollback',hostPath:dir,defaultEngine:'codex'}),a=store.createAgent(p.id,{title:'Owner',engine:'codex',conversationId:p.lastConversationId});
 const policies=new CapabilityPolicyStore(store.sqlite);policies.put({scopeKind:'agent',scopeId:a.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});const before=policyRows(store);
 store.sqlite.exec("CREATE TRIGGER fail_policy_restore BEFORE INSERT ON capability_policies BEGIN SELECT RAISE(FAIL,'restore failure fixture'); END");
 assert.throws(()=>store.rebuildProjections(),/restore failure fixture/);assert.deepEqual(policyRows(store),before);assert.ok(store.getAgent(a.id));store.sqlite.exec('DROP TRIGGER fail_policy_restore');
 const file=join(dir,'projects',p.id,'project.json'),bytes=readFileSync(file);writeFileSync(file,'{malformed');
 store.rebuildProjections();assert.deepEqual(policyRows(store),before);assert.equal(store.getAgent(a.id),undefined);
 writeFileSync(file,bytes);store.rebuildProjections();assert.deepEqual(policyRows(store),before);assert.ok(policies.resolveForAgent(a.id).restrictedCapabilityIds.includes(CAPABILITY_IDS.managedAgentCreate));
});

test('canonical Chat and Project hard deletion cleanup is never resurrected by rebuild',t=>{
 const dir=mkdtempSync(join(tmpdir(),'policy-delete-')),store=new AgentStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const p=store.createProject({label:'Delete',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(p.id,{title:'Delete this Chat'}),a=store.createAgent(p.id,{title:'Owner',engine:'codex',conversationId:chat.id});
 const policies=new CapabilityPolicyStore(store.sqlite);for(const [scopeKind,scopeId] of [['agent',a.id],['chat',chat.id]])policies.put({scopeKind,scopeId,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]});
 store.deleteAgent(a.id);
 const deletion=store.sqlite.prepare('SELECT id FROM agent_deletion_receipts WHERE project_id=?').get(p.id);store.markAgentDeletionServerCleanupComplete(deletion.id);
 const receipt=store.commitConversationDeletion(chat.id);store.finishConversationDeletionStorageCleanup(receipt);store.markConversationDeletionServerCleanupComplete(chat.id);
 assert.equal(policies.get('chat',chat.id),undefined);store.rebuildProjections();assert.equal(policies.get('chat',chat.id),undefined);
 store.deleteProject(p.id);assert.deepEqual(policyRows(store),[]);store.rebuildProjections();assert.deepEqual(policyRows(store),[]);
});
