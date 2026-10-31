import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';

test('installation compensation restores the exact reserved handle and runtime settings without resurrecting a deleted Agent',t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-compensation-'));let store=new AgentStore(root),passed=false;
 t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const project=store.createProject({label:'Compensation',hostPath:root,defaultEngine:'codex'});
 const before=store.createAgent(project.id,{title:'Original',engine:'codex',conversationId:project.lastConversationId,model:'original-model',effort:'medium',speed:'fast'});
 const snapshot={title:before.title,handle:before.handle,activeEngine:before.activeEngine,model:before.model??null,effort:before.effort??null,speed:before.speed??null,managementPermissions:before.managementPermissions};
 const changed=store.updateAgent(before.id,{title:'Replacement',activeEngine:'claude',model:'replacement-model',effort:'high',speed:null});
 assert.notEqual(changed.handle,before.handle);
 assert.throws(()=>store.restoreAgentConfiguration(before.id,{...snapshot,handle:'Unowned'}),/no longer owned/);
 assert.equal(store.getAgent(before.id).title,'Replacement');
 store.restoreAgentConfiguration(before.id,snapshot);
 store.close();store=new AgentStore(root);
 const restored=store.getAgent(before.id);
 for(const key of ['id','title','handle','activeEngine','model','effort','speed','managementPermissions'])assert.deepEqual(restored[key],before[key],key);
 assert.equal(store.deleteAgent(before.id),true);
 assert.equal(store.restoreAgentConfiguration(before.id,snapshot),undefined);
 assert.equal(store.getAgent(before.id),undefined);passed=true;
});

import {BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {BranchInstallationService} from '../../apps/server/dist/branch-installation-service.js';
function compensationFixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'branch-compensation-journal-'));let store=new AgentStore(root);
 const openService=()=>new BranchInstallationService(store,new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)),async()=>{throw Error('Unexpected Chat deletion')},async()=>{throw Error('Unexpected Agent deletion')},async()=>{throw Error('Unexpected Chat creation')});
 let service=openService();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});
 const project=store.createProject({label:'Inverse ownership',hostPath:root,defaultEngine:'codex'}),chat=store.getConversation(project.lastConversationId);
 const agent=title=>store.createAgent(project.id,{title,engine:'codex',conversationId:chat.id});
 const snapshot=a=>({id:a.id,title:a.title,handle:a.handle,activeEngine:a.activeEngine,model:a.model??null,effort:a.effort??null,speed:a.speed??null,managementPermissions:a.managementPermissions,managerAgentId:a.managerAgentId??null});
 const journal=(id,value)=>store.sqlite.prepare("INSERT INTO branch_installation_plans(id,package_json,bindings_json,preview_json,state,journal_json,created_at,updated_at) VALUES(?,'{}','{}','[]','canceling',?,?,?)").run(id,JSON.stringify(value),new Date().toISOString(),new Date().toISOString());
 return{get store(){return store},get service(){return service},project,chat,agent,snapshot,journal,reopen(){store.close();store=new AgentStore(root);service=openService()}};
}
test('failed installation compensation preserves newer edits across restart and records partial progress',async t=>{
 const f=compensationFixture(t),a=f.agent('Before'),before=f.snapshot(a);
 const changed=f.store.updateAgent(a.id,{title:'Applied',activeEngine:'claude',model:'applied'}),{managerAgentId,...applied}=f.snapshot(changed);
 f.store.updateConversation(f.chat.id,{title:'Applied Chat'});
 f.journal('failed-inverse',{chats:[{id:f.chat.id,title:f.chat.title,instructions:f.chat.instructions??'',applied:{id:f.chat.id,title:'Applied Chat',instructions:f.chat.instructions??''}}],agents:[{...before,applied,appliedManager:null}]});
 const restore=f.store.restoreAgentConfiguration.bind(f.store);f.store.restoreAgentConfiguration=()=>{throw Error('Controlled failed inverse')};
 await f.service.tick();assert.equal(f.store.getConversation(f.chat.id).title,f.chat.title);
 const partial=JSON.parse(f.store.sqlite.prepare('SELECT journal_json FROM branch_installation_plans WHERE id=?').get('failed-inverse').journal_json);assert.equal(partial.chats.length,0);assert.equal(partial.agents.length,1);
 f.store.restoreAgentConfiguration=restore;f.store.updateAgent(a.id,{title:'Newer human edit',activeEngine:'codex',model:'newer'});f.store.updateConversation(f.chat.id,{title:'Newer Chat'});
 f.reopen();await f.service.tick();assert.equal(f.store.getAgent(a.id).title,'Newer human edit');assert.equal(f.store.getAgent(a.id).model,'newer');assert.equal(f.store.getConversation(f.chat.id).title,'Newer Chat');
 assert.match(f.service.status('failed-inverse').error,/newer|review/i);assert.equal(f.service.status('failed-inverse').state,'canceling');
 f.store.deleteAgent(a.id);await f.service.tick();assert.equal(f.store.getAgent(a.id),undefined);assert.equal(f.service.status('failed-inverse').state,'canceled');
});
test('manager-tree inverse restores independent entries before retrying a temporarily cyclic inverse',async t=>{
 const f=compensationFixture(t),a=f.agent('A'),b=f.agent('B');f.store.updateAgentOrganization(b.id,{managerAgentId:a.id});
 const beforeA=f.snapshot(f.store.getAgent(a.id)),beforeB=f.snapshot(f.store.getAgent(b.id));
 f.store.updateAgentOrganization(b.id,{managerAgentId:null});f.store.updateAgentOrganization(a.id,{managerAgentId:b.id});
 const entry=before=>{const {managerAgentId,...applied}=f.snapshot(f.store.getAgent(before.id));return {...before,applied,appliedManager:managerAgentId}};
 f.journal('tree-inverse',{chats:[],agents:[entry(beforeB),entry(beforeA)]});
 await f.service.tick();assert.equal(f.store.getAgent(a.id).managerAgentId,undefined);assert.equal(f.service.status('tree-inverse').state,'canceling');
 f.reopen();await f.service.tick();assert.equal(f.store.getAgent(b.id).managerAgentId,a.id);assert.equal(f.service.status('tree-inverse').state,'canceled');
});
