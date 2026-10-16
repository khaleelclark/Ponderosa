import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {AgentStore,CoordinationV3Store,CapabilityPolicyStore,MemoryStore} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import {MemoryAuthority} from '../dist/memory-authority.js';
import {voiceMemoryExposure,memorySessionResetSeq} from '../dist/voice-memory-exposure.js';
import {registerMemoryRoutes} from '../dist/routes/memory.js';
function fixture(t,{enabled=true,seed=true,global=false}={}) {
 const root=mkdtempSync(join(tmpdir(),'voice-exposure-')),store=new AgentStore(root),c=new CoordinationV3Store(store.sqlite);
 const p=store.createProject({label:'Exposure fixture',hostPath:root,defaultEngine:'fixture'}),chat=store.getConversation(p.lastConversationId),a=store.createAgent(p.id,{engine:'fixture',conversationId:chat.id,title:'Voice'});
 c.coordinate({projectId:p.id,conversationId:chat.id,actorScope:'operator:test',idempotencyKey:'one',requests:[{recipientAgentId:a.id,lifetime:{kind:'indefinite'},payload:{text:'inert'}}]});
 const lease=c.leaseNextRun({workerId:'test'});assert.equal(lease.agentId,a.id);
 const injection={injectionId:lease.injectionId,runId:lease.runId,fencingToken:lease.fencingToken};
 c.preparePromptInjection({...injection,prompt:'inert'});c.markPromptSubmitted(injection);
 const unavailable=new Set(),ports={store,opts:{dataDir:root,engines:[],authToken:'inert',memoryEnabled:enabled},agentMessageCapabilities:new Map(),activeRuns:new Map(),capabilityOwnsAuthoritativeRun:()=>false,unavailable:(...ids)=>ids.some(id=>unavailable.has(id))};
 const authority=new MemoryAuthority(ports),scope={agentId:a.id,runId:lease.runId,fencingToken:lease.fencingToken,conversationId:chat.id};
 let receipt;
 if(seed)receipt=authority.forOperator('dev',p.id).save({text:'Synthetic memory',classification:'user_statement',commandKey:'seed'});
 if(global)authority.setGrant(p.id,'dev',true,0);
 const playback=authority.forPlayback(scope);
 const input={agentId:a.id,projectId:p.id,conversationId:chat.id,messageId:'accepted-input',runId:lease.runId};
 const read=()=>voiceMemoryExposure(ports,input);
 function packet(patch={}) {
  const memory=enabled?authority.forPreparation(scope):undefined;
  const record=receipt&&memory?.get(receipt.memoryId);
  const manifest={schemaVersion:3,conversationId:chat.id,communicationEventIds:['accepted-input'],memoryScopes:memory?.scopeGenerations()??[],memorySessionResetSeq:memorySessionResetSeq(store,a.id),sources:record?[{kind:'memory',ref:record.memoryId,revision:record.revision,generation:record.generation,hash:record.textHash,scope:record.scope,delivery:'submitted'}]:[],...patch};
  store.sqlite.prepare(`INSERT OR REPLACE INTO provider_inputs(execution_id,scheduler_run_id,agent_id,project_id,provider_prompt,prompt_hash,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(lease.runId,lease.runId,a.id,p.id,'inert',createHash('sha256').update('inert').digest('hex'),JSON.stringify(manifest),'now','now');
  return manifest;
 }
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 return {store,c,p,chat,a,lease,ports,authority,scope,playback,input,read,packet,receipt,unavailable};
}
test('completed exposure ignores only expired lease; preparation, playback writes and exact fences remain denied',t=>{
 const f=fixture(t);f.packet();assert.equal(f.read().state,'valid');
 const injection={injectionId:f.lease.injectionId,runId:f.lease.runId,fencingToken:f.lease.fencingToken};
 f.c.preparePromptInjection({...injection,prompt:"inert"});f.c.markPromptSubmitted(injection);f.c.acknowledgePromptInjection(injection);
 f.c.completeRun(f.lease.runId,f.lease.fencingToken);f.store.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01' WHERE id=?").run(f.lease.runId);
 const before=f.store.sqlite.prepare("SELECT total_changes() n").get().n;
 assert.equal(f.read().state,'valid');assert.equal(f.playback.get(f.receipt.memoryId).text,'Synthetic memory');
 assert.throws(()=>f.authority.forPreparation(f.scope).scopeGenerations(),/fenced/);
 assert.throws(()=>f.playback.save({text:'denied',classification:'agent_inference',commandKey:'write'}));
 assert.throws(()=>f.playback.forget(f.receipt.memoryId,1,'forget'));
 assert.throws(()=>f.authority.forPlayback({...f.scope,fencingToken:f.scope.fencingToken+1}).scopeGenerations(),/fenced/);
 assert.equal(f.store.sqlite.prepare("SELECT total_changes() n").get().n,before,'playback and denied writes make no durable mutations');
});
test('leased exposure requires its live lease; failed/cancelled/unknown/fenced Runs deny',t=>{
 const f=fixture(t);f.packet();f.store.sqlite.prepare("UPDATE scheduler_runs SET lease_expires_at='2000-01-01' WHERE id=?").run(f.lease.runId);assert.equal(f.read().state,'invalid');
 for(const state of ['failed','cancelled','outcome_unknown']){f.store.sqlite.prepare('UPDATE scheduler_runs SET status=? WHERE id=?').run(state,f.lease.runId);assert.equal(f.read().state,'invalid',state);}
 f.store.sqlite.prepare("UPDATE scheduler_runs SET status='completed',side_effects_fenced_at='now' WHERE id=?").run(f.lease.runId);assert.equal(f.read().state,'invalid');
});
test('missing existing principal fails without creating it, including playback after disable',t=>{
 const f=fixture(t,{seed:false});assert.throws(()=>f.playback.scopeGenerations(),/owner/);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM memory_installation_owner').get().n,0);
 f.authority.setGrant(f.p.id,'dev',true,0);f.store.sqlite.prepare('DELETE FROM memory_installation_owner').run();f.ports.opts.memoryEnabled=false;
 assert.throws(()=>f.playback.scopeGenerations(),/owner/);assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM memory_installation_owner').get().n,0);
});
test('confirmed disabled packet differs from missing, malformed, foreign and legacy evidence',t=>{
 const f=fixture(t,{enabled:false,seed:false});assert.equal(f.read().state,'pending');f.packet();assert.equal(f.read().state,'disabled');
 for(const patch of [{memorySessionResetSeq:undefined},{memoryScopes:undefined},{conversationId:'foreign'},{communicationEventIds:[]},{schemaVersion:2},{sources:[{kind:'memory'}]}]){f.packet(patch);assert.equal(f.read().state,'invalid',JSON.stringify(patch));}
 f.packet();f.store.sqlite.prepare("UPDATE provider_inputs SET source_manifest_json='{' WHERE execution_id=?").run(f.lease.runId);assert.equal(f.read().state,'invalid');
 f.packet();f.store.sqlite.prepare("UPDATE provider_inputs SET provider_prompt='changed' WHERE execution_id=?").run(f.lease.runId);assert.equal(f.read().state,'invalid');
});
test('empty authorized scopes validate, revoke→regrant cannot revive even without SSE, and failed/same-state grants do not advance epochs',t=>{
 const f=fixture(t,{seed:false});f.authority.forOperator('dev',f.p.id).list(1);f.authority.setGrant(f.p.id,'dev',true,0);f.packet();assert.equal(f.read().state,'valid');
 const generation=()=>f.store.sqlite.prepare("SELECT generation FROM memory_scope_generations WHERE scope='project' AND owner_id=?").get(f.p.id).generation;
 const original=generation();f.authority.setGrant(f.p.id,'dev',true,1);assert.equal(generation(),original);assert.equal(f.read().state,'valid');
 assert.throws(()=>f.authority.setGrant(f.p.id,'dev',false,0));assert.equal(generation(),original);
 f.authority.setGrant(f.p.id,'dev',false,2);assert.equal(generation(),original+1);assert.equal(f.read().state,'invalid');
 f.authority.setGrant(f.p.id,'dev',true,3);assert.equal(generation(),original+2);assert.equal(f.read().state,'invalid');
 f.packet();assert.equal(f.read().state,'valid','deliberate fresh packet binds new epoch');
});
test('correction/Forget/expiry/source authorization and current policy/owner deny prior submitted evidence',t=>{
 const f=fixture(t);f.packet();f.authority.forOperator('dev',f.p.id).update(f.receipt.memoryId,1,{text:'Corrected',classification:'user_statement',commandKey:'correct'});assert.equal(f.read().state,'invalid');
 f.packet();assert.equal(f.read().state,'valid');new CapabilityPolicyStore(f.store.sqlite).put({scopeKind:'run',scopeId:f.lease.runId,expectedRevision:0,restrictedCapabilityIds:[CAPABILITY_IDS.memoryRead]});assert.equal(f.read().state,'invalid');
});
test('expiry independently denies without generation mutation or notification',t=>{
 const f=fixture(t);f.packet();f.store.sqlite.prepare("UPDATE memory_revisions SET expires_at='2000-01-01' WHERE memory_id=?").run(f.receipt.memoryId);assert.equal(f.read().state,'invalid');
});
test('private historical source cannot retain automatic exposure after source authorization is removed',t=>{
 const f=fixture(t);const source={kind:'communication',id:'unreadable',revision:'1',sha256:'a'.repeat(64)};
 f.store.sqlite.prepare('UPDATE memory_revisions SET sources_json=? WHERE memory_id=?').run(JSON.stringify([source]),f.receipt.memoryId);f.packet();assert.equal(f.read().state,'invalid');
});
test('canonical epoch is exact across more than 256 later events, and reset never stamps old manifest',t=>{
 const f=fixture(t);f.store.appendEvent(f.a.id,{type:'session_reset',reason:'explicit_compaction'});const m=f.packet();assert.ok(m.memorySessionResetSeq>0);assert.equal(f.read().state,'valid');
 for(let n=0;n<270;n++)f.store.appendEvent(f.a.id,{type:'text',delta:'inert'});
 assert.equal(f.read().state,'valid');f.store.appendEvent(f.a.id,{type:'session_reset',reason:'explicit_compaction'});assert.equal(f.read().state,'invalid');
 assert.equal(f.store.getProviderInput(f.lease.runId).sourceManifest.memorySessionResetSeq,m.memorySessionResetSeq,'old packet unchanged');
});
test('unavailable/deleted owner and foreign Chat/Project binding deny',t=>{
 const f=fixture(t);f.packet();f.unavailable.add(f.chat.id);assert.equal(f.read().state,'invalid');f.unavailable.clear();
 assert.equal(voiceMemoryExposure(f.ports,{...f.input,conversationId:'other'}).state,'invalid');
 f.store.sqlite.prepare('UPDATE agents SET archived=1 WHERE id=?').run(f.a.id);assert.equal(f.read().state,'invalid');
});
test('postcommit scoped hints include revoked Project, omit content, and failed/idempotent commands emit none',async t=>{
 const f=fixture(t),app=Fastify(),hints=[];registerMemoryRoutes(app,f.ports,h=>hints.push(h));t.after(()=>app.close());
 const grant=(enabled,expectedRevision)=>app.inject({method:'PUT',url:`/api/projects/${f.p.id}/memory-global-grant`,payload:{enabled,expectedRevision}});
 assert.equal((await grant(true,0)).statusCode,200);assert.equal(hints.length,1);
 assert.equal((await grant(true,1)).statusCode,200);assert.equal(hints.length,1);
 assert.equal((await grant(false,0)).statusCode,409);assert.equal(hints.length,1);
 assert.equal((await grant(false,2)).statusCode,200);assert.equal(hints.length,2);assert.equal(hints[1].projectId,f.p.id);
 const command={operation:'update',memoryId:f.receipt.memoryId,expectedRevision:1,text:'Correction private bytes',commandKey:'update'};
 const call=()=>app.inject({method:'POST',url:`/api/projects/${f.p.id}/memories`,payload:command});assert.equal((await call()).statusCode,200);assert.equal(hints.length,3);assert.equal((await call()).statusCode,200);assert.equal(hints.length,3);
 assert.deepEqual(Object.keys(hints[2]).sort(),['generation','projectId','scope','type']);assert.ok(!JSON.stringify(hints).includes('Correction private bytes'));
});
