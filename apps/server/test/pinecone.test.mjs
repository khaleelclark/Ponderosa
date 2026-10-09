import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore, CoordinationV3Store} from '@ponderosa/agents';
import {createServer} from '../dist/app.js';
import {recoverFailedAgentCreations} from '../dist/server-lifecycle.js';
import {pineconeGuidance} from '../dist/pinecone-guidance.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'pinecone-http-'));
  const store=new AgentStore(dir);
  const project=store.createProject({label:'Synthetic',hostPath:dir,defaultEngine:'codex'});
  const chat=store.createConversation(project.id,{title:'Private work'});
  let starts=0;
  const adapter={id:'codex',displayName:'Synthetic subscription Adapter',listModels:()=>[],listEfforts:()=>[],run:()=>{starts++;throw new Error('No live execution permitted');}};
  const app=createServer({dataDir:dir,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,startDrained:true});
  await app.ready();
  t.after(async()=>{app.prepareForShutdown();await app.close();store.close();await rm(dir,{recursive:true,force:true});});
  const create=(key='pinecone',extra={},url=`/api/projects/${project.id}/agents`)=>app.inject({method:'POST',url,payload:{experience:'pinecone',title:'Pinecone',engine:'codex',conversationId:chat.id,idempotencyKey:key,...extra}});
  return {dir,store,project,chat,app,create,starts:()=>starts};
}
const counts=store=>Object.fromEntries(['agents','pinecone_profiles','runtime_communications','agent_activations','scheduler_runs'].map(table=>[table,store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n]));

test('canonical HTTP Pinecone creation is empty, exact-replay safe and unique under concurrent intake',async t=>{
  const {store,chat,project,app,create,starts}=await fixture(t);
  const before=counts(store);
  const attempts=await Promise.all([create('one'),create('one'),create('other')]);
  const accepted=attempts.find(r=>r.statusCode===200);assert.ok(accepted,attempts.map(r=>r.body).join('\n'));
  const agent=accepted.json();
  assert.equal(counts(store).agents,before.agents+1);assert.equal(counts(store).pinecone_profiles,1);
  for(const table of ['runtime_communications','agent_activations','scheduler_runs'])assert.equal(counts(store)[table],before[table]);
  assert.equal(starts(),0);assert.equal(store.readCommunicationEvents(project.id).length,0);
  const same=await create('one');assert.equal(same.statusCode,200,same.body);assert.equal(same.json().id,agent.id);
  const conflict=await create('one',{title:'Changed'});assert.equal(conflict.statusCode,409,conflict.body);
  const regularConflict=await create('one',{experience:undefined});assert.equal(regularConflict.statusCode,409,regularConflict.body);
  const profile=await app.inject({url:`/api/agents/${agent.id}/pinecone`});assert.equal(profile.statusCode,200,profile.body);
  assert.deepEqual(profile.json(),store.getPineconeProfile(agent.id));assert.equal(profile.json().conversationId,chat.id);
  assert.equal(agent.presetSnapshot.id,'builtin:pinecone:1');assert.ok(agent.presetSnapshot.guidance.length<4000);
  assert.deepEqual(agent.managementPermissions,{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false});
  const sent=await app.inject({method:'POST',url:`/api/agents/${agent.id}/messages`,payload:{text:'Help plan my private week',idempotencyKey:'first',activeRunDelivery:'queue'}});
  assert.equal(sent.statusCode,202,sent.body);
  const communications=store.readCommunicationEvents(project.id);assert.equal(communications.length,1);
  assert.equal(communications[0].intent,'user_dm');assert.deepEqual(communications[0].audience,{kind:'user_agent',userId:'local-operator',agentId:agent.id});
  assert.equal(communications[0].conversationId,chat.id);assert.equal(starts(),0);
  const activations=store.sqlite.prepare('SELECT agent_id,payload_json FROM agent_activations').all();assert.equal(activations.length,1);assert.equal(activations[0].agent_id,agent.id);
  assert.equal(store.listAgents(project.id).filter(a=>a.title==='Pinecone').length,1);
});

test('malformed, managed, incompatible, wrong owner/product and archived creation deny without effect',async t=>{
 const {store,project,chat,app,create}=await fixture(t);
 const foreign=store.createProject({label:'Other',hostPath:'/tmp/pinecone-other',defaultEngine:'codex'});
 const foreignChat=store.createConversation(foreign.id,{title:'Other'});
 const branchProject=store.createProject({label:'Branch',hostPath:project.hostPath,defaultEngine:'codex',chatOwned:true,branchId:'fixture-branch'});
 const branchChat=store.getConversation(branchProject.lastConversationId);
 for(const extra of [{conversationId:{toString:'malformed'}},{title:32},{engine:[]},{experience:{}},{experience:'other'},{idempotencyKey:''},{initialMessage:''},{draftAttachmentIds:[]},{draftOwnerId:'owner'},{presetId:'custom'},{managerAgentId:'manager'},{awaitResult:false},{managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}},{conversationId:'missing'},{conversationId:foreignChat.id},{conversationId:branchChat.id}]) {
   const before=counts(store),r=await create(`deny-${JSON.stringify(extra)}`,extra);assert.ok(r.statusCode>=400,r.body);assert.deepEqual(counts(store),before);
 }
 const before=counts(store),wrongProduct=await create('wrong-product',{},`/api/branches/engine/projects/${project.id}/agents`);assert.ok(wrongProduct.statusCode>=400,wrongProduct.body);assert.deepEqual(counts(store),before);
 store.updateConversation(chat.id,{archived:true});const archived=await create('archive');assert.ok(archived.statusCode>=400,archived.body);assert.deepEqual(counts(store),before);
 const spawn=await app.inject({method:'POST',url:'/api/agent-spawn',payload:{experience:'pinecone',title:'Fabrication'}});assert.ok(spawn.statusCode>=400,spawn.body);assert.deepEqual(counts(store),before);
 const imported=await app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,headers:{'idempotency-key':'fabricate'},payload:{conversationId:foreignChat.id,experience:'pinecone',engineMapping:{},package:{}}});assert.ok(imported.statusCode>=400,imported.body);assert.deepEqual(counts(store),before);
});

test('portable template import cannot fabricate a Pinecone profile',async t=>{
 const {store,project,chat,app}=await fixture(t),before=counts(store);
 const node={ref:'root',title:'Impostor',engine:'codex',experience:'pinecone',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}};
 const result=await app.inject({method:'POST',url:`/api/projects/${project.id}/import-agents`,headers:{'idempotency-key':'fabricated-node'},payload:{conversationId:chat.id,engineMapping:{codex:'codex'},package:{schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Synthetic',rootRef:'root',agents:[node]}}});
 assert.equal(result.statusCode,400,result.body);assert.match(result.body,/unknown|field|experience/);assert.deepEqual(counts(store),before);
});

test('rename, rebuild, archive, deletion, tombstone and replacement preserve canonical history',async t=>{
 const {store,app,create,project,chat}=await fixture(t);const r=await create();assert.equal(r.statusCode,200,r.body);const agent=r.json(),profile=store.getPineconeProfile(agent.id);
 const sent=await app.inject({method:'POST',url:`/api/conversations/${chat.id}/direct-messages`,payload:{text:'Keep this private history',recipients:[{agentId:agent.id}],idempotencyKey:'history',activeRunDelivery:'queue'}});assert.equal(sent.statusCode,200,sent.body);
 const renamed=await app.inject({method:'PATCH',url:`/api/agents/${agent.id}`,payload:{title:'Spruce'}});assert.equal(renamed.statusCode,200,renamed.body);
 store.rebuildProjections();assert.equal(store.getAgent(agent.id).title,'Spruce');assert.deepEqual(store.getPineconeProfile(agent.id),profile);assert.equal(store.readCommunicationEvents(project.id).length,1);
 store.updateAgent(agent.id,{archived:true});assert.ok((await create('new-while-archived')).statusCode>=400,'archiving preserves the existing coordinator identity');
 assert.equal((await app.inject({url:`/api/agents/${agent.id}/pinecone`})).statusCode,404);
 store.updateAgent(agent.id,{archived:false});assert.equal((await app.inject({url:`/api/agents/${agent.id}/pinecone`})).statusCode,200);
 const coordination=new CoordinationV3Store(store.sqlite);assert.equal(store.deleteAgent(agent.id,id=>coordination.handleAgentDeletion(id)),true);
 assert.equal(store.getPineconeProfile(agent.id),undefined);assert.equal(store.sqlite.prepare('SELECT count(*) n FROM pinecone_profiles').get().n,0);
 assert.ok(store.sqlite.prepare('SELECT 1 FROM agent_deletion_tombstones WHERE agent_id=?').get(agent.id));assert.equal(store.readCommunicationEvents(project.id).length,1);
 const next=await create('replacement');assert.equal(next.statusCode,200,next.body);assert.notEqual(next.json().id,agent.id);
});

test('ordinary creation and profile absence retain existing Broadcast opening behavior',async t=>{
 const {store,app,create,project}=await fixture(t);
 const ordinary=await create('ordinary',{experience:undefined,initialMessage:'Ordinary shared opening'});assert.equal(ordinary.statusCode,200,ordinary.body);
 assert.equal(store.getPineconeProfile(ordinary.json().id),undefined);assert.equal((await app.inject({url:`/api/agents/${ordinary.json().id}/pinecone`})).statusCode,404);
 assert.equal(store.readCommunicationEvents(project.id)[0].intent,'broadcast');
 const cone=await create('cone');assert.equal(cone.statusCode,200,cone.body);
});

test('profile insertion failure rolls back filesystem and canonical rows; unsettled empty creation is quarantined and recovered',async t=>{
 const {store,create,project,chat,dir}=await fixture(t),before=counts(store);
 store.sqlite.exec("CREATE TRIGGER pinecone_failure BEFORE INSERT ON pinecone_profiles BEGIN SELECT RAISE(FAIL,'fixture profile failure'); END");
 const bad=await create('fail');assert.ok(bad.statusCode>=400,bad.body);assert.deepEqual(counts(store),before);
 store.sqlite.exec('DROP TRIGGER pinecone_failure');const valid=await create('fail');assert.equal(valid.statusCode,200,valid.body);
 const another=store.createConversation(project.id,{title:'Recovery'});
 const operation=store.beginAgentCreationOperation({projectId:project.id,conversationId:another.id,productScope:'dev',kind:'human',actorScope:'user:local-operator',idempotencyKey:'interrupted',payloadHash:'fixture-hash'}).operation;
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';store.addAgentCreationOperationMember(operation.id,id,0);
 store.createAgent(project.id,{experience:'pinecone',title:'Unsettled',engine:'codex',conversationId:another.id,idempotencyKey:'interrupted'},undefined,id,pineconeGuidance('codex'));
 const quarantine=new Set([id]);const coordination=new CoordinationV3Store(store.sqlite);
 const recovered=recoverFailedAgentCreations({store,assets:{},dataDir:dir,deletingAgentIds:quarantine,handleAgentDeletion:id=>coordination.handleAgentDeletion(id)});
 assert.deepEqual(recovered.failures,[]);assert.equal(store.getAgent(id),undefined);assert.equal(store.getPineconeProfile(id),undefined);assert.equal(quarantine.size,0);assert.equal(store.getAgentCreationOperation(operation.id).status,'rolled_back');
 assert.equal(store.sqlite.prepare('SELECT count(*) n FROM agent_activations WHERE agent_id=?').get(id).n,0);
 assert.equal(store.getPineconeProfile(valid.json().id).conversationId,chat.id);
});
