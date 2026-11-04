import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,lstatSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';

const identity=stat=>Object.fromEntries([['device',stat.dev],['inode',stat.ino],['mode',stat.mode],['nlink',stat.nlink],['uid',stat.uid],['gid',stat.gid],['size',stat.size],['mtimeNs',stat.mtimeNs],['ctimeNs',stat.ctimeNs]].map(([key,value])=>[key,String(value)]));
function fixture(){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'generated-hook-store-'))),data=path.join(root,'data'),working=path.join(root,'working');mkdirSync(working);
 let store=new AgentStore(data);
 const project=store.createProject({label:'Owned hook root',hostPath:working,defaultEngine:'codex',chatOwned:true});
 const operation=store.beginAgentCreationOperation({projectId:project.id,conversationId:project.lastConversationId,actorScope:'user:local-operator',kind:'import',idempotencyKey:'generated-hook-import',payloadHash:'source-original-input'}).operation;
 const agents=['Owner','Shared peer'].map((title,index)=>{const agent=store.createAgent(project.id,{title,engine:'codex',conversationId:project.lastConversationId});store.addAgentCreationOperationMember(operation.id,agent.id,index);return agent;});
 const original=Buffer.from('canonical original bytes'),sha=createHash('sha256').update(original).digest('hex'),artifactId=randomUUID();
 store.updateAgentCreationOperation(operation.id,{artifactIds:[artifactId],artifactIdentities:[{id:artifactId,byteLength:original.length,sha256:sha}],result:{earlierReceipt:'retained'}});
 const namespace=path.join(working,'.ponderosa-portable-review','active-git-hooks'),name='a'.repeat(64),text='../../hook-tree';mkdirSync(namespace,{recursive:true});mkdirSync(path.join(working,'hook-tree'));symlinkSync(text,path.join(namespace,name));
 const rootIdentity=identity(lstatSync(working,{bigint:true})),proof={schema:'ponderosa.generated-hook-namespace.v1',root:{device:rootIdentity.device,inode:rootIdentity.inode},namespace:identity(lstatSync(namespace,{bigint:true})),links:[{name,text,identity:identity(lstatSync(path.join(namespace,name),{bigint:true}))}]};
 const input=agent=>({agentId:agent.id,rootPath:working,root:proof.root,sourceOriginalSha256:sha});
 return {root,data,working,project,operation,agents,sha,proof,input,artifactId,original,get store(){return store;},reopen(){store.close();store=new AgentStore(data);},dispose(){try{store.close();}finally{rmSync(root,{recursive:true,force:true});}}};
}

test('canonical generated hooks survive result replacement and restart, deduplicated across exact shared-root members',()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.updateAgentCreationOperation(f.operation.id,{result:{canonicalGeneratedHooks:[]}}),/only be issued/);
  const issued=f.store.recordGeneratedHookNamespace(f.agents[0].id,f.working,f.sha,f.proof);
  f.store.recordGeneratedHookNamespace(f.agents[1].id,f.working,f.sha,f.proof);
  assert.equal(f.store.findGeneratedHookNamespace(f.input(f.agents[0])),undefined,'pending import cannot authorize retained export');
  const result=f.store.getAgentCreationOperation(f.operation.id).result;
  assert.equal(result.earlierReceipt,'retained');assert.equal(result.canonicalGeneratedHooks.length,1);assert.deepEqual(result.canonicalGeneratedHooks[0].agentIds,f.agents.map(agent=>agent.id));
  f.store.updateAgentCreationOperation(f.operation.id,{status:'completed',result:{laterReceipt:'retained'}});
  f.reopen();
  for(const agent of f.agents)assert.deepEqual(f.store.findGeneratedHookNamespace(f.input(agent)),issued);
  const returned=f.store.findGeneratedHookNamespace(f.input(f.agents[0]));returned.links[0].text='changed-local-object';
  assert.equal(f.store.findGeneratedHookNamespace(f.input(f.agents[0])).links[0].text,f.proof.links[0].text);
  assert.equal(f.store.getAgentCreationOperation(f.operation.id).result.laterReceipt,'retained');
  assert.equal(f.store.findGeneratedHookNamespace({...f.input(f.agents[0]),sourceOriginalSha256:'b'.repeat(64)}),undefined);
  assert.equal(f.store.findGeneratedHookNamespace({...f.input(f.agents[0]),root:{...f.proof.root,inode:'0'}}),undefined);
  const changed=structuredClone(f.store.getAgentCreationOperation(f.operation.id).result);changed.canonicalGeneratedHooks[0].proof.links[0].text='different';
  assert.throws(()=>f.store.updateAgentCreationOperation(f.operation.id,{result:changed}),/only be issued/);
  const other=path.join(f.root,'other-root');mkdirSync(other);const agent=f.store.getAgent(f.agents[0].id);
  const moved=f.store.updateAgentWorkingCopy(agent.id,{...agent.workingCopy,id:'copy:'+randomUUID(),mode:'separate_git',rootPath:other,branch:'test-moved-owner',branchOwned:true});
  assert.equal(moved.workingCopy.rootPath,other);assert.equal(moved.workingCopy.state,'ready');
  assert.equal(f.store.findGeneratedHookNamespace(f.input(agent)),undefined,'a changed current owner cannot reuse old root proof');
 }finally{f.dispose();}
});

test('issuer rejects wrong original, completed nonstaged operations, malformed identities and conflicting physical proofs',()=>{
 const f=fixture();try{
  assert.throws(()=>f.store.recordGeneratedHookNamespace(f.agents[0].id,f.working,'b'.repeat(64),f.proof),/retained original/);
  const malformed=structuredClone(f.proof);malformed.links[0].identity.nlink='2';
  assert.throws(()=>f.store.recordGeneratedHookNamespace(f.agents[0].id,f.working,f.sha,malformed),/link declaration/);
  f.store.recordGeneratedHookNamespace(f.agents[0].id,f.working,f.sha,f.proof);
  const changed=structuredClone(f.proof);changed.namespace.inode='0';
  assert.throws(()=>f.store.recordGeneratedHookNamespace(f.agents[0].id,f.working,f.sha,changed),/another physical identity/);
  f.store.updateAgentCreationOperation(f.operation.id,{status:'completed'});
  assert.throws(()=>f.store.recordGeneratedHookNamespace(f.agents[1].id,f.working,f.sha,f.proof),/fenced canonical import/);
 }finally{f.dispose();}
});

test('completed grouped import can issue only while its exact canonical Branch member is staged',()=>{
 const f=fixture();try{
  f.store.updateAgentCreationOperation(f.operation.id,{status:'completed',artifactIds:[],artifactIdentities:[]});
  f.store.recordProjectArtifacts([{artifact:{id:f.artifactId,projectId:f.project.id,agentId:f.agents[0].id,originAgentId:f.agents[0].id,kind:'document',path:'imported/'+f.artifactId+'.json',summary:'Retained original',createdAt:new Date().toISOString(),mediaType:'application/json',visibility:'project',pinned:false,size:f.original.length,sha256:f.sha}}]);
  const now=new Date().toISOString(),branch=randomUUID();
  f.store.sqlite.prepare('INSERT INTO branches(id,chat_id,name,active_version_id,binding_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(branch,'','Owned import','','',now,now);
  f.store.sqlite.prepare('INSERT INTO branch_installation_resources(branch_id,package_id,chat_ref,agent_ref,local_id,state,staging_plan_id,creation_operation_id) VALUES(?,?,?,?,?,?,?,?)').run(branch,'package','chat','agent',f.agents[1].id,'staging','physical-plan',f.operation.id);
  const issued=f.store.recordGeneratedHookNamespace(f.agents[1].id,f.working,f.sha,f.proof);
  assert.deepEqual(f.store.findGeneratedHookNamespace(f.input(f.agents[1])),issued);
  f.store.sqlite.prepare('UPDATE branch_installation_resources SET state=? WHERE local_id=?').run('active',f.agents[1].id);
  assert.throws(()=>f.store.recordGeneratedHookNamespace(f.agents[1].id,f.working,f.sha,f.proof),/fenced canonical import/);
 }finally{f.dispose();}
});
