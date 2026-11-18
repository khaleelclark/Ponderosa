import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '@ponderosa/agents';
import {localMemoryFor,MemoryHostClosing} from '../../apps/server/dist/local-memory.js';
import {BranchResourceService} from '../../apps/server/dist/branch-resource-service.js';
import {checkpointPackageCustody} from '../../apps/server/dist/checkpoint-agent-packages.js';
import {ownedChroma,vector} from '../memory/portability-fixture.mjs';
import {fixture,withFixture,until} from '../shared/fixture.mjs';
import {inspect} from 'node:util';
import {DatabaseSync} from 'node:sqlite';

const memoryOptions=async root=>({chromaUrl:await ownedChroma(),collectionPrefix:'copy_unavailable_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR,stateDirectory:path.join(root,'policy'),provision:true});
function deploy(f,store,chat,source,key){
 const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const definition={schema:'ponderosa.branch.v1',name:'Temporary copy',trigger:{kind:'manual'},entry:'work',controls:[],steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'source'},instructions:'Do this job',jobHandling:'copy'}],edges:[],policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:chat.id,idempotencyKey:key+'-deploy',definition,bindings:{agents:{source:source.id},directories:{workspace:f.root}}});
 return {branches,branch,job:branches.accept(branch.id,key,'input')};
}

test('a configured but unavailable memory service allows explicitly reviewed no-memory copy and retirement', {timeout:180000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Source'),source=await f.createIdleAgent(chat,'Source agent'),memory=localMemoryFor(f.app);assert.ok(memory);await memory.ready();
  const original=memory.checkpointSourceDatabases.bind(memory);let checks=0;memory.checkpointSourceDatabases=async()=>{checks++;throw Error('synthetic readiness unavailable before dispatch');};
  t.after(()=>{memory.checkpointSourceDatabases=original;});
  const {branch,job}=deploy(f,store,chat,source,'unavailable-memory');
  const resource=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id),'copy resource',30000);
  const base=`/api/branches/${branch.id}/executions/${job.id}/resources/${resource.step_execution_id}`;
  const review=await until(async()=>{const r=await f.api('GET',base);return r.status===200&&r.body.expertCopyReview&&r.body.currentPolicyReview?r.body:undefined},'no-memory review',90000);
  assert.ok(checks>0);assert.equal(review.expertCopyReview.sourceMemoryAvailable,false);
  const hash=review.expertCopyReview.reviewWithoutMemorySha256,agentActions=Object.fromEntries(review.currentPolicyReview.source.filter(x=>x.settings).map(x=>[x.ref,'keep_destination']));
  const consent={accessSettingsResolution:{action:'keep_destination',reviewSha256:hash,agentActions},snapshotSha256:review.expertCopyReview.snapshotSha256,copySourceMemory:false,allowFindingsWriteback:false};
  const approved=await f.api('POST',base+'/access-review',consent);assert.equal(approved.status,200,JSON.stringify(approved.body));
  const r=await until(()=>{const x=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);return x?.state==='active'&&x},'active no-memory copy',90000);
  await until(()=>store.sqlite.prepare('SELECT state FROM coordination_requests WHERE id=?').get(r.requestId)?.state==='completed','copy completion',90000);
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id)?.state==='retired','copy retirement',90000);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM local_memory_scope_provisioning WHERE chat_id=?').get(r.copyChatId).n,0);
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs WHERE agent_id=?').get(source.id).n,0);
  const saved=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);assert.ok(saved.finalSnapshotReceipt);assert.equal(saved.finalVerifiedSha256,saved.finalSnapshotReceipt.sha256);
 },{storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:memoryOptions});
});

test('unknown source memory mutation stays held and is not replayed by a copy', {timeout:180000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Source'),source=await f.createIdleAgent(chat,'Source agent'),memory=localMemoryFor(f.app);await memory.ready();await memory.verifyChat(chat.id);
  const raw=memory.core.database.raw,scope='chat:'+chat.id,name=raw.names(scope).memory,original=raw.client.getCollection.bind(raw.client),id=randomUUID();let writes=0;
  raw.client.getCollection=async args=>{const c=await original(args);if(args.name===name){const upsert=c.upsert.bind(c);c.upsert=async input=>{writes++;if(writes>1)throw Error('unexpected repeated source upsert');await upsert(input);throw Error('synthetic lost acknowledgement after real disposable upsert');};}return c;};t.after(()=>{raw.client.getCollection=original;});
  const authority={chatId:chat.id,actor:{kind:'agent',id:source.id},runId:'synthetic-known-worker',fenceToken:'1',sourceType:'ai_inference',readChat:false,readGlobal:false,writeScope:scope,visibility:'private',guard:async()=>{}};
  await assert.rejects(memory.core.database.run(authority,()=>memory.core.database.put({id,scope,text:'synthetic retained source',embedding:vector,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:new Date().toISOString()}})),/lost acknowledgement/);
  assert.equal(writes,1);assert.equal(memory.core.database.scopeHasUnsettledMutation(scope),true);
  const {branches,job}=deploy(f,store,chat,source,'unknown-memory');
  const resource=await until(()=>{const r=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);return r?.error?r:undefined},'unknown source hold',60000);
  const receipt=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);assert.equal(receipt.snapshotReceipt,undefined);assert.equal(resource.root_agent_id,null);assert.equal(writes,1);assert.equal(memory.core.database.scopeHasUnsettledMutation(scope),true);
  const collection=await original({name});assert.ok((await collection.get({ids:[id]})).ids.includes(id),'the acknowledged backend row is preserved');
  const holds=f.ok(await f.api('GET','/api/local-memory/mutation-holds')).filter(h=>h.effect?.scope===scope);assert.ok(holds.length,'unknown outcome stays visible and unreconciled');
  // Pause a real retry after it has entered source capture. A concurrent
  // cancellation must not retire this resource before that capture settles.
  const assertSettled=memory.assertCheckpointSourceSettled.bind(memory), sourceDatabases=memory.checkpointSourceDatabases.bind(memory);
  let enteredResolve, releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve}), release=new Promise(resolve=>{releaseResolve=resolve});
  let bypassFirstCheck=true;
  memory.assertCheckpointSourceSettled=()=>{if(bypassFirstCheck){bypassFirstCheck=false;return;}return assertSettled();};
  memory.checkpointSourceDatabases=async()=>{enteredResolve();await release;return sourceDatabases();};
  branches.invalidateExpertPreflightHold(resource.step_execution_id);
  t.after(()=>{releaseResolve();memory.assertCheckpointSourceSettled=assertSettled;memory.checkpointSourceDatabases=sourceDatabases;});
  try {
    await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('capture retry did not start')),30000);timer.unref();})]);
    branches.cancel(job.id);
    const other=deploy(f,store,chat,source,'independent-cancel');
    const otherResource=await until(()=>store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(other.job.id),'independent resource',30000);
    other.branches.cancel(other.job.id);
    await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(otherResource.step_execution_id)?.state==='retired','unrelated resource retirement',30000);
    assert.equal(store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id).state,'reserved','in-flight capture has not drained');
    assert.equal(readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id).snapshotReceipt,undefined);
  } finally {releaseResolve();}
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id)?.state==='retired','cancelled copy retirement',60000);
  assert.equal(writes,1);
  assert.equal(memory.core.database.scopeHasUnsettledMutation(scope),true);
  assert.ok((await collection.get({ids:[id]})).ids.includes(id),'the source row remains after copy retirement');
  assert.ok(f.ok(await f.api('GET','/api/local-memory/mutation-holds')).some(h=>h.effect?.scope===scope),'the source hold remains visible after copy retirement');

 },{storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:memoryOptions});
});

test('shutdown preserves an exact unsubmitted memory hold across restart', {timeout:180000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Shutdown source'),source=await f.createIdleAgent(chat,'Source agent'),memory=localMemoryFor(f.app);
  await memory.ready();await memory.verifyChat(chat.id);
  const raw=memory.core.database.raw,scope='chat:'+chat.id,name=raw.names(scope).memory,original=raw.client.getCollection.bind(raw.client),id=randomUUID();let writes=0;
  raw.client.getCollection=async args=>{const c=await original(args);if(args.name===name){const upsert=c.upsert.bind(c);c.upsert=async input=>{writes++;if(writes>1)throw Error('unexpected repeated source upsert');await upsert(input);throw Error('synthetic lost acknowledgement after real disposable upsert');};}return c;};t.after(()=>{raw.client.getCollection=original;});
  const authority={chatId:chat.id,actor:{kind:'agent',id:source.id},runId:'synthetic-known-worker',fenceToken:'1',sourceType:'ai_inference',readChat:false,readGlobal:false,writeScope:scope,visibility:'private',guard:async()=>{}};
  await assert.rejects(memory.core.database.run(authority,()=>memory.core.database.put({id,scope,text:'synthetic retained source',embedding:vector,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:new Date().toISOString()}})),/lost acknowledgement/);
  const {job}=deploy(f,store,chat,source,'shutdown-unknown-memory');
  const resource=await until(()=>{const r=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);return r?.error?.includes('memory mutation requires reconciliation')?r:undefined},'typed unsubmitted hold',60000);
  const before=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
  assert.equal(before.snapshotReceipt,undefined);assert.equal(writes,1);
  const savedBefore=store.sqlite.prepare('SELECT result_json,created_at FROM branch_commands WHERE execution_id=? AND command_key=?').get(job.id,'expert-preflight-hold:'+resource.step_execution_id);
  const revisionBefore=store.sqlite.prepare('SELECT revision FROM branch_executions WHERE id=?').get(job.id).revision;
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.deepEqual(store.sqlite.prepare('SELECT result_json,created_at FROM branch_commands WHERE execution_id=? AND command_key=?').get(job.id,'expert-preflight-hold:'+resource.step_execution_id),savedBefore);
  assert.equal(store.sqlite.prepare('SELECT revision FROM branch_executions WHERE id=?').get(job.id).revision,revisionBefore,'unchanged hold must not generate checkpoint churn');

  // Exercise the real stored reservation and each post-drain refusal separately.
  const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const checker=new BranchResourceService(branches,store,async()=>{},async()=>{},async()=>{});
  const witness=memory.checkpointMutationHoldWitness();assert.ok(witness);
  let currentWitness=witness,custody='missing',sourceValid=true;
  checker.setPackageEngine({inspectCheckpoint:async()=>({state:custody}),expertSourceHoldWitness:()=>currentWitness,
   checkExpertSnapshotSource:()=>{if(!sourceValid)throw Error('source unavailable');}});
  const readProof=branches.expertPreflightHolds.bind(branches);
  const proof=await until(()=>readProof().find(item=>item.stepExecutionId===resource.step_execution_id),'durable preflight receipt',30000);
  branches.expertPreflightHolds=()=>[proof];
  assert.equal(proof.holdWitness,witness);
  assert.equal((await checker.shutdownErrors()).length,0);
  const actualRelease=branches.resourceRelease.bind(branches);
  branches.resourceRelease=()=> 'waiting';assert.equal((await checker.shutdownErrors()).length,0);
  branches.resourceRelease=()=> 'fenced';assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);
  branches.resourceRelease=actualRelease;
  currentWitness='changed';assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);currentWitness=witness;
  for(const state of ['capturing','failed','retained']){custody=state;assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);}custody='missing';
  // A real custody pending marker for this exact source must remain a failure.
  const custodyRoot=path.join(f.root,'synthetic-custody-control');mkdirSync(custodyRoot);
  const actualCustody=checkpointPackageCustody(custodyRoot),custodyId=createHash('sha256').update(proof.source.checkpointId).digest('hex');
  const pending=path.join(custodyRoot,'checkpoint-package-custody',custodyId+'.pending.json');
  writeFileSync(pending,JSON.stringify({version:1,...proof.source,boundaryId:'synthetic-boundary',state:'capturing'}),{mode:0o600});
  checker.setPackageEngine({inspectCheckpoint:source=>actualCustody.inspect(source),expertSourceHoldWitness:()=>currentWitness,
   checkExpertSnapshotSource:()=>{if(!sourceValid)throw Error('source unavailable');}});
  assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);
  unlinkSync(pending);
  checker.setPackageEngine({inspectCheckpoint:async()=>({state:custody}),expertSourceHoldWitness:()=>currentWitness,
   checkExpertSnapshotSource:()=>{if(!sourceValid)throw Error('source unavailable');}});
  branches.expertPreflightHolds=()=>[];assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);
  branches.expertPreflightHolds=()=>[proof];
  sourceValid=false;assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);sourceValid=true;
  branches.expertPreflightHolds=()=>[{...proof,source:{...proof.source,checkpointId:randomUUID()}}];
  assert.match((await checker.shutdownErrors())[0].message,/memory mutation requires reconciliation/);
  branches.expertPreflightHolds=()=>[proof];
  const command='resource-completion-error:synthetic:independent';
  store.sqlite.prepare('INSERT INTO branch_commands VALUES(?,?,?,?,?)').run(job.id,command,'synthetic',JSON.stringify({error:'independent cleanup failure'}),new Date().toISOString());
  assert.ok((await checker.shutdownErrors()).some(e=>e.message==='independent cleanup failure'));
  store.sqlite.prepare('DELETE FROM branch_commands WHERE execution_id=? AND command_key=?').run(job.id,command);
  branches.expertPreflightHolds=readProof;

  try{await f.shutdownProduct();}catch(error){console.error('FIRST_CONTROLLED_SHUTDOWN',inspect(error,{depth:20}));throw error;}
  const closedDb=new DatabaseSync(path.join(f.dataDir,'ponderosa.db'),{readOnly:true});
  const closedRows=closedDb.prepare("SELECT result_json FROM branch_commands WHERE command_key LIKE 'expert-preflight-hold:%'").all();
  assert.equal(closedRows.length,1,'the exact preflight proof survives the first shutdown');
  const previousWitness=JSON.parse(closedRows[0].result_json).holdWitness;closedDb.close();
  await f.restartAfterProductShutdown();
  // Exercise shutdown immediately after reopening, before explicit user action.
  const reopenedBranches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
  const restartedWitness=localMemoryFor(f.app).checkpointMutationHoldWitness();
  assert.notEqual(reopenedBranches.resourceRelease(resource.step_execution_id),'fenced');
  assert.equal(reopenedBranches.expertPreflightHolds().length,1,'restart keeps the exact preflight proof');
  assert.equal(restartedWitness,previousWitness,'restart preserves the same durable source hold');
  try{await f.shutdownProduct();}catch(error){console.error('SECOND_CONTROLLED_SHUTDOWN',inspect(error,{depth:20}));throw error;}
  await f.restartAfterProductShutdown();
  const reopened=localMemoryFor(f.app);await reopened.ready();
  const after=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
  assert.deepEqual(after.snapshotSource,before.snapshotSource);assert.equal(after.snapshotReceipt,undefined);
  assert.equal(reopened.core.database.scopeHasUnsettledMutation(scope),true);
  const collection=await reopened.core.database.raw.client.getCollection({name});
  assert.ok((await collection.get({ids:[id]})).ids.includes(id));
  assert.ok(f.ok(await f.api('GET','/api/local-memory/mutation-holds')).some(h=>h.effect?.scope===scope));
  assert.equal(writes,1);
  const restartedBranches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));restartedBranches.cancel(job.id);
  await until(()=>store.sqlite.prepare('SELECT state FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id)?.state==='retired','cancelled held copy retirement',60000);
 },{storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:memoryOptions});
});

test('shutdown retains an unrelated preflight failure that races a memory fence', {timeout:180000},async t=>{
 let store,release=()=>{};const f=await fixture({storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:memoryOptions});
 try {
  const chat=await f.createChat('Mixed source'),source=await f.createIdleAgent(chat,'Source agent'),memory=localMemoryFor(f.app);
  await memory.ready();await memory.verifyChat(chat.id);
  const raw=memory.core.database.raw,scope='chat:'+chat.id,name=raw.names(scope).memory,original=raw.client.getCollection.bind(raw.client),id=randomUUID();let writes=0;
  raw.client.getCollection=async args=>{const c=await original(args);if(args.name===name){const upsert=c.upsert.bind(c);c.upsert=async input=>{writes++;await upsert(input);throw Error('synthetic lost acknowledgement');};}return c;};
  const authority={chatId:chat.id,actor:{kind:'agent',id:source.id},runId:'synthetic-known-worker',fenceToken:'1',sourceType:'ai_inference',readChat:false,readGlobal:false,writeScope:scope,visibility:'private',guard:async()=>{}};
  await assert.rejects(memory.core.database.run(authority,()=>memory.core.database.put({id,scope,text:'synthetic source',embedding:vector,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:new Date().toISOString()}})),/lost acknowledgement/);
  const {job}=deploy(f,store,chat,source,'mixed-preflight');
  const resource=await until(()=>{const row=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);return row?.error?.includes('memory mutation requires reconciliation')?row:undefined},'original hold',60000);
  const check=memory.assertCheckpointSourceSettled.bind(memory);let bypass=true,enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve}),gate=new Promise(resolve=>{release=resolve});
  memory.assertCheckpointSourceSettled=()=>{if(bypass){bypass=false;return;}return check();};
  const syntheticSecret='synthetic-bare-preflight-credential',secretKey='PONDEROSA_TEST_PREFLIGHT_TOKEN';
  // Model a known credential; an arbitrary unregistered string is not a secret field.
  const previousSecret=process.env[secretKey];process.env[secretKey]=syntheticSecret;
  t.after(()=>{if(previousSecret===undefined)delete process.env[secretKey];else process.env[secretKey]=previousSecret;});
  memory.checkpointSourceDatabases=async()=>{enteredResolve();await gate;throw Object.assign(Error(syntheticSecret),{code:'SQLITE_BUSY'});};
  new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)).invalidateExpertPreflightHold(resource.step_execution_id);
  await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('mixed preflight did not enter')),30000);timer.unref();})]);
  const closing=f.shutdownProduct();
  await until(()=>{try{memory.assertCheckpointSourceSettled();return false;}catch(error){return error instanceof MemoryHostClosing;}},'memory preClose fence',30000);
  release();
  await assert.rejects(closing,error=>{const details=inspect(error,{depth:20});assert.match(details,/SQLITE_BUSY/);assert.doesNotMatch(details,new RegExp(syntheticSecret));return true;});
  const saved=store.sqlite.prepare('SELECT error FROM branch_resources WHERE step_execution_id=?').get(resource.step_execution_id).error;
  assert.match(saved,/SQLITE_BUSY/);assert.doesNotMatch(saved,new RegExp(syntheticSecret));
  assert.equal(writes,1);assert.equal(memory.core.database.scopeHasUnsettledMutation(scope),true);
  raw.client.getCollection=original;
 } finally {
  release();
  // The first shutdown rejection was asserted above; retain this fixture.
  if(f.app)await f.dispose(false);
  if(store?.sqlite?.open)store.close();
 }
});

test('a changed frozen capture source cannot reuse the prior preflight proof', {timeout:180000},async t=>{
 let store,release=()=>{};const f=await fixture({storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:memoryOptions});
 try {
  const chat=await f.createChat('Changed source'),source=await f.createIdleAgent(chat,'Source agent'),memory=localMemoryFor(f.app);
  await memory.ready();await memory.verifyChat(chat.id);
  const raw=memory.core.database.raw,scope='chat:'+chat.id,name=raw.names(scope).memory,original=raw.client.getCollection.bind(raw.client),id=randomUUID();
  raw.client.getCollection=async args=>{const c=await original(args);if(args.name===name){const upsert=c.upsert.bind(c);c.upsert=async input=>{await upsert(input);throw Error('synthetic lost acknowledgement');};}return c;};
  const authority={chatId:chat.id,actor:{kind:'agent',id:source.id},runId:'synthetic-known-worker',fenceToken:'1',sourceType:'ai_inference',readChat:false,readGlobal:false,writeScope:scope,visibility:'private',guard:async()=>{}};
  await assert.rejects(memory.core.database.run(authority,()=>memory.core.database.put({id,scope,text:'synthetic source',embedding:vector,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:new Date().toISOString()}})),/lost acknowledgement/);
  const {branches,job}=deploy(f,store,chat,source,'changed-preflight');
  const resource=await until(()=>{const row=store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id);return row?.error?.includes('memory mutation requires reconciliation')?row:undefined},'original hold',60000);
  const before=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
  const check=memory.assertCheckpointSourceSettled.bind(memory), databases=memory.checkpointSourceDatabases.bind(memory);let bypass=true,enteredResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve}),gate=new Promise(resolve=>{release=resolve});
  memory.assertCheckpointSourceSettled=()=>{if(bypass){bypass=false;return;}return check();};
  memory.checkpointSourceDatabases=async()=>{enteredResolve();await gate;return databases();};
  branches.invalidateExpertPreflightHold(resource.step_execution_id);
  await Promise.race([entered,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('changed preflight did not enter')),30000);timer.unref();})]);
  branches.retryExpertSnapshot(job.id,resource.step_execution_id,before.snapshotSource);
  const after=readBranchExpertCopy(store.sqlite,job.id,resource.step_execution_id);
  assert.notEqual(after.snapshotSource.checkpointId,before.snapshotSource.checkpointId);
  const closing=f.shutdownProduct();
  await until(()=>{try{memory.assertCheckpointSourceSettled();return false;}catch(error){return error instanceof MemoryHostClosing;}},'memory preClose fence',30000);
  release();
  await assert.rejects(closing,error=>{assert.match(inspect(error,{depth:20}),/Expert source changed during capture preflight/);return true;});
  assert.equal(memory.core.database.scopeHasUnsettledMutation(scope),true);
  raw.client.getCollection=original;
 } finally {
  release();if(f.app)await f.dispose(false);if(store?.sqlite?.open)store.close();
 }
});
