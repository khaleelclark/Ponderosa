import assert from 'node:assert/strict';
import test from 'node:test';
import {writeFile,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {AgentStore} from '@ponderosa/agents';
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
  assert.equal((await f.api('POST',`${endpoint}/by-request/${requestId}/retire`,{conversationId:chat.id,operationId:admitted.id})).status,409,'an admitted operation cannot be retired as unqueued');
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

test('concurrent exact imports retain one request identity and reject changed input',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Concurrent import'),requestId=randomUUID();
  const endpoint=`/api/projects/${chat.projectId}/agent-import-operations`;
  const wire=Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n{}');
  const headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':importRequestFingerprint(wire)};
  const results=await Promise.all([f.api('POST',endpoint,wire,headers),f.api('POST',endpoint,wire,headers)]);
  assert.ok(results.every(result=>result.status===202||result.status===200),JSON.stringify(results));
  assert.equal(results[0].body.id,results[1].body.id);
  const changed=Buffer.concat([wire,Buffer.from(' ')]);
  assert.equal((await f.api('POST',endpoint,changed,{...headers,'x-ponderosa-agent-package-fingerprint':importRequestFingerprint(changed)})).status,409);
 });
});

test('journal sync and rollback failure holds the exact import across restart',{timeout:30000,skip:process.platform==='win32'},async t=>{
 await withFixture(t,async f=>{
  const {promises:hostFs}=await import('@ponderosa/native-host/fs');
  const chat=await f.createChat('Held admission'),other=f.ok(await f.api('POST',`/api/projects/${chat.projectId}/conversations`,{title:'Other destination',defaultEngine:'codex'},{'idempotency-key':randomUUID()})),requestId=randomUUID();
  const endpoint=`/api/projects/${chat.projectId}/agent-import-operations`;
  const pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Held fixture',rootRef:'root',agents:[{ref:'root',title:'Held Agent',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  const metadata={conversationId:chat.id,engineMapping:{codex:'codex'}};
  const wire=Buffer.from(JSON.stringify(metadata)+'\n'+JSON.stringify(pkg));
  const headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':importRequestFingerprint(wire)};
  const directory=path.join(f.dataDir,'agent-import-operations'),physicalDirectory=await realpath(directory);
  const lookup=`${endpoint}/by-request/${requestId}?conversationId=${chat.id}`;
  const originalOpen=hostFs.open,originalUnlink=hostFs.unlink;
  let count=0,release,entered;const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  hostFs.open=async function(name,...args){
   const handle=await originalOpen.call(this,name,...args);
   if(typeof name==='string' && path.basename(name)==='agent-import-operations' && await realpath(name)===physicalDirectory && ++count===2) return {sync:async()=>{entered();await gate;throw Error('injected journal directory sync failure');},close:()=>handle.close()};
   return handle;
  };
  hostFs.unlink=async function(name,...args){
   if(typeof name==='string'&&/^[0-9a-f-]{36}\.json$/.test(path.basename(name))&&await realpath(path.dirname(name))===physicalDirectory)throw Error('injected journal rollback failure');
   return originalUnlink.call(this,name,...args);
  };
  try{
   const first=f.api('POST',endpoint,wire,headers);
   await reached;
   assert.equal((await f.api('GET',lookup)).status,409,'in-flight reservation is visible as held');
   const concurrentCopy=await f.api('POST',`/api/projects/${chat.projectId}/copy-agent`,{sourceAgentId:randomUUID(),conversationId:chat.id},{'idempotency-key':requestId});
   assert.equal(concurrentCopy.status,409);assert.match(concurrentCopy.body.error,/Import admission is held/,'copy cannot create the shared key while admission is in flight');
   release();assert.equal((await first).status,409);
  }finally{release();hostFs.open=originalOpen;hostFs.unlink=originalUnlink;}
  let names=await readdir(directory);const journals=names.filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)),payloads=names.filter(name=>name.endsWith('.payload'));
  assert.equal(journals.length,1);assert.equal(payloads.length,1);
  const savedJournal=await readFile(path.join(directory,journals[0]));const savedPayload=await readFile(path.join(directory,payloads[0]));
  assert.equal((await f.api('POST',endpoint,wire,headers)).status,409);
  const heldCopy=await f.api('POST',`/api/projects/${chat.projectId}/copy-agent`,{sourceAgentId:randomUUID(),conversationId:chat.id},{'idempotency-key':requestId});
  assert.equal(heldCopy.status,409);assert.match(heldCopy.body.error,/Import admission is held/,'copy cannot bypass held identity');
  const legacyHeaders={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId};
  assert.equal((await f.api('POST',`/api/projects/${chat.projectId}/import-agent-package`,wire,legacyHeaders)).status,409,'binary legacy route cannot bypass the hold');
  assert.equal((await f.api('POST',`/api/projects/${chat.projectId}/import-agents`,{...metadata,package:pkg},{'idempotency-key':requestId})).status,409,'JSON legacy route cannot bypass the hold');
  const operationId=journals[0].slice(0,-5);
  assert.equal((await f.api('GET',`/api/lifecycle/agent-imports/${operationId}`)).status,409,'held journal cannot be retired as mutation-free');
  await f.reopen();
  assert.equal((await f.api('GET',lookup)).status,409);
  assert.equal((await f.api('POST',endpoint,wire,headers)).status,409);
  names=await readdir(directory);assert.deepEqual(names.filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)),journals);assert.deepEqual(names.filter(name=>name.endsWith('.payload')),payloads);
  assert.deepEqual(await readFile(path.join(directory,journals[0])),savedJournal);assert.deepEqual(await readFile(path.join(directory,payloads[0])),savedPayload);
  const retire=`${endpoint}/by-request/${requestId}/retire`;
  assert.equal((await f.api('POST',retire,{conversationId:other.id,operationId})).status,404,'another Chat cannot retire the request');
  assert.equal((await f.api('POST',retire.replace('/api/','/api/branches/engine/'),{conversationId:chat.id,operationId})).status,404,'another product cannot retire the request');
  assert.equal((await f.api('POST',retire,{conversationId:chat.id,operationId:randomUUID()})).status,404,'retirement requires the exact held operation');
  const receipt=f.ok(await f.api('POST',retire,{conversationId:chat.id,operationId}));
  assert.deepEqual(receipt,{state:'retired',operationId,requestId,projectId:chat.projectId,conversationId:chat.id,product:'dev',requestFingerprint:headers['x-ponderosa-agent-package-fingerprint']});
  assert.deepEqual(f.ok(await f.api('POST',retire,{conversationId:chat.id,operationId})),receipt,'retirement receipt is idempotent');
  assert.equal((await f.api('POST',endpoint,wire,headers)).status,409,'old request identity is permanently denied');
  assert.equal((await f.api('POST',`/api/projects/${chat.projectId}/import-agent-package`,wire,legacyHeaders)).status,409,'legacy routes cannot revive a retired identity');
  await f.reopen();
  const retired=await f.api('GET',lookup);assert.equal(retired.status,409);assert.equal(retired.body.state,'retired');
  assert.equal((await f.api('POST',endpoint,wire,headers)).status,409);
  assert.equal((await f.api('POST',`/api/projects/${chat.projectId}/import-agent-package`,wire,legacyHeaders)).status,409,'binary legacy route cannot revive a tombstone after restart');
  assert.equal((await f.api('POST',`/api/projects/${chat.projectId}/import-agents`,{...metadata,package:pkg},{'idempotency-key':requestId})).status,409,'JSON legacy route cannot revive a tombstone after restart');
  const retiredCopy=await f.api('POST',`/api/projects/${chat.projectId}/copy-agent`,{sourceAgentId:randomUUID(),conversationId:chat.id},{'idempotency-key':requestId});
  assert.equal(retiredCopy.status,409);assert.match(retiredCopy.body.error,/Import admission is held/,'copy cannot revive a retired identity after restart');
  assert.deepEqual(await readFile(path.join(directory,journals[0])),savedJournal);assert.deepEqual(await readFile(path.join(directory,payloads[0])),savedPayload);
  const newKey=randomUUID(),fresh=f.ok(await f.api('POST',endpoint,wire,{...headers,'idempotency-key':newKey}));
  assert.notEqual(fresh.id,operationId,'only an explicit fresh request starts another import');
  assert.equal(f.turns.length,0);
 });
});

test('retirement waits for the in-flight Project admission and cannot retire a queued import',{timeout:30000,skip:process.platform==='win32'},async t=>{
 await withFixture(t,async f=>{
  const {promises:hostFs}=await import('@ponderosa/native-host/fs');
  const chat=await f.createChat('Concurrent admission retirement'),requestId=randomUUID();
  const endpoint=`/api/projects/${chat.projectId}/agent-import-operations`;
  const pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Admission fixture',rootRef:'root',agents:[{ref:'root',title:'Import target',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  const wire=Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n'+JSON.stringify(pkg));
  const headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':importRequestFingerprint(wire)};
  const directory=await realpath(path.join(f.dataDir,'agent-import-operations')),originalOpen=hostFs.open;
  let count=0,release,entered;const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  hostFs.open=async function(name,...args){
   const handle=await originalOpen.call(this,name,...args);
   if(typeof name==='string'&&path.basename(name)==='agent-import-operations'&&await realpath(name)===directory&&++count===2)
    return {sync:async()=>{entered();await gate;await handle.sync();},close:()=>handle.close()};
   return handle;
  };
  try{
   const admission=f.api('POST',endpoint,wire,headers);await reached;
   const lookup=await f.api('GET',`${endpoint}/by-request/${requestId}?conversationId=${chat.id}`);assert.equal(lookup.status,409);assert.equal(lookup.body.state,'reserved');
   const retirement=f.api('POST',`${endpoint}/by-request/${requestId}/retire`,{conversationId:chat.id,operationId:lookup.body.operationId});
   const beforeRelease=await Promise.race([retirement.then(()=> 'settled'),new Promise(resolve=>setTimeout(()=>resolve('waiting'),40))]);
   assert.equal(beforeRelease,'waiting','retirement waits for the Project admission lock');
   release();const admitted=f.ok(await admission);assert.equal(admitted.id,lookup.body.operationId);
   assert.equal((await retirement).status,409,'an admitted request cannot subsequently be retired as unqueued');
  }finally{release();hostFs.open=originalOpen;}
 });
});

test('copy ledger created first prevents a same-key async import admission',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const {promises:hostFs}=await import('@ponderosa/native-host/fs');
  const chat=await f.createChat('Copy owns request'),requestId=randomUUID();
  const endpoint=`/api/projects/${chat.projectId}/agent-import-operations`;
  const wire=Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n{}');
  const headers={'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':importRequestFingerprint(wire)};
  const directory=await realpath(path.join(f.dataDir,'agent-import-operations')),originalAccess=hostFs.access;
  let release,entered;const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  hostFs.access=async function(name,...args){
   if(typeof name==='string'&&path.basename(name).endsWith('.copy.payload')&&await realpath(path.dirname(name))===directory){entered();await gate;}
   return originalAccess.call(this,name,...args);
  };
  try{
   // The copy reaches its snapshot read only after committing the creation ledger.
   const copy=f.api('POST',`/api/projects/${chat.projectId}/copy-agent`,{sourceAgentId:randomUUID(),conversationId:chat.id},{'idempotency-key':requestId});
   await reached;
   const conflicting=await f.api('POST',endpoint,wire,headers);
   assert.equal(conflicting.status,409);assert.match(conflicting.body.error,/existing import owns this request identity/);
   assert.equal((await f.api('GET',`${endpoint}/by-request/${requestId}?conversationId=${chat.id}`)).status,404,'no async import operation was admitted');
   release();assert.equal((await copy).status,404,'the controlled nonexistent source leaves no copy effects');
   assert.equal(f.turns.length,0);
  }finally{release();hostFs.access=originalAccess;}
 });
});
test('an exact deleted-owner status never returns a stale full import receipt',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const {promises:hostFs}=await import('@ponderosa/native-host/fs');
  const chat=await f.createChat('Deleted owner read race'),other=f.ok(await f.api('POST','/api/projects/'+chat.projectId+'/conversations',{title:'Other Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()})),requestId=randomUUID(),endpoint='/api/projects/'+chat.projectId+'/agent-import-operations';
  const wire=Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n{}'),fingerprint=importRequestFingerprint(wire);
  const op=f.ok(await f.api('POST',endpoint,wire,{'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':fingerprint}));
  await until(async()=>{const response=await f.api('GET',endpoint+'/'+op.id);return response.status===200&&response.body.status==='failed';},'terminal read-race import');
  const directory=await realpath(path.join(f.dataDir,'agent-import-operations')),original=hostFs.readFile;
  let release,entered;const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  hostFs.readFile=async function(name,...args){
   if(typeof name==='string'&&path.basename(name)===op.id+'.json'&&await realpath(path.dirname(name))===directory){entered();await gate;}
   return original.call(this,name,...args);
  };
  try{
   const lookup=f.api('GET',endpoint+'/by-request/'+requestId+'?conversationId='+chat.id);await reached;
   const deletion=await until(async()=>{const result=await f.api('DELETE','/api/conversations/'+chat.id);return result.status===409?undefined:result;},'worker lease release before Chat deletion');
   assert.equal(f.ok(deletion).deleted,true);
   release();const response=await lookup;assert.equal(response.status,409);assert.equal(response.body.state,'destination_deleted');
   assert.equal(response.body.operationId,op.id);assert.equal(response.body.requestFingerprint,fingerprint);
   assert.equal('result' in response.body,false);assert.equal('payloadHash' in response.body,false);
   assert.equal((await f.api('GET',endpoint+'/by-request/'+requestId+'?conversationId='+other.id)).status,404);
   assert.equal((await f.api('GET',(endpoint+'/by-request/'+requestId+'?conversationId='+chat.id).replace('/api/','/api/branches/engine/'))).status,404);
  }finally{release();hostFs.readFile=original;}
 });
});

test('worker holds its Chat lease and preserves journal and payload if owner is deleted',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const {promises:hostFs}=await import('@ponderosa/native-host/fs');
  const chat=await f.createChat('Deleted owner worker'),requestId=randomUUID(),endpoint='/api/projects/'+chat.projectId+'/agent-import-operations';
  const pkg={schema:'ponderosa.agent-package.v1',mode:'template',kind:'agent',exportedAt:new Date().toISOString(),sourceLabel:'Original',rootRef:'root',agents:[{ref:'root',title:'Import target',engine:'codex',managementPermissions:{allowAutomaticDescendantDeletion:false,allowAutomaticDescendantReorganization:false}}]};
  const wire=Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n'+JSON.stringify(pkg)),fingerprint=importRequestFingerprint(wire);
  const directory=await realpath(path.join(f.dataDir,'agent-import-operations')),original=hostFs.open;
  let release,entered;const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  hostFs.open=async function(name,...args){
   if(typeof name==='string'&&name.endsWith('.payload')&&await realpath(path.dirname(name))===directory){entered();await gate;}
   return original.call(this,name,...args);
  };
  try{
   const op=f.ok(await f.api('POST',endpoint,wire,{'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':fingerprint}));
   await reached;
   assert.equal((await f.api('DELETE','/api/conversations/'+chat.id)).status,409,'worker lease blocks ordinary Chat deletion');
   assert.equal((await f.api('DELETE','/api/projects/'+chat.projectId)).status,409,'worker lease blocks ordinary Project deletion');
   const journal=path.join(directory,op.id+'.json'),payload=path.join(directory,op.id+'.payload');
   const savedJournal=await readFile(journal),savedPayload=await readFile(payload);
   // Simulate an already-committed deletion from an older version.
   assert.equal(store.commitConversationDeletion(chat.id)?.canonicalDeletionCompleted,true);
   release();hostFs.open=original;
   await f.reopen();
   assert.deepEqual(await readFile(journal),savedJournal);assert.deepEqual(await readFile(payload),savedPayload);
   const status=await f.api('GET',endpoint+'/by-request/'+requestId+'?conversationId='+chat.id);
   assert.equal(status.status,409);assert.equal(status.body.state,'destination_deleted');assert.equal(status.body.operationId,op.id);
   assert.equal(status.body.requestFingerprint,fingerprint);assert.equal(f.turns.length,0);
  }finally{release();hostFs.open=original;}
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});

test('committed Project deletion exposes only exact content-free import status',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('Deleted project import'),requestId=randomUUID(),endpoint='/api/projects/'+chat.projectId+'/agent-import-operations';
  const wire=Buffer.from(JSON.stringify({conversationId:chat.id,engineMapping:{codex:'codex'}})+'\n{}'),fingerprint=importRequestFingerprint(wire);
  const op=f.ok(await f.api('POST',endpoint,wire,{'content-type':'application/vnd.ponderosa.agent-import','idempotency-key':requestId,'x-ponderosa-agent-package-fingerprint':fingerprint}));
  await until(async()=>{const response=await f.api('GET',endpoint+'/'+op.id);return response.status===200&&response.body.status==='failed';},'terminal import before Project deletion');
  const deletion=await until(async()=>{const result=await f.api('DELETE','/api/projects/'+chat.projectId);return result.status===409?undefined:result;},'worker lease release before Project deletion');
  assert.equal(f.ok(deletion).deleted,true);
  await f.reopen();
  const lookup=endpoint+'/by-request/'+requestId+'?conversationId='+chat.id,response=await f.api('GET',lookup);
  assert.equal(response.status,409);assert.equal(response.body.state,'destination_deleted');assert.equal(response.body.operationId,op.id);assert.equal(response.body.requestFingerprint,fingerprint);
  assert.equal('result' in response.body,false);assert.equal('payloadHash' in response.body,false);
  assert.equal((await f.api('GET',lookup.replace('/api/','/api/branches/engine/'))).status,404);
 });
});

test('hydration and direct lookup hold valid journals that differ from their exact intent',{timeout:30000},async t=>{
 let store;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Original intent Chat'),other=f.ok(await f.api('POST','/api/projects/'+chat.projectId+'/conversations',{title:'Other Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  const id=randomUUID(),otherId=randomUUID(),requestId=randomUUID(),hash='0'.repeat(64),directory=path.join(f.dataDir,'agent-import-operations'),now=new Date().toISOString();
  const record={id,requestId,payloadHash:hash,projectId:chat.projectId,conversationId:other.id,product:'dev',sourceLabel:'Controlled mismatch',phase:'queued',status:'pending',createdAt:now,updatedAt:now};
  store.sqlite.prepare("INSERT INTO agent_import_submission_intents(project_id,request_id,conversation_id,product_scope,payload_sha256,request_fingerprint,operation_id,staged_name,state) VALUES (?,?,?,?,?,?,?,?,'queued')").run(chat.projectId,requestId,chat.id,'dev',hash,null,id,'.incoming-'+randomUUID());
  const original=JSON.stringify(record),otherOriginal=JSON.stringify({...record,id:otherId});
  await writeFile(path.join(directory,id+'.json'),original);await writeFile(path.join(directory,otherId+'.json'),otherOriginal);await writeFile(path.join(directory,id+'.payload'),'retained original payload');
  await f.reopen();
  const endpoint='/api/projects/'+chat.projectId+'/agent-import-operations';
  assert.equal((await f.api('GET',endpoint+'/'+id)).status,404,'intent mismatch cannot be read by operation ID');
  assert.equal((await f.api('GET',endpoint+'/'+otherId)).status,404,'a different operation cannot reuse an existing request key');
  assert.equal((await f.api('GET',endpoint+'/by-request/'+requestId+'?conversationId='+other.id)).status,404,'another Chat cannot read the request');
  assert.equal((await f.api('GET',endpoint+'/by-request/'+requestId+'?conversationId='+chat.id)).status,409,'the original identity remains held');
  assert.equal(await readFile(path.join(directory,id+'.json'),'utf8'),original);assert.equal(await readFile(path.join(directory,otherId+'.json'),'utf8'),otherOriginal);
  assert.equal(await readFile(path.join(directory,id+'.payload'),'utf8'),'retained original payload');assert.equal(f.turns.length,0);
 },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
