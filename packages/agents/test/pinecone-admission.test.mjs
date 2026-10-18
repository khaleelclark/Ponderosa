import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {AgentStore,CoordinationV3Store,openDb,WorkspaceStore} from '../dist/index.js';
import {openHistoricalDb} from './fixtures/pinecone-legacy/open.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const snapshot={id:'builtin:pinecone:1',name:'Pinecone',description:'Synthetic',engine:'codex',guidance:'Synthetic bounded instructions'};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'pinecone-admission-'));let store=new AgentStore(dir),c=new CoordinationV3Store(store.sqlite);
 const p=store.createProject({label:'Synthetic',hostPath:dir,defaultEngine:'codex'}),chat=store.createConversation(p.id,{title:'Private'});
 const cone=store.createAgent(p.id,{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:chat.id,idempotencyKey:'cone'},undefined,undefined,snapshot);
 const other=store.createAgent(p.id,{title:'Ordinary',engine:'codex',conversationId:chat.id}),child=store.createAgent(p.id,{title:'Child',engine:'codex',conversationId:chat.id,managerAgentId:cone.id});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});console.log('SETTLED SQLite fixture',dir)});
 const record=(id,agent=cone,policy='next_run')=>{
  const communication={eventId:id,schemaVersion:2,projectId:p.id,conversationId:chat.id,sender:{kind:'user',userId:'local-operator'},intent:'user_dm',audience:{kind:'user_agent',userId:'local-operator',agentId:agent.id},text:id,createdAt:new Date().toISOString()};
  return c.recordRuntimeCommunication({id,projectId:p.id,sender:communication.sender,intent:communication.intent,audience:communication.audience,payload:{communication,dispatch:{conversationId:chat.id,text:id,activeRunDelivery:policy==='next_run'?'queue':'steer',recipients:[{agentId:agent.id,attachments:[]}]}},activation:{agentId:agent.id,kind:'human_message',priority:100,dispatchPolicy:policy,promptClass:'human'}});
 };
 return {dir,p,chat,cone,other,child,record,get store(){return store},get c(){return c},hold(state='paused',key='hold'){return store.updatePineconeAdmission(cone.id,{admissionState:state,expectedRevision:store.getPineconeProfile(cone.id).revision,operationKey:key})},reopen(){store.close();store=new AgentStore(dir);c=new CoordinationV3Store(store.sqlite)}};
}
const ack=(c,l)=>{const a={injectionId:l.injectionId,runId:l.runId,fencingToken:l.fencingToken};c.markRunStarted(l.runId,l.fencingToken);c.preparePromptInjection({...a,prompt:'Synthetic canonical work'});c.markPromptSubmitted(a);c.acknowledgePromptInjection(a);return {runId:l.runId,agentId:l.agentId,fencingToken:l.fencingToken}};
const only=(f,a)=>({workerId:'synthetic',leaseMs:60000,excludedAgentIds:[f.cone,f.other,f.child].filter(x=>x.id!==a.id).map(x=>x.id)});
const schedule=(f,name,agent=f.cone)=>f.c.createTriggerDefinition({projectId:f.p.id,conversationId:f.chat.id,targetAgentId:agent.id,name,instructions:'Synthetic source',sourceKind:'schedule',sourceConfig:{scheduleKind:'interval',startsAt:'2026-01-01T00:00:00.000Z',everyMs:60000},nextFireAt:'2026-01-01T00:00:00.000Z',runBudget:{limit:1,period:'day'},enabled:true});
const scheduled=(f,d,key='tick')=>({triggerId:d.id,occurrenceKey:key,expectedNextFireAt:d.nextFireAt,nextFireAt:'2026-01-01T00:01:00.000Z',lastFiredAt:d.nextFireAt,payload:{missedCount:2,collapsedRecovery:true},provenance:{source:'schedule'}});

test('fresh and populated exact-0e7e upgrade defaults only existing profiles active; reopen preserves hold',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'pinecone-hold-upgrade-')),base='0e7ee833d5f633e0d681c36c7880191cc7e30b94';
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'old.sqlite');let {client}=openHistoricalDb(base,file);
 client.exec("INSERT INTO projects(id,label,host_path,created_at,default_engine) VALUES('p','Existing','/tmp/existing','2026-01-01','codex'); INSERT INTO conversations(id,project_id,title,created_at,updated_at) VALUES('c','p','Existing','2026-01-01','2026-01-01'); INSERT INTO agents(id,project_id,conversation_id,title,handle,active_engine,created_at,updated_at,working_copy_json) VALUES('a','p','c','Pinecone','pinecone','codex','2026-01-01','2026-01-01','{}'),('b','p','c','Ordinary','ordinary','codex','2026-01-01','2026-01-01','{}'); INSERT INTO pinecone_profiles VALUES('a','p','c',1,'2026-01-01');");
 const before=client.prepare('SELECT * FROM agents').all();client.close();({client}=openDb(file));
 assert.deepEqual(client.prepare('SELECT * FROM agents').all(),before);assert.deepEqual(client.prepare('SELECT admission_state,revision,updated_at FROM pinecone_profiles').get(),{admission_state:'active',revision:1,updated_at:'2026-01-01'});assert.equal(client.prepare('SELECT COUNT(*) n FROM pinecone_profiles').get().n,1);client.close();
 const f=fixture(t);assert.equal(f.store.getPineconeProfile(f.cone.id).admissionState,'active');assert.ok(f.store.sqlite.prepare("SELECT 1 FROM _schema_version WHERE name='0039_pinecone_admission_hold.sql'").get());f.hold();f.reopen();assert.equal(f.store.getPineconeProfile(f.cone.id).admissionState,'paused');assert.equal(f.store.getPineconeProfile(f.other.id),undefined);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});

test('mutation receipt exactly replays original result; conflict/stale/validation/failed receipt leave no effects',t=>{
 const f=fixture(t),input={admissionState:'paused',expectedRevision:1,operationKey:'first'},result=f.store.updatePineconeAdmission(f.cone.id,input);f.hold('active','resume');
 assert.deepEqual(f.store.updatePineconeAdmission(f.cone.id,input),result);assert.equal(f.store.getPineconeProfile(f.cone.id).admissionState,'active');
 const before=f.store.getPineconeProfile(f.cone.id),n=()=>f.store.sqlite.prepare('SELECT count(*) n FROM pinecone_admission_receipts').get().n;
 for(const payload of [{...input,admissionState:'active'},{...input,operationKey:'stale'}, {...input,operationKey:' space '},{...input,operationKey:'x'.repeat(129)},{...input,extra:true},{...input,expectedRevision:1.1},{...input,admissionState:'suspended'}]){assert.throws(()=>f.store.updatePineconeAdmission(f.cone.id,payload));assert.deepEqual(f.store.getPineconeProfile(f.cone.id),before);assert.equal(n(),2)}
 f.store.sqlite.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON pinecone_admission_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END;");assert.throws(()=>f.hold('paused','fail'),/receipt failure/);assert.deepEqual(f.store.getPineconeProfile(f.cone.id),before);assert.equal(n(),2);f.store.sqlite.exec('DROP TRIGGER fail_receipt');f.reopen();assert.deepEqual(f.store.updatePineconeAdmission(f.cone.id,input),result);assert.deepEqual(f.store.getPineconeProfile(f.cone.id),before);
});

test('held new/coalesced human/Request/Join/Decision sources persist while children and unrelated Agents admit',t=>{
 const f=fixture(t);f.hold();f.record('human');f.record('human2',f.cone,'steer_or_run');
 f.c.coordinate({projectId:f.p.id,conversationId:f.chat.id,actorScope:'user:local-operator',idempotencyKey:'request',requests:[{requestId:'request',recipientAgentId:f.cone.id,payload:{text:'Synthetic request'},lifetime:{kind:'indefinite'}}]});
 const w=new WorkspaceStore(f.dir),decision=w.createDecision({projectId:f.p.id,conversationId:f.chat.id,agentId:f.cone.id,question:'Durable human choice',mode:'text',options:[],allowOther:true,idempotencyKey:'decision'});
 const before=f.store.sqlite.prepare('SELECT id,state,payload_json FROM agent_activations WHERE agent_id=? ORDER BY id').all(f.cone.id);assert.equal(f.c.leaseNextRun(only(f,f.cone)),undefined);assert.equal(f.c.leaseNextSteering({workerId:'test'}),undefined);assert.deepEqual(f.store.sqlite.prepare('SELECT id,state,payload_json FROM agent_activations WHERE agent_id=? ORDER BY id').all(f.cone.id),before);assert.equal(w.listDecisions({projectId:f.p.id}).find(x=>x.id===decision.id)?.status,'pending');
 for(const agent of [f.child,f.other]){f.record('child-'+agent.id,agent);const lease=f.c.leaseNextRun(only(f,agent));assert.equal(lease.agentId,agent.id);ack(f.c,lease);f.c.completeRun(lease.runId,lease.fencingToken)}
 f.hold('active','resume');const l=f.c.leaseNextRun(only(f,f.cone));assert.equal(l.agentId,f.cone.id);assert.ok(l.activationIds.every(id=>before.some(x=>x.id===id)));
});

test('earlier Run and steer leases may finish; later held coalesced steering is untouched then resumes once',t=>{
 const f=fixture(t);f.record('original');const l=f.c.leaseNextRun(only(f,f.cone));ack(f.c,l);f.record('steer1',f.cone,'steer_or_run');const early=f.c.leaseNextSteering({workerId:'test'});assert.ok(early);f.record('later1',f.cone,'steer_or_run');f.record('later2',f.cone,'steer_or_run');f.hold();
 const a={injectionId:early.injectionId,runId:early.runId,fencingToken:early.fencingToken};f.c.preparePromptInjection({...a,prompt:'Earlier accepted steer'});f.c.markPromptSubmitted(a);f.c.acknowledgePromptInjection(a);
 const before=f.store.sqlite.prepare("SELECT id,state FROM agent_activations WHERE state IN ('pending','retry_pending') ORDER BY id").all();assert.equal(before.length,2);assert.equal(f.c.leaseNextSteering({workerId:'test'}),undefined);assert.deepEqual(f.store.sqlite.prepare("SELECT id,state FROM agent_activations WHERE state IN ('pending','retry_pending') ORDER BY id").all(),before);
 f.hold('active','resume');const later=f.c.leaseNextSteering({workerId:'test',coalesceLimit:16});assert.deepEqual([...later.activationIds].sort(),before.map(x=>x.id));assert.equal(f.c.leaseNextSteering({workerId:'test'}),undefined);f.hold('paused','again');const settled={injectionId:later.injectionId,runId:later.runId,fencingToken:later.fencingToken};f.c.preparePromptInjection({...settled,prompt:'Previously accepted coalesced steer'});f.c.markPromptSubmitted(settled);f.c.acknowledgePromptInjection(settled);f.c.completeRun(l.runId,l.fencingToken);assert.equal(f.store.sqlite.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(l.runId).status,'completed');assert.equal(f.c.leaseNextRun(only(f,f.cone)),undefined);
});

test('held due schedules exclude before bounded page; transactional pause/fire denies before cursor/occurrence effects; manual queues',t=>{
 const f=fixture(t);const due=[];for(let i=0;i<105;i++)due.push(schedule(f,'Held '+i));const ordinary=schedule(f,'Ordinary',f.other);const loaded=f.c.listDueScheduleTriggers(new Date().toISOString(),100);assert.equal(loaded.length,100);f.hold();
 assert.deepEqual(f.c.listDueScheduleTriggers(new Date().toISOString(),100).map(x=>x.id),[ordinary.id]);const before=f.c.getTriggerDefinition(due[0].id);assert.throws(()=>f.c.recordScheduledTriggerOccurrence(scheduled(f,due[0])),/paused/);assert.deepEqual(f.c.getTriggerDefinition(due[0].id),before);assert.equal(f.c.listTriggerOccurrences(due[0].id).length,0);
 const manual=f.c.recordTriggerOccurrence({triggerId:due[0].id,occurrenceKey:'manual',payload:{},provenance:{source:'manual'}});assert.ok(manual.activationId);assert.equal(f.c.leaseNextRun(only(f,f.cone)),undefined);f.hold('active','resume');const tick=f.c.recordScheduledTriggerOccurrence(scheduled(f,due[0]));assert.ok(tick.activationId);assert.equal(f.c.getTriggerDefinition(due[0].id).enabled,true);assert.equal(f.c.getTriggerDefinition(due[0].id).nextFireAt,'2026-01-01T00:01:00.000Z');
});

test('independent real SQLite connection races serialize pause against lease, steering and schedule acceptance',async t=>{
 const f=fixture(t);f.record('original');const run=f.c.leaseNextRun(only(f,f.cone));ack(f.c,run);f.record('race-steer',f.cone,'steer_or_run');const d=schedule(f,'Race');
 const shared=new SharedArrayBuffer(4),gate=new Int32Array(shared);
 const source=`import {parentPort,workerData} from 'node:worker_threads';import {openDb,CoordinationV3Store} from ${JSON.stringify(pathToFileURL(join(repo,'packages/agents/dist/index.js')).href)};const s=openDb(workerData.file),c=new CoordinationV3Store(s.client);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.shared),0,0);const outcome=s.client.transaction(()=>{let result;try{result=c.recordScheduledTriggerOccurrence(workerData.tick)}catch(e){result={error:e.message}}const steer=c.leaseNextSteering({workerId:'racing'});return {result,steer}}).immediate();s.client.close();parentPort.postMessage(outcome);`;
 const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{workerData:{file:join(f.dir,'ponderosa.db'),shared,tick:scheduled(f,d)}});const exited=new Promise((resolve,reject)=>{worker.once('exit',code=>code?reject(Error('worker exit '+code)):resolve());worker.once('error',reject)});
 const first=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});assert.equal(first,'ready');const result=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});Atomics.store(gate,0,1);Atomics.notify(gate,0);f.store.sqlite.transaction(()=>f.hold()).immediate();const raced=await result;await exited;
 assert.equal(f.c.leaseNextRun(only(f,f.cone)),undefined);assert.equal(f.c.leaseNextSteering({workerId:'after'}),undefined);assert.equal(f.store.getPineconeProfile(f.cone.id).admissionState,'paused');if(raced.result.error){assert.match(raced.result.error,/paused/);assert.equal(f.c.listTriggerOccurrences(d.id).length,0)}else assert.equal(f.c.listTriggerOccurrences(d.id).length,1);
 console.log('RACE serialized',JSON.stringify({scheduleAcceptedBeforeHold:!raced.result.error,earlierSteerAllowed:Boolean(raced.steer),afterHoldLease:false,afterHoldSteer:false,workerSettled:true}));
 // Reopen while held, with a pending new-Run source; a second canonical connection still excludes it.
 f.record('ordinary',f.other);f.reopen();assert.equal(f.c.leaseNextRun(only(f,f.cone)),undefined);assert.equal(f.c.leaseNextRun(only(f,f.other)).agentId,f.other.id);
});

for(const scope of ['Agent','Chat','Project'])test(`durable receipt inventory removed by canonical ${scope} deletion`,t=>{
 const f=fixture(t);f.hold();assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM pinecone_admission_receipts').get().n,1);
 if(scope==='Project')assert.equal(f.store.deleteProject(f.p.id),true);
 else {for(const a of [f.child,f.cone,f.other])f.store.deleteAgent(a.id,id=>f.c.handleAgentDeletion(id));if(scope==='Chat'){const receipt=f.store.commitConversationDeletion(f.chat.id);f.store.finishConversationDeletionStorageCleanup(receipt);f.store.markConversationDeletionServerCleanupComplete(f.chat.id)}}
 assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM pinecone_admission_receipts').get().n,0);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);assert.deepEqual(f.store.sqlite.pragma('foreign_key_check'),[]);
});
