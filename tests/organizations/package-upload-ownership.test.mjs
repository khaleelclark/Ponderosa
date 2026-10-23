import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {withFixture,until} from '../shared/fixture.mjs';

test('JSON shaped like a staged Agent upload cannot read or unlink a caller-supplied path',async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Upload ownership'),sentinel=path.join(f.root,'unowned-sentinel.txt'),body='Fixture-owned sentinel; never an admitted upload';await writeFile(sentinel,body);
  for(const endpoint of ['import-agent-package','agent-import-operations']){
   const response=await f.api('POST',`/api/projects/${chat.projectId}/${endpoint}`,{pathname:sentinel,sha256:'0'.repeat(64),size:body.length,reservationId:'forged-upload'},{'idempotency-key':randomUUID()});
   assert.equal(response.status,400);assert.equal(await readFile(sentinel,'utf8'),body,'An unowned path was consumed by upload cleanup');assert.equal(f.turns.length,0);
  }
 });
});

test('binary uploads reject a destination in another product before queue admission and clean up failed intake',async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Dev destination'),headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':randomUUID()},wire=JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n{}';
  for(const endpoint of ['import-agent-package','agent-import-operations']){
   const response=await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/${endpoint}`,wire,headers);assert.equal(response.status,404,JSON.stringify(response));
  }
  const directory=path.join(f.dataDir,'agent-import-operations');assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('.incoming-')||name.endsWith('.payload')||name.endsWith('.json')),[]);assert.equal(f.turns.length,0);
  const invalid=await f.api('POST',`/api/projects/${chat.projectId}/agents`,wire,headers);assert.equal(invalid.status,415);assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('.incoming-')),[]);
 });
});

test('a parser-owned binary organization import retains its destination, exact replay and completed receipt across restart',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Binary import destination'),requestId=randomUUID(),pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'organization',exportedAt:new Date().toISOString(),sourceLabel:'Controlled binary organization',rootRef:'root',agents:[{ref:'root',title:'Imported coordinator',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}},{ref:'child',managerRef:'root',title:'Imported worker',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  const wire=JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n'+JSON.stringify(pkg),headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId},endpoint=`/api/projects/${chat.projectId}/agent-import-operations`;
  const admitted=f.ok(await f.api('POST',endpoint,wire,headers));assert.equal(admitted.conversationId,chat.id);assert.equal(admitted.product,'dev');
  const receipt=f.ok(await f.api('POST',endpoint,wire,headers));assert.equal(receipt.id,admitted.id);
  const completed=await until(async()=>{const operation=f.ok(await f.api('GET',`${endpoint}/${admitted.id}`));return operation.status!=='pending'&&operation;},'canonical binary import',20000);
  assert.equal(completed.status,'completed',JSON.stringify(completed));assert.equal(completed.result.agentIds.length,2);
  assert.equal(f.ok(await f.api('GET',`/api/agents/${completed.result.rootAgentId}`)).agent.conversationId,chat.id);assert.equal(f.turns.length,0);
  await f.reopen();assert.equal(f.ok(await f.api('GET',`${endpoint}/${admitted.id}`)).status,'completed');
  const replay=f.ok(await f.api('POST',endpoint,wire,headers));assert.equal(replay.id,admitted.id);assert.deepEqual(replay.result,completed.result);
  assert.equal((await f.api('GET',endpoint.replace('/api/','/api/branches/engine/')+'/'+admitted.id)).status,404);assert.equal(f.turns.length,0);
 });
});
