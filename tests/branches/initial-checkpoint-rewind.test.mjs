import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {AgentStore,CoordinationV3Store,BranchStore} from '../../packages/agents/dist/index.js';

function fixture(t,{parameters}={}) {
 const dir=mkdtempSync(join(tmpdir(),'branch-initial-rewind-'));
 let store,branches;
 const open=()=>{store=new AgentStore(dir);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({label:'Checkpoint',hostPath:dir,defaultEngine:'codex'});
 const chat=store.createConversation(project.id,{title:'Checkpoint'});
 const definition={schema:'ponderosa.branch.v1',name:'Checkpoint',trigger:{kind:'manual'},entry:'work',
  steps:[{id:'work',kind:'script',runtime:'node',source:'console.log("fixture only")',cwdRef:'root',timeoutMs:5000}],
  controls:[],edges:[],policy:{maxConcurrentExecutions:8,failure:{action:'stop'}},...(parameters?{parameters}:{})};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:'deploy',definition,bindings:{agents:{},directories:{root:dir}}});
 return {get store(){return store},get branches(){return branches},branch,definition,
  accept(){return branches.accept(branch.id,'original','canonical input')},
  reopen(){store.close();open();}};
}
function canceled(f){const source=f.accept();f.branches.cancel(source.id);const checkpoint=f.branches.saveInitialCheckpoint(f.branch.id,source.id);assert.equal(f.branches.execution(source.id).state,'canceled');return {source,checkpoint};}

test('INITIAL rewind survives reopen, records lineage before scheduler dispatch, and executes the original frontier',t=>{
 const f=fixture(t),{source,checkpoint}=canceled(f);f.reopen();
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,'0'.repeat(64),'wrong-hash'),/hash changed/);
 const next=f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind');
 assert.notEqual(next.id,source.id);assert.equal(next.state,'queued');assert.equal(next.input,source.input);
 assert.equal(next.versionId,source.versionId);assert.equal(next.bindingRevisionId,source.bindingRevisionId);
 assert.equal(next.parentExecutionId,undefined);assert.equal(next.callDepth,0);
 const lineage=f.store.sqlite.prepare('SELECT * FROM branch_initial_rewinds WHERE execution_id=?').get(next.id);
 assert.equal(lineage.source_execution_id,source.id);assert.equal(lineage.checkpoint_hash,checkpoint.contentHash);assert.equal(lineage.command_key,'rewind');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_attempts').get().n,0);
 f.reopen();assert.equal(f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind').id,next.id);
 f.branches.advance();const lease=f.branches.claimScript('controlled-worker');assert.ok(lease);assert.equal(lease.executionId,next.id);assert.equal(lease.input,source.input);
 f.branches.settleScript(lease,{failed:false,output:'controlled result'});
 assert.equal(f.branches.execution(next.id).state,'completed');assert.equal(f.branches.execution(source.id).state,'canceled');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_initial_rewinds').get().n,1);
});

test('explicit checkpoint persistence failure preserves primary cancellation and exposes saver error',t=>{
 const f=fixture(t),source=f.accept();f.branches.cancel(source.id);
 f.store.sqlite.exec("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON branch_initial_checkpoints BEGIN SELECT RAISE(ABORT,'injected saver failure'); END");
 assert.throws(()=>f.branches.saveInitialCheckpoint(f.branch.id,source.id),/injected saver failure/);
 assert.equal(f.branches.execution(source.id).state,'canceled');
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_initial_checkpoints').get().n,0);
 f.store.sqlite.exec('DROP TRIGGER fail_checkpoint');assert.ok(f.branches.saveInitialCheckpoint(f.branch.id,source.id));
});

test('lineage failure rolls back the new execution without changing source or its checkpoint',t=>{
 const f=fixture(t),{source,checkpoint}=canceled(f);
 f.store.sqlite.exec("CREATE TRIGGER fail_lineage BEFORE INSERT ON branch_initial_rewinds BEGIN SELECT RAISE(ABORT,'injected lineage failure'); END");
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/injected lineage failure/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,1);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_initial_checkpoints').get().n,1);
 assert.equal(f.branches.execution(source.id).state,'canceled');
 f.store.sqlite.exec('DROP TRIGGER fail_lineage');assert.ok(f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'));
});

test('owner mismatch, noncanceled and started sources cannot rewind',async t=>{
 const f=fixture(t),{source,checkpoint}=canceled(f);
 assert.equal(f.branches.initialCheckpoint('another-branch',source.id),undefined);
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,'wrong-execution',checkpoint.id,checkpoint.contentHash,'rewind'),/not found/);
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id+1,checkpoint.contentHash,'rewind'),/not found/);
 const active=f.branches.accept(f.branch.id,'active','active');
 assert.throws(()=>f.branches.saveInitialCheckpoint(f.branch.id,active.id),/never started/);
 f.store.sqlite.prepare("UPDATE branch_executions SET state='queued',cancel_requested=0 WHERE id=?").run(source.id);
 await f.branches.unitSaver.drain();f.branches.advance();f.branches.cancel(source.id);
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/never started/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_initial_rewinds').get().n,0);
});

test('current configuration and deletion fences refuse new rewind while preserving saved source',t=>{
 const f=fixture(t),{source,checkpoint}=canceled(f);
 f.branches.configure(f.branch.id,{...f.branches.configuration(f.branch.id),limits:{maxCallDepth:99,maxLoopIterations:100,maxTraversals:100}},0);
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/pins changed/);
 f.branches.beginDeletion(f.branch.id);assert.equal(f.branches.initialCheckpoint(f.branch.id,source.id),undefined);
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/unavailable/);
});

test('checkpoint and rewind records are immutable; deletion retains audit refusal then removes lineage in FK-safe order',t=>{
 const f=fixture(t),{source,checkpoint}=canceled(f),next=f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind');
 assert.throws(()=>f.store.sqlite.prepare("UPDATE branch_initial_checkpoints SET content_hash='changed'").run(),/immutable/);
 assert.throws(()=>f.store.sqlite.prepare("UPDATE branch_initial_rewinds SET command_key='changed'").run(),/immutable/);
 f.branches.cancel(next.id);assert.throws(()=>f.branches.deleteBranch(f.branch.id),/audit publication/);
 f.branches.publishAudit(()=>{});f.branches.deleteBranch(f.branch.id);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_initial_rewinds').get().n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_initial_checkpoints').get().n,0);
 assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('acceptance replay never invents a checkpoint and no secret binding bytes enter explicit snapshots',t=>{
 const f=fixture(t,{parameters:{private:{type:'secret'}}});
 f.branches.configure(f.branch.id,{...f.branches.configuration(f.branch.id),secretBindings:{private:'opaque-binding-never-copy'}},0);
 const source=f.accept();f.branches.cancel(source.id);const checkpoint=f.branches.saveInitialCheckpoint(f.branch.id,source.id);
 assert.equal(checkpoint.restoreSupported,false);
 const stored=f.store.sqlite.prepare('SELECT snapshot_json FROM branch_initial_checkpoints').get().snapshot_json;
 assert.ok(!stored.includes('opaque-binding-never-copy'));assert.equal(JSON.parse(stored).secretBindingsOmitted,true);
 f.branches.cancel(source.id);assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/unsupported/);
 f.store.sqlite.prepare('DELETE FROM branch_initial_checkpoints WHERE execution_id=?').run(source.id);
 assert.equal(f.accept().id,source.id);assert.equal(f.branches.initialCheckpoint(f.branch.id,source.id),undefined);
});

test('corrupt snapshot and owned version content refuse rewind without creating an execution',t=>{
 const f=fixture(t),{source,checkpoint}=canceled(f);
 f.store.sqlite.prepare("UPDATE branch_versions SET definition_json='{}' WHERE id=?").run(source.versionId);
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/pins failed verification/);
 f.store.sqlite.exec('DROP TRIGGER branch_initial_checkpoint_immutable');
 f.store.sqlite.prepare("UPDATE branch_initial_checkpoints SET content_hash='corrupt'").run();
 assert.throws(()=>f.branches.rewindInitial(f.branch.id,source.id,checkpoint.id,checkpoint.contentHash,'rewind'),/integrity failure/);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,1);
});

test('actual HTTP checkpoint/rewind routes enforce owner scope and exact command shape without dispatch',async t=>{
 const {createRequire}=await import('node:module');const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
 const {registerBranchRoutes}=await import('../../apps/server/dist/routes/branches.js');
 const app=require('fastify')();const f=fixture(t),{source,checkpoint}=canceled(f);let notifications=0;
 registerBranchRoutes(app,{branches:f.branches,store:f.store,installations:{setPublisher(){}},notify(){notifications++;}});
 t.after(()=>app.close());
 const base=`/api/branches/${f.branch.id}/executions/${source.id}`;
 const capture=await app.inject({method:'POST',url:`${base}/initial-checkpoint`,payload:{}});assert.equal(capture.statusCode,200);assert.equal(capture.json().id,checkpoint.id);
 const read=await app.inject({method:'GET',url:`${base}/initial-checkpoint`});assert.equal(read.statusCode,200);assert.equal(read.json().id,checkpoint.id);assert.equal(read.json().input,undefined);
 assert.equal((await app.inject({method:'GET',url:`/api/branches/foreign/executions/${source.id}/initial-checkpoint`})).statusCode,404);
 for(const payload of [null,{checkpointId:String(checkpoint.id),commandKey:'bad'},{checkpointId:checkpoint.id,commandKey:'bad',extra:true}]){
  const response=await app.inject({method:'POST',url:`${base}/rewind-initial`,payload});assert.equal(response.statusCode,409);
 }
 const request={method:'POST',url:`${base}/rewind-initial`,payload:{checkpointId:checkpoint.id,expectedHash:checkpoint.contentHash,commandKey:'http-rewind'}};
 const result=await app.inject(request);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().state,'queued');
 assert.equal((await app.inject(request)).json().id,result.json().id);assert.equal(notifications,2);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_attempts').get().n,0);
});
