import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withFixture} from '../shared/fixture.mjs';

test('copy between Chats uses the explicit destination and respects product ownership',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const sourceChat=await f.createChat('Source Chat'),destination=await f.createChat('Destination Chat');
  const source=await f.createIdleAgent(sourceChat,'Original');
  const body={sourceAgentId:source.id,conversationId:destination.id,rootTitle:'Copied Agent',mode:'template'};
  const headers={'idempotency-key':randomUUID()};
  const wrongProduct=await f.api('POST',`/api/branches/engine/projects/${destination.projectId}/copy-agent`,body,headers);
  assert.equal(wrongProduct.status,404,'another product cannot copy either Chat');
  const wrongProject=await f.api('POST',`/api/projects/${sourceChat.projectId}/copy-agent`,body,headers);
  assert.equal(wrongProject.status,400,'a destination Chat outside the request Project is rejected');
  assert.match(wrongProject.body.error,/active destination Project Chat is required/);
  const copied=f.ok(await f.api('POST',`/api/projects/${destination.projectId}/copy-agent`,body,headers));
  const imported=f.ok(await f.api('GET',`/api/agents/${copied.rootAgentId}`)).agent;
  assert.equal(imported.title,'Copied Agent');assert.equal(imported.conversationId,destination.id);assert.equal(imported.projectId,destination.projectId);
  const original=f.ok(await f.api('GET',`/api/agents/${source.id}`)).agent;
  assert.equal(original.conversationId,sourceChat.id);assert.equal(original.title,'Original');
  assert.equal(f.turns.length,0);
 });
});
