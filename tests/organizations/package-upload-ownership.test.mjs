import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
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

const importRequestFingerprint=bytes=>{
 const chunkSize=4*1024*1024,count=Math.ceil(bytes.length/chunkSize);
 const hash=createHash('sha256').update(`ponderosa-agent-import:sha256-4m-v1\0${bytes.length}\0${chunkSize}\0${count}\0`,'utf8');
 for(let offset=0;offset<bytes.length;offset+=chunkSize)hash.update(createHash('sha256').update(bytes.subarray(offset,offset+chunkSize)).digest());
 return `sha256-4m-v1:${bytes.length}:${hash.digest('hex')}`;
};

test('a lost import response is looked up by exact request and retried only with matching streamed bytes',{timeout:60000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Request lookup destination'),other=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/conversations`,{title:'Other destination',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const requestId=randomUUID(),pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Recovery fixture 🌲',rootRef:'root',agents:[{ref:'root',title:'Imported agent',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  // Padding crosses the 4 MiB fingerprint boundary without changing JSON semantics.
  const pkgBytes=Buffer.from(JSON.stringify(pkg)+' '.repeat(4*1024*1024),'utf8'),metadata=JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n';
  const payload=Buffer.concat([Buffer.from(metadata),pkgBytes]),fingerprint=importRequestFingerprint(payload);
  const endpoint=`/api/projects/${chat.projectId}/agent-import-operations`,lookup=(request=requestId,conversation=chat.id)=>`${endpoint}/by-request/${encodeURIComponent(request)}?conversationId=${encodeURIComponent(conversation)}`;
  const headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':fingerprint};
  const absent=await f.api('GET',lookup());assert.equal(absent.status,404,'a missing result never asserts that an earlier upload drained');assert.equal(absent.headers['cache-control'],'no-store','an early 404 cannot be cached after admission');
  assert.equal((await f.api('POST',endpoint,payload,{...headers,'x-ponderosa-agent-package-fingerprint':'sha256-4m-v1:00:'+ '0'.repeat(64)})).status,400,'malformed fingerprint is refused');
  const changed=Buffer.from(payload);changed[Buffer.byteLength(metadata)+10]^=1;
  assert.equal((await f.api('POST',endpoint,changed,headers)).status,400,'changed package cannot enter under the saved fingerprint');
  assert.equal((await f.api('GET',lookup())).status,404,'mismatched body creates no operation');
  const changedMetadata=Buffer.concat([Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'other'}})+'\n'),pkgBytes]);
  assert.equal((await f.api('POST',endpoint,changedMetadata,headers)).status,400,'changed metadata cannot enter under the saved fingerprint');
  const admitted=f.ok(await f.api('POST',endpoint,payload,headers));
  assert.equal(admitted.requestId,requestId);assert.equal(admitted.requestFingerprint,fingerprint);assert.equal(admitted.conversationId,chat.id);
  const found=f.ok(await f.api('GET',lookup()));assert.equal(found.id,admitted.id);assert.equal(found.requestFingerprint,fingerprint);
  assert.equal((await f.api('GET',lookup(randomUUID()))).status,404,'another request identity cannot retrieve the operation');
  assert.equal((await f.api('GET',lookup(requestId,other.id))).status,404,'another Chat in the same project cannot retrieve it');
  assert.equal((await f.api('GET',`${endpoint}/by-request/${requestId}`)).status,404,'an exact Chat is required');
  assert.equal((await f.api('GET',lookup().replace('/api/','/api/branches/engine/'))).status,404,'another product cannot retrieve it');
  const replay=f.ok(await f.api('POST',endpoint,payload,headers));assert.equal(replay.id,admitted.id,'same bytes and key retain one operation');
  const changedWithOwnFingerprint={...headers,'x-ponderosa-agent-package-fingerprint':importRequestFingerprint(changed)};
  assert.equal((await f.api('POST',endpoint,changed,changedWithOwnFingerprint)).status,409,'changed input with the same key cannot enqueue another import');
  const completed=await until(async()=>{const operation=f.ok(await f.api('GET',lookup()));return operation.status!=='pending'&&operation;},'fingerprinted import completion',30000);
  assert.equal(completed.status,'completed',JSON.stringify(completed));
  await f.reopen();
  const recovered=f.ok(await f.api('GET',lookup()));assert.equal(recovered.id,admitted.id);assert.equal(recovered.requestFingerprint,fingerprint,'identity survives restart');
  const replayAfterRestart=f.ok(await f.api('POST',endpoint,payload,headers));assert.equal(replayAfterRestart.id,admitted.id);assert.equal(f.turns.length,0);
 });
});
