import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {AgentStore} from '@ponderosa/agents';
import {withFixture} from '../shared/fixture.mjs';

test('copy between Chats uses the explicit destination and respects product ownership',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const sourceChat=await f.createChat('Source Chat'),destination=await f.createChat('Destination Chat');
  const source=await f.createIdleAgent(sourceChat,'Original');
  const body={sourceAgentId:source.id,conversationId:destination.id,rootTitle:'Copied Agent',mode:'template'};
  const headers={'idempotency-key':randomUUID()};
  const wrongProduct=await f.api('POST',`/api/branches/engine/projects/${destination.projectId}/copy-agent`,body,headers);
  assert.equal(wrongProduct.status,404,'another product cannot copy either Chat');
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Other product',idempotencyKey:randomUUID()}));
  const branchChat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Branch Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const branchAgent=f.ok(await f.api('POST',`/api/branches/engine/projects/${branchChat.projectId}/agents`,{title:'Branch source',engine:'codex',conversationId:branchChat.id,idempotencyKey:randomUUID()}));
  const wrongSource=await f.api('POST',`/api/projects/${destination.projectId}/copy-agent`,{...body,sourceAgentId:branchAgent.id},{'idempotency-key':randomUUID()});
  assert.equal(wrongSource.status,404,'a Branch Agent cannot be copied through the Core product');
  const wrongProject=await f.api('POST',`/api/projects/${sourceChat.projectId}/copy-agent`,body,headers);
  assert.equal(wrongProject.status,400,'a destination Chat outside the request Project is rejected');
  assert.match(wrongProject.body.error,/active destination Project Chat is required/);
  store.updateConversation(sourceChat.id,{instructions:'Source instructions'});
  store.updateConversation(destination.id,{instructions:'Destination instructions'});
  const full={...body,mode:'full'};
  const conflict=await f.api('POST',`/api/projects/${destination.projectId}/copy-agent`,full,{'idempotency-key':randomUUID()});
  assert.equal(conflict.status,409,'full copy with conflicting instructions requires a choice');
  const resolution={action:'keep_destination',expectedDestinationSha256:createHash('sha256').update('Destination instructions').digest('hex')};
  const copied=f.ok(await f.api('POST',`/api/projects/${destination.projectId}/copy-agent`,{...full,chatInstructionsResolution:resolution},{'idempotency-key':randomUUID()}));
  const imported=f.ok(await f.api('GET',`/api/agents/${copied.rootAgentId}`)).agent;
  assert.equal(imported.title,'Copied Agent');assert.equal(imported.conversationId,destination.id);assert.equal(imported.projectId,destination.projectId);
  assert.equal(store.getConversation(destination.id).instructions,'Destination instructions');
  const original=f.ok(await f.api('GET',`/api/agents/${source.id}`)).agent;
  assert.equal(original.conversationId,sourceChat.id);assert.equal(original.title,'Original');
  assert.equal(f.turns.length,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
