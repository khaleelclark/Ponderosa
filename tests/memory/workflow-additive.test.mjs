import assert from 'node:assert/strict';
import test from 'node:test';
import {BranchStore} from '@ponderosa/agents';
import {read,vector} from './portability-fixture.mjs';
import {api,ok,noRuns,bindings,selection,confirm,rows,byId,preserve,setup} from './workflow-additive-fixture.mjs';

test('reviewed new Agent/private and preserved Chat/team additions preserve existing memory/authority across reopen and same-plan retry',async t=>{
 const x=await setup(t),{f}=x;const plan=ok(await x.preview());assert.equal(plan.memoryUpdateReview.incoming.length,1);assert.equal(plan.memoryUpdateReview.incoming[0].snapshot.chunks.length,3);assert.equal(plan.memoryUpdateReview.incoming[0].snapshot.conflicts.length,1);assert.equal(plan.memoryUpdateReview.excludedRows,4);assert.ok(plan.memoryUpdateReview.destination[0].chunks.length);
 const refused=await confirm(f,plan.id,{acknowledgeMemoryUpdate:false});assert.equal(refused.status,409);assert.match(refused.body.error,/acknowledgement.*additive memory/);await x.unchanged();
 const result=ok(await confirm(f,plan.id));assert.equal(result.state,'completed',result.error);preserve(x.before,await rows(f,x.chat.id));assert.deepEqual(f.store.getAgent(x.old.id).managementPermissions,x.permissions);
 const resource=f.store.sqlite.prepare("SELECT local_id FROM branch_installation_resources WHERE branch_id=? AND agent_ref='new' AND state='active'").get(x.branchId),fresh=f.store.getAgent(resource.local_id);assert.equal(fresh.conversationId,x.chat.id);assert.notEqual(fresh.id,x.source.b.id);
 const visible=await read(x.scoped,fresh.id);assert.equal(visible.filter(r=>r.text==='EXCLUDED_PRIVATE_FACT').length,1,'Only the selected new Agent private fact is visible');assert.equal(visible.some(r=>r.text==='Included private fact'),false,'Existing source Agent private memory excluded');
 await x.authority();const inventory=await rows(f,x.chat.id);assert.deepEqual(ok(await confirm(f,plan.id)),result);assert.deepEqual(await rows(f,x.chat.id),inventory);noRuns(f);
 await f.reopen();preserve(x.before,await rows(f,x.chat.id));assert.deepEqual(f.store.getAgent(x.old.id).managementPermissions,x.permissions);const exported=ok(await api(f,'GET',`/api/branches/${x.branchId}/package?mode=full`));assert.ok(exported.chats[0].agents.some(a=>a.ref==='new'&&a.definition.memory[0].snapshot.chunks.length));noRuns(f);
});

test('unselected/stale/foreign/removal/source-collision previews refuse or explicitly exclude without touching existing data',async t=>{
 const x=await setup(t),{f}=x;
 for(const sel of [null,false,{newAgents:[{chatRef:'chat',agentRef:'existing'}],teamChats:[]},{newAgents:[],teamChats:['chat']},{...selection,extra:true}]){const r=await x.preview(sel);assert.equal(r.status,400,r.raw);await x.unchanged();}
 const missing=await api(f,'POST','/api/branches/install-preview',{branchId:x.branchId,package:x.pkg,bindings:bindings(f)});assert.equal(missing.status,400);assert.match(missing.body.error,/explicit additive/);
 const foreign=structuredClone(x.pkg);foreign.packageId='foreign';assert.equal((await x.preview(selection,foreign)).status,400);
 const removed=structuredClone(x.pkg);removed.chats[0].agents.shift();removed.agentBindings.worker.agentRef='new';assert.equal((await x.preview(selection,removed)).status,400);
 const collision=structuredClone(x.pkg),team=collision.chats[0].agents[0].definition.memory[0].snapshot.chunks.find(r=>r.stamp.audience.endsWith(':team'));collision.chats[0].agents[1].definition.memory[0].snapshot.chunks.find(r=>r.id===team.id).text='Conflicting source ID';assert.equal((await x.preview(selection,collision)).status,400);await x.unchanged();
 const empty=ok(await x.preview({newAgents:[],teamChats:[]}));assert.deepEqual(empty.memoryUpdateReview.incoming,[]);assert.equal(empty.memoryUpdateReview.excludedRows,8);
 const stale=ok(await x.preview());f.store.updateAgent(x.old.id,{title:'Human edit'});assert.equal((await confirm(f,stale.id)).status,409);f.store.updateAgent(x.old.id,{title:x.old.title});
 const memoryStale=ok(await x.preview());const raw=f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory});await c.update({ids:[x.before[0].ids[0]],documents:['Human memory edit'],embeddings:[vector]});const edited=await rows(f,x.chat.id);const result=await confirm(f,memoryStale.id);assert.equal(result.status,409);assert.match(result.body.error,/Destination memory changed/);assert.deepEqual(await rows(f,x.chat.id),edited);noRuns(f);
});

async function retry(f,id){f.store.sqlite.prepare('UPDATE branch_installation_plans SET next_attempt_at=NULL WHERE id=?').run(id);return ok(await confirm(f,id));}
async function blockPublish(x,operation){const original=BranchStore.prototype.deploy;BranchStore.prototype.deploy=function(input,...args){if(input.idempotencyKey==='install:'+operation)throw Error('Controlled publication unavailable');return original.call(this,input,...args);};try{return ok(await confirm(x.f,operation));}finally{BranchStore.prototype.deploy=original;}}

test('failed staged publication hides additions, rejects edited deterministic IDs without overwrite, and retries the same completed Agent receipt',async t=>{
 const x=await setup(t),plan=ok(await x.preview()),state=await blockPublish(x,plan.id);assert.equal(state.state,'applying');assert.match(state.error,/Controlled publication/);
 assert.equal((await read(x.scoped,x.old.id)).filter(r=>r.text==='Revised seeded team fact 😀').length,1,'Unpublished team addition hidden');
 const staged=x.f.store.sqlite.prepare("SELECT * FROM branch_installation_resources WHERE staging_plan_id=? AND agent_ref='new'").get(plan.id),op=x.f.store.getAgentCreationOperation(staged.creation_operation_id);assert.equal(op.status,'completed');assert.ok(op.result.memoryPlan.length);
 const raw=x.f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory}),id=op.result.memoryPlan[0].chunkIds[0],original=await c.get({ids:[id],include:['documents','metadatas','embeddings']});await c.update({ids:[id],documents:['Explicit staged edit'],embeddings:[vector]});const before=await rows(x.f,x.chat.id),collision=await retry(x.f,plan.id);assert.equal(collision.state,'applying');assert.match(collision.error,/collision/);assert.deepEqual(await rows(x.f,x.chat.id),before,'Collision must not replace or delete the edited record');
 await c.update({ids:[id],documents:original.documents,embeddings:original.embeddings.map(v=>Array.from(v))});const done=await retry(x.f,plan.id);assert.equal(done.state,'completed',done.error);assert.equal(x.f.store.getAgent(staged.local_id).id,staged.local_id);assert.equal(x.f.store.getAgentCreationOperation(op.id).status,'completed');preserve(x.before,await rows(x.f,x.chat.id));noRuns(x.f);
});

test('cancel compensates completed staged team/private memory on a preserved Chat and retains destination data',async t=>{
 const x=await setup(t),plan=ok(await x.preview());assert.equal((await blockPublish(x,plan.id)).state,'applying');const staged=x.f.store.sqlite.prepare("SELECT * FROM branch_installation_resources WHERE staging_plan_id=? AND agent_ref='new'").get(plan.id);
 const result=ok(await api(x.f,'POST',`/api/branches/installations/${plan.id}/cancel`,{}));assert.equal(result.state,'canceled',result.error);assert.equal(x.f.store.getAgent(staged.local_id),undefined);await x.unchanged();assert.equal(x.f.store.getAgentCreationOperation(staged.creation_operation_id)?.result?.memoryPlan,undefined);
});

test('partial physical memory write fails visibly, rolls back its rows, and same-plan retry adds no duplicate facts',async t=>{
 const x=await setup(t),plan=ok(await x.preview()),raw=x.f.memory.core.database.raw,get=raw.client.getCollection.bind(raw.client);let writes=0;
 raw.client.getCollection=async args=>{const c=await get(args),add=c.add.bind(c);c.add=async input=>{if(input.metadatas?.some(m=>m.host_package_operation)&&++writes===2)throw Error('Controlled second additive write failure');return add(input);};return c;};let state;try{state=ok(await confirm(x.f,plan.id));}finally{raw.client.getCollection=get;}
 assert.equal(state.state,'applying');assert.match(state.error,/Controlled second additive write failure/);await x.unchanged();const done=await retry(x.f,plan.id);assert.equal(done.state,'completed',done.error);const after=await rows(x.f,x.chat.id);assert.equal(after[0].ids.length,x.before[0].ids.length+3);assert.equal(after[1].ids.length,x.before[1].ids.length+1);assert.equal((await retry(x.f,plan.id)).state,'completed');assert.deepEqual(await rows(x.f,x.chat.id),after);noRuns(x.f);
});

test('destination edits during staged recovery require a new review and compensate only hidden additions',async t=>{
 const x=await setup(t),plan=ok(await x.preview());assert.equal((await blockPublish(x,plan.id)).state,'applying');
 const raw=x.f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory}),id=x.before[0].ids[0];await c.update({ids:[id],documents:['Concurrent operator edit'],embeddings:[vector]});
 const done=await retry(x.f,plan.id);assert.equal(done.state,'review_required',done.error);assert.match(done.error,/Destination memory changed/);
 const actual=await rows(x.f,x.chat.id);assert.equal(actual[0].ids.length,x.before[0].ids.length);assert.equal(actual[1].ids.length,x.before[1].ids.length);assert.equal(byId(actual[0])[id][0],'Concurrent operator edit');
 for(let i=0;i<x.before.length;i++)for(const [key,row]of Object.entries(byId(x.before[i])))if(key!==id)assert.deepEqual(byId(actual[i])[key],row);
 await x.authority();assert.equal(x.f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE staging_plan_id=? AND state IN ('staging','retiring')").get(plan.id).n,0);noRuns(x.f);
});

import {BranchInstallationService} from '../../apps/server/dist/branch-installation-service.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
// Hold real inventory results and the delivery of a real, completed staged import.
async function overlapping(x,plan,run){
 const prototype=BranchInstallationService.prototype,inventory=prototype.memoryInventory;
 const entered=[deferred(),deferred()],release=[deferred(),deferred()],imported=deferred(),releaseImport=deferred(),pending=[];
 let service,engine,originalImport,imports=0,calls=0;
 prototype.memoryInventory=async function(...args){
  if(this.store!==x.f.store)return inventory.apply(this,args);
  service=this;
  if(!engine){engine=this.engine;originalImport=engine.importAgent;engine.importAgent=async function(...args){imports++;const result=await originalImport.apply(this,args);imported.resolve({result,signal:args[5]?.signal});await releaseImport.promise;args[5]?.signal?.throwIfAborted();return result;};}
  const index=calls++,result=await inventory.apply(this,args);
  if(index<2){entered[index].resolve();await release[index].promise;}
  return result;
 };
 try{
  const a=confirm(x.f,plan.id);pending.push(a);await entered[0].promise;
  const b=confirm(x.f,plan.id);pending.push(b);await entered[1].promise;
  release[0].resolve();const staged=await imported.promise;
  return await run({a,b,staged,service,releaseDuplicate:()=>release[1].resolve(),releaseImport:()=>releaseImport.resolve(),imports:()=>imports});
 }finally{
  release.forEach(g=>g.resolve());releaseImport.resolve();
  await Promise.allSettled(pending);
  if(engine)engine.importAgent=originalImport;
  prototype.memoryInventory=inventory;
  if(service)await service.tick();
 }
}

test('delayed duplicate confirmation cannot revive Stop while a real staged memory import is pending',async t=>{
 const x=await setup(t),plan=ok(await x.preview()),beforeVersion=x.f.store.sqlite.prepare('SELECT active_version_id FROM branches WHERE id=?').get(x.branchId);
 await overlapping(x,plan,async h=>{
  assert.equal(h.service.status(plan.id).state,'applying');assert.equal(h.imports(),1);
  const staged=x.f.store.sqlite.prepare("SELECT * FROM branch_installation_resources WHERE staging_plan_id=? AND agent_ref='new'").get(plan.id);assert.equal(staged.local_id,h.staged.result.rootAgentId);
  assert.ok(x.f.store.getAgentCreationOperation(staged.creation_operation_id).result.memoryPlan.length,'Real imported rows retain exact cleanup receipt');
  const stop=ok(await api(x.f,'POST',`/api/branches/installations/${plan.id}/cancel`,{}));assert.equal(stop.state,'canceling');assert(h.staged.signal.aborted);
  h.releaseDuplicate();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.service.status(plan.id).state,'canceling','A delayed duplicate cannot reset Stop before completing');const late=await h.b;assert.equal(late.status,409,late.raw);assert.match(late.body.error,/no longer available/);assert.equal(h.service.status(plan.id).state,'canceling','Delayed admission must not clear Stop');
  h.releaseImport();assert(['canceling','canceled'].includes(ok(await h.a).state));await h.service.tick();await h.service.tick();
  assert.equal(h.service.status(plan.id).state,'canceled');assert.equal(h.imports(),1);assert.equal(x.f.store.getAgent(staged.local_id),undefined);assert.equal(x.f.store.getAgentCreationOperation(staged.creation_operation_id)?.result?.memoryPlan,undefined);
  assert.deepEqual(x.f.store.sqlite.prepare("SELECT local_id,state FROM branch_installation_resources WHERE staging_plan_id=?").all(plan.id),[{local_id:staged.local_id,state:'deleted'}],'Cleanup retains only its deleted resource tombstone');assert.equal(x.f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE staging_plan_id=? AND state IN ('active','staging','retiring')").get(plan.id).n,0);assert.deepEqual(x.f.store.sqlite.prepare('SELECT active_version_id FROM branches WHERE id=?').get(x.branchId),beforeVersion);await x.unchanged();
  for(const field of ['title','handle','activeEngine','model','effort','speed','managementPermissions','managerAgentId'])assert.deepEqual(x.f.store.getAgent(x.old.id)[field],x.old[field],`Stopped update preserves Agent ${field}`);
  for(const field of ['title','instructions'])assert.deepEqual(x.f.store.getConversation(x.chat.id)[field],x.chat[field],`Stopped update preserves Chat ${field}`);
 });
});

test('overlapping confirmations of one applying plan coalesce without importing twice or replacing memory',async t=>{
 const x=await setup(t),plan=ok(await x.preview());
 await overlapping(x,plan,async h=>{
  h.releaseDuplicate();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.service.status(plan.id).state,'applying');assert.equal(h.imports(),1);
  h.releaseImport();const [a,b]=await Promise.all([h.a,h.b]);assert.equal(ok(a).state,'completed');assert.equal(ok(b).state,'completed');assert.equal(h.imports(),1);
  preserve(x.before,await rows(x.f,x.chat.id));await x.authority();assert.equal(x.f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE branch_id=? AND agent_ref='new' AND state='active'").get(x.branchId).n,1);
 });
});

test('duplicate inventory admission released after completion returns the compacted receipt without revival',async t=>{
 const x=await setup(t),plan=ok(await x.preview());
 await overlapping(x,plan,async h=>{
  h.releaseImport();assert.equal(ok(await h.a).state,'completed');const before=await rows(x.f,x.chat.id),receipt=x.f.store.sqlite.prepare('SELECT * FROM branch_installation_plans WHERE id=?').get(plan.id);assert.equal(receipt.package_json,'{}');
  h.releaseDuplicate();assert.equal(ok(await h.b).state,'completed');assert.deepEqual(x.f.store.sqlite.prepare('SELECT * FROM branch_installation_plans WHERE id=?').get(plan.id),receipt);assert.deepEqual(await rows(x.f,x.chat.id),before);assert.equal(h.imports(),1);await x.authority();
 });
});

test('pending inventory admission cannot revive expired, canceled or review-required durable receipts',async t=>{
 const x=await setup(t),prototype=BranchInstallationService.prototype,inventory=prototype.memoryInventory;
 for(const state of ['expired','canceled','review_required']){
  const plan=ok(await x.preview()),entered=deferred(),release=deferred();let service,pending;
  prototype.memoryInventory=async function(...args){if(this.store!==x.f.store)return inventory.apply(this,args);service=this;const result=await inventory.apply(this,args);entered.resolve();await release.promise;return result;};
  try{
   pending=confirm(x.f,plan.id);await entered.promise;
   if(state==='expired'){x.f.store.sqlite.prepare('UPDATE branch_installation_plans SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',plan.id);await service.tick();}
   else service.compactPlan(plan.id,state,'Controlled terminal receipt transition');
   const receipt=x.f.store.sqlite.prepare('SELECT * FROM branch_installation_plans WHERE id=?').get(plan.id);assert.equal(receipt.state,state);assert.equal(receipt.package_json,'{}');
   release.resolve();const late=await pending;assert.equal(late.status,409,late.raw);assert.deepEqual(x.f.store.sqlite.prepare('SELECT * FROM branch_installation_plans WHERE id=?').get(plan.id),receipt);await x.unchanged();
  }finally{release.resolve();if(pending)await pending;prototype.memoryInventory=inventory;}
 }
});
