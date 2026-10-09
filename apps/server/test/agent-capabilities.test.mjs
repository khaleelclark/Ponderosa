import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,helper,counters,inertDenied} from './managed-helper-policy.fixture.mjs';

test('Dev operator policy read is inert, helper-only CAS preserves unrelated restrictions and rejects Agent bearers',{timeout:20000},async t=>{
 const f=await fixture(t),url=`/api/agents/${f.owner.id}/capabilities`;
 const before=await counters(f);const get=await f.app.inject({url});assert.equal(get.statusCode,200,get.body);assert.equal(get.json().policy.revision,0);assert.equal(f.policies.get('agent',f.owner.id),undefined);assert.deepEqual(await counters(f),before);assert.deepEqual(get.json().catalog.map(c=>c.id),[helper]);
 await inertDenied(f,()=>f.app.inject({url,headers:f.headers}),403);await inertDenied(f,()=>f.app.inject({method:'PUT',url,headers:f.headers,payload:{revision:0,restrictedCapabilityIds:[helper]}}),403);
 f.policies.put({scopeKind:'agent',scopeId:f.owner.id,expectedRevision:0,restrictedCapabilityIds:['browser.read']});
 const put=body=>f.app.inject({method:'PUT',url,payload:body});
 await inertDenied(f,()=>put({revision:1,restrictedCapabilityIds:[helper]}),400);
 for(const body of [null,[],{revision:-1,restrictedCapabilityIds:[]},{revision:1,restrictedCapabilityIds:[] ,extra:true},{revision:1,restrictedCapabilityIds:['browser.read','unknown']},{revision:1,restrictedCapabilityIds:['browser.read','browser.read']}])await inertDenied(f,()=>put(body),400);
 const effects=await counters(f),saved=await put({revision:1,restrictedCapabilityIds:['browser.read',helper]});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().policy.revision,2);assert.deepEqual(await counters(f),effects);
 const race=await Promise.all([put({revision:2,restrictedCapabilityIds:['browser.read']}),put({revision:2,restrictedCapabilityIds:['browser.read']})]);assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);assert.equal(race.find(r=>r.statusCode===409).json().current.revision,3);assert.deepEqual(await counters(f),effects);
 assert.deepEqual(f.policies.get('agent',f.owner.id).restrictedCapabilityIds,['browser.read']);assert.equal(f.starts(),1);
});

test('new Pinecone default and explicit Allow never create helpers; frozen Run stays absent',{timeout:20000},async t=>{
 const f=await fixture(t,{pinecone:true}),url=`/api/agents/${f.owner.id}/capabilities`;
 assert.equal(f.policies.get('agent',f.owner.id).revision,1);await inertDenied(f,()=>f.spawn(),401);
 const before=await counters(f);const allowed=await f.app.inject({method:'PUT',url,payload:{revision:1,restrictedCapabilityIds:[]}});assert.equal(allowed.statusCode,200,allowed.body);assert.deepEqual(await counters(f),before);assert.equal(f.starts(),1);await inertDenied(f,()=>f.spawn(),401);
});

for(const authToken of [undefined,'fixture-operator'])test(`operator boundary ${authToken?'configured':'loopback'} rejects Run bearer and wrong product`,{timeout:20000},async t=>{
 const f=await fixture(t,{authToken}),url=`/api/agents/${f.owner.id}/capabilities`,before=await counters(f);
 const read=await f.app.inject({url,headers:f.operatorHeaders});assert.equal(read.statusCode,200,read.body);
 const forbidden=await f.app.inject({url,headers:f.headers});assert.ok(forbidden.statusCode>=400,forbidden.body);assert.deepEqual(await counters(f),before);
 const wrong=await f.app.inject({url:`/api/branches/engine/agents/${f.owner.id}/capabilities`,headers:f.operatorHeaders});assert.equal(wrong.statusCode,404,wrong.body);assert.deepEqual(await counters(f),before);
 if(authToken){assert.equal((await f.app.inject({url})).statusCode,401);assert.deepEqual(await counters(f),before);}
});

test('policy API rejects archived, pending, compound, foreign owner and Branch namespaces without effects',{timeout:20000},async t=>{
 const f=await fixture(t),url=`/api/agents/${f.owner.id}/capabilities`;
 await inertDenied(f,()=>f.app.inject({url:'/api/agents/agent%3A'+f.owner.id+'/capabilities'}),404);
 f.store.updateAgent(f.owner.id,{archived:true});await inertDenied(f,()=>f.app.inject({url}),404);f.store.updateAgent(f.owner.id,{archived:false});
 const p=f.store.createProject({label:'Foreign',hostPath:f.dir,defaultEngine:'codex'});
 f.store.sqlite.prepare('UPDATE agents SET project_id=? WHERE id=?').run(p.id,f.owner.id);await inertDenied(f,()=>f.app.inject({url}),404);f.store.sqlite.prepare('UPDATE agents SET project_id=? WHERE id=?').run(f.p.id,f.owner.id);
 f.store.markConversationDeletionPending(f.chat.id);await inertDenied(f,()=>f.app.inject({url}),409);
});
