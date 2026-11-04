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
import {checkedCollection,MEMORY_CLEANUP_HOLD,MEMORY_CLEANUP_UNKNOWN_HOLD,isMemoryCleanupHold} from '../../apps/server/dist/local-memory-authority.js';

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
 const conflicts=await f.raw.client.getCollection({name:f.raw.names(scope).log});
 await conflicts.update({ids:[log],metadatas:[{chunk_ids:JSON.stringify([own]),chunk_ids_affected:JSON.stringify([own])}]});
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

test('unowned cleanup is rejected, incompatible binding is detected, and deletion remains held',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,id=await f.seed(scope,scope+':team');
 await assert.rejects(f.memory.purgeChat(f.chat.id),/Exact committed Chat deletion/);assert.deepEqual(await f.rows(scope),[id]);
 const collection=await f.raw.client.getCollection({name:f.raw.names(scope).memory});
 await collection.modify({metadata:{...collection.metadata,embedding_signature:'foreign-model'}});
 // The binding checker identifies the mismatch; the deletion path separately
 // remains held because this backend cannot guarantee safe physical cleanup.
 await assert.rejects(checkedCollection(f.raw,scope,false,async()=>{}),{name:'MemoryCollectionHold',message:'Incompatible memory collection binding'});
 const original=f.raw.client.deleteCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.deleteCollection=async input=>{deletes++;return original(input);};
 try{
  const result=await f.api('DELETE','/api/conversations/'+f.chat.id);assert.equal(result.body.cleanupPending,true);
  assert.match(f.store.getConversationDeletionReceipt(f.chat.id).lastError,/Incompatible memory collection binding/);
  assert.equal(deletes,0);assert.deepEqual(await f.rows(scope),[id]);
 }finally{f.raw.client.deleteCollection=original;}
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

// The old tests required unconditional backend-capability holds. The configured
// Ponderosa memory namespace is now internally serialized; keep preservation
// assertions and distinguish actual unknown effects in separate tests below.
test('internally serialized Chat cleanup deletes its owned collections and preserves other scopes',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,other='chat:'+f.otherChat.id;
 await f.seed(scope,scope+':team');const kept=await f.seed(other,other+':team'),global=await f.seed('global','installation-global',f.memory.principalId);
 const original=f.raw.client.deleteCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.deleteCollection=async args=>{deletes++;return original(args);};
 try{
  const result=await f.api('DELETE','/api/conversations/'+f.chat.id);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.cleanupPending,false);
  assert.equal(deletes,2);assert.equal(await f.rows(scope),null);assert.equal(await f.rows(scope,true),null);
  assert.deepEqual(await f.rows(other),[kept]);assert.deepEqual(await f.rows('global'),[global]);
  assert.equal(f.memory.core.database.scopeHasUnsettledMutation(scope),false);
  await f.reopen();assert.equal(f.store.getConversationDeletionReceipt(f.chat.id).serverCleanupCompleted,true);
 }finally{f.raw.client.deleteCollection=original;}
}));

test('internally serialized Agent cleanup deletes only its private records',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,own=await f.seed(scope,scope+':agent:'+f.a.id),team=await f.seed(scope,scope+':team');
 const original=f.raw.client.getCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.getCollection=async args=>{const c=await original(args),remove=c.delete.bind(c);c.delete=async input=>{deletes++;return remove(input);};return c;};
 try{
  const result=await f.removeAgent();assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.cleanupPending,false);
  assert.equal(deletes,1);assert.deepEqual(await f.rows(scope),[team]);assert.notEqual(own,team);
  assert.equal(f.memory.core.database.scopeHasUnsettledMutation(scope),false);
 }finally{f.raw.client.getCollection=original;}
}));

test('internally serialized Project cleanup preserves other Project memory',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,other='chat:'+f.otherChat.id;
 await f.seed(scope,scope+':team');const kept=await f.seed(other,other+':team');
 const original=f.raw.client.deleteCollection.bind(f.raw.client);let deletes=0;
 f.raw.client.deleteCollection=async args=>{deletes++;return original(args);};
 try{
  const result=await f.api('DELETE','/api/projects/'+f.first.id);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(deletes,2);
  assert.equal(await f.rows(scope),null);assert.equal(await f.rows(scope,true),null);assert.deepEqual(await f.rows(other),[kept]);
  assert.equal(f.memory.core.database.scopeHasUnsettledMutation(scope),false);
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

test('Chat cleanup waits for an already admitted Ponderosa memory write before deleting',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id;let release,entered;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),id=randomUUID();
 const authority={chatId:f.chat.id,actor:{kind:'agent',id:f.a.id},runId:'controlled-write',fenceToken:'1',sourceType:'ai_inference',readChat:true,readGlobal:false,writeScope:scope,visibility:'private',guard:async()=>{}};
 const write=f.memory.core.database.run(authority,async()=>{
  entered();await gate;
  await f.memory.core.database.put({id,scope,text:'Concurrent internal write',embedding:Array.from({length:384},(_,i)=>i?0:1),
   metadata:{source_type:'ai_inference',confidence:1,deprecated:false,timestamp:new Date().toISOString()}});
 });
 await started;
 const deleting=f.api('DELETE','/api/conversations/'+f.chat.id);
 const deadline=Date.now()+5000;while(!f.store.getConversationDeletionReceipt(f.chat.id)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.ok(f.store.getConversationDeletionReceipt(f.chat.id));release();await write;
 const result=await deleting;assert.equal(result.body.cleanupPending,false,JSON.stringify(result));
 assert.equal(await f.rows(scope),null);assert.equal(await f.rows(scope,true),null);
}));

test('lost collection delete response keeps an unknown-effect hold across restart without replay',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id;await f.seed(scope,scope+':team');await f.seed(scope,scope+':team',f.a.id,true);
 const original=f.raw.client.deleteCollection.bind(f.raw.client);let dispatches=0;
 f.raw.client.deleteCollection=async input=>{dispatches++;await original(input);throw Error('Controlled lost response');};
 const result=await f.api('DELETE','/api/conversations/'+f.chat.id);
 assert.equal(result.body.cleanupPending,true);assert.equal(dispatches,1);
 const receipt=f.store.getConversationDeletionReceipt(f.chat.id);
 assert.equal(receipt.lastError,MEMORY_CLEANUP_UNKNOWN_HOLD);
 assert.equal(await f.rows(scope),null);assert.notEqual(await f.rows(scope,true),null);
 assert.ok(f.memory.core.database.scopeHasUnsettledMutation(scope));
 await f.reopen();assert.ok(f.liveMemory.core.database.scopeHasUnsettledMutation(scope));
 const raw=f.liveMemory.core.database.raw,remove=raw.client.deleteCollection.bind(raw.client);let replayed=0;
 raw.client.deleteCollection=async input=>{replayed++;return remove(input);};
 try{
  await f.api('DELETE','/api/conversations/'+f.chat.id);
  assert.equal(replayed,0);assert.ok(f.liveMemory.core.database.scopeHasUnsettledMutation(scope));
  assert.notEqual(await f.rows(scope,true),null);
 }finally{raw.client.deleteCollection=remove;}
}));

test('Agent cleanup holds a private conflict that references team memory',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,own=await f.seed(scope,scope+':agent:'+f.a.id),team=await f.seed(scope,scope+':team');
 const conflict=await f.seed(scope,scope+':agent:'+f.a.id,f.a.id,true);
 const logs=await f.raw.client.getCollection({name:f.raw.names(scope).log});
 await logs.update({ids:[conflict],metadatas:[{chunk_ids:JSON.stringify([team]),chunk_ids_affected:JSON.stringify([team])}]});
 const result=await f.removeAgent();assert.equal(result.body.cleanupPending,true,JSON.stringify(result));
 assert.deepEqual(new Set(await f.rows(scope)),new Set([own,team]));
 assert.deepEqual(await f.rows(scope,true),[conflict]);
 const receipt=f.store.listPendingAgentDeletionReceipts().find(row=>row.deletedAgentIds.includes(f.a.id));
 assert.match(receipt.lastError,/Foreign or unclassified memory conflict/);assert.equal(isMemoryCleanupHold(receipt.lastError),true);
}));

test('same-process Ponderosa memory storages for one Chroma origin serialize without nested wrapping',()=>fixture(async f=>{
 const {ChromaStorage}=await import('@local-memory/mcp-node-private');
 const {AuthorityStorage}=await import('../../apps/server/dist/local-memory-authority.js');
 const second=new ChromaStorage(f.raw.options,f.raw.signature);
 new AuthorityStorage(second,f.memory.principalId,f.memory.core.inference);
 // Reusing the same storage must not wrap its queue twice and deadlock.
 new AuthorityStorage(f.raw,f.memory.principalId,f.memory.core.inference);
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),order=[];
 const first=f.raw.exclusive(async()=>{order.push('first');entered();await gate;order.push('first-done');});
 await started;const next=second.exclusive(async()=>{order.push('second');});
 await new Promise(r=>setImmediate(r));assert.deepEqual(order,['first']);
 release();await Promise.all([first,next]);assert.deepEqual(order,['first','first-done','second']);
 await second.close();
}));

test('acknowledged first collection deletion resumes after a pre-dispatch failure and restart',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id;await f.seed(scope,scope+':team');await f.seed(scope,scope+':team',f.a.id,true);
 const original=f.raw.client.getCollection.bind(f.raw.client);let logReads=0;
 f.raw.client.getCollection=async input=>{
  if(input.name===f.raw.names(scope).log&&++logReads===2)throw Error('Controlled failure before log delete');
  return original(input);
 };
 const result=await f.api('DELETE','/api/conversations/'+f.chat.id);
 f.raw.client.getCollection=original;
 assert.equal(result.body.cleanupPending,true,JSON.stringify(result));
 assert.equal(await f.rows(scope),null);assert.notEqual(await f.rows(scope,true),null);
 assert.equal(f.memory.core.database.scopeHasUnsettledMutation(scope),false,'No log mutation was dispatched');
 await f.reopen();
 const deadline=Date.now()+5000;while(!f.store.getConversationDeletionReceipt(f.chat.id).serverCleanupCompleted&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(f.store.getConversationDeletionReceipt(f.chat.id).serverCleanupCompleted,true);
 assert.equal(await f.rows(scope,true),null);
}));

test('Agent cleanup resumes after known pre-dispatch failure following conflict deletion',()=>fixture(async f=>{
 const scope='chat:'+f.chat.id,own=await f.seed(scope,scope+':agent:'+f.a.id),team=await f.seed(scope,scope+':team');
 const conflict=await f.seed(scope,scope+':agent:'+f.a.id,f.a.id,true);
 const logs=await f.raw.client.getCollection({name:f.raw.names(scope).log});
 await logs.update({ids:[conflict],metadatas:[{chunk_ids:JSON.stringify([own]),chunk_ids_affected:JSON.stringify([own])}]});
 const original=f.raw.client.getCollection.bind(f.raw.client);let memoryReads=0;
 f.raw.client.getCollection=async input=>{
  if(input.name===f.raw.names(scope).memory&&++memoryReads===2)throw Error('Controlled failure before source delete');
  return original(input);
 };
 const result=await f.removeAgent();f.raw.client.getCollection=original;
 assert.equal(result.body.cleanupPending,true,JSON.stringify(result));
 assert.deepEqual(await f.rows(scope,true),[]);assert.deepEqual(new Set(await f.rows(scope)),new Set([own,team]));
 assert.equal(f.memory.core.database.scopeHasUnsettledMutation(scope),false);
 const receipt=f.store.listPendingAgentDeletionReceipts().find(row=>row.deletedAgentIds.includes(f.a.id));assert.ok(receipt);
 const retry=await f.api('POST','/api/projects/'+f.first.id+'/agent-deletions/commit',{rootAgentIds:[f.a.id],previewHash:receipt.previewHash});
 assert.equal(retry.body.cleanupPending,false,JSON.stringify(retry));assert.deepEqual(await f.rows(scope),[team]);
}));

test('Project cleanup resumes after an earlier Chat was fully acknowledged',()=>fixture(async f=>{
 const project=f.store.createProject({label:'Multi Chat project',hostPath:f.root,defaultEngine:'fixture'},undefined,id=>f.memory.reserveNewChat(id));
 const first=f.store.getConversation(project.lastConversationId);
 await f.memory.provisionNewChat(first.id);
 const second=f.store.createConversation(project.id,{title:'Second',defaultEngine:'fixture'},undefined,undefined,id=>f.memory.reserveNewChat(id));
 await f.memory.provisionNewChat(second.id);
 const firstScope='chat:'+first.id,secondScope='chat:'+second.id;
 await f.seed(firstScope,firstScope+':team');await f.seed(secondScope,secondScope+':team');
 const original=f.raw.client.getCollection.bind(f.raw.client);let blocked=false;
 f.raw.client.getCollection=async input=>{
  if(input.name===f.raw.names(secondScope).memory&&!blocked){blocked=true;throw Error('Controlled failure before second Chat cleanup');}
  return original(input);
 };
 const result=await f.api('DELETE','/api/projects/'+project.id);f.raw.client.getCollection=original;
 assert.equal(result.body.cleanupPending,true,JSON.stringify(result));assert.equal(blocked,true);
 assert.equal(await f.rows(firstScope),null);assert.equal(await f.rows(firstScope,true),null);assert.notEqual(await f.rows(secondScope),null);
 assert.equal(f.memory.core.database.scopeHasUnsettledMutation(secondScope),false);
 const retry=await f.api('DELETE','/api/projects/'+project.id);
 assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(await f.rows(secondScope),null);assert.equal(await f.rows(secondScope,true),null);
}));

test('legacy and unknown-result memory holds share stable classification',()=>{
 assert.equal(isMemoryCleanupHold(MEMORY_CLEANUP_HOLD),true);
 assert.equal(isMemoryCleanupHold(new Error(MEMORY_CLEANUP_UNKNOWN_HOLD)),true);
 assert.equal(isMemoryCleanupHold('Controlled ordinary error'),false);
});
