// Deferred canonical fence fixtures; synthetic generation rows are not Branch/provider capture qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentStore,BranchStore,CoordinationV3Store,fenceBranchGenerationExit,generationExitHeld,destinationAdmissionHeld} from '../../packages/agents/dist/index.js';
import {CoordinationV3RuntimeScopeAuthority} from '../../packages/agents/dist/coordination-v3-runtime-scope-authority.js';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'generation-exit-fence-')),store=new AgentStore(dir),db=store.sqlite,coordination=new CoordinationV3Store(db),branches=new BranchStore(db,coordination);
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Inert fence fixture',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Original'}),agent=store.createAgent(project.id,{title:'Original',engine:'codex',conversationId:chat.id});
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Fence',trigger:{kind:'manual'},entry:'agent',steps:[{id:'agent',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Inert source'}],controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}}},bindings:{agents:{worker:agent.id},directories:{}}});
 const execution=branches.accept(branch.id,'source','input');
 for(let n=0;n<30&&!db.prepare('SELECT id FROM branch_step_executions WHERE execution_id=?').get(execution.id);n++){branches.advance();await branches.unitSaver.drain();}
 const step=db.prepare('SELECT id FROM branch_step_executions WHERE execution_id=? ORDER BY rowid LIMIT 1').get(execution.id);
 assert.ok(step);
 db.prepare('UPDATE conversations SET branch_id=?,branch_execution_id=? WHERE id=?').run(branch.id,execution.id,chat.id);
 db.prepare(`INSERT INTO branch_resources(step_execution_id,execution_id,template_ref,state,requested_count,root_agent_id,creation_key,chat_id,generation,retry_draining) VALUES(?,?,?,'active',1,?,?,?,0,1)`).run(step.id,execution.id,'synthetic-template',agent.id,'synthetic-generation',chat.id);
 db.prepare("INSERT INTO branch_resource_members VALUES(?,?,'template')").run(agent.id,step.id);
 const input={executionId:execution.id,stepExecutionId:step.id,generation:0,projectId:project.id,conversationId:chat.id,agentIds:[agent.id]};
 return {store,db,coordination,branches,project,chat,agent,input,scope:new CoordinationV3RuntimeScopeAuthority(db)};
}
test('same-owner durable fence blocks canonical intake and actual leasing while preserving source capture access',async t=>{
 const f=await fixture(t),{db,agent,chat,project,coordination}=f;
 const request=coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:fixture',idempotencyKey:'before-fence',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'Before fence'}}]}).requestIds[0];
 const receipt=db.transaction(()=>fenceBranchGenerationExit(db,f.input))();
 assert.ok(receipt.sha256);assert.equal(generationExitHeld(db,agent.id),true);assert.equal(generationExitHeld(db,undefined,chat.id),true);
 assert.equal(destinationAdmissionHeld(db,agent.id,chat.id),false,'generation fencing does not masquerade as prepared destination admission');
 assert.equal(f.scope.recipientAuthorizedForActivationScope(project.id,agent.id,`agent:${agent.id}`),false);
 assert.equal(f.scope.recipientAuthorizedForActivationScope(project.id,agent.id,`conversation:${chat.id}`),false);
 assert.throws(()=>coordination.coordinate({projectId:project.id,conversationId:chat.id,actorScope:'user:fixture',idempotencyKey:'after-fence',requests:[{recipientAgentId:agent.id,lifetime:{kind:'indefinite'},payload:{text:'Must refuse'}}]}),/fenced/);
 assert.equal(f.store.agentCreationPending(agent.id),false);assert.ok(f.store.listAgents(project.id).some(a=>a.id===agent.id),'original package source remains readable');
 // Trusted terminal drain remains legal even though ordinary new work is fenced.
 coordination.updateRequest({requestId:request,updateId:'drained',kind:'cancelled',actor:{kind:'user',id:'local-operator'}});
 assert.equal(coordination.leaseNextRun({workerId:'fixture'}),undefined);
 const otherChat=f.store.createConversation(project.id,{title:'Unrelated'}),other=f.store.createAgent(project.id,{title:'Unrelated',engine:'codex',conversationId:otherChat.id});
 coordination.coordinate({projectId:project.id,conversationId:otherChat.id,actorScope:'user:fixture',idempotencyKey:'unrelated',requests:[{recipientAgentId:other.id,lifetime:{kind:'indefinite'},payload:{text:'Unrelated work'}}]});
 assert.equal(coordination.leaseNextRun({workerId:'fixture'})?.agentId,other.id);
});
test('caught owner rollback leaves no fence; changed generation/member identity refuses',async t=>{
 const f=await fixture(t);
 assert.throws(()=>fenceBranchGenerationExit(f.db,f.input),/owner transaction/);
 assert.throws(()=>f.db.transaction(()=>{fenceBranchGenerationExit(f.db,f.input);throw Error('owner rollback');})(),/owner rollback/);
 assert.equal(generationExitHeld(f.db,f.agent.id),false);
 assert.throws(()=>f.db.transaction(()=>fenceBranchGenerationExit(f.db,{...f.input,generation:1}))(),/generation required/);
 assert.throws(()=>f.db.transaction(()=>fenceBranchGenerationExit(f.db,{...f.input,agentIds:[f.agent.id,'outside']}))(),/member inventory/);
});
test('fence permanently survives journal phases, owner removal and exact receipt replay',async t=>{
 const f=await fixture(t),receipt=f.db.transaction(()=>fenceBranchGenerationExit(f.db,f.input))();
 const key=`resource-generation-exit:${f.input.stepExecutionId}:0`;
 for(const state of ['fencing','capturing','sealed']){
  f.db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?) ON CONFLICT(execution_id,command_key) DO UPDATE SET result_json=excluded.result_json').run(f.input.executionId,key,'synthetic',JSON.stringify({state}),new Date().toISOString());
  assert.equal(generationExitHeld(f.db,f.agent.id),true);
 }
 // Simulate canonical owner cleanup without asking the fixture to qualify Branch deletion.
 f.db.pragma('foreign_keys=OFF');
 f.db.prepare('DELETE FROM branch_commands WHERE execution_id=?').run(f.input.executionId);
 f.db.prepare('DELETE FROM branch_resource_members WHERE step_execution_id=?').run(f.input.stepExecutionId);
 f.db.prepare('DELETE FROM branch_resources WHERE step_execution_id=?').run(f.input.stepExecutionId);
 f.db.prepare('DELETE FROM branch_executions WHERE id=?').run(f.input.executionId);
 f.db.prepare('DELETE FROM agents WHERE id=?').run(f.agent.id);f.db.prepare('DELETE FROM conversations WHERE id=?').run(f.chat.id);
 assert.equal(generationExitHeld(f.db,f.agent.id),true);assert.equal(generationExitHeld(f.db,undefined,f.chat.id),true);
 assert.deepEqual(f.db.transaction(()=>fenceBranchGenerationExit(f.db,f.input))(),receipt);
 assert.throws(()=>f.db.transaction(()=>fenceBranchGenerationExit(f.db,{...f.input,conversationId:'replacement'}))(),/replay differs/);
 assert.throws(()=>f.db.prepare("DELETE FROM host_lifecycle_commits WHERE kind='branch-generation-exit-fence'").run(),/immutable/);
});

test('canonical subtree, Chat and Project deletion refuse missing, pending and forged sealed generation evidence',async t=>{
 const f=await fixture(t),{store,db,input,agent,chat,project}=f;
 db.transaction(()=>fenceBranchGenerationExit(db,input))();
 const refuses=()=>{
  assert.throws(()=>store.previewAgentDeletion([agent.id]),/sealed capture/);
  assert.throws(()=>store.deleteAgent(agent.id),/sealed capture/);
  assert.throws(()=>store.markConversationDeletionPending(chat.id),/sealed capture/);
  assert.throws(()=>store.commitConversationDeletion(chat.id),/sealed capture/);
  assert.throws(()=>store.markProjectDeletionPending(project.id),/sealed capture/);
  assert.throws(()=>store.commitProjectDeletion(project.id),/sealed capture/);
  assert.ok(store.getAgent(agent.id));assert.ok(store.getConversation(chat.id));assert.ok(store.getProject(project.id));
  assert.equal(db.prepare('SELECT count(*) n FROM agent_deletion_pending').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM project_deletion_pending').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM conversation_deletion_receipts').get().n,0);
 };
 refuses();
 for(const state of ['fencing','capturing','sealed']){
  db.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?) ON CONFLICT(execution_id,command_key) DO UPDATE SET result_json=excluded.result_json').run(input.executionId,`resource-generation-exit:${input.stepExecutionId}:0`,'forged',JSON.stringify({state}),new Date().toISOString());
  refuses();
 }
});
