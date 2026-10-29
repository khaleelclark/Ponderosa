import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,BranchStore,readManagedArtifactContent} from '@ponderosa/agents';
import {AssetStore} from '../../apps/server/dist/assets.js';
import {registerAgentPackageRoutes} from '../../apps/server/dist/routes/agent-packages.js';
import {EXECUTION_ARCHIVE_MEDIA_TYPE,validateExecutionArchive,executionArchive} from '../../apps/server/dist/portable-execution-archive.js';

async function instance(t,branch=false){
 const dataDir=await mkdtemp(path.join(tmpdir(),'execution-portability-'));let store,assets,app,engine;
 const open=async()=>{
  store=new AgentStore(dataDir);assets=new AssetStore(dataDir);app=Fastify();
  const coordination=new CoordinationV3Store(store.sqlite);
  engine=registerAgentPackageRoutes(app,{dataDir,store,coordination,assets,engines:new Map([['codex',{adapter:{id:'codex',listModels:()=>[],listEfforts:()=>[]}}]]),deletingProjectIds:new Set(),deletingConversationIds:new Set(),deletingAgentIds:new Set(),agentCreationConversationLeases:new Map(),cachedModelOptions:()=>[],appendWorkspace(){},agentMessages:id=>store.getProjectedAgentMessages(id),createOperationalNotification(){}}).packageEngine;
  await app.ready();
 };
 const close=async()=>{await app.close();assets.close();store.close();};await open();
 t.after(async()=>{await close();await rm(dataDir,{recursive:true,force:true});});
 const branchId=branch?new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite)).create('Portable workflow','fixture').id:undefined;
 const project=store.createProject({label:'Portable evidence',hostPath:dataDir,defaultEngine:'codex',chatOwned:true,...(branchId?{branchId}:{})});
 return {dataDir,project,get store(){return store;},get app(){return app;},get engine(){return engine;},async reopen(){await close();await open();}};
}
const archives=pkg=>pkg.agents.flatMap(node=>node.artifacts??[]).filter(a=>a.mediaType===EXECUTION_ARCHIVE_MEDIA_TYPE);
function seed(f){
 const root=f.store.createAgent(f.project.id,{title:'Root',engine:'codex',conversationId:f.project.lastConversationId});
 const child=f.store.createAgent(f.project.id,{title:'Child',engine:'codex',conversationId:f.project.lastConversationId,managerAgentId:root.id});
 const outside=f.store.createAgent(f.project.id,{title:'Outside',engine:'codex',conversationId:f.project.lastConversationId});
 f.store.appendEvent(root.id,{type:'command',command:'printf exact-😀',cwd:'/historical/root'});
 f.store.appendEvent(root.id,{type:'tool_call',id:'tool',name:'fixture',input:{safe:'kept',apiKey:'EXCLUDED_KEY',nested:{authorization:'EXCLUDED_AUTH',password:'EXCLUDED_PASSWORD'},token:'EXCLUDED_TOKEN',encoded:JSON.stringify({api_key:'EXCLUDED_JSON_KEY',safe:'encoded kept'})}});
 f.store.appendEvent(child.id,{type:'error',message:'Original failure cause'});
 f.store.appendEvent(outside.id,{type:'command',command:'OUTSIDE_PRIVATE_MARKER',cwd:'/outside'});
 const now=new Date().toISOString();
 f.store.sqlite.prepare(`INSERT INTO scheduler_runs(id,project_id,agent_id,status,lease_owner,lease_expires_at,fencing_token,prompt_injection_state,heartbeat_at,created_at,updated_at) VALUES(?,?,?,'running','SOURCE_LEASE_SECRET',?,1,'injected',?,?,?)`).run(randomUUID(),f.project.id,root.id,now,now,now,now);
 return {root,child};
}
for(const branch of [false,true])test(`fresh-instance ${branch?'Branches Agent':'organization'} execution evidence retains bytes without creating live work`,async t=>{
 const source=await instance(t,branch),destination=await instance(t,branch),{root,child}=seed(source);
 const response=branch?undefined:await source.app.inject({method:'GET',url:`/api/agents/${root.id}/export?mode=full&organization=true`});
 if(response)assert.equal(response.statusCode,200,response.body);
 const pkg=branch?await source.engine.exportAgent(root.id,'full'):response.json();
 assert.equal(archives(pkg).length,branch?1:2);
 const exported=archives(pkg).map(a=>Buffer.from(a.dataBase64,'base64'));
 assert.match(exported[0].toString(),/exact-😀/);
 assert.match(exported[0].toString(),/"status":"running"/);
 assert.doesNotMatch(JSON.stringify(pkg),/EXCLUDED_|SOURCE_LEASE_SECRET|OUTSIDE_PRIVATE_MARKER/);
 const template=await source.engine.exportAgent(root.id,'template');assert.equal(archives(template).length,0);
 const key=randomUUID();
 const imported=await destination.engine.importAgent(destination.project.id,destination.project.lastConversationId,pkg,{codex:'codex'},key);
 assert.deepEqual(await destination.engine.importAgent(destination.project.id,destination.project.lastConversationId,pkg,{codex:'codex'},key),imported,'idempotent receipt does not duplicate evidence');
 assert.equal(imported.agentIds.length,branch?1:2);
 if(!branch){const importedChild=destination.store.listAgents(destination.project.id).find(a=>a.title===child.title);assert.equal(importedChild.managerAgentId,imported.rootAgentId);}
 for(const table of ['scheduler_runs','agent_activations','provider_operation_outbox'])assert.equal(destination.store.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 const retained=destination.store.getProjectArtifacts(destination.project.id).filter(a=>a.mediaType===EXECUTION_ARCHIVE_MEDIA_TYPE).map(a=>readManagedArtifactContent(destination.dataDir,destination.project.id,a.id,a.size,a.sha256)?.body);
 for(const bytes of exported)assert.ok(retained.some(actual=>actual?.equals(bytes)),'source archive bytes retained after identity remapping');
 await destination.reopen();
 const next=branch?await destination.engine.exportAgent(imported.rootAgentId,'full'):(await destination.app.inject({method:'GET',url:`/api/agents/${imported.rootAgentId}/export?mode=full&organization=true`})).json();
 for(const artifact of archives(pkg))assert.ok(archives(next).some(a=>a.dataBase64===artifact.dataBase64),'retained archive bytes survive reopen and re-export');
 assert.equal(destination.store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_runs').get().n,0);
});

test('execution archive schema errors refuse import before destination Agent creation',async t=>{
 const source=await instance(t),destination=await instance(t),{root}=seed(source);
 const pkg=await source.engine.exportAgent(root.id,'full'),artifact=archives(pkg)[0],original=JSON.parse(Buffer.from(artifact.dataBase64,'base64'));
 for(const mutate of [a=>a.schema='ponderosa.execution-archive.v999',a=>a.extraAuthority=true,a=>a.events[0].seq=0,a=>a.events[0].event.api_key='excluded',a=>a.runs[0].status='invented']){
  const invalid=structuredClone(original);mutate(invalid);artifact.dataBase64=Buffer.from(JSON.stringify(invalid)).toString('base64');
  await assert.rejects(destination.engine.importAgent(destination.project.id,destination.project.lastConversationId,pkg,{codex:'codex'},randomUUID()),/Execution archive|execution archive/);
  assert.equal(destination.store.listAgents(destination.project.id).length,0);
  assert.equal(destination.store.getProjectArtifacts(destination.project.id).length,0);
 }
 assert.throws(()=>validateExecutionArchive(Buffer.from([0xff])),/UTF-8 JSON/);
 assert.throws(()=>executionArchive(source.store,root.id,10),/byte limit/);
});
