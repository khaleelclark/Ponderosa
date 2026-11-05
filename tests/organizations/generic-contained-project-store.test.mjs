import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmdirSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,managedWorkspacePath,resolveAgentWorkingCopy} from '@ponderosa/agents';
import {destinationAdmissionHeld} from '../../packages/agents/dist/coordination-v3-destination-staging.js';
import {AgentWorkingCopyService} from '../../apps/server/dist/agent-working-copy-service.js';

const read=filename=>JSON.parse(readFileSync(filename,'utf8'));
const write=(filename,value)=>writeFileSync(filename,JSON.stringify(value));
function fixture(){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'generic-contained-store-'))),data=path.join(root,'data');let store=new AgentStore(data);
 const parentRoot=path.join(root,'parent');mkdirSync(parentRoot);
 const parentProject=store.createProject({label:'Fresh parent',hostPath:parentRoot,defaultEngine:'codex',chatOwned:true});
 const parentAgent=store.createAgent(parentProject.id,{title:'Parent',engine:'codex',conversationId:parentProject.lastConversationId});
 const name='new-child',oldRoot=managedWorkspacePath(data,name);mkdirSync(oldRoot,{recursive:true});writeFileSync(path.join(oldRoot,'retained.txt'),'original managed bytes');
 const project=store.createProject({label:'Unused child',hostPath:oldRoot,defaultEngine:'codex',chatOwned:true,managedWorkspaceName:name,creationHostPath:'managed:workspaces/'+name},{idempotencyKey:'managed-child',payloadHash:'original-project-input'});
 const operation=store.beginAgentCreationOperation({projectId:project.id,conversationId:project.lastConversationId,actorScope:'user:local-operator',kind:'import',idempotencyKey:'original-import',payloadHash:'original-import-input'}).operation;
 const members=['First','Second'].map((title,index)=>{const agent=store.createAgent(project.id,{title,engine:'codex',conversationId:project.lastConversationId});store.addAgentCreationOperationMember(operation.id,agent.id,index);return agent;});
 store.updateAgentCreationOperation(operation.id,{result:{retainedReceipt:'original'}});
 const newRoot=path.join(parentRoot,'child');mkdirSync(newRoot);writeFileSync(path.join(newRoot,'partial.txt'),'retained partial bytes');
 const parentStat=lstatSync(parentRoot,{bigint:true}),childStat=lstatSync(newRoot,{bigint:true}),parent={parentAgentId:parentAgent.id,parentProjectId:parentProject.id,parentPath:parentRoot,parentDevice:parentStat.dev.toString(),parentInode:parentStat.ino.toString(),relativePath:'child',device:childStat.dev.toString(),inode:childStat.ino.toString()};
 store.updateAgentWorkingCopy(parentAgent.id,{...parentAgent.workingCopy,containedRootPreparations:[{id:randomUUID(),relativePath:'child',rootPath:newRoot,parentDevice:parent.parentDevice,parentInode:parent.parentInode,device:parent.device,inode:parent.inode,phase:'created'}]});
 const projectFile=path.join(data,'projects',project.id,'project.json'),chatFile=path.join(data,'projects',project.id,'conversations',project.lastConversationId,'conversation.json'),agentFile=id=>path.join(data,'projects',project.id,'agents',id,'agent.json');
 const originalProject=read(projectFile),ids=members.map(agent=>agent.id);
 return {root,data,parentRoot,parentProject,project,operation,members,oldRoot,newRoot,parent,projectFile,chatFile,agentFile,originalProject,ids,get store(){return store;},bind(){return store.bindPreparingImportedProjectRoot(project.id,operation.id,oldRoot,newRoot,ids,parent);},close(){store.close();},reopen(){store=new AgentStore(data);return store;},dispose(){try{store.close();}finally{rmSync(root,{recursive:true,force:true});}}};
}

test('generic contained binding requires exact pending members and local child identity, preserving original creation provenance',()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.bindPreparingImportedProjectRoot(f.project.id,f.operation.id,f.oldRoot,f.newRoot,[f.ids[0]],f.parent),/all exact members/);
  const original=path.join(f.parentRoot,'original-child');renameSync(f.newRoot,original);mkdirSync(f.newRoot);
  assert.throws(()=>f.bind(),/identity changed/);assert.equal(read(f.projectFile).hostPath,f.oldRoot);
  rmdirSync(f.newRoot);renameSync(original,f.newRoot);
  assert.equal(f.bind().hostPath,f.newRoot);
  const record=read(f.projectFile);assert.equal(record.creationHostPath,f.originalProject.creationHostPath);assert.equal(record.creationPayloadHash,f.originalProject.creationPayloadHash);assert.equal(record.creationIdempotencyKey,f.originalProject.creationIdempotencyKey);
  assert.equal(record.importedRootBinding.creationOperationId,f.operation.id);assert.equal(record.importedRootBinding.planId,undefined);
  assert.deepEqual(record.importedRootBinding.memberIds,f.ids);assert.equal(read(f.chatFile).workingDirectory,f.newRoot);
  for(const id of f.ids)assert.equal(read(f.agentFile(id)).workingCopy.rootPath,f.newRoot);
  const op=f.store.getAgentCreationOperation(f.operation.id);assert.equal(op.status,'preparing');assert.equal(op.result.retainedReceipt,'original');assert.equal(op.result.importedProjectRootBindings[f.project.id].state,'completed');
  assert.equal(readFileSync(path.join(f.oldRoot,'retained.txt'),'utf8'),'original managed bytes');
 }finally{f.dispose();}
});

test('restart repairs only bound path metadata and holds the original generic import without rollback or dispatch',()=>{
 const f=fixture();try{
  f.bind();f.close();
  const record=read(f.projectFile);record.importedRootBinding.state='binding';write(f.projectFile,record);
  const chat=read(f.chatFile);chat.workingDirectory=f.oldRoot;write(f.chatFile,chat);
  for(const id of f.ids){const agent=read(f.agentFile(id));agent.workingCopy.rootPath=f.oldRoot;write(f.agentFile(id),agent);}
  const store=f.reopen(),op=store.getAgentCreationOperation(f.operation.id);
  assert.equal(read(f.projectFile).importedRootBinding.state,'completed');assert.equal(read(f.chatFile).workingDirectory,f.newRoot);
  for(const id of f.ids){assert.equal(read(f.agentFile(id)).workingCopy.rootPath,f.newRoot);assert.equal(store.agentCreationPending(id),true);assert.equal(destinationAdmissionHeld(store.sqlite,id),true);}
  assert.equal(op.status,'preparing');assert.equal(op.result.importedProjectRootBindings[f.project.id].state,'unavailable');assert.match(op.lastError,/unavailable/);
  assert.ok(!store.listRecoverableAgentCreationOperations().some(item=>item.id===op.id),'Automatic rollback and memory cleanup must not receive this operation');
  assert.equal(store.listAgents(f.project.id).length,0);assert.ok(!store.listAgentEngineAssignments().some(agent=>f.ids.includes(agent.id)));
  assert.throws(()=>store.updateAgentCreationOperation(op.id,{status:'rolling_back'}),/rollback is forbidden/);
  assert.throws(()=>store.updateAgentCreationOperation(op.id,{status:'completed'}),/unavailable/);
  store.updateAgentCreationOperation(op.id,{result:{newReceipt:true}});assert.ok(store.getAgentCreationOperation(op.id).result.importedProjectRootBindings[f.project.id]);
  assert.equal(readFileSync(path.join(f.newRoot,'partial.txt'),'utf8'),'retained partial bytes');assert.equal(readFileSync(path.join(f.oldRoot,'retained.txt'),'utf8'),'original managed bytes');
 }finally{f.dispose();}
});

test('restart preserves a replaced child and isolates its unavailable Project from unrelated work',()=>{
 const f=fixture();try{
  f.bind();f.close();const record=read(f.projectFile);record.importedRootBinding.state='binding';write(f.projectFile,record);
  const original=path.join(f.parentRoot,'retained-original-child');renameSync(f.newRoot,original);mkdirSync(f.newRoot);writeFileSync(path.join(f.newRoot,'replacement.txt'),'replacement bytes');
  const store=f.reopen(),op=store.getAgentCreationOperation(f.operation.id);
  assert.equal(read(f.projectFile).importedRootBinding.recoveryError.code,'ERR_IMPORTED_ROOT_RECOVERY_HELD');assert.equal(op.status,'preparing');assert.equal(op.result.importedProjectRootBindings[f.project.id].state,'unavailable');
  assert.ok(store.getProject(f.parentProject.id),'Unrelated parent Project survives the isolated recovery hold');
  assert.equal(destinationAdmissionHeld(store.sqlite,undefined,f.project.lastConversationId),true);
  assert.equal(readFileSync(path.join(original,'partial.txt'),'utf8'),'retained partial bytes');assert.equal(readFileSync(path.join(f.newRoot,'replacement.txt'),'utf8'),'replacement bytes');
 }finally{f.dispose();}
});


test('a Shared contained child can bind beneath its same-Project preparing Separate parent',()=>{
 const f=fixture();try{
  const owner=f.store.createAgent(f.project.id,{title:'Pending Separate parent',engine:'codex',conversationId:f.project.lastConversationId});
  f.store.addAgentCreationOperationMember(f.operation.id,owner.id,2);
  const prior=f.store.getAgent(f.parent.parentAgentId).workingCopy;
  f.store.updateAgentWorkingCopy(owner.id,{...owner.workingCopy,id:'copy:'+randomUUID(),mode:'separate_git',state:'unavailable',rootPath:f.parentRoot,repositoryRoot:f.parentRoot,branch:'import-parent',failure:'Native import pending',containedRootPreparations:prior.containedRootPreparations});
  const ids=[...f.ids,owner.id],parent={...f.parent,parentAgentId:owner.id,parentProjectId:f.project.id};
  assert.equal(f.store.listAgents(f.project.id).length,0,'Ordinary listing still hides preparing actors');
  assert.equal(f.store.bindPreparingImportedProjectRoot(f.project.id,f.operation.id,f.oldRoot,f.newRoot,ids,parent).hostPath,f.newRoot);
  for(const id of f.ids)assert.equal(read(f.agentFile(id)).workingCopy.rootPath,f.newRoot,'All pending Shared owners are updated');
  assert.equal(read(f.agentFile(owner.id)).workingCopy.rootPath,f.parentRoot,'Independent parent ownership is preserved');
  assert.deepEqual(read(f.projectFile).importedRootBinding.memberIds,ids);
 }finally{f.dispose();}
});

test('Shared import custody stays unavailable until the exact metadata operation finishes',()=>{
 const f=fixture();try{
  const agent=f.store.getAgent(f.ids[0]),project=f.store.getProject(f.project.id);
  const pending={...agent.workingCopy,state:'unavailable',failure:'Native import metadata and ownership proof are pending; preserve the exact import operation.'};
  f.store.updateAgentWorkingCopy(agent.id,pending);
  const held=f.store.getAgent(agent.id);
  assert.equal(held.workingCopy.state,'unavailable');
  assert.throws(()=>resolveAgentWorkingCopy(held,project),error=>error.message===pending.failure);
  assert.throws(()=>f.store.updateAgentWorkingCopy(agent.id,{...pending,rootPath:f.newRoot}),/Shared folder identity/);
  assert.throws(()=>f.store.updateAgentWorkingCopy(agent.id,{...pending,failure:undefined}),/Shared folder identity/);
  assert.throws(()=>f.store.updateAgentWorkingCopy(agent.id,{...pending,state:'ready'}),/Shared folder identity/);
  f.store.updateAgentWorkingCopy(agent.id,{...pending,state:'ready',failure:undefined});
  assert.equal(resolveAgentWorkingCopy(f.store.getAgent(agent.id),project).rootPath,project.hostPath);
 }finally{f.dispose();}
});

test('Run admission reports known pending import proof and redacts unknown native details',()=>{
 const f=fixture();try{
  const original=f.store.getAgent(f.ids[0]),service=new AgentWorkingCopyService(f.data,f.store);
  const pending='Native import metadata and ownership proof are pending; preserve the exact import operation.';
  f.store.updateAgentWorkingCopy(original.id,{...original.workingCopy,state:'unavailable',failure:pending});
  assert.throws(()=>service.assertRunAdmission(original.id,original.workingCopy),error=>error.message===pending);
  const incomplete='Native Git import proof is incomplete; preserve its exact root and original import operation.';
  f.store.updateAgentWorkingCopy(original.id,{...original.workingCopy,state:'unavailable',failure:incomplete});
  assert.throws(()=>service.assertRunAdmission(original.id,original.workingCopy),error=>error.message===incomplete);
  const secret='fixture-secret-synthetic-import',privateDetail='native failure at /private/synthetic/file '+secret;
  f.store.updateAgentWorkingCopy(original.id,{...original.workingCopy,state:'unavailable',failure:privateDetail});
  const projected=f.store.getAgent(original.id).workingCopy;
  assert.doesNotMatch(JSON.stringify(projected),new RegExp(secret));
  assert.match(projected.failure,/withheld/);
  assert.throws(()=>service.assertRunAdmission(original.id,original.workingCopy),error=>/working folder is unavailable/.test(error.message)&&!error.message.includes('/private/')&&!error.message.includes(secret));
  assert.throws(()=>service.assertRunAdmission(original.id,{...original.workingCopy,rootPath:f.newRoot}),/changed before the Run/);
 }finally{f.dispose();}
});
