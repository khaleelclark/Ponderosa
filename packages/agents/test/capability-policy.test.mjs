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
