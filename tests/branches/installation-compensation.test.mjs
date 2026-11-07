import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,WorkspaceStore} from '@ponderosa/agents';
import {AGENT_PACKAGE_MAX_BYTES} from '@ponderosa/core';
import {randomUUID} from 'node:crypto';

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

// Deferred: terminal compaction must retain destination receipts without extending their TTL.
test('retained workflow file destinations and nonsecret suggestions survive compaction and reopen',async t=>{
 const f=compensationFixture(t);f.journal('content-receipt',{chats:[],agents:[]});
 const result={rootAgentId:'historical',agentIds:['historical'],workingFilesDestination:'/retained/content',liveWorkingRoots:[{ref:'source-root',path:'/live/root',agentIds:['historical']}],workingRoots:[{ref:'source-root',destination:'/retained/root',agentIds:['historical']}],accessSettingsToReview:[{agentId:'historical',conversationId:f.chat.id,source:{restrictedCapabilityIds:[],readGlobalMemory:true}}]};
 f.service.retainImportResult('content-receipt',JSON.stringify(['chat','agent']),result);
 f.service.compactPlan('content-receipt','completed');
 const before=f.store.sqlite.prepare('SELECT updated_at FROM branch_installation_plans WHERE id=?').get('content-receipt').updated_at;
 f.reopen();await f.service.tick();
 const retained=f.service.status('content-receipt').importResults[JSON.stringify(['chat','agent'])];
 assert.equal(retained.workingFilesDestination,result.workingFilesDestination);assert.deepEqual(retained.workingRoots,result.workingRoots);assert.deepEqual(retained.accessSettingsToReview,result.accessSettingsToReview);assert.deepEqual(retained.liveWorkingRoots,result.liveWorkingRoots);
 assert.equal(f.store.sqlite.prepare('SELECT updated_at FROM branch_installation_plans WHERE id=?').get('content-receipt').updated_at,before);
 assert.equal(f.store.listAgents(f.project.id).length,0);
});


test('staged managed root confirmation is exact, durable and canceled plans cannot adopt it',t=>{
 const f=compensationFixture(t),key=JSON.stringify(['chat','agent']);f.journal('root-review',{chats:[],agents:[]});
 const pending={chatRef:'chat',agentRef:'agent',chatId:f.chat.id,sharedRoot:f.project.hostPath};
 f.store.sqlite.prepare("UPDATE branch_installation_plans SET state='applying',preview_json=? WHERE id='root-review'").run(JSON.stringify({pendingWorkingRoot:pending,fileSelections:{[key]:{newManagedChatFolderName:'reviewed-root',workingFilesActivation:{},workingFilesDestination:path.join(path.dirname(f.project.hostPath),'recovery-sibling')}}}));
 f.reopen();assert.deepEqual(f.service.status('root-review').workingRootReview,pending);
 assert.throws(()=>f.service.resolveWorkingRoot('root-review','chat','agent','/foreign'),/review changed/);
 f.service.resolveWorkingRoot('root-review','chat','agent',pending.sharedRoot);
 assert.equal(f.service.status('root-review').workingRootReview,undefined);
 const saved=JSON.parse(f.store.sqlite.prepare("SELECT preview_json FROM branch_installation_plans WHERE id='root-review'").get().preview_json);
 assert.deepEqual(saved.fileSelections[key].workingFilesActivation,{sharedRoot:pending.sharedRoot});
 assert.throws(()=>f.service.resolveWorkingRoot('root-review','chat','agent',pending.sharedRoot),/review changed/);
 f.store.sqlite.prepare("UPDATE branch_installation_plans SET state='canceling',preview_json=? WHERE id='root-review'").run(JSON.stringify({pendingWorkingRoot:pending}));
 assert.throws(()=>f.service.resolveWorkingRoot('root-review','chat','agent',pending.sharedRoot),/not awaiting/);
});

test('empty Chat imports retain passive title history after plan compaction and restart without replaying a Rename',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'branch-title-history-'));let store=new AgentStore(root),workspace=new WorkspaceStore(root),branches,service;let passed=false;
 const noOperation=async()=>{throw Error('Unexpected Agent, deletion or snapshot operation');};
 const open=()=>{
  branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  service=new BranchInstallationService(store,branches,noOperation,noOperation,async(input,_key,owner)=>{
   const project=store.createProject({label:input.label,hostPath:root,defaultEngine:'codex',chatOwned:true,branchId:owner.branchId});return store.getConversation(project.lastConversationId);
  },undefined,workspace);
  service.setEngine({validateAgent(){throw Error('Empty Chat cannot import an Agent');},exportAgent:noOperation,readCheckpointBytes:noOperation,captureCheckpoint:noOperation,captureExpertSnapshot:noOperation});
  service.setPublisher(input=>branches.deploy(input));
 };open();t.after(async()=>{await service.stop();workspace.close();store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 const history=[{sourceInstanceId:randomUUID(),eventId:7,projectId:'original-project',conversationId:'original-chat',createdAt:'2026-11-07T00:00:00.000Z',change:{previousTitle:'Original before',title:'Original after',actor:{kind:'operator_api'},origin:'operator_request',requestId:'original-request'}}];
 const {DEFAULT_BRANCH_CONFIGURATION}=await import('../../packages/agents/dist/branch-parameters.js');
 const definition={schema:'ponderosa.branch.v1',name:'Passive Chat history',trigger:{kind:'manual'},entry:'unused',steps:[{id:'unused',kind:'script',runtime:'node',cwdRef:'workspace',source:"process.stdout.write('not invoked')",timeoutMs:1000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
 const pkg={schema:'ponderosa.branch-installation.v1',packageId:randomUUID(),mode:'full',exportedAt:new Date().toISOString(),definition,chats:[{ref:'chat',title:'Destination Chat title',agents:[],titleHistory:history}],agentBindings:{},limits:structuredClone(DEFAULT_BRANCH_CONFIGURATION.limits)};
 const preview=await service.preview(pkg,{agents:{},directories:{workspace:root}}),result=await service.confirm(preview.id,true);assert.equal(result.state,'completed',JSON.stringify(result));
 assert.equal(store.sqlite.prepare('SELECT package_json FROM branch_installation_plans WHERE id=?').get(preview.id).package_json,'{}','existing compaction actually ran');
 const chat=store.sqlite.prepare('SELECT id,project_id,title FROM conversations WHERE branch_id=?').get(result.branchId);assert.equal(chat.title,'Destination Chat title');
 assert.equal(workspace.listConversationChanges({projectId:chat.project_id,conversationId:chat.id}).items.length,0,'imported evidence never enters live Rename history');
 assert.deepEqual(workspace.exportChatTitleHistory({projectId:chat.project_id,conversationId:chat.id,maximumBytes:AGENT_PACKAGE_MAX_BYTES}),history);
 await service.stop();workspace.close();store.close();store=new AgentStore(root);workspace=new WorkspaceStore(root);open();
 const internal=await service.export(result.branchId,'full');assert.equal(internal.chats[0].titleHistory,undefined,'shared Branch export default stays excluded');
 const exported=await service.export(result.branchId,'full',false,{},false,false,undefined,true);assert.deepEqual(exported.chats[0].titleHistory,history);
 // Existing same-Chat package updates can re-import a redacted copy of a
 // locally retained original after its literal value becomes a known secret.
 const known='synthetic-later-known-title-'+randomUUID(),prior=process.env.PONDEROSA_TEST_TITLE_TOKEN;t.after(()=>{if(prior===undefined)delete process.env.PONDEROSA_TEST_TITLE_TOKEN;else process.env.PONDEROSA_TEST_TITLE_TOKEN=prior;});
 workspace.append({type:'conversation_changed',projectId:chat.project_id,conversationId:chat.id,action:'updated',titleChange:{previousTitle:'Before '+known,title:'After local rename',actor:{kind:'operator_api'},origin:'operator_request',requestId:'actual-local-source'}});
 process.env.PONDEROSA_TEST_TITLE_TOKEN=known;
 const normalized=await service.export(result.branchId,'full',false,{},false,false,undefined,true);assert.equal(JSON.stringify(normalized.chats[0].titleHistory).includes(known),false);
 const update=await service.preview(normalized,{agents:{},directories:{workspace:root}},result.branchId),updated=await service.confirm(update.id,true);assert.equal(updated.state,'completed',JSON.stringify(updated));
 assert.equal(workspace.exportChatTitleHistory({projectId:chat.project_id,conversationId:chat.id,maximumBytes:AGENT_PACKAGE_MAX_BYTES}).length,2,'same-source import preserves its canonical original without raw/redacted duplicates');
 const again=await service.export(result.branchId,'full',false,{},false,false,undefined,true);assert.deepEqual(again.chats[0].titleHistory,normalized.chats[0].titleHistory);
 const {mergeChatTitleHistory}=await import('../../apps/server/dist/portable-chat-title-history.js');const conflict=structuredClone(history);conflict[0].change.title='Genuinely different source value';assert.throws(()=>mergeChatTitleHistory(history,conflict),/identity differs/u);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_runs').get().n,0);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branch_executions').get().n,0);passed=true;
});
