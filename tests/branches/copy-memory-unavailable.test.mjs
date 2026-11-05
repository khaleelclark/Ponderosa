import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store,readBranchExpertCopy} from '@ponderosa/agents';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';
import {ownedChroma,vector} from '../memory/portability-fixture.mjs';
import {withFixture,until} from '../shared/fixture.mjs';

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
  branches.cancel(job.id);
 },{storeFactory:dir=>(store=new AgentStore(dir)),localMemoryForRoot:memoryOptions});
});
