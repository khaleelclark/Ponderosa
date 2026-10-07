import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import {AgentStore,BranchStore,CoordinationV3Store,WorkspaceStore} from '@ponderosa/agents';
import {artifactAgentInProduct,projectInProduct,registerProductScope,requestProduct,rewriteProductUrl} from '../dist/product-scope.js';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'historical-artifact-scope-'));
 const store=new AgentStore(dir),workspace=new WorkspaceStore(dir),branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const app=Fastify({rewriteUrl:rewriteProductUrl});registerProductScope(app,store,workspace,()=>undefined,()=>false);
 app.get('/api/projects/:projectId/artifacts',async request=>store.getProjectArtifactPage(request.params.projectId,{limit:100,branchOwned:requestProduct(request)==='branches',scope:requestProduct(request)}));
 app.get('/api/projects/:projectId/artifacts/:aid',async request=>store.getProjectArtifact(request.params.projectId,request.params.aid)??{error:'missing'});
 app.get('/api/projects/:id',async request=>store.getProject(request.params.id)??{error:'missing'});
 t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,store,branches,app};
}

test('deleted Agent artifacts remain readable only in their original product',async t=>{
 const f=fixture(t),project=f.store.createProject({label:'Mixed',hostPath:f.dir,defaultEngine:'codex'});
 const devChat=f.store.getConversation(project.lastConversationId),devAgent=f.store.createAgent(project.id,{title:'Dev',engine:'codex',conversationId:devChat.id});
 const branch=f.branches.create('Review','branch'),branchChat=f.store.createConversation(project.id,{title:'Branch review'});
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(branch.id,branchChat.id);
 const branchAgent=f.store.createAgent(project.id,{title:'Branch',engine:'codex',conversationId:branchChat.id});
 for(const [agent,id] of [[devAgent,'dev-history'],[branchAgent,'branch-history']]){
  f.store.recordProjectArtifact({id,projectId:project.id,agentId:agent.id,originAgentId:agent.id,kind:'generated_file',path:`${id}.txt`,summary:id,createdAt:new Date().toISOString(),size:1,sha256:'a'.repeat(64),mediaType:'text/plain'});
 }
 f.store.deleteAgent(devAgent.id);f.store.deleteAgent(branchAgent.id);
 assert.equal(f.store.sqlite.prepare('SELECT conversation_id FROM agents WHERE id=?').get(devAgent.id).conversation_id,null);
 assert.equal(artifactAgentInProduct(f.store,devAgent.id,project.id,'dev'),true);
 assert.equal(artifactAgentInProduct(f.store,devAgent.id,project.id,'branches'),false);
 assert.equal(artifactAgentInProduct(f.store,branchAgent.id,project.id,'branches'),true);
 assert.equal(artifactAgentInProduct(f.store,branchAgent.id,project.id,'dev'),false);
 const devPage=await f.app.inject(`/api/projects/${project.id}/artifacts`),branchPage=await f.app.inject(`/api/branches/engine/projects/${project.id}/artifacts`);
 assert.equal(devPage.statusCode,200,devPage.body);assert.equal(branchPage.statusCode,200,branchPage.body);
 assert.deepEqual(devPage.json().items.map(item=>item.id),['dev-history']);
 assert.deepEqual(branchPage.json().items.map(item=>item.id),['branch-history']);
 for(const [prefix,allowed,denied] of [['/api','dev-history','branch-history'],['/api/branches/engine','branch-history','dev-history']]){
  const visible=await f.app.inject(`${prefix}/projects/${project.id}/artifacts/${allowed}`);
  const hidden=await f.app.inject(`${prefix}/projects/${project.id}/artifacts/${denied}`);
  assert.equal(visible.statusCode,200,visible.body);assert.equal(visible.json().id,allowed);
  assert.equal(hidden.statusCode,404,hidden.body);
 }
});


test('Dev Project remains in Dev after its last Chat is deleted',async t=>{
 const f=fixture(t),project=f.store.createProject({label:'Historical Dev',hostPath:f.dir,defaultEngine:'codex'});
 const chat=f.store.getConversation(project.lastConversationId);
 f.store.markConversationDeletionPending(chat.id);
 f.store.commitConversationDeletion(chat.id,()=>{});
 assert.equal(f.store.getConversation(chat.id),undefined);
 assert.equal(projectInProduct(f.store,project.id,'dev'),true);
 assert.equal(projectInProduct(f.store,project.id,'branches'),false);
 assert.equal((await f.app.inject(`/api/projects/${project.id}`)).statusCode,200);
 assert.equal((await f.app.inject(`/api/branches/engine/projects/${project.id}`)).statusCode,404);
});


test('legacy unknown deletion scope is repaired only for exclusively Dev history',t=>{
 const f=fixture(t),dev=f.store.createProject({label:'Old Dev',hostPath:f.dir,defaultEngine:'codex'});
 const devAgent=f.store.createAgent(dev.id,{title:'Old Agent',engine:'codex',conversationId:dev.lastConversationId});
 f.store.deleteAgent(devAgent.id);
 const branch=f.branches.create('Old Branch','old-branch');
 const branchProject=f.store.createProject({label:'Old Branch Project',hostPath:f.dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id});
 const branchAgent=f.store.createAgent(branchProject.id,{title:'Old Branch Agent',engine:'codex',conversationId:branchProject.lastConversationId});
 f.store.deleteAgent(branchAgent.id);
 f.store.sqlite.prepare("UPDATE agent_deletion_receipts SET product_scope='unknown' WHERE project_id IN (?,?)").run(dev.id,branchProject.id);
 f.store.sqlite.prepare('DELETE FROM agent_deletion_tombstones WHERE agent_id IN (?,?)').run(devAgent.id,branchAgent.id);
 const migration=readFileSync(new URL('../../../packages/agents/src/schema/0030_historical_artifact_product_scope.sql',import.meta.url),'utf8');
 f.store.sqlite.exec(migration);
 f.store.sqlite.exec(migration);
 const scope=id=>f.store.sqlite.prepare('SELECT product_scope FROM agent_deletion_receipts WHERE project_id=?').get(id).product_scope;
 assert.equal(scope(dev.id),'dev');
 assert.equal(scope(branchProject.id),'unknown');
 assert.equal(artifactAgentInProduct(f.store,devAgent.id,dev.id,'dev'),true);
 assert.equal(artifactAgentInProduct(f.store,devAgent.id,dev.id,'branches'),false);
 assert.equal(artifactAgentInProduct(f.store,branchAgent.id,branchProject.id,'dev'),false);
 assert.equal(artifactAgentInProduct(f.store,branchAgent.id,branchProject.id,'branches'),false);
});


test('staging and retiring Branch Agents cannot expose live artifacts',async t=>{
 const f=fixture(t),branch=f.branches.create('Lifecycle','lifecycle');
 const project=f.store.createProject({label:'Branch lifecycle',hostPath:f.dir,defaultEngine:'codex',chatOwned:true,branchId:branch.id});
 const agent=f.store.createAgent(project.id,{title:'Scoped',engine:'codex',conversationId:project.lastConversationId});
 f.store.recordProjectArtifact({id:'lifecycle-artifact',projectId:project.id,agentId:agent.id,originAgentId:agent.id,kind:'generated_file',path:'lifecycle.txt',summary:'Lifecycle',createdAt:new Date().toISOString(),size:1,sha256:'a'.repeat(64),mediaType:'text/plain'});
 f.store.sqlite.prepare("INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state) VALUES (?,?,?,?,?,?)").run(branch.id,'pkg','chat','agent',agent.id,'staging');
 const read=()=>f.app.inject(`/api/branches/engine/projects/${project.id}/artifacts/lifecycle-artifact`);
 const list=()=>f.app.inject(`/api/branches/engine/projects/${project.id}/artifacts`);
 for(const state of ['staging','retiring']){
  f.store.sqlite.prepare('UPDATE branch_installation_resources SET state=? WHERE local_id=?').run(state,agent.id);
  assert.equal(artifactAgentInProduct(f.store,agent.id,project.id,'branches'),false);
  assert.equal((await read()).statusCode,404);
  assert.deepEqual((await list()).json().items,[]);
 }
 f.store.sqlite.prepare("UPDATE branch_installation_resources SET state='active' WHERE local_id=?").run(agent.id);
 assert.equal(artifactAgentInProduct(f.store,agent.id,project.id,'branches'),true);
 assert.equal((await read()).statusCode,200);
 assert.deepEqual((await list()).json().items.map(item=>item.id),['lifecycle-artifact']);
});
