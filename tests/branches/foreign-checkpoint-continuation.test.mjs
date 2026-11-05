// Deferred SOURCE ONLY. Actual callers; native Script bodies/provider adapters never run.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore,BranchStore,CoordinationV3Store,CapabilityPolicyStore,stableJson} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {createServer} from '../../apps/server/dist/app.js';
async function fixture(t,{unknown=false}={}){
 const root=mkdtempSync(path.join(tmpdir(),'foreign-script-cut-')),state=path.join(root,'state'),sourceState=path.join(root,'source-state'),destination=path.join(root,'destination');mkdirSync(destination);
 let activeState=sourceState,store=new AgentStore(activeState),app;
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
 const open=()=>{app=createServer({dataDir:activeState,store,logger:false,startDrained:true,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});};open();
 const close=async()=>{app.prepareForShutdown();await app.close();store.close();};t.after(async()=>{await close();rmSync(root,{recursive:true,force:true});});
 const call=(method,url,payload)=>app.inject({method,url,...(payload===undefined?{}:{payload})});
 const api=async(method,url,payload)=>{const r=await call(method,url,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
 const pkg=await api('GET',`/api/branches/${branch.id}/package?mode=full&includeValues=true`);
 const exported=JSON.parse(pkg.runtimeData.owners[0].facts.find(f=>f.kind==='frontier').json);
 assert.equal(pkg.runtimeData.owners[0].facts.filter(f=>f.kind==='transition').some(f=>JSON.parse(f.json).kind==='script_authorized'),false);
 if(!unknown){assert.ok(exported.steps.some(s=>s.step_id==='prefix'&&s.state==='completed'));assert.equal(exported.attempts.some(a=>['leased','running','outcome_unknown'].includes(a.state)||a.request_id||a.recovery_of_request_id||a.runtime_outcome_json),false);assert.equal(exported.resources.length,0);assert.equal(exported.actions.length,0);}
 // Export under drained admission; the receiving server owns no original runnable suffix.
 await close();activeState=state;store=new AgentStore(activeState);open();
 assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM branch_executions').get().n,0);
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
 return {api,call,url,selection,done,saved,original,imported,destination,get store(){return store},async reopen(){await close();store=new AgentStore(activeState);open();},async review(){return api('POST',url+'/review',selection);},async confirm(review,key='continue'){return api('POST',url,{...selection,commandKey:key,reviewSha256:review.reviewSha256,acceptCurrentAuthority:true});}};
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
 const driver=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));assert.equal(driver.getBranch(f.original.branchId),undefined);driver.advance();await driver.unitSaver.drain();const suffix=driver.claimScript('inert-suffix');assert.equal(suffix.executionId,receipt.executionId);assert.equal(suffix.cwd,f.destination);assert.equal(f.store.sqlite.prepare('SELECT step_id FROM branch_step_executions WHERE id=(SELECT step_execution_id FROM branch_attempts WHERE id=?)').get(suffix.attemptId).step_id,'suffix');
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

// The source is a real canceled-before-admission owner; only the fresh synthetic
// fixture data root is touched and the provider is never allowed to execute.
async function h2BeforeEntryFixture(t,{separate=false,forge=false}={}){
 const root=mkdtempSync(path.join(tmpdir(),'h2-before-entry-'));
 const sourceState=path.join(root,'source'),destinationState=path.join(root,'destination');
 mkdirSync(sourceState);mkdirSync(destinationState);
 let activeState=sourceState,store=new AgentStore(activeState),app,passed=false;
 const inert=async function*(){throw Error('No provider execution is allowed');};
 const adapter={id:'codex',displayName:'Inert H2',trustedSystemPromptChannel:'developer',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=> 'fixture',defaultEffort:()=> 'medium',seed:inert,continue:inert};
 const open=async()=>{app=createServer({dataDir:activeState,store,logger:false,startDrained:true,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});await app.ready();};
 const close=async()=>{if(app){app.prepareForShutdown();await app.close();app=undefined;}store.close();};
 t.after(async()=>{await close();if(passed)rmSync(root,{recursive:true,force:true});else t.diagnostic('Retained synthetic fixture: '+root);});
 await open();
 const call=(method,url,payload)=>app.inject({method,url,headers:{'idempotency-key':randomUUID()},...(payload===undefined?{}:{payload})});
 const api=async(method,url,payload)=>{const response=await call(method,url,payload);assert.equal(response.statusCode,200,response.body);return response.json();};
 const owner=await api('POST','/api/branches',{name:'H2 source',idempotencyKey:randomUUID()});
 const chat=await api('POST',`/api/branches/${owner.id}/chats`,{label:'H2 source Chat',defaultEngine:'codex'});
 const agent=await api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:'H2 source Agent',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()});
 new CapabilityPolicyStore(store.sqlite).put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]});
 const definition={schema:'ponderosa.branch.v1',name:'H2 source',trigger:{kind:'manual'},entry:'steer',controls:[],
  steps:[{id:'steer',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Synthetic guidance',jobHandling:'steer'},
   {id:'copy',kind:'agent',target:{kind:'persistent_agent',ref:'worker'},instructions:'Synthetic copy',jobHandling:'copy'}],
  edges:[{id:'next',from:'steer',to:'copy',on:'success',input:{kind:'literal',text:'Synthetic copy input'}}],
  policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
 await api('POST','/api/branches/deploy',{chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:randomUUID(),definition,bindings:{agents:{worker:agent.id},directories:{}}});
 const sourceStore=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const original=sourceStore.accept(owner.id,'h2-original','Original objective');sourceStore.cancel(original.id);
 await sourceStore.unitSaver.drain();
 const sourceRow=store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(original.id);
 assert.equal(sourceRow.state,'canceled');assert.equal(sourceRow.admitted_at,null);assert.equal(sourceRow.admission_json,null);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branch_initial_checkpoints WHERE execution_id=?').get(original.id).n,0,'no manual initial checkpoint');
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM branch_step_executions WHERE execution_id=?').get(original.id).n,0);
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,0);
 const pkg=await api('GET',`/api/branches/${owner.id}/package?mode=full&includeValues=true`);
 if(forge){
  const ownerFact=pkg.runtimeData.owners.find(item=>item.sourceExecutionId===original.id),frontier=ownerFact.facts.find(item=>item.kind==='frontier');
  const selected=JSON.parse(frontier.json),altered='Forged input',inputHash=h2Hash({input:altered,source:'manual'});
  selected.execution[0].input_text=altered;selected.execution[0].input_hash=inputHash;
  frontier.json=stableJson(selected);frontier.sha256=h2Hash(frontier.json);
  for(const fact of ownerFact.facts.filter(item=>item.kind==='transition')){
   const transition=JSON.parse(fact.json);
   if(transition.kind==='trigger_accepted'){
    const evidence=JSON.parse(transition.evidence_json);evidence.inputHash=inputHash;
    transition.evidence_json=stableJson(evidence);fact.json=stableJson(transition);fact.sha256=h2Hash(fact.json);
   }
  }
  ownerFact.sha256=h2Hash({sourceExecutionId:ownerFact.sourceExecutionId,sourceBranchId:ownerFact.sourceBranchId,chatRefs:ownerFact.chatRefs,facts:ownerFact.facts});
  const data=pkg.runtimeData;data.sha256=h2Hash({schema:data.schema,sourceBranchId:data.sourceBranchId,identities:data.identities,owners:data.owners});
 }
 if(separate){await close();activeState=destinationState;store=new AgentStore(activeState);await open();}
 const preview=await api('POST','/api/branches/install-preview',{package:pkg,bindings:{agents:{},directories:{workspace:root},engines:{codex:'codex'}}});
 const installation=`/api/branches/installations/${preview.id}`;
 let result=await api('POST',installation+'/confirm',{acknowledgeFullImport:true,acknowledgeRuntimeDataSha256:pkg.runtimeData.sha256}),reviewed=false;
 for(let i=0;i<20&&result.state==='applying';i++){
  const pending=(await api('GET',installation)).accessSettingsReview;
  if(pending){
   const choices=Object.fromEntries((pending.review.source??[]).filter(item=>item.settings).map(item=>[item.ref,'keep_destination']));
   await api('POST',installation+'/access-review',{chatRef:pending.chatRef,agentRef:pending.agentRef,resolution:{action:'keep_destination',reviewSha256:pending.review.reviewSha256,agentActions:choices}});reviewed=true;
  }
  result=await api('POST',installation+'/confirm',{});
 }
 assert.equal(result.state,'completed',result.error);assert.equal(reviewed,true,'source Agent access requires an explicit choice');
 const saved=await api('GET',installation+`/runtime-data?branchId=${result.branchId}`),imported=saved.receipt.executionMap[original.id];
 assert.equal(saved.receipt.frontiers[original.id].disposition,'evidence_only');
 const fact=saved.data.owners.find(item=>item.sourceExecutionId===original.id).facts.find(item=>item.kind==='frontier'&&item.key==='current');
 assert.ok(fact);assert.equal(JSON.parse(fact.json).execution[0].state,'canceled');
 const destinationAgent=saved.receipt.agentMap[agent.id];assert.ok(destinationAgent);
 assert.equal(new CapabilityPolicyStore(store.sqlite).resolveForAgent(destinationAgent).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryWrite),false,'keep destination does not inherit source access');
 await api('PUT',`/api/branches/${result.branchId}/availability`,{enabled:true});
 const selection={planId:preview.id,sourceExecutionId:original.id,checkpointKey:'current',checkpointSha256:fact.sha256};
 const url=`/api/branches/${result.branchId}/executions/${imported}/foreign-continuation`;
 return {root,owner,agent,original,sourceRow,pkg,preview,result,saved,imported,destinationAgent,selection,url,api,call,get store(){return store;},
  async reopen(){await close();store=new AgentStore(activeState);await open();},
  async review(){return api('POST',url+'/review',selection);},
  async confirm(review,key='h2-once'){return api('POST',url,{...selection,commandKey:key,reviewSha256:review.reviewSha256,acceptCurrentAuthority:true});},
  done(){passed=true;}};
}
const h2Hash=value=>createHash('sha256').update(typeof value==='string'?value:stableJson(value)).digest('hex');

test('same-root before-entry import reviews live source and accepts one fresh destination without replay',{timeout:60000},async t=>{
 const f=await h2BeforeEntryFixture(t),count=()=>f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n;
 const before=count(),held=f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(f.imported),review=await f.review();
 assert.deepEqual(review.beforeEntry,{sourceBranchId:f.owner.id,sourceExecutionId:f.original.id,sourceFrontierSha256:f.selection.checkpointSha256});
 assert.equal(review.engine,'current_destination');assert.equal(review.accessChoice,'current_destination');assert.equal(review.bindings.agents.worker,f.destinationAgent);
 const noConsent=await f.call('POST',f.url,{...f.selection,commandKey:'not-authorized',reviewSha256:review.reviewSha256});assert.equal(noConsent.statusCode,409);assert.equal(count(),before);
 await f.reopen();const receipt=await f.confirm(review);
 assert.equal(receipt.admission,null);assert.deepEqual(receipt.idMap,{});assert.notEqual(receipt.executionId,f.imported);assert.equal(count(),before+1);
 assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(receipt.executionId).admitted_at,null,'fresh execution is normally queued, not a copied admission');
 assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(f.imported),held);
 assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM branch_executions WHERE id=?').get(f.original.id),f.sourceRow,'original source remains unchanged');
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_step_executions WHERE execution_id=?').get(f.original.id).n,0);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM coordination_requests').get().n,0);
 assert.deepEqual(await f.confirm(review),receipt);assert.deepEqual(await f.api('GET',f.url+'?commandKey=h2-once'),receipt);
 const exported=await f.api('GET',`/api/branches/${f.result.branchId}/package?mode=full&includeValues=true`);
 assert.ok(exported.runtimeData.owners.some(owner=>owner.sourceExecutionId===f.imported),'held owner remains in re-export');
 assert.ok(exported.runtimeData.owners.some(owner=>owner.sourceExecutionId===receipt.executionId),'fresh owner remains in re-export');
 // A later unavailable source cannot make an already accepted receipt vanish or replay.
 f.store.sqlite.prepare('UPDATE branches SET deleting=1 WHERE id=?').run(f.owner.id);
 await f.reopen();assert.deepEqual(await f.api('GET',f.url+'?commandKey=h2-once'),receipt);assert.equal(count(),before+1);
 f.done();
});

test('before-entry review holds an independently rehashed forged source and a separate installation',{timeout:60000},async t=>{
 for(const options of [{forge:true},{separate:true}]){
  const f=await h2BeforeEntryFixture(t,options),before=f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n;
  const result=await f.call('POST',f.url+'/review',f.selection);
  assert.equal(result.statusCode,409,result.body);assert.match(result.json().error,/source|frontier|changed|evidence/i);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n,before);
  assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(f.imported).admitted_at,null);
  f.done();
 }
});

test('before-entry acceptance rechecks source, Agent policy and reviewed destination',{timeout:60000},async t=>{
 const f=await h2BeforeEntryFixture(t),before=f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n;
 const command=(review,key)=>({...f.selection,commandKey:key,reviewSha256:review.reviewSha256,acceptCurrentAuthority:true});
 const first=await f.review();
 f.store.sqlite.prepare('UPDATE branch_executions SET admission_json=? WHERE id=?').run('{}',f.original.id);
 let result=await f.call('POST',f.url,command(first,'source-changed'));assert.equal(result.statusCode,409);assert.match(result.json().error,/source|admission|changed|evidence/i);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n,before);
 f.store.sqlite.prepare('UPDATE branch_executions SET admission_json=NULL WHERE id=?').run(f.original.id);
 const unknownReview=await f.review();
 f.store.sqlite.prepare("UPDATE branch_executions SET state=?,wait_reason=?,cancel_requested=0 WHERE id=?").run("waiting","Uncertain provider outcome",f.original.id);
 result=await f.call("POST",f.url,command(unknownReview,"source-unknown"));assert.equal(result.statusCode,409);assert.match(result.json().error,/source|frontier|changed|evidence/i);
 f.store.sqlite.prepare("UPDATE branch_executions SET state=?,wait_reason=?,cancel_requested=? WHERE id=?").run(f.sourceRow.state,f.sourceRow.wait_reason,f.sourceRow.cancel_requested,f.original.id);
 assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM branch_executions WHERE branch_id=?").get(f.result.branchId).n,before);
 const durabilityReview=await f.review(),invocation=JSON.parse(f.sourceRow.checkpoint_invocation_json);
 invocation.durability="failed";
 f.store.sqlite.prepare("UPDATE branch_executions SET checkpoint_invocation_json=? WHERE id=?").run(stableJson(invocation),f.original.id);
 result=await f.call("POST",f.url,command(durabilityReview,"source-durability-failed"));assert.equal(result.statusCode,409);assert.match(result.json().error,/source|durability|changed|evidence/i);
 f.store.sqlite.prepare("UPDATE branch_executions SET checkpoint_invocation_json=? WHERE id=?").run(f.sourceRow.checkpoint_invocation_json,f.original.id);
 assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM branch_executions WHERE branch_id=?").get(f.result.branchId).n,before);
 const second=await f.review();
 new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'agent',scopeId:f.destinationAgent,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]});
 result=await f.call('POST',f.url,command(second,'policy-changed'));assert.equal(result.statusCode,409);assert.match(result.json().error,/review|authority|changed|stale/i);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n,before);
 const third=await f.review(),speed=f.store.getAgent(f.destinationAgent).speed;
 f.store.updateAgent(f.destinationAgent,{speed:speed==="fast"?"standard":"fast"});
 result=await f.call('POST',f.url,command(third,'speed-changed'));assert.equal(result.statusCode,409);assert.match(result.json().error,/review|authority|changed|stale/i);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n,before);
 assert.equal(f.store.sqlite.prepare('SELECT admitted_at FROM branch_executions WHERE id=?').get(f.imported).admitted_at,null);
 f.done();
});

test('before-entry final receipt failure rolls back fresh acceptance',{timeout:60000},async t=>{
 const f=await h2BeforeEntryFixture(t),review=await f.review(),before=f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n;
 f.store.sqlite.exec("CREATE TEMP TRIGGER h2_last_receipt BEFORE INSERT ON branch_commands WHEN NEW.command_key LIKE 'foreign-continuation:%' BEGIN SELECT RAISE(ABORT,'h2-last-receipt'); END");
 const input={...f.selection,commandKey:'h2-atomic',reviewSha256:review.reviewSha256,acceptCurrentAuthority:true},failed=await f.call('POST',f.url,input);
 assert.equal(failed.statusCode,409);assert.match(failed.json().error,/h2-last-receipt/);
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n,before);
 assert.equal((await f.call('GET',f.url+'?commandKey=h2-atomic')).statusCode,404);
 f.store.sqlite.exec('DROP TRIGGER h2_last_receipt');
 const receipt=await f.api('POST',f.url,input);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM branch_executions WHERE branch_id=?').get(f.result.branchId).n,before+1);
 assert.deepEqual(await f.api('POST',f.url,input),receipt);f.done();
});
