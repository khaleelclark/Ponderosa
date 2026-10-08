import {registerTriggerRoutes} from '../dist/routes/triggers.js';
import {BranchInstallationService} from '../dist/branch-installation-service.js';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,createHash} from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
import {TriggerSourceService} from '../dist/trigger-service.js';
import {registerBranchRoutes} from '../dist/routes/branches.js';
async function fixture(t,kind='webhook',sourceConfig={replayWindowSeconds:300}){
 const dir=mkdtempSync(join(tmpdir(),'branch-triggers-')),store=new AgentStore(dir),coordination=new CoordinationV3Store(store.sqlite),branches=new BranchStore(store.sqlite,coordination);
 const owner=branches.create('Triggers','owner');
 const project=store.createProject({label:'Triggers',hostPath:dir,defaultEngine:'codex',chatOwned:true,branchId:owner.id}),chat=store.getConversation(project.lastConversationId);
 const sources=new TriggerSourceService({store,coordination,dataDir:dir,notify(){}}),app=Fastify();registerBranchRoutes(app,{store,branches,installations:new BranchInstallationService(store,branches,async()=>{},async()=>{}),sources,notify(){}});
 registerTriggerRoutes(app,{store,coordination,sources,deletingConversationIds:new Set(),webhookRawBodies:new WeakMap(),rejectQuarantinedMutation:()=>false,appendWorkspace(){},reconcileOperationalNotifications(){},resolveOperationalNotification(){},notifyScheduler(){}});
 t.after(async()=>{await sources.stop();await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
 const input={chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'deploy',definition:{schema:'ponderosa.branch.v1',name:'Trigger graph',trigger:{kind,configRef:'source'},entry:'gate',steps:[{id:'gate',kind:'human_gate',prompt:'Review',editable:false}],controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:dir},triggers:{source:{sourceConfig,enabled:true}}}};
 const deploy=async body=>{const response=await app.inject({method:'POST',url:'/api/branches/deploy',payload:body});assert.equal(response.statusCode,200,response.body);return response.json()};
 const branch=await deploy(input);
 return {dir,store,coordination,branches,sources,app,project,chat,input,branch,deploy};
}

test('signed webhook atomically accepts a version-pinned Branch execution and replays without Agent activation',async t=>{
 const f=await fixture(t),secret={secret:f.branch.webhookSecret};assert.ok(secret.secret);
 assert.equal((await f.deploy(f.input)).webhookSecret,undefined);
 const rawBody=Buffer.from(JSON.stringify({text:'untrusted event'})),timestamp=String(Math.floor(Date.now()/1000)),eventId='external-1';
 const signature='v1='+createHmac('sha256',secret.secret).update(`${timestamp}.${eventId}.`).update(rawBody).digest('hex');
 const event={triggerId:f.branch.triggerId,eventId,timestamp,signature,rawBody,payload:JSON.parse(rawBody)};
 assert.throws(()=>f.sources.verifyAndRecordWebhook({...event,signature:'v1=bad'}),/signature/);
 const result=f.sources.verifyAndRecordWebhook(event),occurrence=f.coordination.getTriggerOccurrence(result.occurrenceId);
 assert.ok(occurrence.branchExecutionId);assert.equal(occurrence.activationId,undefined);assert.equal(occurrence.agentId,undefined);
 assert.equal(f.branches.execution(occurrence.branchExecutionId).versionId,f.branch.versionId);
 const next=await f.deploy({...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'deploy-2',definition:{...f.input.definition,name:'Edited'}});
 assert.notEqual(next.versionId,f.branch.versionId);assert.equal(next.triggerId,f.branch.triggerId);
 assert.equal(f.sources.verifyAndRecordWebhook(event).replayed,true);assert.equal(f.branches.listExecutions(f.branch.id).length,1);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_activations').get().n,0);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);
});

test('configuration route returns exact owned binding revisions after a newer deployment',async t=>{
 const f=await fixture(t),other=join(f.dir,'other');mkdirSync(other);
 const newer=await f.deploy({...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'new-bindings',bindings:{...f.input.bindings,directories:{workspace:other}}});
 const old=await f.app.inject({method:'GET',url:`/api/branches/${f.branch.id}/configuration?revisionId=${f.branch.bindingRevisionId}`});
 assert.equal(old.statusCode,200,old.body);assert.equal(old.json().directories.workspace,f.dir);
 const current=await f.app.inject({method:'GET',url:`/api/branches/${f.branch.id}/configuration`});
 assert.equal(current.statusCode,200,current.body);assert.equal(current.json().directories.workspace,other);
 assert.notEqual(newer.bindingRevisionId,f.branch.bindingRevisionId);
 const foreign=await f.app.inject({method:'GET',url:`/api/branches/wrong-owner/configuration?revisionId=${f.branch.bindingRevisionId}`});
 assert.equal(foreign.statusCode,404);
});

test('webhook deployment does not depend on unrelated filesystem watcher refresh',async t=>{
 const f=await fixture(t);
 f.sources.refresh=async()=>{throw new Error('unrelated filesystem watcher failed')};
 const next=await f.deploy({...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'webhook-edit',definition:{...f.input.definition,name:'Webhook edit'}});
 assert.notEqual(next.versionId,f.branch.versionId);
});

test('idempotent filesystem deployment replay retries owner-scoped source repair',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*.txt'],exclude:[],quietMs:100,maxWindowMs:1000});
 const input={...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'filesystem-repair',definition:{...f.input.definition,name:'Filesystem repair'}};
 f.sources.applyDefinitionChange=async()=>{throw new Error('watcher repair failed')};
 const first=await f.app.inject({method:'POST',url:'/api/branches/deploy',payload:input});
 assert.equal(first.statusCode,400,first.body);
 assert.notEqual(f.branches.getBranch(f.branch.id).versionId,f.branch.versionId);
 let repaired=0;
 f.sources.reconcileBranch=async branchId=>{assert.equal(branchId,f.branch.id);repaired++};
 const replay=await f.app.inject({method:'POST',url:'/api/branches/deploy',payload:input});
 assert.equal(replay.statusCode,200,replay.body);
 assert.equal(replay.json().versionId,f.branches.getBranch(f.branch.id).versionId);
 assert.equal(repaired,1);
});

test('scheduled Branch uses existing schedule cursor and fires once without an Agent',async t=>{
 const at=new Date(Date.now()+60000).toISOString(),f=await fixture(t,'schedule',{scheduleKind:'once',at});
 const due=new Date(Date.now()-1000).toISOString();f.coordination.updateTriggerDefinition(f.branch.triggerId,{nextFireAt:due});
 await f.sources.processDueSchedules();await f.sources.processDueSchedules();
 assert.equal(f.branches.listExecutions(f.branch.id).length,1);assert.equal(f.coordination.getTriggerDefinition(f.branch.triggerId).nextFireAt,undefined);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM agent_activations').get().n,0);
});

test('filesystem Branch coalesces durable path metadata and never injects watched contents',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*.txt'],exclude:[],quietMs:100,maxWindowMs:1000});
 for(const path of ['a.txt','b.txt'])f.coordination.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path,eventType:'change',maxCapturedPaths:10});
 const burst=f.coordination.listPendingFilesystemTriggerBursts()[0];assert.equal(burst.branchId,f.branch.id);assert.equal(burst.agentId,undefined);
 const result=f.coordination.flushFilesystemTriggerBurst(f.branch.triggerId),occurrence=f.coordination.getTriggerOccurrence(result.occurrenceId);
 assert.equal(occurrence.payload.changes.length,2);assert.equal(occurrence.provenance.contentInjected,false);
 assert.ok(occurrence.branchExecutionId);assert.equal(f.coordination.flushFilesystemTriggerBurst(f.branch.triggerId),undefined);
});

test('changing trigger kind atomically disables the old source and prevents detached intake',async t=>{
 const f=await fixture(t),old=f.branch.triggerId;
 const next=await f.deploy({...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'manual',definition:{...f.input.definition,trigger:{kind:'manual'}}});
 assert.equal(next.triggerId,undefined);assert.equal(f.coordination.getTriggerDefinition(old).enabled,false);
 assert.throws(()=>f.coordination.recordTriggerOccurrence({triggerId:old,occurrenceKey:'stale',payload:{},provenance:{source:'test'},allowDisabled:true}),/no longer attached/);
 assert.equal(f.coordination.listTriggerOccurrences(old).length,0);
});

test('existing Agent Automations still create only their canonical Activation',async t=>{
 const f=await fixture(t),agent=f.store.createAgent(f.project.id,{title:'Worker',engine:'codex',conversationId:f.chat.id});
 const trigger=f.coordination.createTriggerDefinition({projectId:f.project.id,conversationId:f.chat.id,targetAgentId:agent.id,name:'Agent schedule',instructions:'Work',sourceKind:'webhook',sourceConfig:{replayWindowSeconds:300}});
 const result=f.coordination.recordTriggerOccurrence({triggerId:trigger.id,occurrenceKey:'one',payload:{hello:'world'},provenance:{source:'test'}});
 assert.ok(result.activationId);assert.equal(f.coordination.getTriggerOccurrence(result.occurrenceId).branchExecutionId,undefined);
 assert.equal(f.branches.listExecutions(f.branch.id).length,0);
 assert.throws(()=>f.coordination.createTriggerDefinition({projectId:f.project.id,conversationId:f.chat.id,targetAgentId:agent.id,branchId:f.branch.id,name:'Both',instructions:'Invalid',sourceKind:'webhook',sourceConfig:{}}),/exactly one/);
});


test('deployment replay and graph-only updates survive an elapsed one-time schedule',async t=>{
 const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
 const f=await fixture(t,'schedule',{scheduleKind:'once',at:new Date(now+60000).toISOString()});
 t.mock.timers.tick(120000);await f.sources.processDueSchedules();
 assert.equal(f.coordination.getTriggerDefinition(f.branch.triggerId).enabled,false);
 assert.equal((await f.deploy(f.input)).versionId,f.branch.versionId);
 const updated=await f.deploy({...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'graph-after-fire',definition:{...f.input.definition,name:'Revised graph'}});
 assert.equal(updated.triggerId,f.branch.triggerId);assert.equal(f.coordination.getTriggerDefinition(updated.triggerId).enabled,false);
});

test('large-event reference is readable only through the requesting Run Branch lineage',async t=>{
 const f=await fixture(t),agent=f.store.createAgent(f.project.id,{title:'Reader',engine:'codex',conversationId:f.chat.id});
 const definition={...f.input.definition,entry:'read',steps:[{id:'read',kind:'agent',target:{kind:'persistent_agent',ref:'reader'},instructions:'Read event'}]};
 const branch=await f.deploy({...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'reader',definition,bindings:{...f.input.bindings,agents:{reader:agent.id}}});
 const result=f.coordination.recordTriggerOccurrence({triggerId:branch.triggerId,occurrenceKey:'large',payload:{text:'x'.repeat(12000)},provenance:{source:'test'}});
 const occurrence=f.coordination.getTriggerOccurrence(result.occurrenceId),execution=f.branches.execution(occurrence.branchExecutionId);
 assert.match(execution.input,/trigger-occurrence:/);f.branches.advance();
 const lease=f.coordination.leaseNextRun({workerId:'test'});assert.ok(lease);
 assert.equal(f.coordination.canReadBranchTriggerOccurrence(occurrence.id,lease.runId,agent.id),true);
 assert.equal(f.coordination.canReadBranchTriggerOccurrence(occurrence.id,lease.runId,'other-agent'),false);
 assert.equal(f.coordination.canReadBranchTriggerOccurrence(occurrence.id,'other-run',agent.id),false);
 const another=f.coordination.recordTriggerOccurrence({triggerId:branch.triggerId,occurrenceKey:'other',payload:{private:'other event'},provenance:{source:'test'}});
 assert.equal(f.coordination.canReadBranchTriggerOccurrence(another.occurrenceId,lease.runId,agent.id),false);
});

test('deployment preview validates trigger configuration without installing or exposing a secret',async t=>{
 const f=await fixture(t),before=f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_versions').get().n;
 const input={...f.input,branchId:f.branch.id,expectedVersionId:f.branch.versionId,idempotencyKey:'preview'};
 const preview=await f.app.inject({method:'POST',url:'/api/branches/preview',payload:input});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().webhookSecret,undefined);
 const bad=await f.app.inject({method:'POST',url:'/api/branches/preview',payload:{...input,bindings:{...input.bindings,triggers:{source:{enabled:true,sourceConfig:{replayWindowSeconds:-1}}}}}});assert.equal(bad.statusCode,400);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_versions').get().n,before);
 const contexts=await f.app.inject({url:'/api/branches/contexts'});assert.equal(contexts.statusCode,200);assert.ok(contexts.json().some(c=>c.id===f.chat.id));
});

test('parameter changes update trigger configuration without changing the workflow definition',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*.txt'],exclude:[],quietMs:100,maxWindowMs:1000});
 const input={...f.input,expectedVersionId:f.branch.versionId,idempotencyKey:'parameter-trigger',definition:{...f.input.definition,parameters:{pattern:{type:'text',default:'**/*.txt'}}},bindings:{...f.input.bindings,triggers:{source:{enabled:true,sourceConfig:{include:['{{parameter:pattern}}'],exclude:[],quietMs:100,maxWindowMs:1000}}}}};
 const branch=await f.deploy(input);assert.deepEqual(f.branches.trigger(branch.id).sourceConfig.include,['**/*.txt']);
 const result=await f.app.inject({method:'PUT',url:`/api/branches/${branch.id}/settings`,payload:{revision:0,configuration:{parameters:{pattern:'**/*.md'},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}}}});
 assert.equal(result.statusCode,200,result.body);assert.deepEqual(f.branches.trigger(branch.id).sourceConfig.include,['**/*.md']);assert.equal(f.branches.getBranch(branch.id).versionId,branch.versionId);
});


test('filesystem watcher resolves the current Branch path parameter',async t=>{
 const f=await fixture(t,'filesystem',{include:['**/*'],exclude:[],quietMs:100,maxWindowMs:1000}),defaultPath=join(f.dir,'default-watch'),configuredPath=join(f.dir,'configured-watch');mkdirSync(defaultPath);mkdirSync(configuredPath);
 const input={...f.input,expectedVersionId:f.branch.versionId,idempotencyKey:'parameter-directory',definition:{...f.input.definition,parameters:{source_path:{type:'path',default:defaultPath}}},bindings:{...f.input.bindings,directories:{workspace:'{{parameter:source_path}}'}}};
 const deployment=await f.app.inject({method:'POST',url:'/api/branches/deploy',payload:input});assert.equal(deployment.statusCode,200,deployment.body);
 assert.equal(f.branches.trigger(f.branch.id).enabled,true);assert.deepEqual(f.branches.configuration(f.branch.id).parameters,{});
 await f.sources.start();assert.equal(f.sources.watchers.get('branch:'+f.branch.id)?.projectPath,defaultPath);
 const configured=await f.app.inject({method:'PUT',url:`/api/branches/${f.branch.id}/settings`,payload:{revision:0,configuration:{parameters:{source_path:configuredPath},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}}}});assert.equal(configured.statusCode,200,configured.body);
 assert.equal(f.sources.watchers.get('branch:'+f.branch.id)?.projectPath,configuredPath);
});

test('Branch trigger pause and resume validate the Branch, not a nonexistent Dev Chat',async t=>{
 const f=await fixture(t);const {registerTriggerRoutes}=await import('../dist/routes/triggers.js');const app=Fastify();
 registerTriggerRoutes(app,{store:f.store,coordination:f.coordination,sources:f.sources,deletingConversationIds:new Set(),webhookRawBodies:new WeakMap(),rejectQuarantinedMutation:()=>false,appendWorkspace(){},reconcileOperationalNotifications(){},resolveOperationalNotification(){},notifyScheduler(){}});t.after(()=>app.close());
 for(const enabled of [false,true]){const response=await app.inject({method:'PATCH',url:'/api/triggers/'+f.branch.triggerId,payload:{enabled}});assert.equal(response.statusCode,200,response.body);assert.equal(f.branches.trigger(f.branch.id).enabled,enabled);}
 f.store.sqlite.prepare('UPDATE trigger_definitions SET enabled=0,secret_ciphertext=NULL,secret_fingerprint=NULL WHERE id=?').run(f.branch.triggerId);
 const missing=await app.inject({method:'PATCH',url:'/api/triggers/'+f.branch.triggerId,payload:{enabled:true}});assert.equal(missing.statusCode,400);assert.match(missing.json().error,/Rotate/);
 const rotated=await app.inject({method:'POST',url:'/api/triggers/'+f.branch.triggerId+'/rotate-secret'});assert.equal(rotated.statusCode,200,rotated.body);assert.ok(rotated.json().webhookSecret);
 const enabled=await app.inject({method:'PATCH',url:'/api/triggers/'+f.branch.triggerId,payload:{enabled:true}});assert.equal(enabled.statusCode,200,enabled.body);
 f.store.sqlite.prepare('UPDATE branches SET deleting=1 WHERE id=?').run(f.branch.id);
 const blocked=await app.inject({method:'PATCH',url:'/api/triggers/'+f.branch.triggerId,payload:{enabled:false}});assert.equal(blocked.statusCode,409);assert.match(blocked.json().error,/Branch/);
});

test('deployment validation identifies the Branch, Script and missing directory without leaking filesystem errors',async t=>{
 const f=await fixture(t);const input={...f.input,expectedVersionId:f.branch.versionId,definition:{...f.input.definition,entry:'format',steps:[{id:'format',label:'Format Report',kind:'script',runtime:'node',source:'',cwdRef:'work',timeoutMs:1000}]},bindings:{agents:{},directories:{work:''}}};
 const response=await f.app.inject({method:'POST',url:'/api/branches/preview',payload:input});assert.equal(response.statusCode,400);assert.match(response.json().error,/Branch.*Trigger graph.*Format Report.*Working directory is required/);
});

test('budget API revisions, idempotent grants, editability and trusted trigger Run once',async t=>{
 const f=await fixture(t,'schedule',{scheduleKind:'once',at:new Date(Date.now()+60000).toISOString()});
 const url=`/api/branches/${f.branch.id}/execution-budget`;
 const unlimited=(await f.app.inject(url)).json();assert.equal(unlimited.policy,null);
 const input={commandKey:'budget-set',expectedRevision:0,expectedPeriodId:null,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true};
 const set=await f.app.inject({method:'PUT',url,payload:input});assert.equal(set.statusCode,200,set.body);
 const budget=set.json();
 const at=new Date().toISOString();
 // Untrusted metadata and a manual-looking key do not exempt ordinary intake.
 const occurrence=f.coordination.recordTriggerOccurrence({triggerId:f.branch.triggerId,occurrenceKey:'manual:forged',payload:{source:'operator_manual_run'},provenance:{source:'operator_manual_run',automaticBudgetConsumed:false},now:at});
 const {stableJson}=await import('@ponderosa/agents');const payloadHash=value=>createHash('sha256').update(stableJson(value)).digest('hex');assert.equal(f.coordination.getTriggerOccurrence(occurrence.occurrenceId).inputHash,payloadHash({triggerId:f.branch.triggerId,occurrenceKey:'manual:forged',payload:{source:'operator_manual_run'},payloadMediaType:'application/json'}));
 assert.equal(f.coordination.recordTriggerOccurrence({triggerId:f.branch.triggerId,occurrenceKey:'manual:forged',payload:{source:'operator_manual_run'},provenance:{source:'webhook'},now:at}).replayed,true);
 assert.throws(()=>f.coordination.recordTriggerOccurrence({triggerId:f.branch.triggerId,occurrenceKey:'manual:forged',payload:{source:'operator_manual_run'},provenance:{source:'manual'},branchOperatorManual:true,now:at}),/conflict/);
 const first=f.coordination.getTriggerOccurrence(occurrence.occurrenceId).branchExecutionId;f.branches.advance(at);assert.equal(f.branches.execution(first).admissionSource,'automatic');assert.equal(f.branches.executionBudget(f.branch.id).used,1);
 const run=await f.app.inject({method:'POST',url:`/api/triggers/${f.branch.triggerId}/run`,payload:{}});assert.equal(run.statusCode,200,run.body);
 const manual=f.coordination.getTriggerOccurrence(run.json().occurrenceId).branchExecutionId;f.branches.advance();assert.equal(f.branches.execution(manual).admissionSource,'manual');assert.ok(f.branches.execution(manual).admittedAt);assert.equal(f.branches.executionBudget(f.branch.id).used,1);
 const heldOccurrence=f.coordination.recordTriggerOccurrence({triggerId:f.branch.triggerId,occurrenceKey:'held',payload:{},provenance:{source:'test'}});const heldId=f.coordination.getTriggerOccurrence(heldOccurrence.occurrenceId).branchExecutionId;f.branches.advance();
 const held=(await f.app.inject(url)).json();assert.equal(held.heldCount,1);
 const grantInput={commandKey:'grant',expectedRevision:held.revision,expectedPeriodId:held.periodId,additional:1};
 const granted=await f.app.inject({method:'POST',url:url+'/allow',payload:grantInput});assert.equal(granted.statusCode,200,granted.body);
 const replay=await f.app.inject({method:'POST',url:url+'/allow',payload:grantInput});assert.deepEqual(replay.json(),granted.json());
 assert.equal((await f.app.inject({method:'POST',url:url+'/allow',payload:{...grantInput,additional:2}})).statusCode,409);
 assert.equal((await f.app.inject({method:'POST',url:url+'/allow',payload:{...grantInput,commandKey:'stale'}})).statusCode,409);
 assert.equal((await f.app.inject({method:'PUT',url,payload:{...input,commandKey:'invalid',policy:{limit:0,period:'day'},expectedRevision:granted.json().revision,expectedPeriodId:budget.periodId}})).statusCode,400);
 assert.equal((await f.app.inject({method:'PUT',url,payload:{...input,source:'manual'}})).statusCode,400);
 assert.equal((await f.app.inject('/api/branches/missing/execution-budget')).statusCode,404);
 f.branches.advance();assert.ok(f.branches.execution(heldId).admittedAt);assert.equal(f.branches.executionBudget(f.branch.id).used,2);
 const events=[];f.branches.publishAudit(e=>events.push(e));const {workspaceEventInProduct}=await import('../dist/routes/streams.js');
 for(const event of events.filter(e=>e.type==='branch_execution_budget')){assert.equal(workspaceEventInProduct(f.store,{},event,'branches'),true);assert.equal(workspaceEventInProduct(f.store,{},event,'dev'),false);assert.equal(workspaceEventInProduct(f.store,{}, {...event,branchId:'forged'},'branches'),false)}
});
for(const kind of ['schedule','webhook','filesystem'])test(`${kind} intake shares automatic budget and held work keeps its exact occurrence`,async t=>{
 const config=kind==='schedule'?{scheduleKind:'once',at:new Date(Date.now()+60000).toISOString()}:kind==='filesystem'?{include:['**/*.txt'],exclude:[],quietMs:100,maxWindowMs:1000}:{replayWindowSeconds:300};
 const f=await fixture(t,kind,config),b=f.branches.executionBudget(f.branch.id);
 f.branches.updateExecutionBudget(f.branch.id,{commandKey:'source-budget',expectedRevision:b.revision,expectedPeriodId:b.periodId,policy:{limit:1,period:'lifetime'},acknowledgeNewPeriod:true});
 let last;
 for(let i=0;i<2;i++){
 if(kind==='schedule'){const due=new Date(Date.now()-1000).toISOString();f.coordination.updateTriggerDefinition(f.branch.triggerId,{nextFireAt:due,enabled:true});await f.sources.processDueSchedules()}
 else if(kind==='filesystem'){f.coordination.recordFilesystemTriggerEvent({triggerId:f.branch.triggerId,path:`${i}.txt`,eventType:'change',maxCapturedPaths:10});f.coordination.flushFilesystemTriggerBurst(f.branch.triggerId)}
 else{const rawBody=Buffer.from(JSON.stringify({manual:true,automaticBudgetConsumed:false})),timestamp=String(Math.floor(Date.now()/1000)),eventId=`budget-${i}`,signature='v1='+createHmac('sha256',f.branch.webhookSecret).update(`${timestamp}.${eventId}.`).update(rawBody).digest('hex');f.sources.verifyAndRecordWebhook({triggerId:f.branch.triggerId,eventId,timestamp,signature,rawBody,payload:JSON.parse(rawBody)})}
 f.branches.advance();last=f.branches.listExecutions(f.branch.id)[0];
 }
 assert.equal(f.branches.executionBudget(f.branch.id).used,1);assert.equal(last.admissionSource,'automatic');assert.ok(last.budgetWait);assert.equal(last.state,'queued');
 const occurrence=f.coordination.listTriggerOccurrences(f.branch.triggerId).find(o=>o.branchExecutionId===last.id);assert.ok(occurrence);
 assert.equal(f.store.sqlite.prepare('SELECT COUNT(*) n FROM branch_paths WHERE execution_id=?').get(last.id).n,0);
});
