import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { publishConversationMessageReceipt } from '../src/conversationMessageReceipt.js';
import { queryKeys } from '../src/queryKeys.js';

const message={id:'saved',communicationEventId:'event',conversationId:'chat',role:'user',text:'hello',createdAt:'2026-09-11T12:00:00Z'};
const detail={conversation:{id:'chat'},agents:[],messages:[],history:{hasMore:true,cursor:'older'}};
test('confirmed message appears before any refresh; replay does not duplicate or regress newer state', async()=>{
  const client=new QueryClient();
  const key=queryKeys.conversations.detail('chat');
  client.setQueryData(key,detail);
  client.setQueryData(queryKeys.conversations.detail('other'),{...detail,conversation:{id:'other'}});
  await publishConversationMessageReceipt(client,'chat',message);
  assert.deepEqual(client.getQueryData(key).messages,[message]);
  assert.deepEqual(client.getQueryData(key).history,detail.history);
  assert.equal(client.getQueryData(queryKeys.conversations.detail('other')).messages.length,0);
  const updated={...message,text:'edited',editRevision:1};
  client.setQueryData(key,{...detail,messages:[updated]});
  await publishConversationMessageReceipt(client,'chat',message);
  assert.deepEqual(client.getQueryData(key).messages,[updated]);
  await publishConversationMessageReceipt(client,'chat',undefined);
  await publishConversationMessageReceipt(client,'chat',{...message,id:'wrong',conversationId:'other'});
  assert.deepEqual(client.getQueryData(key).messages,[updated]);
  client.clear();
});
test('stale in-flight reads cannot overwrite the receipt; unloaded chats remain unloaded', async()=>{
  const client=new QueryClient();const key=queryKeys.conversations.detail('chat');
  client.setQueryData(key,detail);
  let finish;
  const read=client.fetchQuery({queryKey:key,queryFn:()=>new Promise(resolve=>{finish=resolve;})}).catch(()=>undefined);
  await publishConversationMessageReceipt(client,'chat',message);
  finish(detail);await read;
  assert.deepEqual(client.getQueryData(key).messages,[message]);
  await publishConversationMessageReceipt(client,'unloaded',{...message,conversationId:'unloaded'});
  assert.equal(client.getQueryData(queryKeys.conversations.detail('unloaded')),undefined);
  client.clear();
});
