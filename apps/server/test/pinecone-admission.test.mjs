import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';
import {registerPineconeRoutes} from '../dist/routes/pinecone.js';
import {TriggerSourceService} from '../dist/trigger-service.js';
import {fixture as liveFixture} from './managed-helper-policy.fixture.mjs';
const snapshot={id:'builtin:pinecone:1',name:'Pinecone',description:'Synthetic',engine:'codex',guidance:'Synthetic bounded instructions'};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pinecone-admission-http-')),store=new AgentStore(dir),p=store.createProject({label:'Synthetic',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(p.id,{title:'Private'}),cone=store.createAgent(p.id,{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:chat.id,idempotencyKey:'cone'},undefined,undefined,snapshot),c=new CoordinationV3Store(store.sqlite);let starts=0;
 const adapter={id:'codex',displayName:'Inert',listModels:()=>[],listEfforts:()=>[],run(){starts++;throw Error('No provider allowed')}};
 const app=createServer({dataDir:dir,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,startDrained:true});await app.ready();t.after(async()=>{assert.equal(starts,0);app.prepareForShutdown();await app.close();store.close();await rm(dir,{recursive:true,force:true});console.log('SETTLED HTTP',JSON.stringify({dir,serverClosed:true,storeClosed:true,providerModelStarts:0}))});
 const url=`/api/agents/${cone.id}/pinecone`,patch=(body,headers)=>app.inject({method:'PATCH',url,payload:body,headers});return {dir,store,p,chat,cone,c,app,url,patch};
}
const body=(admissionState='paused',expectedRevision=1,operationKey='hold')=>({admissionState,expectedRevision,operationKey});
const effects=f=>Object.fromEntries(['pinecone_profiles','pinecone_admission_receipts','agent_activations','scheduler_runs','trigger_occurrences'].map(table=>[table,f.store.sqlite.prepare(`SELECT * FROM ${table}`).all()]));

test('normal Dev PATCH persists canonical hold; original receipt replays after later Resume; stale/key conflict/strict bodies deny before effects',async t=>{
 const f=await fixture(t),initial=effects(f),paused=await f.patch(body());assert.equal(paused.statusCode,200,paused.body);assert.equal(paused.json().admissionState,'paused');assert.equal(paused.json().revision,2);assert.equal((await f.app.inject({url:f.url})).json().admissionState,'paused');
 for(const key of ['agent_activations','scheduler_runs','trigger_occurrences'])assert.deepEqual(effects(f)[key],initial[key]);
 const resumed=await f.patch(body('active',2,'resume'));assert.equal(resumed.statusCode,200,resumed.body);const replay=await f.patch(body());assert.deepEqual(replay.json(),paused.json());assert.equal(f.store.getPineconeProfile(f.cone.id).admissionState,'active');
 const before=effects(f);for(const [payload,status]of [[body('active',1,'hold'),409],[body('paused',1,'stale'),409],[{...body(),extra:true},400],[body('paused',-1,'negative'),400],[body('paused',1,' key '),400],[body('paused',1,'x'.repeat(129)),400],[body('pause',1,'invalid'),400],[null,400],[[],400]]){const r=await f.patch(payload);assert.equal(r.statusCode,status,r.body);assert.deepEqual(effects(f),before)}
 const sent=await f.app.inject({method:'POST',url:`/api/agents/${f.cone.id}/messages`,payload:{text:'Durable queue',idempotencyKey:'message',activeRunDelivery:'queue'}});assert.equal(sent.statusCode,202,sent.body);assert.equal(f.store.readCommunicationEvents(f.p.id).at(-1).intent,'user_dm');
});

for(const authToken of [undefined,'fixture-operator'])test(`canonical inert Run bearer cannot mutate config; ${authToken?'authenticated':'loopback'} operator can pause without stopping its Run`,{timeout:20000},async t=>{
 const f=await liveFixture(t,{pinecone:true,authToken}),url=`/api/agents/${f.owner.id}/pinecone`,patch=(payload,headers=f.operatorHeaders)=>f.app.inject({method:'PATCH',url,payload,headers});
 const run=f.runRow(),before=f.store.getPineconeProfile(f.owner.id);const denied=await patch(body(),f.headers);assert.ok(denied.statusCode>=400,denied.body);assert.deepEqual(f.store.getPineconeProfile(f.owner.id),before);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM pinecone_admission_receipts').get().n,0);
 const wrong=await f.app.inject({method:'PATCH',url:`/api/branches/engine/agents/${f.owner.id}/pinecone`,headers:f.operatorHeaders,payload:body()});assert.equal(wrong.statusCode,404,wrong.body);
 if(authToken)assert.equal((await patch(body(),{})).statusCode,401);
 const paused=await patch(body());assert.equal(paused.statusCode,200,paused.body);assert.equal(f.runRow().id,run.id);assert.equal(f.runRow().status,'running');assert.equal(f.starts(),1);
 const queued=await f.app.inject({method:'POST',url:`/api/agents/${f.owner.id}/messages`,headers:f.operatorHeaders,payload:{text:'Queued while held',idempotencyKey:'held-message',activeRunDelivery:'steer'}});assert.ok(queued.statusCode<300,queued.body);assert.equal(f.coordination.leaseNextSteering({workerId:'held-probe'}),undefined);assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM agent_activations WHERE agent_id=? AND state='pending'").get(f.owner.id).n,1);
});

test('archive, foreign identity, ordinary profile, quarantined creation, and durable deleting Chat deny config without effects',async t=>{
 const f=await fixture(t);const denied=async(status)=>{const before=effects(f),r=await f.patch(body());assert.equal(r.statusCode,status,r.body);assert.deepEqual(effects(f),before)};
 f.store.updateAgent(f.cone.id,{archived:true});await denied(404);f.store.updateAgent(f.cone.id,{archived:false});f.store.updateConversation(f.chat.id,{archived:true});await denied(404);f.store.updateConversation(f.chat.id,{archived:false});
 const ordinary=f.store.createAgent(f.p.id,{title:'Ordinary',engine:'codex',conversationId:f.chat.id});assert.equal((await f.app.inject({method:'PATCH',url:`/api/agents/${ordinary.id}/pinecone`,payload:body()})).statusCode,404);
 const other=f.store.createConversation(f.p.id,{title:'Other'});f.store.sqlite.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(other.id,f.cone.id);await denied(404);f.store.sqlite.prepare('UPDATE agents SET conversation_id=? WHERE id=?').run(f.chat.id,f.cone.id);
 f.store.markConversationDeletionPending(f.chat.id);await denied(409);
});

test('hold excludes schedule intake; Resume uses existing collapsed catch-up, exact cursor, finite budget and no duplicates',async t=>{
 const f=await fixture(t),sources=new TriggerSourceService({store:f.store,coordination:f.c,dataDir:f.dir,notify(){}});t.after(()=>sources.stop());
 const now=Date.now(),at=new Date(now-5*60000).toISOString(),d=f.c.createTriggerDefinition({projectId:f.p.id,conversationId:f.chat.id,targetAgentId:f.cone.id,name:'Catch-up',instructions:'Synthetic finite source',sourceKind:'schedule',sourceConfig:{scheduleKind:'interval',everyMs:60000,startsAt:at},nextFireAt:at,runBudget:{limit:1,period:'day'},enabled:true});
 assert.equal((await f.patch(body())).statusCode,200);await sources.processDueSchedules();assert.equal(f.c.listTriggerOccurrences(d.id).length,0);assert.equal(f.c.getTriggerDefinition(d.id).nextFireAt,at);
 assert.equal((await f.patch(body('active',2,'resume'))).statusCode,200);await sources.processDueSchedules();const items=f.c.listTriggerOccurrences(d.id);assert.equal(items.length,1);const tick=f.c.getTriggerOccurrence(items[0].id);assert.equal(tick.payload.collapsedRecovery,true);assert.ok(tick.payload.missedCount>=5);await sources.processDueSchedules();assert.equal(f.c.listTriggerOccurrences(d.id).length,1);
 const run=f.c.leaseNextRun({workerId:'canonical-synthetic'});assert.equal(run.agentId,f.cone.id);assert.equal(f.c.getTriggerDefinition(d.id).budgetState.used,1);const auth={runId:run.runId,injectionId:run.injectionId,fencingToken:run.fencingToken};f.c.preparePromptInjection({...auth,prompt:'Synthetic scheduled check'});f.c.markPromptSubmitted(auth);f.c.acknowledgePromptInjection(auth);f.c.completeRun(run.runId,run.fencingToken);
 f.c.recordTriggerOccurrence({triggerId:d.id,occurrenceKey:'later-budget',payload:{},provenance:{source:'schedule'}});assert.equal(f.c.leaseNextRun({workerId:'budget-held'}),undefined);assert.equal(f.c.getTriggerDefinition(d.id).budgetState.held,true);
});

test('canonical store mutation and postcommit projection/resume seams stay on the actual SQLite transaction; explicit quarantine denies',async t=>{
 const f=await fixture(t),app=Fastify(),deletingAgentIds=new Set(),deletingProjectIds=new Set(),deletingConversationIds=new Set();let changes=0,resumes=0;const update=f.store.updatePineconeAdmission.bind(f.store);f.store.updatePineconeAdmission=(id,input)=>{assert.equal(f.store.sqlite.inTransaction,true);return update(id,input)};
 registerPineconeRoutes(app,{store:f.store,deletingAgentIds,deletingProjectIds,deletingConversationIds,agentMessageCapabilities:new Map([['fixture-run',{}]]),profileChanged(){assert.equal(f.store.sqlite.inTransaction,false);changes++},resumeAdmission(){assert.equal(f.store.sqlite.inTransaction,false);resumes++}});t.after(()=>app.close());
 const patch=(payload,headers)=>app.inject({method:'PATCH',url:f.url,payload,headers});assert.equal((await patch(body(),{authorization:'Bearer fixture-run'})).statusCode,403);
 for(const set of [deletingAgentIds,deletingProjectIds,deletingConversationIds]){const id=set===deletingAgentIds?f.cone.id:set===deletingProjectIds?f.p.id:f.chat.id;set.add(id);const before=effects(f);assert.equal((await patch(body())).statusCode,409);assert.deepEqual(effects(f),before);set.delete(id)}
 assert.equal((await patch(body())).statusCode,200);assert.equal(changes,1);assert.equal(resumes,0);assert.equal((await patch(body('active',2,'resume'))).statusCode,200);assert.equal(resumes,1);
});
