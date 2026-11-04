import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,BranchStore,CoordinationV3Store} from '@ponderosa/agents';
import {createServer} from '../../apps/server/dist/app.js';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';

let chroma;
async function isolatedChroma(){
 if(chroma)return chroma.url;
 const root=await mkdtemp(path.join(tmpdir(),'memory-deletion-chroma-')),reserve=net.createServer();
 await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.env.PONDEROSA_TEST_CHROMA_BIN??'chroma',['run','--path',root,'--host','127.0.0.1','--port',String(port)],{stdio:'ignore',env:{...process.env,ANONYMIZED_TELEMETRY:'False'}});
 chroma={root,child,url:'http://127.0.0.1:'+port,exit:once(child,'exit')};
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Owned Chroma exited');try{if((await fetch(chroma.url+'/api/v2/heartbeat')).ok)return chroma.url;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Owned Chroma unavailable');
}
after(async()=>{if(chroma){chroma.child.kill('SIGTERM');await chroma.exit;await rm(chroma.root,{recursive:true,force:true});}});
async function fixture(run){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'memory-deletion-'))),dataDir=path.join(root,'data'),token=randomUUID(),headers={authorization:'Bearer '+token};
 let store=new AgentStore(dataDir),app,passed=false;
 const adapter={id:'fixture',displayName:'Inert',listModels:()=>[],listEfforts:()=>[],async*seed(){throw Error('No provider turn allowed');},async*continue(){throw Error('No provider turn allowed');}};
 const first=store.createProject({label:'Memory cleanup',hostPath:root,defaultEngine:'fixture',chatOwned:true}),chat=store.getConversation(first.lastConversationId);
 const a=store.createAgent(first.id,{engine:'fixture',conversationId:chat.id,title:'Private owner'}),b=store.createAgent(first.id,{engine:'fixture',conversationId:chat.id,title:'Preserved peer'});
 const other=store.createProject({label:'Other Chat',hostPath:root,defaultEngine:'fixture',chatOwned:true}),otherChat=store.getConversation(other.lastConversationId);
 const options={dataDir,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,localMemory:{chromaUrl:await isolatedChroma(),collectionPrefix:'cleanup_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR??path.join(tmpdir(),'unconfigured-memory-models'),stateDirectory:path.join(root,'policy'),provision:true}};
 async function open(){app=createServer({...options,store});await app.ready();}
 try{
  await open();const memory=localMemoryFor(app),raw=memory.core.database.raw;
  const api=async(method,url,payload)=>{const res=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});return {status:res.statusCode,body:res.json()};};
  const seed=async(scope,audience,actor=a.id,log=false)=>{
   const id=randomUUID(),at=new Date().toISOString(),sourceType=scope==='global'?'user_statement':'ai_inference',provenance={actor:{kind:scope==='global'?'user':'agent',id:actor},runId:'synthetic-source',fenceToken:'1',at};
   const stamp={format:1,principal:memory.principalId,id,scope,ownerChat:scope==='global'?'global':scope.slice(5),audience,sourceType,provenance,origin:provenance};
   const collection=await raw.client.getCollection({name:raw.names(scope)[log?'log':'memory']});
   await collection.upsert({ids:[id],documents:['Disposable private lifecycle fixture'],embeddings:[Array.from({length:384},(_,i)=>i?0:1)],metadatas:[{source_type:sourceType,confidence:1,deprecated:false,timestamp:at,[log?'host_conflict_authority':'host_source_authority']:JSON.stringify(stamp)}]});return id;
  };
  const rows=async(scope,log=false)=>{try{return (await(await raw.client.getCollection({name:raw.names(scope)[log?'log':'memory']})).get({include:['metadatas']})).ids;}catch(error){if(error.name==='ChromaNotFoundError')return null;throw error;}};
  const removeAgent=async()=>{const preview=store.previewAgentDeletion([a.id]);return api('POST','/api/projects/'+first.id+'/agent-deletions/commit',{rootAgentIds:[a.id],previewHash:preview.previewHash});};
  const f={root,headers,first,chat,a,b,otherChat,memory,raw,seed,rows,api,removeAgent,get store(){return store;},get liveMemory(){return localMemoryFor(app);},async reopen(){app.prepareForShutdown();await app.close();store.close();store=new AgentStore(dataDir);await open();}};
  await run(f);passed=true;
 }finally{if(app){app.prepareForShutdown();await app.close();}store.close();if(passed)await rm(root,{recursive:true,force:true});else console.log('Retained memory cleanup fixture:',root);}
}
test('Agent deletion erases only its private bodies and conflicts; team, peer and global survive',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,own=await f.seed(scope,scope+':agent:'+f.a.id),log=await f.seed(scope,scope+':agent:'+f.a.id,f.a.id,true);
 const team=await f.seed(scope,scope+':team'),peer=await f.seed(scope,scope+':agent:'+f.b.id,f.b.id),global=await f.seed('global','installation-global',f.memory.principalId);
 const result=await f.removeAgent();assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.cleanupPending,false);
 assert.deepEqual(new Set(await f.rows(scope)),new Set([team,peer]));assert.deepEqual(await f.rows(scope,true),[]);assert.deepEqual(await f.rows('global'),[global]);
 assert.equal((await f.rows(scope)).includes(own),false);assert.equal((await f.rows(scope,true)).includes(log),false);
}));
test('Chat deletion clears its exact collection pair and global grant without touching other scopes',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,other='chat:'+f.otherChat.id;
 await f.seed(scope,scope+':team');await f.seed(scope,scope+':agent:'+f.a.id,f.a.id,true);
 const kept=await f.seed(other,other+':team'),global=await f.seed('global','installation-global',f.memory.principalId);
 f.memory.setGrant(f.chat.id,true,0,'dev');
 const result=await f.api('DELETE','/api/conversations/'+f.chat.id);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.cleanupPending,false);
 assert.equal(await f.rows(scope),null);assert.equal(await f.rows(scope,true),null);
 assert.equal(f.memory.policy.prepare('SELECT 1 FROM local_memory_chat_grants WHERE chat_id=?').get(f.chat.id),undefined);
 assert.deepEqual(await f.rows(other),[kept]);assert.deepEqual(await f.rows('global'),[global]);
 await f.memory.provisionInventory();assert.equal(await f.rows(scope),null,'retired scope must not be recreated');
}));
test('partial Chat cleanup failure remains durable and idempotent after reopen',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id;await f.seed(scope,scope+':team');await f.seed(scope,scope+':team',f.a.id,true);
 const original=f.raw.client.deleteCollection.bind(f.raw.client);let refuse=true;
 f.raw.client.deleteCollection=async input=>{if(refuse&&input.name===f.raw.names(scope).log)throw Error('Controlled cleanup failure');return original(input);};
 const result=await f.api('DELETE','/api/conversations/'+f.chat.id);assert.equal(result.body.cleanupPending,true,JSON.stringify(result));
 assert.equal(f.store.getConversationDeletionReceipt(f.chat.id).serverCleanupCompleted,false);assert.equal(await f.rows(scope),null);assert.notEqual(await f.rows(scope,true),null);
 refuse=false;f.raw.client.deleteCollection=original;
 await f.reopen();
 const deadline=Date.now()+5000;while(!f.store.getConversationDeletionReceipt(f.chat.id).serverCleanupCompleted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.store.getConversationDeletionReceipt(f.chat.id).serverCleanupCompleted,true);assert.equal(await f.rows(scope,true),null);
}));
test('Project deletion purges every owned Chat memory scope before removing its canonical owners',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,other='chat:'+f.otherChat.id;
 await f.seed(scope,scope+':team');const kept=await f.seed(other,other+':team');
 const result=await f.api('DELETE','/api/projects/'+f.first.id);assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(await f.rows(scope),null);assert.equal(await f.rows(scope,true),null);assert.deepEqual(await f.rows(other),[kept]);
}));
test('Chat cleanup refuses foreign metadata and never erases it as host-owned data',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,id=await f.seed(scope,scope+':team'),collection=await f.raw.client.getCollection({name:f.raw.names(scope).memory}),row=await collection.get({ids:[id],include:['metadatas']});
 const metadata=row.metadatas[0],stamp=JSON.parse(metadata.host_source_authority);stamp.principal=randomUUID();
 await collection.update({ids:[id],metadatas:[{...metadata,host_source_authority:JSON.stringify(stamp)}]});
 const result=await f.api('DELETE','/api/conversations/'+f.chat.id);assert.equal(result.body.cleanupPending,true,JSON.stringify(result));
 assert.deepEqual(await f.rows(scope),[id]);assert.match(f.store.getConversationDeletionReceipt(f.chat.id).lastError,/Foreign|unclassified/);
}));

test('unowned cleanup and incompatible collection bindings fail closed',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,id=await f.seed(scope,scope+':team');
 await assert.rejects(f.memory.purgeChat(f.chat.id),/Exact committed Chat deletion/);assert.deepEqual(await f.rows(scope),[id]);
 const collection=await f.raw.client.getCollection({name:f.raw.names(scope).memory});
 await collection.modify({metadata:{...collection.metadata,embedding_signature:'foreign-model'}});
 const result=await f.api('DELETE','/api/conversations/'+f.chat.id);assert.equal(result.body.cleanupPending,true);assert.deepEqual(await f.rows(scope),[id]);
}));
test('Agent cleanup failure retains its durable receipt and retry preserves team data',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,own=await f.seed(scope,scope+':agent:'+f.a.id),team=await f.seed(scope,scope+':team');
 await f.seed(scope,scope+':agent:'+f.a.id,f.a.id,true);
 const original=f.raw.client.getCollection.bind(f.raw.client);let refuse=true;
 f.raw.client.getCollection=async input=>{const c=await original(input);if(input.name===f.raw.names(scope).log){const remove=c.delete.bind(c);c.delete=async args=>{if(refuse)throw Error('Controlled private cleanup failure');return remove(args);};}return c;};
 const result=await f.removeAgent();assert.equal(result.body.cleanupPending,true);assert.equal((await f.rows(scope)).includes(own),false);assert.deepEqual(await f.rows(scope),[team]);
 const receipt=f.store.listPendingAgentDeletionReceipts().find(r=>r.deletedAgentIds.includes(f.a.id));assert.ok(receipt);refuse=false;
 const retry=await f.api('POST','/api/projects/'+f.first.id+'/agent-deletions/commit',{rootAgentIds:[f.a.id],previewHash:receipt.previewHash});
 assert.equal(retry.body.cleanupPending,false,JSON.stringify(retry));assert.deepEqual(await f.rows(scope),[team]);assert.deepEqual(await f.rows(scope,true),[]);
}));
test('queued old memory work settles before Chat erasure and cannot leave a recreated scope',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id;let release,entered;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const old=f.raw.exclusive(async()=>{entered();await gate;await f.seed(scope,scope+':agent:'+f.a.id);});
 await started;
 const deleting=f.api('DELETE','/api/conversations/'+f.chat.id);
 const deadline=Date.now()+5000;while(!f.store.getConversationDeletionReceipt(f.chat.id)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.ok(f.store.getConversationDeletionReceipt(f.chat.id));release();await old;
 const result=await deleting;assert.equal(result.body.cleanupPending,false,JSON.stringify(result));assert.equal(await f.rows(scope),null);await f.memory.provisionInventory();assert.equal(await f.rows(scope),null);
}));
test('cleanup can erase valid scopes beyond the ordinary 10000-source read ceiling',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,privateId=await f.seed(scope,scope+':agent:'+f.a.id),collection=await f.raw.client.getCollection({name:f.raw.names(scope).memory});
 const template=(await collection.get({ids:[privateId],include:['metadatas']})).metadatas[0],stamp=JSON.parse(template.host_source_authority),vector=Array.from({length:384},(_,i)=>i?0:1);
 const populate=async audience=>{
  for(let offset=0;offset<10001;offset+=500){
   const ids=Array.from({length:Math.min(500,10001-offset)},()=>randomUUID());
   await collection.upsert({ids,documents:ids.map(()=> 'Disposable bulk lifecycle fixture'),embeddings:ids.map(()=>vector),metadatas:ids.map(id=>({...template,host_source_authority:JSON.stringify({...stamp,id,audience})}))});
  }
 };
 await populate(scope+':agent:'+f.a.id);
 const removed=await f.removeAgent();assert.equal(removed.body.cleanupPending,false,JSON.stringify(removed));assert.deepEqual(await f.rows(scope),[]);
 await populate(scope+':team');const result=await f.api('DELETE','/api/conversations/'+f.chat.id);
 assert.equal(result.body.cleanupPending,false,JSON.stringify(result));assert.equal(await f.rows(scope),null);
}));

test('backend without atomic delete holds Chat memory cleanup without dispatch or hidden orphan',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,id=await f.seed(scope,scope+':team'),originalDelete=f.raw.client.deleteCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.deleteCollection=async args=>{deletes++;return originalDelete(args);};
 try{
  const result=await f.api('DELETE','/api/conversations/'+f.chat.id);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.cleanupPending,true);
  const receipt=f.store.getConversationDeletionReceipt(f.chat.id);assert.match(receipt.lastError,/Memory cleanup held/);
  assert.equal(deletes,0);assert.deepEqual(await f.rows(scope),[id]);
  const holds=await f.api('GET','/api/local-memory/provisioning-holds');
  assert.equal(holds.status,200);assert.ok(holds.body.some(row=>row.scope==='unknown'&&/Memory cleanup held/.test(row.reason)));
  assert.equal(JSON.stringify(holds.body).includes(f.chat.id),false,'retired Chat identity is not leaked across products');
  const updatedAt=receipt.updatedAt;await f.reopen();
  const after=f.store.getConversationDeletionReceipt(f.chat.id);assert.equal(after.serverCleanupCompleted,false);assert.equal(after.updatedAt,updatedAt,'startup sweep does not retry a stable unsupported cleanup');
  assert.deepEqual(await f.rows(scope),[id]);
 }finally{f.raw.client.deleteCollection=originalDelete;}
}));

test('backend without record CAS holds Agent cleanup and preserves all rows',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,own=await f.seed(scope,scope+':agent:'+f.a.id),team=await f.seed(scope,scope+':team');
 const original=f.raw.client.getCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.getCollection=async args=>{const c=await original(args),remove=c.delete.bind(c);c.delete=async input=>{deletes++;return remove(input);};return c;};
 try{
  const result=await f.removeAgent();assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.cleanupPending,true);
  assert.equal(deletes,0);assert.deepEqual(new Set(await f.rows(scope)),new Set([own,team]));
  const receipt=f.store.listPendingAgentDeletionReceipts().find(row=>row.deletedAgentIds.includes(f.a.id));assert.ok(receipt);assert.match(receipt.lastError,/Memory cleanup held/);
  const holds=await f.api('GET','/api/local-memory/provisioning-holds');assert.ok(holds.body.some(row=>row.scope==='unknown'&&/Memory cleanup held/.test(row.reason)));
 }finally{f.raw.client.getCollection=original;}
}));

test('backend without atomic deletion holds Project cleanup before canonical removal',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,id=await f.seed(scope,scope+':team'),original=f.raw.client.deleteCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.deleteCollection=async args=>{deletes++;return original(args);};
 try{
  const result=await f.api('DELETE','/api/projects/'+f.first.id);
  assert.equal(result.status,503,JSON.stringify(result));assert.equal(result.body.cleanupPending,true);assert.equal(result.body.retryable,false);
  assert.equal(deletes,0);assert.deepEqual(await f.rows(scope),[id]);
  const holds=await f.api('GET','/api/local-memory/provisioning-holds');assert.ok(holds.body.some(row=>row.scope==='unknown'&&/Memory cleanup held/.test(row.reason)));
 }finally{f.raw.client.deleteCollection=original;}
}));

test('independent Chat cleanup errors are retried before the stable memory hold is recorded',async()=>{
 const {createConversationDeletionAuthority}=await import('../../apps/server/dist/conversation-deletion-authority.js');
 const {MEMORY_CLEANUP_HOLD}=await import('../../apps/server/dist/local-memory-authority.js');
 const receipt={conversationId:'synthetic-chat',projectId:'synthetic-project',canonicalDeletionCompleted:true,storageCleanupCompleted:true,serverCleanupCompleted:false};
 let assetFails=true,memoryCalls=0;
 const store={
  getConversationDeletionReceipt:()=>receipt,
  purgeOperatorChatArtifacts:()=>{},
  refreshConversationDeletionProjection:()=>{},
  recordConversationDeletionCleanupError:(_id,error)=>{receipt.lastError=error;},
  markConversationDeletionServerCleanupComplete:()=>{throw Error('memory hold must not complete cleanup');},
 };
 const workspace={deleteDraft:()=>{},getPreferences:()=>({}),reconcileConversationDeletion:()=>({type:'synthetic'})};
 const authority=createConversationDeletionAuthority({store,workspace,drafts:{deleteSurface:async()=>{},fenceMutations:async()=>()=>{}},assets:{purgeConversationAssets:async()=>{if(assetFails)throw Error('Synthetic asset cleanup unavailable');}},deletingConversationIds:new Set(),agentCreationConversationLeases:new Map(),conversationDeliveryLeases:new Map(),reconcileConversationRuntimeCommunicationProjections:async()=>0,purgeChatMemory:async()=>{memoryCalls++;throw Error(MEMORY_CLEANUP_HOLD);},commitAgentDeletion:async()=>{},purgeCommunicationV4Conversation:()=>{},publishWorkspace:()=>{}});
 assert.equal(await authority.processConversationDeletionCleanup(receipt),false);assert.equal(memoryCalls,0);assert.match(receipt.lastError,/Synthetic asset cleanup unavailable/);
 assetFails=false;assert.equal(await authority.processConversationDeletionCleanup(receipt),false);assert.equal(memoryCalls,1);assert.equal(receipt.lastError,MEMORY_CLEANUP_HOLD);
});


test('temporary Branch Agent and Chat cleanup uses retained owner proof across restart without touching foreign memory',()=>fixture(async f=>{
 const branches=new BranchStore(f.store.sqlite,new CoordinationV3Store(f.store.sqlite));
 const owner=branches.create('Temporary workflow','memory-temp-owner'),permissions={allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false};
 const template={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Worker',rootRef:'worker',agents:[{ref:'worker',title:'Worker',engine:'fixture',managementPermissions:permissions}]};
 const branch=branches.deploy({chatId:'',branchId:owner.id,expectedVersionId:'',idempotencyKey:'memory-temp-deploy',definition:{schema:'ponderosa.branch.v1',name:'Temporary workflow',trigger:{kind:'manual'},entry:'team',templates:{team:template},steps:[{id:'team',kind:'agent',target:{kind:'ephemeral_organization',templateRef:'team'},instructions:'Review'}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,maxEphemeralAgents:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root},engines:{fixture:'fixture'}}});
 const execution=branches.accept(branch.id,'input','Review');branches.advance();const provision=branches.resourceProvisions()[0];assert.ok(provision);
 const project=f.store.createProject({label:'Temporary',hostPath:f.root,defaultEngine:'fixture',chatOwned:true,branchId:branch.id,executionId:execution.id}),chat=f.store.getConversation(project.lastConversationId);
 branches.bindResourceChat(provision.stepExecutionId,chat.id);
 const agent=f.store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Temporary worker'});
 f.store.sqlite.prepare("INSERT INTO branch_resource_members(agent_id,step_execution_id,origin) VALUES(?,?,'template')").run(agent.id,provision.stepExecutionId);
 const scope='chat:'+chat.id,name=f.raw.names(scope).memory;
 await f.raw.client.createCollection({name,metadata:{fixture:'foreign'}});
 const preview=f.store.previewAgentDeletion([agent.id]);f.store.deleteAgentSubtrees([agent.id],preview.previewHash);
 const receipt=f.store.getAgentDeletionReceiptByPreviewHash(preview.previewHash);assert.ok(receipt.storageCleanupCompleted);
 await f.memory.purgeAgents(receipt);
 const deleted=f.store.commitConversationDeletion(chat.id);assert.ok(deleted.canonicalDeletionCompleted);
 assert.equal(f.memory.isProvenTemporaryChat(chat.id,project.id,branch.id),true);
 assert.equal(f.memory.isProvenTemporaryChat(chat.id,'foreign-project',branch.id),false);
 await f.memory.purgeAgents(receipt);
 await f.memory.purgeChat(chat.id);assert.equal((await f.raw.client.getCollection({name})).name,name);
 await f.reopen();await f.liveMemory.purgeChat(chat.id);assert.equal((await f.liveMemory.core.database.raw.client.getCollection({name})).name,name);
}));
