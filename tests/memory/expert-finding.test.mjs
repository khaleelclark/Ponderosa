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
