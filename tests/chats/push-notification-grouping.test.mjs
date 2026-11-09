import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {pushPayload} from '../../apps/server/dist/web-push-delivery.js';
import '../shared/resolve-typescript.mjs';
const {parseRoute}=await import('../../apps/web/src/routing.ts');
const {notificationNavigationRoute}=await import('../../apps/web/src/notificationNavigation.ts');

const workerSource=await readFile(new URL('../../apps/web/public/push-handler.js',import.meta.url),'utf8');
function device(view,visibilityState='visible') {
  const handlers={},calls=[],visible=new Map(),receipts=new Map(),opened=[];
  const cache={
    match:async request=>receipts.get(request.url),
    put:async(request,response)=>{receipts.set(request.url,response);},
    keys:async()=>[...receipts.keys()].map(url=>new Request(url)),
    delete:async request=>receipts.delete(request.url),
  };
  const self={
    addEventListener:(type,handler)=>{handlers[type]=handler;},
    location:{origin:'https://fixture.invalid'}, caches:{},
    clients:{matchAll:async()=>[{postMessage:message=>opened.push(message),focus:async()=>{},id:'window',visibilityState,url:'https://fixture.invalid/'}]},
    registration:{showNotification:async(title,options)=>{calls.push({title,...options});visible.set(options.tag,{title,...options});}},
  };
  vm.runInNewContext(workerSource,{self,caches:{open:async()=>cache},Request,Response,URL});
  if(view)handlers.message({data:{type:'ponderosa:active-notification-view',view},source:{id:'window'}});
  return {calls,visible,receipts,opened,async click(item){
    let completion;handlers.notificationclick({notification:{...item,close(){}},waitUntil:promise=>{completion=promise;}});
    assert.ok(completion);await completion;
  },async push(payload){
    let completion;handlers.push({data:{json:()=>payload},waitUntil:promise=>{completion=promise;}});
    assert.ok(completion);await completion;
  }};
}
const notification=(id,overrides={})=>({
  id,kind:'direct_responses',projectId:'project',conversationId:'chat',agentId:'agent',
  communicationEventId:'message:'+id,title:'Agent response',body:'Reply',...overrides,
});
test('UI002 recovery push click and in-app notification open the same exact Agent technical action',async()=>{
 const item=notification('recovery',{kind:'operational',category:'coordination',workContext:{kind:'activation',recordId:'held-work',activationIds:['held-work'],state:'blocked',occurredAt:'2026-11-09T00:00:00Z'},action:{kind:'open_agent',targetId:'agent'}});
 const payload=pushPayload(item),url=new URL(payload.url,'https://fixture.invalid');
 const route=parseRoute(url.pathname,url.search),inApp=notificationNavigationRoute(item);
 assert.equal(route.kind,'agent');assert.equal(route.agentId,'agent');assert.equal(route.view,'technical');assert.equal(route.technicalFocusId,'activation:held-work');
 assert.deepEqual({...route,urlDriven:undefined},{...inApp,urlDriven:undefined});
 const d=device();await d.push(payload);await d.click(d.visible.get(item.id));assert.equal(d.opened[0].url,url.href);
 const ordinary=notification('ordinary',{action:{kind:'open_agent',targetId:'agent'}});
 assert.equal(notificationNavigationRoute(ordinary).kind,'conversation');assert.match(pushPayload(ordinary).url,/\/chats\/chat/);
 const branch=pushPayload({...item,branchId:'branch'}),branchUrl=new URL(branch.url,'https://fixture.invalid');
 const nested=new URL(branchUrl.searchParams.get('workspace'),'https://fixture.invalid');
 assert.equal(parseRoute(nested.pathname,nested.search).technicalFocusId,'activation:held-work');
});
test('repeated ordinary Chat activity replaces one visible notification while retaining per-message receipts',async()=>{
  const d=device({kind:'conversation',projectId:'elsewhere',conversationId:'other'});
  const payloads=Array.from({length:30},(_,i)=>pushPayload(notification('notice-'+i)));
  for(const payload of payloads)await d.push(payload);
  assert.equal(d.calls.length,30);
  assert.equal(d.visible.size,1,'One replaceable notification for the same Chat and activity kind');
  assert.equal(d.receipts.size,30,'Retry receipts remain per original notification');
  assert.ok(d.calls.every(call=>call.renotify===false),'Replacement does not request another alert');
  assert.equal(d.visible.values().next().value.data.notificationId,'notice-29','The replacement reflects the last delivered message');
  await d.push(payloads[0]);
  assert.equal(d.calls.length,30,'Replayed IDs remain deduplicated');
  const reversed=device();
  await reversed.push(payloads[29]);await reversed.push(payloads[0]);
  assert.equal(reversed.visible.size,1);
  assert.equal(reversed.visible.values().next().value.data.notificationId,"notice-0","Arrival order can replace a newer message preview with an older one");
  assert.equal(reversed.receipts.size,2);
});
test('different Chats share a kind while activity kinds remain distinct and active Chats stay quiet',async()=>{
  const outside=device({kind:'conversation',projectId:'elsewhere',conversationId:'other'});
  const items=[
    notification('one'),notification('two',{conversationId:'other-chat'}),
    notification('three',{kind:'broadcasts'}),notification('four',{kind:'everyone'}),
  ];
  for(const item of items)await outside.push(pushPayload(item));
  assert.equal(outside.visible.size,3);
  const direct=outside.visible.get(pushPayload(items[0]).displayTag);
  assert.equal(direct.data.notificationId,items[1].id);
  assert.equal(direct.data.url,pushPayload(items[1]).url,"The displayed item opens its own exact Chat and message");
  assert.notEqual(direct.data.url,pushPayload(items[0]).url);
  await outside.click(direct);
  assert.equal(outside.opened[0].url,new URL(direct.data.url,"https://fixture.invalid").href,"Click opens the retained notification destination");
  const firstTag=pushPayload(items[0]).displayTag;
  outside.visible.delete(firstTag);
  await outside.push(pushPayload(items[0]));
  assert.equal(outside.visible.has(firstTag),false,"A retry of an older receipt cannot reopen a dismissed alert");
  assert.equal(outside.receipts.size,4);
  const active=device({kind:'conversation',projectId:'project',conversationId:'chat'});
  await active.push(pushPayload(items[0]));assert.equal(active.calls.length,0);
  const hidden=device({kind:'conversation',projectId:'project',conversationId:'chat'},'hidden');
  await hidden.push(pushPayload(items[0]));assert.equal(hidden.calls.length,1);
});
test('Assistant reports and operational, decision, information and unclassified notices stay individual',async()=>{
  const d=device();
  const items=[
    notification('report-one',{communicationEventId:'assistant-report:one'}),
    notification('report-two',{communicationEventId:'assistant-report:two'}),
    notification('decision-one',{kind:'decision'}),notification('decision-two',{kind:'decision'}),
    notification('operation-one',{kind:'operational'}),notification('operation-two',{kind:'operational'}),
    notification('info-one',{kind:'information'}),notification('info-two',{kind:'information'}),
    notification('unclassified',{communicationEventId:undefined}),
  ];
  for(const item of items) {
    const payload=pushPayload(item);
    assert.equal(payload.displayTag,undefined,item.id);
    await d.push(payload);
  }
  assert.equal(d.visible.size,items.length);
});
