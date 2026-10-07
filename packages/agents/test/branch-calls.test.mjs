import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore,CoordinationV3Store,BranchStore} from '../dist/index.js';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'branch-calls-')); let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 const project=store.createProject({label:'Calls',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Context'});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,chat,get store(){return store},get branches(){return branches},reopen(){store.close();open()},deploy(name,steps,edges=[],bindings={},controls=[]){return branches.deploy({chatId:chat.id,idempotencyKey:name.replaceAll(' ','-'),definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:controls[0]?.id??steps[0].id,steps,controls,edges,policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{root:dir},...bindings}})}};
}
const script={id:'script',kind:'script',runtime:'node',source:'console.log("ok")',cwdRef:'root',timeoutMs:1000};
const call={id:'call',kind:'branch_call',branchRef:'child'};
test('disabled dependency waits across restart and admits exactly one current child',t=>{
 const f=fixture(t),child=f.deploy('child',[script]),parent=f.deploy('parent',[call],[],{branches:{child:child.id}});
 f.branches.setEnabled(child.id,false);const e=f.branches.accept(parent.id,'one','hello');f.branches.advance();
 assert.match(f.branches.detail(e.id).attempts[0].error,/disabled/);f.reopen();f.branches.advance();
 assert.equal(f.branches.listExecutions(child.id).length,0);
 f.branches.setEnabled(child.id,true);f.branches.advance();f.branches.advance();
 assert.equal(f.branches.listExecutions(child.id).length,1);
 const lease=f.branches.claimScript('test');assert.equal(lease.input,'hello');f.branches.settleScript(lease,{failed:false,output:'child result'});
 f.branches.advance();assert.equal(f.branches.execution(e.id).output,'child result');
});
test('parent cancellation cancels only its child and never recreates it',t=>{
 const f=fixture(t),child=f.deploy('child',[script]),parent=f.deploy('parent',[call],[],{branches:{child:child.id}});
 const unrelated=f.branches.accept(child.id,'unrelated','keep');const e=f.branches.accept(parent.id,'parent','cancel');
 f.branches.advance();f.branches.advance();const owned=f.branches.listExecutions(child.id).find(x=>x.parentExecutionId===e.id);assert.ok(owned);
 f.branches.cancel(e.id);f.branches.advance();
 assert.equal(f.branches.execution(owned.id).state,'canceled');assert.notEqual(f.branches.execution(unrelated.id).state,'canceled');
 assert.equal(f.branches.listExecutions(child.id).length,2);
});
test('self calls at concurrency one progress to the inherited depth limit',t=>{
 const f=fixture(t),b=f.deploy('recursive',[call],[],{});
 const d=f.branches.version(b.id,b.versionId).definition;
 f.branches.deploy({chatId:f.chat.id,branchId:b.id,expectedVersionId:b.versionId,idempotencyKey:'recursive-bind',definition:d,bindings:{agents:{},directories:{},branches:{child:b.id}}});
 f.branches.configure(b.id,{parameters:{},limits:{maxCallDepth:3,maxLoopIterations:100,maxTraversals:100}},0);
 const e=f.branches.accept(b.id,'root','recurse');for(let i=0;i<15;i++)f.branches.advance();
 assert.equal(f.branches.listExecutions(b.id).length,4);assert.equal(f.branches.execution(e.id).state,'failed');
 assert.match(f.branches.execution(e.id).output,/maxCallDepth/);
});
test('a loop creates new invocations and terminates at its configured limit',t=>{
 const f=fixture(t),b=f.deploy('loop',[script],[{id:'again',from:'script',to:'script',on:'success',loop:true,input:{kind:'literal',text:'next'}}]);
 f.branches.configure(b.id,{parameters:{},limits:{maxCallDepth:100,maxLoopIterations:2,maxTraversals:100}},0);
 const e=f.branches.accept(b.id,'loop','first');f.branches.advance();
 for(let i=0;i<3;i++){const lease=f.branches.claimScript('test');assert.equal(lease.input,i?'next':'first');f.branches.settleScript(lease,{failed:false,output:'ignored'});}
 assert.equal(f.branches.detail(e.id).steps.length,4);assert.equal(f.branches.execution(e.id).state,'failed');assert.match(f.branches.execution(e.id).output,/maxLoopIterations/);
});

test('independent child cancellation follows the explicit canceled edge',t=>{
 const f=fixture(t),child=f.deploy('canceled-child',[script]),parent=f.deploy('canceled-route',[call,{...script,id:'recover'}],[{id:'on-cancel',from:'call',to:'recover',on:'canceled'}],{branches:{child:child.id}});
 const e=f.branches.accept(parent.id,'one','input');f.branches.advance();f.branches.advance();
 const owned=f.branches.listExecutions(child.id).find(x=>x.parentExecutionId===e.id);assert.ok(owned);f.branches.cancel(owned.id);f.reopen();f.branches.advance();
 assert.equal(f.branches.detail(e.id).attempts[0].outcome.kind,'child_canceled');
 const recovery=f.branches.claimScript('test');assert.equal(recovery.executionId,e.id);f.branches.settleScript(recovery,{failed:false,output:'handled cancellation'});f.branches.advance();
 assert.equal(f.branches.execution(e.id).state,'completed');assert.equal(f.branches.listExecutions(child.id).length,1);
});

test('rejecting recovery after independent child cancellation seals a terminal failed result',t=>{
 const f=fixture(t),child=f.deploy('gate-child',[{id:'gate',kind:'human_gate',prompt:'Wait',editable:false}]),parent=f.deploy('gate-parent',[call],[],{branches:{child:child.id}});
 const execution=f.branches.accept(parent.id,'cancel-gate','input');f.branches.advance();f.branches.advance();
 const owned=f.branches.listExecutions(child.id).find(run=>run.parentExecutionId===execution.id);assert.ok(owned);
 f.branches.cancel(owned.id);f.reopen();f.branches.advance();
 const waiting=f.branches.detail(execution.id),gate=waiting.gates.find(item=>item.state==='waiting');assert.ok(gate);assert.equal(gate.purpose,'recovery');
 assert.equal(waiting.attempts[0].outcome.kind,'child_canceled');
 f.branches.resolveGate(gate.id,{commandKey:'reject-canceled-child',expectedRevision:gate.revision,decision:'reject'});
 const detail=f.branches.detail(execution.id);
 assert.equal(detail.execution.state,'failed');assert.equal(detail.sealedResults.length,1);
 assert.equal(detail.sealedResults[0].terminalAttemptId,waiting.attempts[0].id);
 assert.match(detail.execution.output,/Child Branch was canceled/);
});

test('a persisted canceled-child recovery gate without a saved result can still be rejected',t=>{
 const f=fixture(t),child=f.deploy('old-gate-child',[{id:'gate',kind:'human_gate',prompt:'Wait',editable:false}]),parent=f.deploy('old-gate-parent',[call],[],{branches:{child:child.id}});
 const execution=f.branches.accept(parent.id,'legacy-cancel-gate','input');f.branches.advance();f.branches.advance();
 const owned=f.branches.listExecutions(child.id).find(run=>run.parentExecutionId===execution.id);assert.ok(owned);
 f.branches.cancel(owned.id);f.branches.advance();
 const gate=f.branches.detail(execution.id).gates.find(item=>item.state==='waiting');assert.ok(gate);
 f.store.sqlite.prepare('UPDATE branch_attempts SET result_json=NULL WHERE id=?').run(gate.attemptId);
 f.reopen();f.branches.resolveGate(gate.id,{commandKey:'reject-legacy-cancel',expectedRevision:gate.revision,decision:'reject'});
 const detail=f.branches.detail(execution.id);assert.equal(detail.execution.state,'failed');assert.equal(detail.sealedResults.length,1);
 assert.match(detail.execution.output,/Child Branch was canceled/);
});

test('parameter snapshots stay stable while a waiting call uses current child settings',t=>{
 const f=fixture(t),base=f.deploy('configured-child',[{id:'gate',kind:'human_gate',prompt:'For {{parameter:recipient}}',editable:false}]);
 const definition={...f.branches.version(base.id,base.versionId).definition,parameters:{recipient:{type:'text',default:'old'}}};
 const child=f.branches.deploy({chatId:f.chat.id,branchId:base.id,expectedVersionId:base.versionId,idempotencyKey:'parameter-schema',definition,bindings:{agents:{},directories:{}}});
 const parent=f.deploy('parameter-parent',[call],[],{branches:{child:child.id}});
 f.branches.setEnabled(child.id,false);const e=f.branches.accept(parent.id,'one','explicit input');f.branches.advance();
 f.branches.configure(child.id,{parameters:{recipient:'current'},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}},0);f.branches.setEnabled(child.id,true);f.branches.advance();f.branches.advance();
 const owned=f.branches.listExecutions(child.id).find(x=>x.parentExecutionId===e.id);assert.equal(owned.configuration.parameters.recipient,'current');
 f.branches.configure(child.id,{parameters:{recipient:'later'},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}},1);
 assert.equal(f.branches.execution(owned.id).configuration.parameters.recipient,'current');assert.equal(f.branches.detail(owned.id).gates[0].prompt,'For current');
});

test('child loops cannot reset an ancestor loop ceiling',t=>{
 const f=fixture(t),child=f.deploy('looping-child',[script],[{id:'again',from:'script',to:'script',on:'success',loop:true}]),parent=f.deploy('limited-parent',[call],[],{branches:{child:child.id}});
 f.branches.configure(parent.id,{parameters:{},limits:{maxCallDepth:100,maxLoopIterations:1,maxTraversals:100}},0);
 const e=f.branches.accept(parent.id,'one','');f.branches.advance();f.branches.advance();
 for(let i=0;i<2;i++){const lease=f.branches.claimScript('test');assert.ok(lease);f.branches.settleScript(lease,{failed:false,output:'again'});}
 f.branches.advance();assert.equal(f.branches.execution(e.id).state,'failed');assert.match(f.branches.execution(e.id).output,/maxLoopIterations \(limit 1/);
});

test('directory parameter references use frozen execution configuration',t=>{
 const f=fixture(t),base=f.deploy('path-parameter',[script]),definition={...f.branches.version(base.id,base.versionId).definition,parameters:{folder:{type:'path',default:f.dir}}};
 const b=f.branches.deploy({chatId:f.chat.id,branchId:base.id,expectedVersionId:base.versionId,idempotencyKey:'directory-parameter',definition,bindings:{agents:{},directories:{root:'{{parameter:folder}}'}}});
 const e=f.branches.accept(b.id,'first','');f.branches.configure(b.id,{parameters:{folder:'/tmp'},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}},0);f.branches.advance();
 const lease=f.branches.claimScript('test');assert.equal(lease.executionId,e.id);assert.equal(lease.cwd,f.dir);
});

test('inspection names disabled dependencies and the exact admitted child without changing execution state',t=>{
 const f=fixture(t),child=f.deploy('Security Review',[script]),parent=f.deploy('Release',[call],[],{branches:{child:child.id}});
 f.branches.setEnabled(child.id,false);const e=f.branches.accept(parent.id,'inspect','text');f.branches.advance();
 let detail=f.branches.detail(e.id);assert.equal(detail.waits[0].kind,'disabled_branch');assert.equal(detail.waits[0].branchId,child.id);assert.match(detail.waits[0].message,/Security Review/);
 f.branches.setEnabled(child.id,true);f.branches.advance();detail=f.branches.detail(e.id);
 assert.equal(detail.waits[0].kind,'child');assert.equal(detail.waits[0].executionId,detail.attempts[0].childExecutionId);assert.equal(detail.attempts[0].calledBranch.name,'Security Review');
 const revision=detail.execution.revision;assert.equal(f.branches.detail(e.id).execution.revision,revision);
});

test('execution filters query canonical state before paging and reject invalid filters',t=>{
 const f=fixture(t),b=f.deploy('filter',[script]);
 const first=f.branches.accept(b.id,'first','');
 const second=f.branches.accept(b.id,'second','');
 f.branches.cancel(first.id);f.branches.advance();
 assert.deepEqual(f.branches.listExecutions(b.id,undefined,'canceled').map(e=>e.id),[first.id]);
 assert.ok(f.branches.listExecutions(b.id).some(e=>e.id===second.id));
 assert.deepEqual(f.branches.listExecutions(b.id,first.id,'canceled'),[]);
 assert.throws(()=>f.branches.listExecutions(b.id,undefined,'unknown'),/status filter/);
});
test('typed parameter help is canonical and secret defaults remain forbidden',t=>{
 const f=fixture(t),b=f.deploy('parameters',[script]);
 const definition=f.branches.version(b.id,b.versionId).definition;
 const deploy=parameters=>f.branches.deploy({chatId:f.chat.id,branchId:b.id,expectedVersionId:b.versionId,idempotencyKey:'parameter-help',definition:{...definition,parameters},bindings:{agents:{},directories:{root:f.dir}}});
 assert.throws(()=>deploy({token:{type:'secret',default:'forbidden'}}),/Secret defaults/);
 const next=deploy({folder:{type:'path',required:true,help:'Choose an existing folder'},token:{type:'secret',help:'Engine-owned binding'}});
 assert.equal(f.branches.version(next.id,next.versionId).definition.parameters.folder.help,'Choose an existing folder');
});

test('deployment idempotency includes replacement configuration',t=>{
 const f=fixture(t),base=f.deploy('configuration-receipt',[script]),definition={...f.branches.version(base.id,base.versionId).definition,parameters:{value:{type:'text'}}};
 const input={chatId:f.chat.id,branchId:base.id,expectedVersionId:base.versionId,idempotencyKey:'configuration-receipt-update',definition,bindings:{agents:{},directories:{root:f.dir}}};
 const limits={maxCallDepth:100,maxLoopIterations:100,maxTraversals:100};
 f.branches.deploy(input,undefined,undefined,{parameters:{value:'first'},limits});
 assert.throws(()=>f.branches.deploy(input,undefined,undefined,{parameters:{value:'second'},limits}),/idempotency conflict/);
});

test('deployment removes obsolete configured parameter values atomically',t=>{
 const f=fixture(t),base=f.deploy('parameter-removal',[script]);
 const withParameter=f.branches.deploy({chatId:f.chat.id,branchId:base.id,expectedVersionId:base.versionId,idempotencyKey:'parameter-add',definition:{...f.branches.version(base.id,base.versionId).definition,parameters:{recipient:{type:'text'}}},bindings:{agents:{},directories:{root:f.dir}}});
 f.branches.configure(withParameter.id,{parameters:{recipient:'operator@example.test'},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}},0);
 const withoutParameter={...f.branches.version(withParameter.id,withParameter.versionId).definition,parameters:{}};
 const preview=f.branches.preview({chatId:f.chat.id,branchId:withParameter.id,expectedVersionId:withParameter.versionId,idempotencyKey:'parameter-remove',definition:withoutParameter,bindings:{agents:{},directories:{root:f.dir}}});
 assert.ok(preview.operations.some(operation=>operation.resource==='Parameter value'&&operation.ref==='recipient'&&operation.kind==='detach'));
 const deployed=f.branches.deploy({chatId:f.chat.id,branchId:withParameter.id,expectedVersionId:withParameter.versionId,idempotencyKey:'parameter-remove',definition:withoutParameter,bindings:{agents:{},directories:{root:f.dir}}});
 assert.deepEqual(f.branches.configuration(deployed.id).parameters,{});
 assert.doesNotThrow(()=>f.branches.accept(deployed.id,'after-removal','run'));
});
