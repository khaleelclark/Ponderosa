import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {instance,read,vector} from './portability-fixture.mjs';

test('private finding is authored by the copy and inherited by an actual full Agent copy',async t=>{
 const f=await instance(t),id=randomUUID(),scope='chat:'+f.chat.id,at=new Date().toISOString();
 const authority={chatId:f.chat.id,actor:{kind:'agent',id:f.b.id},runId:'copy-run',fenceToken:'copy-fence',sourceType:'ai_inference',readChat:false,readGlobal:false,writeScope:scope,visibility:'private',privateFindingRecipientId:f.a.id,guard:async()=>{}};
 await f.memory.core.database.run(authority,()=>f.memory.core.database.put({id,scope,text:'Useful finding from the temporary copy',embedding:vector,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:false,timestamp:at}}));
 const original=await read(f,f.a.id),other=await read(f,f.b.id);
 assert.equal(original.length,1);assert.equal(other.length,0);
 const stamp=JSON.parse(original[0].metadata.host_source_authority);
 assert.equal(stamp.audience,scope+':agent:'+f.a.id);assert.deepEqual(stamp.provenance.actor,{kind:'agent',id:f.b.id});assert.equal(stamp.provenance.runId,'copy-run');assert.equal(stamp.provenance.fenceToken,'copy-fence');
 const noRuns=()=>{for(const name of ['scheduler_runs','agent_activations'])assert.equal(f.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n,0);};noRuns();
 const response=await f.app.inject({method:'POST',url:`/api/projects/${f.project.id}/copy-agent`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{sourceAgentId:f.a.id,conversationId:f.chat.id,mode:'full'}});
 assert.equal(response.statusCode,201,response.body);const result=response.json();const copy=await read(f,result.rootAgentId);
 assert.equal(copy.length,1);assert.equal(copy[0].text,'Useful finding from the temporary copy');assert.deepEqual(JSON.parse(copy[0].metadata.host_source_authority).origin.actor,{kind:'agent',id:f.b.id});noRuns();
});

test('finding audience override cannot be combined with read, global, user, team or mutation authority',async t=>{
 const f=await instance(t),base={chatId:f.chat.id,actor:{kind:'agent',id:f.b.id},runId:'copy-run',fenceToken:'1',sourceType:'ai_inference',readChat:false,readGlobal:false,writeScope:'chat:'+f.chat.id,visibility:'private',privateFindingRecipientId:f.a.id,guard:async()=>{}};
 for(const changed of [{readChat:true},{readGlobal:true},{actor:{kind:'user',id:'operator'}},{visibility:'team'},{writeScope:'global'},{targetId:'existing'}])await assert.rejects(f.memory.core.database.run({...base,...changed},async()=>{}),/unavailable or unauthorized/);
});

test('original finding destination is explicit and private',async()=>{
 const {validateMemoryCall}=await import('../../apps/server/dist/local-memory-catalog.js');
 assert.deepEqual(validateMemoryCall('save',{text:'useful finding',destination:'chat',visibility:'private',recipient:'original'}),{text:'useful finding',destination:'chat',visibility:'private',recipient:'original'});
 for(const input of [{text:'x',destination:'global',visibility:'private',recipient:'original'},{text:'x',destination:'chat',recipient:'original'},{text:'x',destination:'chat',visibility:'team',recipient:'original'},{text:'x',destination:'chat',visibility:'private',recipient:'other'}])assert.throws(()=>validateMemoryCall('save',input),/Original recipient/);
});

test('host-only final memory export rejects an unrelated durable Chat',async t=>{
 const f=await instance(t);let checks=0;
 await assert.rejects(f.memory.exportExpertFinalPackageMemory(f.chat.id,[f.a.id],()=>{checks++;}),/Exact reviewed temporary agent copy/);
 assert.equal(checks,1);
});

test('retained expert receipt identifies memory even when generic temporary proof excludes provisioned Chats',async t=>{
 const f=await instance(t),{BranchStore,CoordinationV3Store,readBranchExpertCopy}=await import('@ponderosa/agents');
 const {sealBranchExpertSnapshot,reserveBranchExpertChat}=await import('../../packages/agents/dist/branch-expert-copy.js');
 const sourceProject=f.store.createProject({label:'Source',hostPath:f.root,defaultEngine:'fixture',chatOwned:true}),sourceChat=f.store.getConversation(sourceProject.lastConversationId),source=f.store.createAgent(sourceProject.id,{title:'Expert',engine:'fixture',conversationId:sourceChat.id});
 const branches=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));
 const definition={schema:'ponderosa.branch.v1',name:'Expert cleanup',trigger:{kind:'manual'},entry:'work',controls:[],steps:[{id:'work',kind:'agent',target:{kind:'persistent_agent',ref:'expert'},instructions:'Work',jobHandling:'copy'}],edges:[],policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}};
 const branch=branches.deploy({chatId:sourceChat.id,idempotencyKey:'expert-cleanup-deploy',definition,bindings:{agents:{expert:source.id},directories:{workspace:f.root}}}),job=branches.accept(branch.id,'expert-cleanup-job','input');for(let i=0;i<6;i++)branches.advance();
 const resource=f.store.sqlite.prepare('SELECT * FROM branch_resources WHERE execution_id=?').get(job.id),r=readBranchExpertCopy(f.store.sqlite,job.id,resource.step_execution_id);
 sealBranchExpertSnapshot(f.store.sqlite,job.id,resource.step_execution_id,{...r.snapshotSource,version:1,custodyId:'fixture-custody',boundaryId:'fixture-boundary',sha256:'a'.repeat(64),byteLength:20});
 reserveBranchExpertChat(f.store.sqlite,job.id,resource.step_execution_id,{copyChatId:f.chat.id,copyProjectId:f.project.id});
 assert.equal(f.memory.isProvenTemporaryChat(f.chat.id,f.project.id,branch.id),false);
 assert.equal(f.memory.hasExpertMemory(f.chat.id,f.project.id),true);
 assert.throws(()=>f.memory.hasExpertMemory(f.chat.id,'different-project'),/memory is retained/);
});
