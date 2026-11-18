import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,activeChatOwnerSql,activeAgentOwnerSql} from '../../packages/agents/dist/index.js';
import {CoordinationV3RuntimeScopeAuthority} from '../../packages/agents/dist/coordination-v3-runtime-scope-authority.js';
import {branchInstallationHeld} from '../../packages/agents/dist/branch-installation-hold.js';
import {withFixture} from '../shared/fixture.mjs';

function addPlan(db,id,branchId,state='applying'){
 db.prepare(`INSERT INTO branch_installation_plans(id,branch_id,package_json,bindings_json,preview_json,state,created_at)
   VALUES(?,?,'{}','{}','{}',?,?)`).run(id,branchId,state,new Date().toISOString());
}
function link(db,branchId,plan,chatId,agentId){
 const put=db.prepare(`INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state,staging_plan_id)
   VALUES(?,?,?,?,?,'active',?)`);
 put.run(branchId,'package','chat','',chatId,plan);
 put.run(branchId,'package','chat','agent',agentId,plan);
}
test('unfinished and missing Branch plans hold queued work without failing it or starving other Agents',async t=>{
 const root=mkdtempSync(join(tmpdir(),'branch-install-hold-')),store=new AgentStore(root);
 const db=store.sqlite,coordination=new CoordinationV3Store(db),branches=new BranchStore(db,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(root,{recursive:true,force:true});});
 const owner=branches.create('Owner','hold-owner'),descendant=branches.create('Descendant','hold-descendant');
 const project=store.createProject({label:'Plan hold',hostPath:root,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Held'}),agent=store.createAgent(project.id,{title:'Held worker',engine:'codex',conversationId:chat.id});
 const otherChat=store.createConversation(project.id,{title:'Independent'}),other=store.createAgent(project.id,{title:'Independent worker',engine:'codex',conversationId:otherChat.id});
 const request=coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:fixture',idempotencyKey:'before-plan',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'Preserve this request'}}]}).requestIds[0];
 const before=db.prepare('SELECT id,state FROM agent_activations WHERE agent_id=?').get(agent.id);assert.ok(before);
 const plan=randomUUID();addPlan(db,plan,owner.id);link(db,owner.id,plan,chat.id,agent.id);
 // Verify both named parameters, including the repeated Agent expression,
 // with Agent-only, Chat-only, paired and unrelated inputs.
 assert.equal(branchInstallationHeld(db,agent.id,undefined),true);
 assert.equal(branchInstallationHeld(db,undefined,chat.id),true);
 assert.equal(branchInstallationHeld(db,agent.id,chat.id),true);
 assert.equal(branchInstallationHeld(db,other.id,otherChat.id),false);
 assert.equal(branchInstallationHeld(db,undefined,undefined),false);
 // Tree publication moves the Chat away from the plan's original Branch.
 db.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(descendant.id,chat.id);
 const scope=new CoordinationV3RuntimeScopeAuthority(db);
 const visible=()=>{
  const c=db.prepare(`SELECT 1 FROM conversations c WHERE c.id=? AND ${activeChatOwnerSql('c')}`).get(chat.id);
  const a=db.prepare(`SELECT 1 FROM agents a WHERE a.id=? AND ${activeAgentOwnerSql('a')}`).get(agent.id);
  return [Boolean(c),Boolean(a)];
 };
 assert.deepEqual(visible(),[false,false]);
 assert.equal(scope.recipientAuthorizedForActivationScope(project.id,agent.id,`conversation:${chat.id}`),false);
 assert.equal(coordination.leaseNextRun({workerId:'held'}),undefined);
 assert.deepEqual(db.prepare('SELECT id,state FROM agent_activations WHERE id=?').get(before.id),before);
 assert.equal(db.prepare('SELECT state FROM coordination_requests WHERE id=?').get(request).state,'open');
 coordination.coordinate({projectId:project.id,conversationId:otherChat.id,actorScope:'user:fixture',idempotencyKey:'independent',requests:[{recipientAgentId:other.id,lifetime:{kind:'indefinite'},payload:{text:'Independent'}}]});
 const otherLease=coordination.leaseNextRun({workerId:'other'});assert.equal(otherLease.agentId,other.id);
 // A vanished plan is not evidence that staged resources are published.
 db.prepare('DELETE FROM branch_installation_plans WHERE id=?').run(plan);
 assert.deepEqual(visible(),[false,false]);
 assert.equal(coordination.leaseNextRun({workerId:'missing'}),undefined);
 assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(before.id).state,before.state);
 addPlan(db,plan,owner.id,'completed');
 assert.equal(branchInstallationHeld(db,agent.id,chat.id),false);
 assert.deepEqual(visible(),[true,true]);
 const released=coordination.leaseNextRun({workerId:'released'});assert.equal(released.agentId,agent.id);
 coordination.markRunStarted(released.runId,released.fencingToken);
 coordination.markRunStarted(otherLease.runId,otherLease.fencingToken);
 const heldSteer=coordination.enqueueMessageActivation({projectId:project.id,agentId:agent.id,scopeKey:`conversation:${chat.id}`,messageId:'held-steering',kind:'human',payload:{text:'Preserve steering'}});
 const otherSteer=coordination.enqueueMessageActivation({projectId:project.id,agentId:other.id,scopeKey:`conversation:${otherChat.id}`,messageId:'other-steering',kind:'human',payload:{text:'Independent steering'}});
 db.prepare("UPDATE branch_installation_plans SET state='applying' WHERE id=?").run(plan);
 const selected=coordination.leaseNextSteering({workerId:'steer'});assert.equal(selected.runId,otherLease.runId);assert.ok(selected.activationIds.includes(otherSteer));
 assert.equal(db.prepare('SELECT state FROM agent_activations WHERE id=?').get(heldSteer).state,'pending');
 db.prepare("UPDATE branch_installation_plans SET state='completed' WHERE id=?").run(plan);
 assert.equal(coordination.leaseNextSteering({workerId:'released-steer'}).runId,released.runId);
});

test('unfinished Branch plan hides promoted Chat and Agent from product routes until completion',async t=>{
 let store;
 await withFixture(t,async f=>{
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Held resources',idempotencyKey:randomUUID()}));
  const chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Held Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const agent=f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:'Held Agent',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
  const plan=randomUUID();addPlan(store.sqlite,plan,branch.id);link(store.sqlite,branch.id,plan,chat.id,agent.id);
  assert.equal((await f.api('GET',`/api/branches/engine/conversations/${chat.id}`)).status,404);
  assert.equal((await f.api('GET',`/api/branches/engine/agents/${agent.id}`)).status,404);
  const chats=f.ok(await f.api('GET',`/api/branches/${branch.id}/chats`)),agents=f.ok(await f.api('GET',`/api/branches/${branch.id}/agents`));
  assert.equal(chats.some(row=>row.id===chat.id),false);assert.equal(agents.some(row=>row.id===agent.id),false);
  store.sqlite.prepare("UPDATE branch_installation_plans SET state='completed' WHERE id=?").run(plan);
  assert.equal((await f.api('GET',`/api/branches/engine/conversations/${chat.id}`)).status,200);
  assert.equal((await f.api('GET',`/api/branches/engine/agents/${agent.id}`)).status,200);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
