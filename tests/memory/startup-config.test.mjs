import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,chmod,symlink,link,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentStore} from '@ponderosa/agents';
import {LocalMemoryService} from '../../apps/server/dist/local-memory.js';
import {loadLocalMemoryConfiguration} from '../../apps/server/dist/local-memory-config.js';
const valid={chromaUrl:'http://127.0.0.1:8000',collectionPrefix:'private_branches',modelDir:'/synthetic/models',stateDirectory:'/synthetic/policy',provision:true};
async function fixture(run){const root=await mkdtemp(path.join(tmpdir(),'memory-config-'));const file=path.join(root,'memory.json');try{await writeFile(file,JSON.stringify(valid),{mode:0o600});await run(file,root);}finally{await rm(root,{recursive:true,force:true});}}
test('normal server memory remains opt-in without a configuration file',()=>{assert.equal(loadLocalMemoryConfiguration(undefined),undefined);assert.equal(loadLocalMemoryConfiguration(''),undefined);});
test('operator configuration supplies the same physical-memory options for generic Branches startup',()=>fixture(async file=>{assert.deepEqual(loadLocalMemoryConfiguration(file),valid);}));
test('legacy journal configuration is refused without rewriting or creating state',()=>fixture(async file=>{await writeFile(file,JSON.stringify({...valid,journalDirectory:'/synthetic/old-journal'}));const before=await readFile(file);assert.throws(()=>loadLocalMemoryConfiguration(file),/legacy journal/);assert.deepEqual(await readFile(file),before);}));
test('configuration refuses missing paths, relative paths, URL credentials and truthy non-boolean provisioning',()=>fixture(async file=>{
 for(const patch of [{modelDir:''},{stateDirectory:'relative'}, {chromaUrl:'http://synthetic:secret@127.0.0.1:8000'},{chromaUrl:'file:///synthetic'},{provision:'true'},{chatId:'forged-scope'}]){
  await writeFile(file,JSON.stringify({...valid,...patch}));assert.throws(()=>loadLocalMemoryConfiguration(file));
 }
 assert.throws(()=>loadLocalMemoryConfiguration('relative.json'),/absolute/);
}));
test('operator configuration rejects replaceable symlinks and writable-by-others files',()=>fixture(async(file,root)=>{
 const link=path.join(root,'link.json');await symlink(file,link);assert.throws(()=>loadLocalMemoryConfiguration(link));
 await chmod(file,0o666);assert.throws(()=>loadLocalMemoryConfiguration(file),/operator-owned/);
}));
test('operator configuration rejects oversized input before parsing',()=>fixture(async file=>{await writeFile(file,' '.repeat(16385));assert.throws(()=>loadLocalMemoryConfiguration(file),/16KiB/);}));

async function admittedFixture(run){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'memory-admitted-root-'))),dataDir=path.join(root,'data'),store=new AgentStore(dataDir),admission=store.stateAdmission();
 const inference={signature:'synthetic-authority-check',async embed(){throw Error('No inference expected');},async rerank(){throw Error('No inference expected');},async close(){}};
 const ports={store,opts:{dataDir:admission.dataDir,localMemory:{stateDirectory:path.join(root,'policy'),chromaUrl:'http://127.0.0.1:1',collectionPrefix:'synthetic_authority_check',modelDir:root,provision:true}},capabilities:new Map(),activeRuns:new Map(),ownsRun:()=>false};
 try{await run({root,dataDir,ports,inference});}finally{admission.close();store.close();await rm(root,{recursive:true,force:true});}
}

test('Local Memory initializes its policy against the held canonical root without starting inference or Chroma',()=>admittedFixture(async({ports,inference})=>{
 const memory=new LocalMemoryService(ports,inference);
 try{assert.match(memory.principalId,/^[0-9a-f-]{36}$/);assert.equal(memory.policy.open,true);}finally{await memory.close();}
 ports.opts.localMemory.provision=false;
 const reopened=new LocalMemoryService(ports,inference);
 try{assert.equal(reopened.principalId,memory.principalId);}finally{await reopened.close();}
}));

test('Local Memory refuses policy state inside the physical admitted data directory',()=>admittedFixture(async({dataDir,ports,inference})=>{
 for(const stateDirectory of [dataDir,path.join(dataDir,'policy')]){
  ports.opts.localMemory.stateDirectory=stateDirectory;
  assert.throws(()=>new LocalMemoryService(ports,inference),/outside canonical dataDir/);
 }
}));

test('Local Memory preserves private external-policy and explicit provisioning checks',()=>admittedFixture(async({root,ports,inference})=>{
 const stateDirectory=path.join(root,'external-policy');await mkdir(stateDirectory,{mode:0o700});
 ports.opts.localMemory={...ports.opts.localMemory,stateDirectory,provision:false};
 assert.throws(()=>new LocalMemoryService(ports,inference),/explicit provision/);
}));

test('Local Memory excludes the held physical root after its display path is renamed and replaced',()=>admittedFixture(async({root,dataDir,ports,inference})=>{
 const moved=path.join(root,'moved-data');await rename(dataDir,moved);await mkdir(dataDir);
 ports.opts.reportedDataDir=dataDir;
 ports.opts.localMemory.stateDirectory=path.join(moved,'policy');
 assert.throws(()=>new LocalMemoryService(ports,inference),/outside canonical dataDir/);
}));

test('Local Memory still refuses policy aliases, broad permissions and hard-linked databases',()=>admittedFixture(async({root,ports,inference})=>{
 const stateDirectory=ports.opts.localMemory.stateDirectory;await mkdir(stateDirectory,{mode:0o700});
 const alias=path.join(root,'alias');await symlink(stateDirectory,alias);
 ports.opts.localMemory.stateDirectory=alias;
 assert.throws(()=>new LocalMemoryService(ports,inference),/aliases unsupported/);
 ports.opts.localMemory.stateDirectory=stateDirectory;
 await chmod(stateDirectory,0o755);
 assert.throws(()=>new LocalMemoryService(ports,inference),/must be private/);
 await chmod(stateDirectory,0o700);
 const memory=new LocalMemoryService(ports,inference);await memory.close();
 await link(path.join(stateDirectory,'host-policy.sqlite'),path.join(root,'linked-policy.sqlite'));
 assert.throws(()=>new LocalMemoryService(ports,inference),/private regular file/);
}));

import {CapabilityPolicyStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {AuthorityStorage} from '../../apps/server/dist/local-memory-authority.js';

function authorizeMemoryAgent(ports,root){
 const project=ports.store.createProject({label:'Global writes',hostPath:root,defaultEngine:'inert',chatOwned:true});
 const chat=ports.store.getConversation(project.lastConversationId),agent=ports.store.createAgent(project.id,{engine:'inert',conversationId:chat.id,title:'Writer'});
 const at=new Date().toISOString(),lease=new Date(Date.now()+60000).toISOString();
 ports.store.sqlite.prepare("INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at,scope_key) VALUES(?,?,?,'running','owned',?,1,'injected',?,?,?,?)").run('owned-global-run',project.id,agent.id,lease,at,at,at,'conversation:'+chat.id);
 const capability={agentId:agent.id,conversationId:chat.id,runId:'owned-global-run',v3SchedulerRunId:'owned-global-run',v3FencingToken:1,availableToolNames:['save','update','forget'].map(n=>'ponderosa_local_memory_'+n)};
 ports.capabilities.set('owned-capability',capability);ports.activeRuns.set(agent.id,{messageCapability:'owned-capability',conversationId:chat.id,controller:new AbortController()});ports.ownsRun=()=>true;
 return {chat,agent};
}

test('global writes use live human policy, correct scope and provenance without operator authentication',()=>admittedFixture(async({root,ports,inference})=>{
 const {chat,agent}=authorizeMemoryAgent(ports,root);
 const memory=new LocalMemoryService(ports,inference),policies=new CapabilityPolicyStore(ports.store.sqlite);
 memory.ready=async()=>{};
 let captured;
 memory.perform=async(_operation,_args,authority)=>{await authority.guard();captured=authority;return {ok:true};};
 try{
  assert.equal(memory.operator({raw:{aborted:false},headers:{}}),memory.principalId);
  await memory.executeAgent('owned-capability','save',{text:'Global fact',destination:'global'});
  assert.equal(captured.writeScope,'global');assert.equal(captured.sourceType,'ai_inference');assert.deepEqual(captured.actor,{kind:'agent',id:agent.id});
  const oldGuard=captured.guard;
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryWrite]});
  await assert.rejects(oldGuard,/policy denies/);
  await assert.rejects(memory.executeAgent('owned-capability','save',{text:'Denied',destination:'global'}),/policy denies/);
  policies.put({scopeKind:'agent',scopeId:agent.id,expectedRevision:1,restrictedCapabilityIds:[]});
  await assert.rejects(memory.executeAgent('owned-capability','update',{chunk_id:'source',text:'Changed',destination:'global'}),/global source mutation requires read/);
  memory.setGrant(chat.id,true,0,'dev');
  await memory.executeAgent('owned-capability','update',{chunk_id:'source',text:'Changed',destination:'global'});
  assert.equal(captured.targetId,'source');assert.equal(captured.readGlobal,true);
  const globalGuard=captured.guard;memory.setGrant(chat.id,false,1,'dev');await assert.rejects(globalGuard,/grant revoked/);
  await assert.rejects(memory.executeAgent('owned-capability','save',{text:'Private',destination:'global',visibility:'private'}),/Global private/);
  await memory.executeAgent('owned-capability','save',{text:'Chat fact',destination:'chat'});assert.equal(captured.writeScope,'chat:'+chat.id);
  ports.activeRuns.get(agent.id).controller.abort();await assert.rejects(memory.executeAgent('owned-capability','save',{text:'Expired',destination:'global'}),/expired canonical Run/);
 }finally{await memory.close();}
}));

test('agent-authored global records remain readable across authority calls with genuine AI provenance',async()=>{
 const rows=new Map(),vector=Array.from({length:384},(_,i)=>i?0:1);
 const collection={metadata:{'hnsw:space':'cosine',embedding_signature:'owned',dimensions:384},async get({ids}={}){const chosen=[...rows].filter(([id])=>!ids||ids.includes(id));return {ids:chosen.map(([id])=>id),metadatas:chosen.map(([,r])=>r.metadata),documents:chosen.map(([,r])=>r.text),embeddings:chosen.map(([,r])=>r.embedding)};},async upsert({ids,metadatas,documents,embeddings}){ids.forEach((id,i)=>rows.set(id,{metadata:metadatas[i],text:documents[i],embedding:embeddings[i]}));}};
 const raw={signature:'owned',exclusive:fn=>fn(),names:()=>({memory:'owned-memory',log:'owned-log'}),client:{getCollection:async()=>collection}};
 const storage=new AuthorityStorage(raw,'owned-principal',{}),authority={chatId:'owned-chat',actor:{kind:'agent',id:'writer'},runId:'owned-run',fenceToken:'1',sourceType:'ai_inference',readGlobal:true,readChat:true,writeScope:'global',guard:async()=>{}};
 await storage.run(authority,()=>storage.put({id:'fact',scope:'global',text:'Retained global fact',embedding:vector,metadata:{source_type:'ai_inference',confidence:1,deprecated:false,timestamp:new Date().toISOString()}}));
 const result=await storage.run({...authority,writeScope:undefined},()=>storage.get('fact',['global']));
 assert.equal(result.text,'Retained global fact');const stamp=JSON.parse(result.metadata.host_source_authority);assert.equal(stamp.provenance.actor.kind,'agent');assert.equal(stamp.sourceType,'ai_inference');
});

// Optional real physical-source qualification; always launches its own Chroma root.
test('real Chroma stores and retrieves an Agent global write through the complete host/core path',{skip:!process.env.PONDEROSA_TEST_CHROMA_BIN,timeout:30000},()=>admittedFixture(async({root,ports})=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),net=await import('node:net');
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.env.PONDEROSA_TEST_CHROMA_BIN,['run','--path',path.join(root,'chroma'),'--host','127.0.0.1','--port',String(port)],{stdio:'ignore',env:{PATH:process.env.PATH,ANONYMIZED_TELEMETRY:'False',TMPDIR:root}}),exit=once(child,'exit');
 let memory;
 try{
  ports.opts.localMemory.chromaUrl='http://127.0.0.1:'+port;
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Owned Chroma exited');try{if((await fetch(ports.opts.localMemory.chromaUrl+'/api/v2/heartbeat')).ok)break;}catch{}await new Promise(r=>setTimeout(r,25));}
  const {chat}=authorizeMemoryAgent(ports,root);ports.capabilities.get('owned-capability').availableToolNames.push('ponderosa_local_memory_get');
  const inference={signature:'synthetic-global-qualification',async embed(){return Array.from({length:384},(_,i)=>i?0:1);},async rerank(pairs){return pairs.map(()=>1);},async close(){}};
  memory=new LocalMemoryService(ports,inference);memory.setGrant(chat.id,true,0,'dev');
  const saved=await memory.executeAgent('owned-capability','save',{text:'Disposable global fact',destination:'global'}),id=saved.structuredContent.result.chunk_id;
  assert.equal(typeof id,'string');
  const found=await memory.executeAgent('owned-capability','get',{chunk_id:id,source:'global'});
  assert.equal(found.structuredContent.result.found,true);assert.match(JSON.stringify(found),/Disposable global fact/);
  const raw=await memory.core.database.raw.client.getCollection({name:memory.core.database.raw.names('global').memory});
  const records=await raw.get({ids:[id],include:['metadatas']});const stamp=JSON.parse(records.metadatas[0].host_source_authority);
  assert.equal(stamp.provenance.actor.kind,'agent');assert.equal(stamp.sourceType,'ai_inference');assert.equal(stamp.scope,'global');
  const updated=await memory.executeAgent('owned-capability','update',{chunk_id:id,text:'Changed disposable global fact',destination:'global'}),next=updated.structuredContent.result.chunk_id;
  assert.equal(updated.structuredContent.result.updated_from_chunk_id,id);assert.notEqual(next,id);
  const changed=await memory.executeAgent('owned-capability','get',{chunk_id:next,source:'global'});assert.match(changed.structuredContent.result.text,/Changed disposable/);
  const forgotten=await memory.executeAgent('owned-capability','forget',{chunk_id:next,destination:'global'});assert.equal(forgotten.structuredContent.result.deleted,true);

 }finally{if(memory)await memory.close();child.kill('SIGTERM');await exit;}
}));
