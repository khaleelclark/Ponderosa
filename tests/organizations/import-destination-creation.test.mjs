import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withFixture} from '../shared/fixture.mjs';

test('import destination creation replays exact Core and Branch Chat identities',{timeout:30000},async t=>{
 await withFixture(t,async f=>{
  const branch=f.ok(await f.api('POST','/api/branches',{name:'Import workflow',idempotencyKey:randomUUID()}));
  for(const owner of [undefined,branch.id]){
   const key=randomUUID(),body={label:'Restored Chat',createFolderName:'import-'+randomUUID(),defaultEngine:'codex'};
   const url=owner?`/api/branches/${owner}/chats`:'/api/chats';
   const first=f.ok(await f.api('POST',url,body,{'idempotency-key':key}));
   const replay=f.ok(await f.api('POST',url,body,{'idempotency-key':key}));
   assert.equal(replay.id,first.id);assert.equal(replay.projectId,first.projectId);
   assert.equal(first.branchId,owner);assert.ok(first.workingDirectory);
   const wrong=await f.api('POST',url,{...body,label:'Different Chat'},{'idempotency-key':key});
   assert.equal(wrong.status,409,'the same identity cannot create changed content');
   const path=owner?`/api/branches/engine/conversations/${first.id}`:`/api/conversations/${first.id}`;
   assert.equal(f.ok(await f.api('GET',path)).conversation.id,first.id);
  }
  assert.equal(f.turns.length,0);
 });
});
