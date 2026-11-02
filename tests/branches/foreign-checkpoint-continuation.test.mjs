// Deferred SOURCE ONLY. Actual callers; native Script bodies/provider adapters never run.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,CapabilityPolicyStore,stableJson} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {createServer} from '../../apps/server/dist/app.js';
async function fixture(t,{unknown=false}={}){
 const root=mkdtempSync(path.join(tmpdir(),'foreign-script-cut-')),state=path.join(root,'state'),destination=path.join(root,'destination');mkdirSync(destination);
 let store=new AgentStore(state),app;
 const source=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const definition={schema:'ponderosa.branch.v1',name:'Foreign Script cut',trigger:{kind:'manual'},entry:'prefix',steps:['prefix','suffix'].map(id=>({id,kind:'script',runtime:'node',source:'// inert '+id,cwdRef:'work',timeoutMs:5000})),controls:[],edges:[{id:'next',from:'prefix',to:'suffix',on:'success'}],policy:{maxConcurrentExecutions:4,failure:{action:'stop'}}};
 const branch=source.deploy({chatId:'',idempotencyKey:'foreign-source',definition,bindings:{agents:{},directories:{work:root}}});
 source.configure(branch.id,{...source.configuration(branch.id),checkpointMode:'sync'},0);
 const original=source.accept(branch.id,'source','input');let lease;
 for(let i=0;i<16&&!lease;i++){source.advance();await source.unitSaver.drain();lease=source.claimScript('inert-source');}
 assert.ok(lease);source.settleScript(lease,{failed:false,output:'retained-prefix'});await source.unitSaver.drain();
 source.advance();await source.unitSaver.drain();
 if(unknown){assert.ok(source.claimScript('unknown-source'));await source.unitSaver.drain();}
 const inert=async function*(){throw Error('No provider execution')},adapter={id:'codex',displayName:'Inert fixture',trustedSystemPromptChannel:'developer',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=>'fixture',defaultEffort:()=>'medium',seed:inert,continue:inert};
 const open=()=>{app=createServer({dataDir:state,store,logger:false,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});};open();
 const close=async()=>{app.prepareForShutdown();await app.close();store.close();};t.after(async()=>{await close();rmSync(root,{recursive:true,force:true});});
 const call=(method,url,payload)=>app.inject({method,url,...(payload===undefined?{}:{payload})});
 const api=async(method,url,payload)=>{const r=await call(method,url,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
 const pkg=await api('GET',`/api/branches/${branch.id}/package?mode=full&includeValues=true`);
 const preview=await api('POST','/api/branches/install-preview',{package:pkg,bindings:{agents:{},directories:{work:destination}}});
 let done=await api('POST',`/api/branches/installations/${preview.id}/confirm`,{acknowledgeFullImport:true,acknowledgeRuntimeDataSha256:pkg.runtimeData.sha256});
 for(let i=0;i<12&&done.state==='applying';i++)done=await api('POST',`/api/branches/installations/${preview.id}/confirm`,{});
 assert.equal(done.state,'completed',done.error);
 const saved=await api('GET',`/api/branches/installations/${preview.id}/runtime-data?branchId=${done.branchId}`),imported=saved.receipt.executionMap[original.id];
 if(!unknown)assert.equal(saved.receipt.frontiers[original.id].disposition,'recreated_held',saved.receipt.frontiers[original.id].reason);
 const fact=saved.data.owners[0].facts.filter(f=>f.kind==='checkpoint').reverse().find(f=>{const c=JSON.parse(f.json);return c.restore_supported===true&&c.selected?.steps.some(s=>s.step_id==='prefix'&&s.state==='completed');});assert.ok(fact);
 const selection={planId:preview.id,sourceExecutionId:original.id,checkpointKey:fact.key,checkpointSha256:fact.sha256};
 const url=`/api/branches/${done.branchId}/executions/${imported}/foreign-continuation`;
 const settings=await api('GET',`/api/branches/${done.branchId}/settings`);
 await api('PUT',`/api/branches/${done.branchId}/settings`,{revision:settings.revision,configuration:{...settings.configuration,checkpointMode:'sync'}});
 await api('PUT',`/api/branches/${done.branchId}/availability`,{enabled:true});
 return {api,call,url,selection,done,saved,original,imported,destination,get store(){return store},async reopen(){await close();store=new AgentStore(state);open();},async review(){return api('POST',url+'/review',selection);},async confirm(review,key='continue'){return api('POST',url,{...selection,commandKey:key,reviewSha256:review.reviewSha256,acceptCurrentAuthority:true});}};
}
test('import -> human review -> fresh acceptance/admission -> selected suffix -> original-key receipt/replay/restart',async t=>{
 const f=await fixture(t),before=f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(f.imported),review=await f.review();
 assert.equal(review.custody,'not_applicable');assert.equal(review.engine,'node');assert.equal(review.accessChoice,'current_destination');assert.equal(review.directoryChoices.work.realpath,f.destination);assert.deepEqual(review.nativeMaps,f.saved.receipt);
 const rejected=await f.call('POST',f.url,{...f.selection,commandKey:'unreviewed',reviewSha256:review.reviewSha256});assert.equal(rejected.statusCode,409);
 await f.reopen();const receipt=await f.confirm(review);
 assert.notEqual(receipt.executionId,f.imported);assert.equal(receipt.admission.kind,'manual');assert.equal(receipt.admission.budget.used,review.budget.used);assert.equal(receipt.admission.revision,review.budget.revision);
 const accepted=f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(receipt.executionId);assert.ok(accepted.admitted_at);assert.equal(accepted.admission_source,'manual');assert.equal(accepted.state,'running');assert.equal(accepted.version_id,review.versionId);assert.equal(accepted.binding_revision_id,review.bindingRevisionId);
 assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(f.imported),before);
 const prefix=f.store.sqlite.prepare("SELECT s.*,a.fence,a.request_id FROM branch_step_executions s JOIN branch_attempts a ON a.step_execution_id=s.id WHERE s.execution_id=? AND s.step_id='prefix'").get(receipt.executionId);assert.equal(prefix.state,'completed');assert.equal(prefix.fence,0);assert.equal(prefix.request_id,null);assert.equal(JSON.parse(prefix.result_json).output,'retained-prefix');
 assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_checkpoints WHERE execution_id=? AND kind='script_leased'").get(receipt.executionId).n,0);
 assert.deepEqual(await f.api('GET',f.url+'?commandKey=continue'),receipt);await f.reopen();assert.deepEqual(await f.confirm(review),receipt);
 const driver=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));driver.setEnabled(f.original.branchId,false);driver.advance();await driver.unitSaver.drain();const suffix=driver.claimScript('inert-suffix');assert.equal(suffix.executionId,receipt.executionId);assert.equal(suffix.cwd,f.destination);assert.equal(f.store.sqlite.prepare('SELECT step_id FROM branch_step_executions WHERE id=(SELECT step_execution_id FROM branch_attempts WHERE id=?)').get(suffix.attemptId).step_id,'suffix');
 driver.settleScript(suffix,{failed:false,output:'continued-suffix'});driver.advance();await driver.unitSaver.drain();assert.equal(driver.execution(receipt.executionId).state,'completed');assert.deepEqual(await f.api('GET',f.url+'?commandKey=continue'),receipt);
});
test('stale current budget, policy and directory choices refuse without acceptance',async t=>{
 const f=await fixture(t),review=await f.review(),count=()=>f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions WHERE branch_id=?').get(f.done.branchId).n,before=count();
 const b=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));b.updateExecutionBudget(f.done.branchId,{commandKey:'policy',expectedRevision:review.budget.revision,expectedPeriodId:review.budget.periodId,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true});
 let r=await f.call('POST',f.url,{...f.selection,commandKey:'stale-budget',reviewSha256:review.reviewSha256,acceptCurrentAuthority:true});assert.equal(r.statusCode,409);assert.equal(count(),before);
 const current=await f.review(),policies=new CapabilityPolicyStore(f.store.sqlite);policies.put({scopeKind:'branch',scopeId:f.done.branchId,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.scripts]});
 r=await f.call('POST',f.url,{...f.selection,commandKey:'stale-policy',reviewSha256:current.reviewSha256,acceptCurrentAuthority:true});assert.equal(r.statusCode,409);assert.equal(count(),before);
 policies.put({scopeKind:'branch',scopeId:f.done.branchId,expectedRevision:1,restrictedCapabilityIds:[]});const directoryReview=await f.review();rmSync(f.destination,{recursive:true});
 r=await f.call('POST',f.url,{...f.selection,commandKey:'missing-directory',reviewSha256:directoryReview.reviewSha256,acceptCurrentAuthority:true});assert.equal(r.statusCode,409);assert.equal(count(),before);
});
test('unknown source outcome/custody stays held even with an older effect-free saved cut',async t=>{
 const f=await fixture(t,{unknown:true}),before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions WHERE branch_id=?').get(f.done.branchId).n;
 const r=await f.call('POST',f.url+'/review',f.selection);assert.equal(r.statusCode,409);assert.match(r.json().error,/unknown|custody/);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions WHERE branch_id=?').get(f.done.branchId).n,before);assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(f.imported).admitted_at,null);
});
test('last receipt failure atomically rolls back fresh acceptance, budget/admission and every frontier row',async t=>{
 const f=await fixture(t),review=await f.review(),before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,budget=f.store.sqlite.prepare('SELECT * FROM branch_execution_budgets WHERE branch_id=?').get(f.done.branchId);
 f.store.sqlite.exec("CREATE TEMP TRIGGER foreign_last_receipt BEFORE INSERT ON branch_commands WHEN NEW.command_key LIKE 'foreign-continuation:%' BEGIN SELECT RAISE(ABORT,'last-foreign-receipt'); END");
 const payload={...f.selection,commandKey:'atomic',reviewSha256:review.reviewSha256,acceptCurrentAuthority:true},failed=await f.call('POST',f.url,payload);assert.equal(failed.statusCode,409);assert.match(failed.json().error,/last-foreign-receipt/);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,before);assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM branch_execution_budgets WHERE branch_id=?').get(f.done.branchId),budget);assert.equal((await f.call('GET',f.url+'?commandKey=atomic')).statusCode,404);
 f.store.sqlite.exec('DROP TRIGGER foreign_last_receipt');const done=await f.api('POST',f.url,payload);assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,before+1);assert.deepEqual(await f.api('POST',f.url,payload),done);
});

test('current imported native uncertainty refuses fresh authority and a changed original command conflicts',async t=>{
 const f=await fixture(t),review=await f.review(),attempt=f.store.sqlite.prepare('SELECT a.id FROM branch_attempts a JOIN branch_step_executions s ON s.id=a.step_execution_id WHERE s.execution_id=? LIMIT 1').get(f.imported);assert.ok(attempt);
 f.store.sqlite.prepare('UPDATE branch_attempts SET lease_owner=? WHERE id=?').run('unobserved-current-owner',attempt.id);
 let r=await f.call('POST',f.url,{...f.selection,commandKey:'current-unknown',reviewSha256:review.reviewSha256,acceptCurrentAuthority:true});assert.equal(r.statusCode,409);assert.match(r.json().error,/authority|provenance/);
 assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(f.imported).admitted_at,null);
 f.store.sqlite.prepare('UPDATE branch_attempts SET lease_owner=NULL WHERE id=?').run(attempt.id);
 const receipt=await f.confirm(review,'one-command');r=await f.call('POST',f.url,{...f.selection,commandKey:'one-command',reviewSha256:'0'.repeat(64),acceptCurrentAuthority:true});assert.equal(r.statusCode,409);assert.deepEqual(await f.api('GET',f.url+'?commandKey=one-command'),receipt);
});
