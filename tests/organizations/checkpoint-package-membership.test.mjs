import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCheckpointMembership} from '../../apps/server/dist/checkpoint-package-membership.js';
const agent=(id,managerAgentId,conversationId='chat')=>({id,managerAgentId,conversationId});
test('capture permits complete independent organizations without unrelated Chat Agents',()=>{
  assert.doesNotThrow(()=>assertCheckpointMembership('chat',['a','b','c'],[agent('a'),agent('b','a'),agent('c'),agent('unrelated')]));
});
test('capture refuses missing or moved members and every omitted topology edge',()=>{
  assert.throws(()=>assertCheckpointMembership('chat',['missing'],[]),/missing or moved/);
  assert.throws(()=>assertCheckpointMembership('chat',['a'],[agent('a',undefined,'other')]),/missing or moved/);
  assert.throws(()=>assertCheckpointMembership('chat',['b'],[agent('a'),agent('b','a')]),/external manager/);
  assert.throws(()=>assertCheckpointMembership('chat',['a'],[agent('a'),agent('b','a')]),/live descendant/);
});
