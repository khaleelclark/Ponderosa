import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {withFixture} from '../shared/fixture.mjs';

test('shared Chat creation validates folders, replays concurrent retries once and never takes Branch ownership from HTTP payload', {timeout:30000},t=>withFixture(t,async f=>{
 const body={label:'Creation boundary',defaultEngine:'codex'},key=randomUUID();
 const create=(value=body,id=key)=>f.api('POST','/api/chats',value,{'idempotency-key':id});
 assert.equal((await create(body,'invalid')).status,400);
 assert.equal((await create({...body,defaultEngine:''},randomUUID())).status,400);
 assert.equal((await create({...body,hostPath:path.join(f.root,'missing')},randomUUID())).status,400);
 const file=path.join(f.root,'file.txt');await writeFile(file,'fixture');
 const invalid=await create({...body,hostPath:file},randomUUID());assert.equal(invalid.status,400);assert.match(invalid.body.error,/must be a directory/);
 const responses=await Promise.all([create(),create()]),a=f.ok(responses[0]),b=f.ok(responses[1]);assert.equal(a.id,b.id);
 assert.equal((await create({...body,label:'Changed'})).status,409);
 const plain=f.ok(await create({...body,branchId:randomUUID(),executionId:randomUUID()},randomUUID()));
 assert.equal(plain.branchId,undefined);assert.equal(plain.executionId,undefined);
 await f.reopen();assert.equal(f.ok(await create()).id,a.id);
 const deletion=f.ok(await f.api('DELETE',`/api/conversations/${a.id}`,{expectedAgentIds:[]}));assert.equal(deletion.deleted,true);
 const retry=await create();assert.equal(retry.status,409);assert.match(retry.body.error,/no longer belongs to a live Chat/);
}));
