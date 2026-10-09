import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';
import {registerTriggerRoutes} from '../dist/routes/triggers.js';
import {TriggerSourceService} from '../dist/trigger-service.js';

const reviewed=t=>Object.fromEntries(['id','projectId','conversationId','name','instructions','sourceKind','sourceConfig','enabled','fullAccess'].map(k=>[k,t[k]]).concat([['targetAgentId',t.targetAgentId??null],['branchId',t.branchId??null],['runBudget',t.runBudget??null]]));
const counts=store=>Object.fromEntries(['agents','runtime_communications','coordination_requests','coordination_joins','agent_activations','scheduler_runs','trigger_occurrences'].map(table=>[table,store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'pinecone-responsibilities-http-')),store=new AgentStore(root);let starts=0;
 const adapter=id=>({id,displayName:'Inert '+id,listModels:()=>[],listEfforts:()=>[],run(){starts++;throw Error('Provider forbidden')}});
 const app=createServer({dataDir:root,store,engines:['codex','claude'].map(id=>({adapter:adapter(id),authStatus:async()=>({authenticated:true})})),logger:false,startDrained:true});await app.ready();
 const p=store.createProject({label:'Synthetic',hostPath:root,defaultEngine:'codex'}),a=store.createConversation(p.id,{title:'A'}),b=store.createConversation(p.id,{title:'B'});
 const cr=await app.inject({method:'POST',url:`/api/projects/${p.id}/agents`,payload:{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:a.id,idempotencyKey:'cone'}});assert.equal(cr.statusCode,200,cr.body);const cone=cr.json(),other=store.createAgent(p.id,{title:'B',engine:'claude',conversationId:b.id});
 const request={conversationId:a.id,targetAgentId:cone.id,name:'Review sources',instructions:'Synthetic trusted instructions',sourceKind:'schedule',sourceConfig:{scheduleKind:'cron',expression:'0 9 * * *',timezone:'UTC'},runBudget:{limit:1,period:'day'},enabled:false};
 const call=(method,url,payload)=>app.inject({method,url,payload});
 const create=async(extra={})=>{const r=await call('POST',`/api/projects/${p.id}/triggers`,{...request,...extra});assert.equal(r.statusCode,201,r.body);return r.json().trigger};
 t.after(async()=>{assert.equal(starts,0);app.prepareForShutdown();await app.close();store.close();await rm(root,{recursive:true,force:true});console.log('SETTLED',JSON.stringify({root,providerStarts:starts,removed:true}));});
 return {store,app,p,a,b,cone,other,request,call,create};
}

test('guarded review accepts same definition, explicit disabled confirmation and automatic budget hold',async t=>{
 const f=await fixture(t),d=await f.create(),guard=reviewed(d),before=counts(f.store);
 const no=await f.call('POST',`/api/triggers/${d.id}/run`,{confirmDisabled:false,reviewedDefinition:guard});assert.equal(no.statusCode,409,no.body);assert.deepEqual(counts(f.store),before);
 const enabled=await f.call('PATCH',`/api/triggers/${d.id}`,{enabled:true,reviewedDefinition:guard});assert.equal(enabled.statusCode,200,enabled.body);assert.deepEqual(counts(f.store),before);
 const c=new CoordinationV3Store(f.store.sqlite);
 const first=c.recordTriggerOccurrence({triggerId:d.id,occurrenceKey:'automatic-1',payload:{untrusted:'payload'},provenance:{source:'schedule'},now:new Date().toISOString()});
 const repeat=c.recordTriggerOccurrence({triggerId:d.id,occurrenceKey:'automatic-1',payload:{untrusted:'payload'},provenance:{source:'schedule'},now:new Date().toISOString()});assert.equal(repeat.replayed,true);assert.equal(repeat.occurrenceId,first.occurrenceId);
 // Admission budget is charged at the canonical scheduler lease, not occurrence intake.
 const lease=c.leaseNextRun({workerId:'inert-fixture'});assert.equal(lease.agentId,f.cone.id);assert.equal(c.getTriggerDefinition(d.id).budgetState.used,1);
 const auth={injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken};c.preparePromptInjection({...auth,prompt:"Synthetic budget work"});c.markPromptSubmitted(auth);c.acknowledgePromptInjection(auth);
 c.completeRun(lease.runId,lease.fencingToken);
 c.recordTriggerOccurrence({triggerId:d.id,occurrenceKey:'automatic-2',payload:{untrusted:'second'},provenance:{source:'schedule'},now:new Date().toISOString()});assert.equal(c.leaseNextRun({workerId:'held-fixture'}),undefined);assert.equal(c.getTriggerDefinition(d.id).budgetState.held,true);
 const current=c.getTriggerDefinition(d.id),disabled=await f.call('PATCH',`/api/triggers/${d.id}`,{enabled:false,reviewedDefinition:reviewed(current)});assert.equal(disabled.statusCode,200,disabled.body);
 const manual=await f.call('POST',`/api/triggers/${d.id}/run`,{confirmDisabled:true,reviewedDefinition:reviewed(disabled.json())});assert.equal(manual.statusCode,200,manual.body);assert.equal(c.getTriggerOccurrence(manual.json().occurrenceId).agentId,f.cone.id);assert.equal(c.getTriggerDefinition(d.id).budgetState.used,1);assert.equal(c.getTriggerOccurrence(first.occurrenceId).triggerSnapshot.instructions,d.instructions);
});

test('stale retarget/instructions/schedule/budget/name/enabled and identity guards deny both actions without effects',async t=>{
 const f=await fixture(t);
 for(const patch of [{conversationId:f.b.id,targetAgentId:f.other.id},{instructions:'Changed trusted instructions'},{sourceConfig:{scheduleKind:'cron',expression:'0 12 * * *',timezone:'UTC'}},{runBudget:{limit:2,period:'week'}},{name:'Renamed'},{enabled:true}]){
  const d=await f.create(),changed=await f.call('PATCH',`/api/triggers/${d.id}`,patch);assert.equal(changed.statusCode,200,changed.body);
  const before=counts(f.store),row=f.store.sqlite.prepare('SELECT * FROM trigger_definitions WHERE id=?').get(d.id);
  for(const [method,suffix,payload]of [['PATCH','',{enabled:true}],['POST','/run',{confirmDisabled:true}]]){
   const r=await f.call(method,`/api/triggers/${d.id}${suffix}`,{...payload,reviewedDefinition:reviewed(d)});assert.equal(r.statusCode,409,r.body);assert.deepEqual(counts(f.store),before);assert.deepEqual(f.store.sqlite.prepare('SELECT * FROM trigger_definitions WHERE id=?').get(d.id),row);
  }
 }
 const d=await f.create();for(const delta of [{id:'other'},{conversationId:f.b.id},{targetAgentId:f.other.id}]){const before=counts(f.store);const r=await f.call('POST',`/api/triggers/${d.id}/run`,{confirmDisabled:true,reviewedDefinition:{...reviewed(d),...delta}});assert.equal(r.statusCode,409,r.body);assert.deepEqual(counts(f.store),before);}
});

test('malformed/incomplete guards and manual bodies reject; object-order and telemetry changes accept',async t=>{
 const f=await fixture(t),d=await f.create(),guard=reviewed(d),before=counts(f.store);
 for(const bad of [null,true,{}, {...guard,id:undefined},{...guard,runBudget:undefined},{...guard,fullAccess:false},{...guard,enabled:'yes'},{...guard,sourceConfig:{scheduleKind:'cron',expression:'0 9 * * *'}},{...guard,runBudget:{limit:1}},{...guard,branchId:'also-branch'},{...guard,extra:true}]){
  for(const [method,suffix,base]of [['PATCH','',{enabled:true}],['POST','/run',{confirmDisabled:true}]]){const r=await f.call(method,`/api/triggers/${d.id}${suffix}`,{...base,reviewedDefinition:bad});assert.equal(r.statusCode,400,r.body);assert.deepEqual(counts(f.store),before);}
 }
 for(const body of [{confirmDisabled:'yes'},{unexpected:true}]){const r=await f.call('POST',`/api/triggers/${d.id}/run`,body);assert.equal(r.statusCode,400,r.body);assert.deepEqual(counts(f.store),before);}
 f.store.sqlite.prepare('UPDATE trigger_definitions SET next_fire_at=?,last_fired_at=?,run_budget_used=1,run_budget_allowance=1 WHERE id=?').run('2030-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',d.id);
 const reordered={...guard,sourceConfig:{timezone:'UTC',expression:'0 9 * * *',scheduleKind:'cron'},runBudget:{period:'day',limit:1}};
 const accepted=await f.call('PATCH',`/api/triggers/${d.id}`,{name:'Same review accepted',reviewedDefinition:reordered});assert.equal(accepted.statusCode,200,accepted.body);assert.deepEqual(counts(f.store),before);
 const legacy=await f.call('POST',`/api/triggers/${d.id}/run`,{confirmDisabled:true});assert.equal(legacy.statusCode,200,legacy.body);
});

test('target filtering precedes pagination; advanced sources remain visible; wrong product/archive/membership reject',async t=>{
 const f=await fixture(t);
 for(let i=0;i<28;i++)await f.create({name:'Exact '+i});
 for(let i=0;i<5;i++)await f.create({conversationId:f.b.id,targetAgentId:f.other.id,name:'Other '+i});
 await f.create({name:'Advanced webhook',sourceKind:'webhook',sourceConfig:{replayWindowSeconds:300}});
 const ids=[];let cursor;do{const r=await f.call('GET',`/api/triggers?projectId=${f.p.id}&targetAgentId=${f.cone.id}&limit=7${cursor?'&cursor='+encodeURIComponent(cursor):''}`);assert.equal(r.statusCode,200,r.body);assert.ok(r.json().length<=7);for(const d of r.json()){assert.equal(d.targetAgentId,f.cone.id);ids.push(d.id);}cursor=r.headers['x-next-cursor'];}while(cursor);
 assert.equal(new Set(ids).size,29);
 const d=await f.create();const baseline=counts(f.store);
 for(const payload of [{...f.request,conversationId:f.b.id},{...f.request,targetAgentId:f.other.id}]){const r=await f.call('POST',`/api/projects/${f.p.id}/triggers`,payload);assert.equal(r.statusCode,400,r.body);assert.deepEqual(counts(f.store),baseline);}
 const wrong=await f.call('POST',`/api/branches/engine/projects/${f.p.id}/triggers`,f.request);assert.ok(wrong.statusCode>=400,wrong.body);assert.deepEqual(counts(f.store),baseline);
 f.store.updateConversation(f.a.id,{archived:true});for(const [method,url,payload]of [['POST',`/api/projects/${f.p.id}/triggers`,f.request],['PATCH',`/api/triggers/${d.id}`,{enabled:true,reviewedDefinition:reviewed(d)}],['POST',`/api/triggers/${d.id}/run`,{confirmDisabled:true,reviewedDefinition:reviewed(d)}]]){const r=await f.call(method,url,payload);assert.ok(r.statusCode>=400,r.body);assert.deepEqual(counts(f.store),baseline);}
});

test('actual connection keeps reviewed read and registry acceptance transactional; Branch guard metadata preserves enabled-only legacy contract',async t=>{
 const f=await fixture(t),c=new CoordinationV3Store(f.store.sqlite),branches=new BranchStore(f.store.sqlite,c),owner=branches.create('Synthetic branch','owner');
 const p=f.store.createProject({label:'Branch',hostPath:f.p.hostPath,defaultEngine:'codex',chatOwned:true,branchId:owner.id}),chat=f.store.getConversation(p.lastConversationId);
 const d=c.createTriggerDefinition({projectId:p.id,conversationId:chat.id,branchId:owner.id,name:'Branch schedule',instructions:'Synthetic branch trigger',sourceKind:'schedule',sourceConfig:{scheduleKind:'cron',expression:'0 9 * * *',timezone:'UTC'},enabled:false});
 const app=Fastify(),sources=new TriggerSourceService({store:f.store,coordination:c,dataDir:f.p.hostPath,notify(){}}),deleting=new Set();let reads=0,updates=0;
 const get=c.getTriggerDefinition.bind(c),update=c.updateTriggerDefinition.bind(c);
 c.getTriggerDefinition=id=>{assert.equal(f.store.sqlite.inTransaction,true,'authority read is in actual SQLite transaction');reads++;return get(id)};
 c.updateTriggerDefinition=(id,input)=>{assert.equal(f.store.sqlite.inTransaction,true);assert.ok(!Object.hasOwn(input,'reviewedDefinition'));updates++;return update(id,input)};
 registerTriggerRoutes(app,{store:f.store,coordination:c,sources,deletingConversationIds:deleting,webhookRawBodies:new WeakMap(),rejectQuarantinedMutation:()=>false,appendWorkspace(){assert.equal(f.store.sqlite.inTransaction,false)},reconcileOperationalNotifications(){assert.equal(f.store.sqlite.inTransaction,false)},resolveOperationalNotification(){},notifyScheduler(){assert.equal(f.store.sqlite.inTransaction,false)}});
 t.after(async()=>{await sources.stop();await app.close()});
 const ordinary=await f.create();const record=c.recordTriggerOccurrence.bind(c);let occurrences=0;c.recordTriggerOccurrence=input=>{assert.equal(f.store.sqlite.inTransaction,true,'manual occurrence accepts on the same actual connection');occurrences++;return record(input)};
 const manual=await app.inject({method:'POST',url:`/api/triggers/${ordinary.id}/run`,payload:{confirmDisabled:true,reviewedDefinition:reviewed(ordinary)}});assert.equal(manual.statusCode,200,manual.body);assert.equal(occurrences,1);
 const enabled=await app.inject({method:'PATCH',url:`/api/triggers/${d.id}`,payload:{enabled:true,reviewedDefinition:reviewed(d)}});assert.equal(enabled.statusCode,200,enabled.body);assert.ok(reads>0);assert.equal(updates,1);
 const forbidden=await app.inject({method:'PATCH',url:`/api/triggers/${d.id}`,payload:{name:'Forbidden',reviewedDefinition:reviewed(enabled.json())}});assert.equal(forbidden.statusCode,400,forbidden.body);assert.equal(updates,1);
 const legacy=await app.inject({method:'PATCH',url:`/api/triggers/${d.id}`,payload:{enabled:false}});assert.equal(legacy.statusCode,200,legacy.body);assert.equal(updates,2);
 deleting.add(chat.id);const before=counts(f.store);const rejected=await app.inject({method:'POST',url:`/api/triggers/${d.id}/run`,payload:{confirmDisabled:true,reviewedDefinition:reviewed(legacy.json())}});assert.equal(rejected.statusCode,409,rejected.body);assert.deepEqual(counts(f.store),before);
});
