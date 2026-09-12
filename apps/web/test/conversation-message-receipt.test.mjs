import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, MutationObserver } from '@tanstack/react-query';
import { publishConversationMessageReceipt } from '../src/conversationMessageReceipt.js';
import { queryKeys } from '../src/queryKeys.js';

const message={id:'saved',communicationEventId:'event',conversationId:'chat',role:'user',text:'hello',createdAt:'2026-09-11T12:00:00Z'};
const detail={conversation:{id:'chat'},agents:[],messages:[],history:{hasMore:true,cursor:'older'}};
test('confirmed send skips delivery-status caches and preserves their in-flight reads', async()=>{
  const client=new QueryClient();
  const receiptKey=queryKeys.conversations.activeDeliveryReceipts('chat','event','activation');
  const receipts={items:[{communicationEventId:'event',deliveryReceipts:[]}]};
  // Insert this sibling first: the old prefix updater throws before publishing the message.
  client.setQueryData(receiptKey,receipts);
  const keys=[100,200].map(limit=>queryKeys.conversations.detail('chat',limit));
  for(const key of keys)client.setQueryData(key,detail);
  let finish;
  let cancelled=false;
  const read=client.fetchQuery({queryKey:receiptKey,queryFn:({signal})=>{
    signal.addEventListener('abort',()=>{cancelled=true;});
    return new Promise(resolve=>{finish=resolve;});
  }}).catch(()=>undefined);
  const mutation=new MutationObserver(client,{
    mutationFn:async()=>({message}),
    onSuccess:response=>publishConversationMessageReceipt(client,'chat',response.message),
  });
  try {
    await mutation.mutate();
    assert.equal(mutation.getCurrentResult().status,'success');
    for(const key of keys)assert.deepEqual(client.getQueryData(key).messages,[message]);
    assert.deepEqual(client.getQueryData(receiptKey),receipts);
    assert.equal(cancelled,false);
  } finally {
    finish(receipts);await read;client.clear();
  }
});
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

test('cache failures cannot turn an acknowledged send into a failed mutation', async t=>{
  for(const failure of ['cancel','publish','refresh'])await t.test(failure,async t=>{
    const client=new QueryClient();const key=queryKeys.conversations.detail('chat');
    const sibling=queryKeys.conversations.activeDeliveryReceipts('chat','event','activation');
    client.setQueryData(key,detail);client.setQueryData(sibling,{items:[]});
    const logs=t.mock.method(console,'error',()=>{});
    if(failure==='cancel')t.mock.method(client,'cancelQueries',async()=>{throw Error('cache cancellation failed');});
    else t.mock.method(client,'setQueriesData',()=>{throw Error('cache publication failed');});
    const invalidate=client.invalidateQueries.bind(client);
    const refresh=t.mock.method(client,'invalidateQueries',async filter=>{
      await invalidate(filter);
      if(failure==='refresh')throw Error('refresh failed');
    });
    let sends=0;
    const mutation=new MutationObserver(client,{
      mutationFn:async()=>{sends++;return {message};},
      onSuccess:response=>publishConversationMessageReceipt(client,'chat',response.message),
    });
    await mutation.mutate();
    assert.equal(sends,1);
    assert.equal(mutation.getCurrentResult().status,'success');
    assert.equal(refresh.mock.callCount(),1);
    assert.equal(client.getQueryState(key).isInvalidated,true);
    assert.equal(client.getQueryState(sibling).isInvalidated,false);
    assert.equal(logs.mock.callCount(),failure==='refresh'?2:1);
    client.clear();
  });
});

test('actual transport failures still reject and never publish a message', async()=>{
  const client=new QueryClient();const key=queryKeys.conversations.detail('chat');
  client.setQueryData(key,detail);
  const failure=Error('request rejected');
  const mutation=new MutationObserver(client,{
    mutationFn:async()=>{throw failure;},
    onSuccess:response=>publishConversationMessageReceipt(client,'chat',response.message),
  });
  await assert.rejects(mutation.mutate(),failure);
  assert.equal(mutation.getCurrentResult().status,'error');
  assert.deepEqual(client.getQueryData(key).messages,[]);
  client.clear();
});
