import {after} from 'node:test';
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
async function ownedChroma(){
 if(chroma)return chroma.url;
 const root=await mkdtemp(path.join(tmpdir(),'memory-package-chroma-')),reserve=net.createServer();
 await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const child=spawn(process.env.PONDEROSA_TEST_CHROMA_BIN??'chroma',['run','--path',root,'--host','127.0.0.1','--port',String(port)],{stdio:'ignore',env:{...process.env,ANONYMIZED_TELEMETRY:'False'}});
 chroma={root,child,url:'http://127.0.0.1:'+port,exit:once(child,'exit')};
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('Owned Chroma exited');try{if((await fetch(chroma.url+'/api/v2/heartbeat')).ok)return chroma.url;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Owned Chroma unavailable');
}
after(async()=>{if(chroma){chroma.child.kill('SIGTERM');await chroma.exit;await rm(chroma.root,{recursive:true,force:true});}});
export async function instance(t,branch=false,memoryConfigured=true){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'memory-package-'))),dataDir=path.join(root,'data'),token=randomUUID();let store=new AgentStore(dataDir),app;
 const adapter={id:'fixture',displayName:'Inert',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=>'fixture',defaultEffort:()=>'medium',async*seed(){throw Error('No provider turn allowed');},async*continue(){throw Error('No provider turn allowed');}};
 const branchId=branch?new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)).create('Portable memory scope','fixture').id:undefined;
 const project=store.createProject({label:'Memory portability',hostPath:root,defaultEngine:'fixture',chatOwned:true,...(branchId?{branchId}:{})}),chat=store.getConversation(project.lastConversationId);
 const a=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Included'}),b=store.createAgent(project.id,{engine:'fixture',conversationId:chat.id,title:'Excluded'});
 const options={dataDir,authToken:token,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,localMemory:{chromaUrl:await ownedChroma(),collectionPrefix:'package_'+randomUUID().replaceAll('-',''),modelDir:process.env.PONDEROSA_TEST_MEMORY_MODEL_DIR??path.join(tmpdir(),'unconfigured-memory-models'),stateDirectory:path.join(root,'policy'),provision:true}};
 const open=async()=>{app=createServer({...options,...(!memoryConfigured?{localMemory:undefined}:{}),store});await app.ready();};
 const close=async()=>{app.prepareForShutdown();await app.close();store.close();};await open();
 t.after(async()=>{await close();await rm(root,{recursive:true,force:true});});
 const f={root,project,chat,a,b,options,dataDir,headers:{authorization:'Bearer '+token},get app(){return app;},get memory(){return localMemoryFor(app);},get store(){return store;},async reopen(){await close();store=new AgentStore(dataDir);await open();},async suspend(){await close();},async resume(){store=new AgentStore(dataDir);await open();}};return f;
}
export const vector=Array.from({length:384},(_,i)=>i?0:1);
export async function seed(f,embedding=vector){
 const memory=f.memory,raw=memory.core.database.raw,scope='chat:'+f.chat.id,at=new Date().toISOString();
 const provenance={actor:{kind:'agent',id:f.a.id},runId:'source-not-a-live-run',fenceToken:'historical-source',at};
 const row=(id,audience,text,parent)=>({id,text,embedding,metadata:{source_type:'ai_inference',confidence:0.9,deprecated:Boolean(parent===null),timestamp:at,...(typeof parent==='string'?{supersedes:parent}:{})},stamp:{format:1,principal:memory.principalId,id,scope,ownerChat:f.chat.id,audience,sourceType:'ai_inference',provenance,origin:provenance}});
 const parent=randomUUID(),child=randomUUID(),privateId=randomUUID(),outside=randomUUID(),conflict=randomUUID();
 const rows=[row(parent,scope+':team','Original seeded team fact',null),row(child,scope+':team','Revised seeded team fact 😀',parent),row(privateId,scope+':agent:'+f.a.id,'Included private fact'),row(outside,scope+':agent:'+f.b.id,'EXCLUDED_PRIVATE_FACT')];
 const c=await raw.client.getCollection({name:raw.names(scope).memory});
 await c.upsert({ids:rows.map(r=>r.id),documents:rows.map(r=>r.text),embeddings:rows.map(r=>r.embedding),metadatas:rows.map(r=>({...r.metadata,host_source_authority:JSON.stringify(r.stamp)}))});
 const log=await raw.client.getCollection({name:raw.names(scope).log}),r=row(conflict,scope+':team','Preserved conflict reasoning');
 await log.upsert({ids:[conflict],documents:[r.text],embeddings:[embedding],metadatas:[{...r.metadata,log_id:conflict,chunk_ids:JSON.stringify([parent,child]),chunk_ids_affected:JSON.stringify([parent,child]),chunks_affected:2,host_conflict_authority:JSON.stringify(r.stamp)}]});
 const global=await raw.client.getCollection({name:raw.names('global').memory}),gid=randomUUID(),gprov={...provenance,actor:{kind:'user',id:memory.principalId}};
 await global.upsert({ids:[gid],documents:['EXCLUDED_GLOBAL_FACT'],embeddings:[embedding],metadatas:[{...r.metadata,source_type:'user_statement',host_source_authority:JSON.stringify({...r.stamp,id:gid,scope:'global',ownerChat:'global',audience:'installation-global',sourceType:'user_statement',provenance:gprov,origin:gprov})}]});
 return {parent,child,privateId};
}
export async function read(f,agentId,readGlobal=false,readChat=true){
 const a={chatId:f.chat.id,actor:{kind:'agent',id:agentId},runId:'trusted-test-read',fenceToken:'1',sourceType:'ai_inference',readChat,readGlobal,observeExposure:false,guard:async()=>{}};
 return f.memory.core.database.run(a,()=>f.memory.core.database.list(['chat:'+f.chat.id,...(readGlobal?['global']:[])]));
}
