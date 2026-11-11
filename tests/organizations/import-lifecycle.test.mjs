import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore} from '@ponderosa/agents';
import {AssetStore} from '../../apps/server/dist/assets.js';
import {registerAgentPackageRoutes} from '../../apps/server/dist/routes/agent-packages.js';
test('operator retires only mutation-free imports and preserves unknown effects plus upload originals',async()=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'import-lifecycle-')),store=new AgentStore(dataDir),assets=new AssetStore(dataDir),app=Fastify();
 try{
  const project=store.createProject({label:'Lifecycle',hostPath:dataDir,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Owner'}),directory=path.join(dataDir,'agent-import-operations');
  await mkdir(directory,{recursive:true});const records=[];
  for(const unknown of [false,true]){
   const id=randomUUID(),requestId=randomUUID(),payload='retained original '+id,payloadHash=createHash('sha256').update(payload).digest('hex'),now=new Date().toISOString();
   const creation=store.beginAgentCreationOperation({projectId:project.id,actorScope:'user:local-operator',kind:'import',idempotencyKey:requestId,payloadHash,conversationId:chat.id}).operation;
   if(unknown)store.updateAgentCreationOperation(creation.id,{result:{unknownEffect:true}});
   await writeFile(path.join(directory,`${id}.json`),JSON.stringify({id,requestId,payloadHash,projectId:project.id,conversationId:chat.id,product:'dev',sourceLabel:'Private upload',phase:'failed',status:'failed',createdAt:now,updatedAt:now}));
   await writeFile(path.join(directory,`${id}.payload`),payload);records.push({id,creation,payload});
  }
  registerAgentPackageRoutes(app,{dataDir,store,assets,coordination:{runtimeArtifact:()=>undefined,handleAgentDeletion(){}},engines:new Map(),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:()=>[],createOperationalNotification(){}});
  const review=async id=>(await app.inject({method:'GET',url:`/api/lifecycle/agent-imports/${id}`})).json();
  const first=await review(records[0].id);assert.equal(first.canRetireMutationFree,true);
  const input={commandKey:'retire-empty',reviewSha256:first.reviewSha256,action:'retire_mutation_free',note:'No effect or participant reservation exists'};
  const retired=await app.inject({method:'POST',url:`/api/lifecycle/agent-imports/${records[0].id}/reconcile`,payload:input});assert.equal(retired.statusCode,200);assert.equal(store.getAgentCreationOperation(records[0].creation.id).status,'rolled_back');
  assert.deepEqual((await app.inject({method:'POST',url:`/api/lifecycle/agent-imports/${records[0].id}/reconcile`,payload:input})).json(),retired.json());
  const unknown=await review(records[1].id);assert.equal(unknown.canRetireMutationFree,false);
  const rejected=await app.inject({method:'POST',url:`/api/lifecycle/agent-imports/${records[1].id}/reconcile`,payload:{...input,reviewSha256:unknown.reviewSha256}});assert.equal(rejected.statusCode,409);
  const preserved=await app.inject({method:'POST',url:`/api/lifecycle/agent-imports/${records[1].id}/reconcile`,payload:{...input,reviewSha256:unknown.reviewSha256,action:'preserve_unresolved'}});assert.equal(preserved.json().state,'preserved_unresolved');assert.deepEqual(store.getAgentCreationOperation(records[1].creation.id).result,{unknownEffect:true});
  const evidence=path.join(directory,'retained-orphans'),files=await readdir(evidence);
  for(const record of records){const file=files.find(name=>name.endsWith(`${record.id}.payload`));assert.ok(file);assert.equal(await readFile(path.join(evidence,file),'utf8'),record.payload);}
 }finally{await app.close();assets.close();store.close();await rm(dataDir,{recursive:true,force:true});}
});
