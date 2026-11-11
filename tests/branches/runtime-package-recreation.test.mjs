// Deferred source fixture. Provider, native Script and browser adapters never execute here.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,captureBranchRuntimeData,validateBranchRuntimeData,stableJson} from '@ponderosa/agents';
import {BranchInstallationService} from '../../apps/server/dist/branch-installation-service.js';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:stableJson(v)).digest('hex');
function fixture(t,mode){
 const root=mkdtempSync(path.join(tmpdir(),'runtime-package-'));let store,branches;
 const open=()=>{store=new AgentStore(root);branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));};open();
 t.after(async()=>{await branches.unitSaver.drain().catch(()=>{});store.close();rmSync(root,{recursive:true,force:true});});
 const project=store.createProject({label:'Runtime data',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Source'});
 const definition={schema:'ponderosa.branch.v1',name:'Portable runtime',trigger:{kind:'manual'},entry:'a',steps:['a','b'].map(id=>({id,kind:'script',runtime:'node',source:'// inert '+id,cwdRef:'root',timeoutMs:5000})),controls:[],edges:[{id:'next',from:'a',to:'b',on:'success'}],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}};
 const source=branches.deploy({chatId:chat.id,idempotencyKey:'source',definition,bindings:{agents:{},directories:{root}}});branches.configure(source.id,{...branches.configuration(source.id),checkpointMode:mode},0);
 const execution=branches.accept(source.id,'manual-source','input');
 const service=()=>{const s=new BranchInstallationService(store,branches,async()=>{throw Error('Unexpected delete')},async()=>{throw Error('Unexpected delete')},async(input,key,owner)=>{const project=store.createProject({label:input.label,hostPath:input.hostPath,defaultEngine:input.defaultEngine}),chat=store.getConversation(project.lastConversationId);store.sqlite.prepare('UPDATE conversations SET branch_id=? WHERE id=?').run(owner.branchId,chat.id);return store.getConversation(chat.id);});s.setEngine({exportAgent:async()=>{throw Error('No Agent in this fixture')},readCheckpoint:async()=>{throw Error('No custody in this fixture')},validateAgent(){}});s.setPublisher((input,configuration)=>branches.deploy(input,undefined,undefined,configuration));return s;};
 return {root,source,execution,definition,get store(){return store},get branches(){return branches},service,async prefix(){let lease;for(let n=0;n<16&&!lease;n++){await branches.unitSaver.drain();branches.advance();lease=branches.claimScript('inert');}assert.ok(lease);branches.settleScript(lease,{failed:false,output:'sealed-prefix'});await branches.unitSaver.drain();},async reopen(){await branches.unitSaver.drain();store.close();open();}};
}
for(const mode of ['async','sync'])test(`full runtime data ${mode}: actual export -> reviewed new install -> held remap -> lost response -> restart`,async t=>{
 const f=fixture(t,mode);await f.prefix();
 const sourceData=captureBranchRuntimeData(f.store.sqlite,f.source.id,{},{});assert.ok(sourceData.owners[0].facts.some(v=>v.kind==='checkpoint'));
 const service=f.service(),pkg=await service.export(f.source.id,'full');assert.deepEqual(pkg.runtimeData,sourceData);assert.equal((await service.export(f.source.id,'template')).runtimeData,undefined);
 f.branches.cancel(f.execution.id);await f.branches.unitSaver.drain();
 const preview=await service.preview(pkg,{agents:{},directories:{root:f.root}});assert.equal(preview.runtimeDataReview.manifestSha256,pkg.runtimeData.sha256);
 await assert.rejects(service.confirm(preview.id,true),/exact runtime manifest hash/);
 const done=await service.confirm(preview.id,true,undefined,false,preview.runtimeDataReview.manifestSha256);assert.equal(done.state,'completed',done.error);
 const read=service.runtimeData(preview.id,done.branchId),receipt=read.receipt,target=receipt.executionMap[f.execution.id];
 assert.equal(receipt.disposition,'held');assert.equal(receipt.currentAuthority,false);assert.equal(receipt.dispatched,false);assert.equal(f.branches.getBranch(done.branchId).enabled,false);
 assert.notEqual(target,f.execution.id);assert.equal(receipt.frontiers[f.execution.id].disposition,'recreated_held');
 const detail=f.branches.detail(target);assert.equal(detail.steps.length,1);assert.equal(detail.steps[0].result.output,'sealed-prefix');assert.equal(detail.attempts[0].fence,0);assert.equal(detail.attempts[0].leaseOwner,undefined);
 assert.equal(f.branches.execution(target).runtimeData.held,true);
 assert.throws(()=>f.branches.intervene(target,{action:'retry',commandKey:'cannot-run',reason:'No import authority',expectedRevision:f.branches.execution(target).revision}),/no execution authority/);
 f.branches.setEnabled(done.branchId,true);f.branches.advance();assert.equal(f.branches.claimScript('import-cannot-run'),undefined);
 assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(target).admitted_at,null);
 assert.deepEqual(service.runtimeData(preview.id,done.branchId),read);await f.reopen();assert.deepEqual(f.service().runtimeData(preview.id,done.branchId),read);
 const stored=f.store.sqlite.prepare("SELECT result_json FROM branch_commands WHERE execution_id=? AND command_key LIKE 'portable-runtime-manifest:%'").get(target);const altered=JSON.parse(stored.result_json);altered.receipt.executionMap[f.execution.id]='foreign';f.store.sqlite.prepare("UPDATE branch_commands SET result_json=? WHERE execution_id=? AND command_key LIKE 'portable-runtime-manifest:%'").run(stableJson(altered),target);
 assert.throws(()=>f.service().runtimeData(preview.id,done.branchId),/integrity failure/);
});
test('runtime manifest rejects changed bytes, omitted pins, aliased owners and embedded credential bindings',async t=>{
 const f=fixture(t,'sync');await f.prefix();const original=captureBranchRuntimeData(f.store.sqlite,f.source.id,{},{});
 for(const edit of [d=>d.owners[0].facts[0].json+=' ',d=>d.owners[0].facts=d.owners[0].facts.filter(v=>v.kind!=='definition'),d=>d.owners.push(structuredClone(d.owners[0])),d=>{const p=d.owners[0].facts.find(v=>v.kind==='provenance');p.json=stableJson({secretBindings:{private:'never portable'}});p.sha256=hash(p.json);}]){
  const d=structuredClone(original);edit(d);for(const o of d.owners)o.sha256=hash({sourceExecutionId:o.sourceExecutionId,sourceBranchId:o.sourceBranchId,chatRefs:o.chatRefs,facts:o.facts});d.sha256=hash({schema:d.schema,sourceBranchId:d.sourceBranchId,identities:d.identities,owners:d.owners});
  assert.throws(()=>validateBranchRuntimeData(d));
 }
});
test('a currently leased source is retained as explicit evidence-only data without copying native leases',async t=>{
 const f=fixture(t,'sync');await f.prefix();let lease;for(let n=0;n<16&&!lease;n++){f.branches.advance();lease=f.branches.claimScript('inert-unknown');await f.branches.unitSaver.drain();}assert.ok(lease);
 const pkg=await f.service().export(f.source.id,'full'),api=f.service(),preview=await api.preview(pkg,{agents:{},directories:{root:f.root}}),done=await api.confirm(preview.id,true,undefined,false,pkg.runtimeData.sha256);
 const saved=api.runtimeData(preview.id,done.branchId),target=saved.receipt.executionMap[f.execution.id];assert.equal(saved.receipt.frontiers[f.execution.id].disposition,'evidence_only');assert.equal(saved.receipt.disposition,'held');assert.equal(f.branches.detail(target).attempts.length,0);
 const sourceAttempt=JSON.parse(saved.data.owners[0].facts.find(v=>v.kind==='frontier').json).attempts.find(a=>a.id===lease.attemptId);assert.equal(sourceAttempt.state,'leased');assert.equal(Object.hasOwn(sourceAttempt,'lease_owner'),false);assert.equal(Object.hasOwn(sourceAttempt,'process_identity_json'),false);
});

test('execution-owned Chat has fresh native ownership and exact source identity mapping',async t=>{
 const f=fixture(t,'sync');await f.prefix();
 const project=f.store.createProject({label:'Execution Chat',hostPath:f.root,defaultEngine:'codex'}),chat=f.store.getConversation(project.lastConversationId);
 f.store.sqlite.prepare('UPDATE conversations SET branch_id=?,branch_execution_id=? WHERE id=?').run(f.source.id,f.execution.id,chat.id);
 const api=f.service(),pkg=await api.export(f.source.id,'full');assert.equal(pkg.chats.length,1);assert.equal(pkg.chats[0].executionRef,f.execution.id);
 const preview=await api.preview(pkg,{agents:{},directories:{root:f.root,workspace:f.root}}),done=await api.confirm(preview.id,true,undefined,false,pkg.runtimeData.sha256),read=api.runtimeData(preview.id,done.branchId);
 const freshChat=read.receipt.chatMap[chat.id],freshExecution=read.receipt.executionMap[f.execution.id];assert.notEqual(freshChat,chat.id);
 assert.deepEqual(f.store.sqlite.prepare('SELECT branch_id,branch_execution_id FROM conversations WHERE id=?').get(freshChat),{branch_id:done.branchId,branch_execution_id:freshExecution});
 assert.equal(f.store.sqlite.prepare('SELECT branch_execution_id FROM conversations WHERE id=?').get(chat.id).branch_execution_id,f.execution.id);
 assert.deepEqual(read.data,pkg.runtimeData);await f.reopen();assert.deepEqual(f.service().runtimeData(preview.id,done.branchId).receipt,read.receipt);
});
test('a failure at the final manifest insert rolls back definition publication, all owners and native frontiers',async t=>{
 const f=fixture(t,'sync');await f.prefix();const api=f.service(),pkg=await api.export(f.source.id,'full'),preview=await api.preview(pkg,{agents:{},directories:{root:f.root}});
 f.store.sqlite.exec("CREATE TEMP TRIGGER reject_runtime_manifest BEFORE INSERT ON branch_commands WHEN NEW.command_key LIKE 'portable-runtime-manifest:%' BEGIN SELECT RAISE(ABORT,'fixture last manifest failure'); END");
 const done=await api.confirm(preview.id,true,undefined,false,pkg.runtimeData.sha256);assert.notEqual(done.state,'completed');assert.match(done.error,/last manifest failure/);
 assert.equal(f.branches.getBranch(done.branchId).versionId,'');assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(done.branchId).n,0);assert.equal(api.runtimeData(preview.id,done.branchId),undefined);
});

// Deferred: real composer roundtrip, not a forged acceptance or foreign SQLite copy.
test('re-export keeps original private manifest and imports again without acceptance',async t=>{
 const f=fixture(t,'sync');await f.prefix();const api=f.service();
 const original=await api.export(f.source.id,'full');
 const first=await api.preview(original,{agents:{},directories:{root:f.root}});
 const done=await api.confirm(first.id,true,undefined,false,original.runtimeData.sha256);
 const exported=await api.export(done.branchId,'full');
 const origin=JSON.parse(exported.runtimeData.owners[0].facts.find(f=>f.kind==='import').json);
 assert.deepEqual(origin.data,original.runtimeData);assert.equal(origin.receipt.currentAuthority,false);
 assert.equal(origin.receipt.executionMap[f.execution.id],exported.runtimeData.owners[0].sourceExecutionId);
 const second=await api.preview(exported,{agents:{},directories:{root:f.root}});
 const again=await api.confirm(second.id,true,undefined,false,exported.runtimeData.sha256);
 assert.equal(again.state,'completed',again.error);
 const saved=api.runtimeData(second.id,again.branchId);
 assert.deepEqual(saved.data,exported.runtimeData);assert.equal(saved.receipt.dispatched,false);
 for(const id of Object.values(saved.receipt.executionMap))assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(id).admitted_at,null);
 await f.reopen();assert.deepEqual(f.service().runtimeData(second.id,again.branchId),saved);
});
test('automatic occurrence data retains its original hash and trigger identity without fresh trigger admission',async t=>{
 const f=fixture(t,'sync');
 // Contract fixture: input_hash is the trigger envelope hash, not the manual-input hash.
 const occurrence='source-occurrence',inputHash=hash({payload:'original event'});
 f.store.sqlite.prepare("UPDATE branch_executions SET admission_source='automatic',occurrence_key=?,input_hash=?,provenance_json=? WHERE id=?").run(`trigger:${occurrence}`,inputHash,stableJson({source:'trigger',occurrenceId:occurrence,contentInjected:false}),f.execution.id);
 const api=f.service(),pkg=await api.export(f.source.id,'full');
 assert.equal(JSON.parse(pkg.runtimeData.owners[0].facts.find(f=>f.kind==='frontier').json).execution[0].input_hash,inputHash);
 const preview=await api.preview(pkg,{agents:{},directories:{root:f.root}}),done=await api.confirm(preview.id,true,undefined,false,pkg.runtimeData.sha256);
 assert.equal(done.state,'completed',done.error);const saved=api.runtimeData(preview.id,done.branchId);
 assert.equal(saved.receipt.dispatched,false);assert.equal(f.branches.execution(saved.receipt.executionMap[f.execution.id]).admissionSource,undefined);
 f.store.sqlite.prepare("UPDATE branch_executions SET occurrence_key='wrong-occurrence' WHERE id=?").run(f.execution.id);
 await assert.rejects(api.export(f.source.id,'full'),/occurrence provenance/);
});
