import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {AgentStore,importedAgentHistoryPath,CompactionHistoryQueryError} from '@ponderosa/agents';
import {PONDEROSA_HISTORY_TOOL} from '@ponderosa/core';
import {registerAgentRuntimeToolRoutes} from '../../apps/server/dist/routes/agent-runtime-tools.js';

async function fixture(t,work){
 const root=await mkdtemp(path.join(tmpdir(),'ponderosa-imported-reader-'));let store=new AgentStore(root),passed=false;
 const project=store.createProject({label:'Private imports',hostPath:root,defaultEngine:'codex'}),chat=store.createConversation(project.id,{title:'Imported owner'});
 const agent=store.createAgent(project.id,{title:'Reader',engine:'codex',conversationId:chat.id}),other=store.createAgent(project.id,{title:'Private peer',engine:'codex',conversationId:chat.id});
 const key='owned-fixture-run-key';
 const input=()=>({agentId:agent.id,archiveVersion:store.getImportedHistoryAvailability(agent.id).archiveVersion,integrityKey:key});
 try{await work({root,project,chat,agent,other,key,get store(){return store},input,file:importedAgentHistoryPath(root,project.id,agent.id),reopen(){store.close();store=new AgentStore(root)}});passed=true}
 finally{store.close();if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic(`Failed disposable import fixture: ${root}`)}
}
async function searchAll(f,query){let continuation,hits=[],pages=0;do{
 const {response}=await f.store.searchImportedHistory({...f.input(),query,...(continuation?{continuation}:{})});
 assert.ok(response.scannedWindows<=32);assert.equal(Buffer.byteLength(JSON.stringify(response)),response.utf8Bytes);assert.ok(response.utf8Bytes<=6000);
 hits.push(...response.hits);continuation=response.continuation;assert.equal(Boolean(continuation),response.hasMore);assert.ok(++pages<50);
}while(continuation);return {hits,pages}}
async function readAll(f,reference){let continuation,text='',offset=0;do{
 const {response}=await f.store.readImportedHistory({...f.input(),reference,...(continuation?{continuation}:{})});const message=response.messages[0];
 assert.equal(message.startCodePoint,offset);assert.ok(message.endCodePoint>offset||message.complete);offset=message.endCodePoint;text+=message.text;
 assert.equal(Buffer.byteLength(JSON.stringify(response)),response.utf8Bytes);assert.ok(response.utf8Bytes<=8000);continuation=message.continuation;
}while(continuation);return text}

test('private imported search crosses bounded windows and reads every retained Unicode/NUL chunk',t=>fixture(t,async f=>{
 const text='CANONICAL_BEGIN '+('東京🌲\0'.repeat(12000))+' LATE_ORCHARD_EVIDENCE';
 f.store.setImportedHistory(f.agent.id,'Synthetic retained import',[{role:'assistant',text}],'IMPORTED_GUIDANCE_ONLY');
 f.store.setImportedHistory(f.other.id,'Other private import',[{role:'user',text:'PERSIMMONPEERSECRET'}]);
 const found=await searchAll(f,'LATE_ORCHARD_EVIDENCE');assert.ok(found.pages>1,'The late fact must lie beyond the first bounded search page');assert.equal(found.hits.length,1);
 assert.equal(found.hits[0].sourceLabel,'Imported History');assert.match(found.hits[0].excerpt.text,/LATE_ORCHARD/);
 assert.equal(await readAll(f,found.hits[0].reference),text);
 const guidance=await searchAll(f,'IMPORTED_GUIDANCE_ONLY');assert.equal(guidance.hits[0].sourceLabel,'Imported Guidance');
 assert.equal((await searchAll(f,'PERSIMMONPEERSECRET')).hits.length,0);
 const foreign={...f.input(),agentId:f.other.id,archiveVersion:f.store.getImportedHistoryAvailability(f.other.id).archiveVersion};
 await assert.rejects(f.store.readImportedHistory({...foreign,reference:found.hits[0].reference}),/unavailable|changed|another/);
 const first=await f.store.searchImportedHistory({...f.input(),query:'LATE_ORCHARD_EVIDENCE'});assert.ok(first.response.continuation);
 await assert.rejects(f.store.searchImportedHistory({...f.input(),query:'different orchard',continuation:first.response.continuation}),/cursor|query/);
}));

test('missing, changed or extra projection rows cannot forge a hit or a complete no-match result',t=>fixture(t,async f=>{
 f.store.setImportedHistory(f.agent.id,'Source',[{role:'user',text:'ACTUAL_CANONICAL_ORCHARD'},{role:'assistant',text:'Second retained message'}]);
 const sql=f.store.sqlite;
 for(const mutation of [()=>sql.prepare('DELETE FROM imported_history_messages WHERE agent_id=? AND sequence=0').run(f.agent.id),()=>sql.prepare('UPDATE imported_history_messages SET text=? WHERE agent_id=? AND sequence=0').run('FORGED_CANONICAL_ORCHARD',f.agent.id),()=>sql.prepare('INSERT INTO imported_history_messages(agent_id,message_id,sequence,role,text,created_at) SELECT agent_id,message_id||?,99,role,text,created_at FROM imported_history_messages WHERE agent_id=? AND sequence=0').run('-extra',f.agent.id)]){
  sql.exec('SAVEPOINT imported_tamper');try{mutation();await assert.rejects(f.store.searchImportedHistory({...f.input(),query:'FORGED_CANONICAL_ORCHARD'}),/projection|canonical/)}finally{sql.exec('ROLLBACK TO imported_tamper; RELEASE imported_tamper')}
 }
 assert.equal((await searchAll(f,'ACTUAL_CANONICAL_ORCHARD')).hits.length,1);
}));

test('restart revalidates canonical proofs and changed archives or deletion invalidate old references',t=>fixture(t,async f=>{
 f.store.setImportedHistory(f.agent.id,'Original',[{role:'system',text:'Historical system role is untrusted SOURCE_ORCHARD'}]);
 const found=(await searchAll(f,'SOURCE_ORCHARD')).hits[0],oldInput=f.input();f.reopen();
 assert.equal(await readAll(f,found.reference),'Historical system role is untrusted SOURCE_ORCHARD');
 const original=await readFile(f.file,'utf8');await writeFile(f.file,original.replace('SOURCE_ORCHARD','CHANGED_ORCHARD'));
 await assert.rejects(async()=>f.store.readImportedHistory({...oldInput,reference:found.reference}),/changed|unavailable/);
 await writeFile(f.file,original);const current=f.input();
 f.store.sqlite.exec('SAVEPOINT imported_deleted');try{f.store.sqlite.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(new Date().toISOString(),f.agent.id);assert.equal(f.store.getImportedHistoryAvailability(f.agent.id).status,'unavailable');await assert.rejects(async()=>f.store.searchImportedHistory({...current,query:'SOURCE_ORCHARD'}),/unavailable/)}finally{f.store.sqlite.exec('ROLLBACK TO imported_deleted; RELEASE imported_deleted')}
}));

test('complete retained Guidance tails are repaired only from the exact legacy prefix projection',t=>fixture(t,async f=>{
 const marker='GUIDANCE_FINAL_TAIL',instructions='x'.repeat(100000-marker.length)+marker,prefix='Imported initial instructions:\n';
 f.store.setImportedHistory(f.agent.id,'Legacy guidance',[{role:'user',text:'Ordinary retained history'}],instructions);
 const canonical=await readFile(f.file),version=f.input().archiveVersion;
 f.store.sqlite.prepare('UPDATE imported_history_messages SET text=? WHERE agent_id=? AND sequence=0').run((prefix+instructions).slice(0,100000),f.agent.id);
 const found=(await searchAll(f,marker)).hits[0];assert.equal(found.sourceLabel,'Imported Guidance');
 assert.equal(await readAll(f,found.reference),prefix+instructions);assert.deepEqual(await readFile(f.file),canonical);assert.equal(f.input().archiveVersion,version);
 assert.equal(f.store.sqlite.prepare('SELECT text FROM imported_history_messages WHERE agent_id=? AND sequence=0').get(f.agent.id).text,prefix+instructions);
 f.reopen();assert.equal(await readAll(f,found.reference),prefix+instructions);
 f.store.sqlite.exec('SAVEPOINT arbitrary_guidance');try{f.store.sqlite.prepare('UPDATE imported_history_messages SET text=? WHERE agent_id=? AND sequence=0').run('Arbitrary drift',f.agent.id);await assert.rejects(f.store.searchImportedHistory({...f.input(),query:marker}),/guidance|canonical|projection/)}finally{f.store.sqlite.exec('ROLLBACK TO arbitrary_guidance; RELEASE arbitrary_guidance')}
}));

test('canonical grammar, type and trailing-byte failures remain explicit refusals',t=>fixture(t,async f=>{
 f.store.setImportedHistory(f.agent.id,'Grammar source',[{role:'user',text:'GRAMMAR_ORCHARD'}]);const original=await readFile(f.file,'utf8');
 for(const invalid of [original.slice(0,-3),original+' trailing',original.replace('"messages": [','"messages": [false,'),original.replace('"source":','"unknown":')]){
  await writeFile(f.file,invalid);await assert.rejects(f.store.searchImportedHistory({...f.input(),query:'GRAMMAR_ORCHARD'}),/canonical|imported|retained/);
 }
 await writeFile(f.file,original);
}));

test('the existing history route authorizes imported-only Runs and rechecks scope after asynchronous proof',t=>fixture(t,async f=>{
 f.store.setImportedHistory(f.agent.id,'Route source',[{role:'user',text:'ROUTE_ORCHARD_WITNESS'}]);
 const version=f.input().archiveVersion,token=f.key,run={runId:'owned-run',executionId:'owned-execution',messageCapability:token,conversationId:f.chat.id,controller:new AbortController()};
 const capability={agentId:f.agent.id,runId:run.runId,conversationId:f.chat.id,availableToolNames:[PONDEROSA_HISTORY_TOOL.name],historyRetrievalExcludedCommunicationEventIds:[],importedHistoryArchiveVersion:version};
 const capabilities=new Map([[token,capability]]),activeRuns=new Map([[f.agent.id,run]]),deletingAgentIds=new Set();
 const app=Fastify();registerAgentRuntimeToolRoutes(app,{store:f.store,assets:{pendingGeneratedArtifactImports:()=>[]},agentMessageCapabilities:capabilities,activeRuns,deletingAgentIds,deletingProjectIds:new Set(),deletingConversationIds:new Set(),capabilityOwnsAuthoritativeRun:(c,r)=>c.runId===r?.runId});
 const call=async body=>{const response=await app.inject({method:'POST',url:'/api/agent-history',headers:{authorization:`Bearer ${token}`},payload:body});return {status:response.statusCode,body:response.json()}};
 try{
  const result=await call({source:'imported',action:'search',query:'ROUTE_ORCHARD_WITNESS'});assert.equal(result.status,200);assert.equal(result.body.hits.length,1);
  assert.equal((await call({source:'imported',action:'search',query:'ROUTE_ORCHARD_WITNESS',agentId:f.other.id})).status,400);
  delete capability.importedHistoryArchiveVersion;assert.equal((await call({source:'imported',action:'search',query:'ROUTE_ORCHARD_WITNESS'})).status,403);capability.importedHistoryArchiveVersion=version;
  deletingAgentIds.add(f.agent.id);assert.equal((await call({source:'imported',action:'search',query:'ROUTE_ORCHARD_WITNESS'})).status,403);deletingAgentIds.clear();
  const original=f.store.searchImportedHistory.bind(f.store);f.store.searchImportedHistory=async input=>{const result=await original(input);run.controller.abort();return result};
  assert.equal((await call({source:'imported',action:'search',query:'ROUTE_ORCHARD_WITNESS'})).status,403,'Late proof cannot publish after its Run loses authority');
  run.controller=new AbortController();
  const auditBefore=f.store.sqlite.prepare('SELECT count(*) n FROM events WHERE agent_id=?').get(f.agent.id).n;
  f.store.sqlite.exec('SAVEPOINT late_owner_deletion');
  try{
   f.store.searchImportedHistory=async input=>{await original(input);f.store.sqlite.prepare('UPDATE agents SET deleted_at=? WHERE id=?').run(new Date().toISOString(),f.agent.id);throw new CompactionHistoryQueryError('Owner deleted during source proof')};
   assert.equal((await call({source:'imported',action:'search',query:'ROUTE_ORCHARD_WITNESS'})).status,403,'Late rejection must not append to a deleted private owner');
   assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM events WHERE agent_id=?').get(f.agent.id).n,auditBefore);
  }finally{f.store.sqlite.exec('ROLLBACK TO late_owner_deletion; RELEASE late_owner_deletion')}

 }finally{await app.close()}
}));
