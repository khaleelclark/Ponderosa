import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';

function fixture(t){
 const root=mkdtempSync(path.join(tmpdir(),'branch-chat-owner-'));let store=new AgentStore(root),passed=false;
 t.after(()=>{store.close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic(`Retained fixture: ${root}`)});
 let branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));const branch=branches.create('Owner','owner');
 return {root,branch,get branches(){return branches},get store(){return store},reopen(){store.close();store=new AgentStore(root);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite))},done(){passed=true}};
}

test('persistent Branch Chat identity survives edits, projection rebuild, reopening and deletion receipts',t=>{
 const f=fixture(t),identity={idempotencyKey:'persistent-branch-chat',payloadHash:'reviewed-owner'};
 const input={label:'Branch Chat',chatOwned:true,branchId:f.branch.id,hostPath:f.root,defaultEngine:'codex'};
 const project=f.store.createProject(input,identity),id=project.lastConversationId;
 assert.equal(f.store.getConversation(id).branchId,f.branch.id);
 assert.equal(f.store.createProject(input,identity).id,project.id);
 assert.equal(f.store.updateConversation(id,{title:'Renamed'}).branchId,f.branch.id);
 f.store.rebuildProjections();assert.equal(f.store.getConversation(id).branchId,f.branch.id);
 f.reopen();assert.equal(f.store.getConversation(id).branchId,f.branch.id);
 assert.equal(f.store.getConversation(id).executionId,undefined);
 const receipt=f.store.markConversationDeletionPending(id);
 assert.equal(receipt.branchId,f.branch.id);
 assert.equal(f.store.getConversation(id),undefined);
 assert.equal(f.store.getConversation(id,{includeDeleting:true}).branchId,f.branch.id);
 f.done();
});

test('invalid and deleting Branch owners fail before creation; replay cannot change a Chat owner',t=>{
 const f=fixture(t),input={label:'Owned',chatOwned:true,branchId:f.branch.id,hostPath:f.root,defaultEngine:'codex'};
 const count=()=>f.store.sqlite.prepare('SELECT count(*) n FROM projects').get().n;
 assert.throws(()=>f.store.createProject({...input,branchId:randomUUID()}),/owner is unavailable/);
 assert.throws(()=>f.store.createProject({...input,executionId:randomUUID()}),/execution owner is unavailable/);
 assert.throws(()=>f.store.createProject({...input,chatOwned:false}),/owner is unavailable/);
 assert.equal(count(),0);
 const identity={idempotencyKey:'scoped-branch-chat',payloadHash:'trusted-hash'},project=f.store.createProject(input,identity);
 const other=f.branches.create('Other','other');
 assert.throws(()=>f.store.createProject({...input,branchId:other.id},identity),/different Branch owner/);
 assert.throws(()=>f.store.createProject({...input,branchId:undefined},identity),/different Branch owner/);
 assert.equal(f.store.getConversation(project.lastConversationId).branchId,f.branch.id);
 f.branches.beginDeletion(f.branch.id);
 assert.throws(()=>f.store.createProject(input),/owner is unavailable/);
 assert.equal(count(),1);f.done();
});

test('temporary Chat ownership pins its exact Branch execution across rebuild and reopen',t=>{
 const f=fixture(t),branch=f.branches.deploy({chatId:'',branchId:f.branch.id,expectedVersionId:'',idempotencyKey:'temporary-definition',definition:{schema:'ponderosa.branch.v1',name:'Temporary context',trigger:{kind:'manual'},entry:'review',steps:[{id:'review',kind:'human_gate',prompt:'Review',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{}}});
 const execution=f.branches.accept(branch.id,'one','Input'),other=f.branches.create('Other','other');
 const input={label:'Temporary context',chatOwned:true,branchId:branch.id,executionId:execution.id,hostPath:f.root,defaultEngine:'codex'};
 assert.throws(()=>f.store.createProject({...input,branchId:other.id}),/execution owner is unavailable/);
 const project=f.store.createProject(input),id=project.lastConversationId;
 f.store.rebuildProjections();f.reopen();
 const chat=f.store.getConversation(id);assert.equal(chat.branchId,branch.id);assert.equal(chat.executionId,execution.id);f.done();
});
