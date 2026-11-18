import {setStandaloneProductScope} from '../../apps/web/src/api/productScope';
import {useMessageDeliveryReceipts} from '../../apps/web/src/components/useMessageDeliveryReceipts';
import {reconcileQueuedProjectMessages} from '../../apps/web/src/components/ConversationView.helpers';
import {ChatMessageFrame} from '../../apps/web/src/components/chat/ChatMessageFrame';
import {ChatMessageBody} from '../../apps/web/src/components/chat/ChatMessages';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {MutationNotificationProvider} from "../../apps/web/src/components/MutationNotifications";
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useQueuedConversationMessagesController} from '../../apps/web/src/components/useQueuedConversationMessagesController';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CssBaseline,ThemeProvider} from '@mui/material';
import {createPonderosaTheme} from '../../apps/web/src/theme';
import {QueuedMessageTray} from '../../apps/web/src/components/chat/QueuedMessageTray';
import {ChatSurface} from '../../apps/web/src/components/chat/ChatSurface';
import {saveCapturedSubmission,removeCapturedSubmission,readCapturedSubmissions,type CapturedSubmission} from '../../apps/web/src/components/chat/submissionOutbox';
import {capturedQueueReceipt} from '../../apps/web/src/components/chat/capturedDraftSubmissions';
import {applyQueuedMessageCancellation} from '../../apps/web/src/components/messageDeliveryReceipts';
import type {QueuedConversationMessageDto} from '@ponderosa/core';

const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(read:()=>boolean,message:string){const end=performance.now()+5000;while(performance.now()<end){if(read())return;await tick();}throw Error(message);}
export async function queuedTrayColdMountRegression():Promise<void>{
 const probe=window as Window&{queuedTrayCheckpoint?:(name:string)=>Promise<void>;queuedTrayNativeAction?:(action:string)=>Promise<void>};
 const checkpoint=async(name:string)=>{await probe.queuedTrayCheckpoint?.(name);};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto'});
 const scope='queued-tray-regression',pendingId='queued-tray-pending',acceptedId='queued-tray-accepted';
 const theme=createPonderosaTheme(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
 const schedulerWindow=window as unknown as {scheduler?:{postTask?:(run:()=>void,options:{signal:AbortSignal;priority:string})=>Promise<void>}};
 const schedulerDescriptor=Object.getOwnPropertyDescriptor(window,'scheduler');
 const scheduler=schedulerWindow.scheduler??{};
 if(!schedulerWindow.scheduler)Object.defineProperty(window,'scheduler',{configurable:true,value:scheduler});
 const nativePostTask=scheduler.postTask;
 const tasks:Array<{signal:AbortSignal;run():void;done:boolean}>=[];
 scheduler.postTask=(run,options)=>new Promise<void>((resolve,reject)=>{
  const task={signal:options.signal,done:false,run(){task.done=true;run();resolve();}};tasks.push(task);
  options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
 });
 const messages:QueuedConversationMessageDto[]=Array.from({length:30},(_,i)=>({deliveryId:'delivery-'+(i+1),messageId:'message-'+(i+1),conversationId:scope,targetAgentId:'agent',position:i+1,text:'Queue '+(i+1)+' exact λ😀',createdAt:'2026-11-07T00:00:00Z',status:'queued'}));
 const captured=(id:string,status:'unknown'|'accepted',acceptedDeliveryIds?:string[])=>({version:1,scope,storageKey:'synthetic-draft',ownerId:'owner',clientId:id,createdAt:1,action:'queue',text:'Captured exact λ😀',editorText:'Captured exact λ😀',attachmentNames:['retained.txt'],mentionedAgents:[],newAgentRequested:false,pending:{idempotencyKey:id,fingerprint:'a'.repeat(64)},status,acceptedDeliveryIds}) as CapturedSubmission;
 const edits:Array<{id:string;text:string}>=[],steers:string[]=[],deletes:string[]=[],retries:string[]=[];
 const retry=(event:Event)=>retries.push((event as CustomEvent<string>).detail);
 window.addEventListener('ponderosa-submission-retry',retry);
 let epoch=0;
 const render=(rows=messages)=>flushSync(()=>root.render(<QueryClientProvider client={client}><ThemeProvider theme={theme}>
  <CssBaseline/><input aria-label="Synthetic retained draft" defaultValue="Keep this draft λ😀"/>
  <QueuedMessageTray key={epoch} scope={scope} messages={rows} onSteer={m=>{steers.push(m.deliveryId);}} onEdit={(m,text)=>{edits.push({id:m.deliveryId,text});}} onDelete={m=>{deletes.push(m.deliveryId);}}/>
 </ThemeProvider></QueryClientProvider>));
 const tray=()=>host.querySelector<HTMLElement>('[aria-label="Queued Messages"]')!;
 const rows=()=>Array.from(tray().querySelectorAll<HTMLElement>('[data-delivery-id]'));
 const capturedRows=()=>tray().querySelectorAll('[data-operation-id]:not([data-delivery-id])');
 const button=(name:string)=>tray().querySelector<HTMLButtonElement>('[aria-label="'+name+'"]')!;
 const field=()=>tray().querySelector<HTMLTextAreaElement>('textarea[aria-label^="Edit Queued Message"]')!;
 const nextTask=async()=>{await until(()=>tasks.some(t=>!t.done&&!t.signal.aborted),'Missing background batch');return tasks.find(t=>!t.done&&!t.signal.aborted)!;};
 const fresh=async()=>{epoch++;render([]);assert(rows().length===0&&capturedRows().length===2,'Empty server state retains both browser intents until an exact canonical receipt deduplicates acceptance');render();await nextTask();assert(rows().length===8,'Only the first eight canonical rows mount while background work is held');assert(capturedRows().length===1,'Unconfirmed intent is immediate and accepted duplicate is excluded');assert(tray().getAttribute('aria-busy')==='true','Finite loading is announced');};
 const changeText=(input:HTMLTextAreaElement,value:string)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
 try{
  saveCapturedSubmission(captured(pendingId,'unknown'));saveCapturedSubmission(captured(acceptedId,'accepted',['delivery-1']));
  await fresh();await checkpoint('initial-eight');
  if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('edit-first');else button('Edit Queued Message 1').click();await until(()=>Boolean(field())&&document.activeElement===field(),'Early edit must focus normally');
  assert(rows().length===8,'Early pointer edit must not synchronously mount the offscreen remainder');
  await checkpoint('early-edit-eight');
  changeText(field(),'Early edit λ😀');await tick();
  if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('save');else Array.from(tray().querySelectorAll('button')).find(n=>n.textContent==='Save')!.click();
  await until(()=>edits.length===1&&!field(),'Early edit settles');assert(edits[0].id==='delivery-1'&&edits[0].text==='Early edit λ😀','Exact early edit callback is preserved');assert(rows().length===8,'Saving an early row does not force all rows');
  for(const count of [16,24,30]){(await nextTask()).run();await until(()=>rows().length===count,'Background batch did not append '+count+' rows');}
  await checkpoint('complete-thirty');
  assert(tray().getAttribute('aria-busy')!=='true','All canonical rows finish without interaction');
  assert(rows().map(n=>n.querySelector<HTMLElement>('[tabindex="0"]')?.textContent).join('|')===messages.map(m=>m.text).join('|'),'All exact texts and order survive');
  assert(button('Steer Queued Message 30').textContent==='Steer'&&button('Steer Queued Message 30').querySelector('svg'),'Steer label and existing arrow share one button');
  if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('steer-tail');else button('Steer Queued Message 30').click();
  if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('delete-tail');else button('Delete Queued Message 30').click();
  await until(()=>steers.length===1&&deletes.length===1,'Tail actions settle');assert(steers[0]==='delivery-30'&&deletes[0]==='delivery-30','Tail actions keep exact identity');
  Array.from(tray().querySelectorAll('button')).find(n=>n.textContent==='Retry')!.click();assert(retries[0]===pendingId,'Unconfirmed retry keeps exact operation');
  assert(host.querySelector<HTMLInputElement>('[aria-label="Synthetic retained draft"]')!.value==='Keep this draft λ😀','The sibling draft is unchanged');

  await fresh();const prefix={...messages[0],deliveryId:'new-prefix',messageId:'new-prefix',position:0,text:'Transient prefix'};
  render([prefix,...messages]);assert(rows().length===31,'ID mutation reveals every current row before paint');
  button('Edit Queued Message 30').click();await until(()=>Boolean(field())&&document.activeElement===field(),'Tail edit focuses');
  changeText(field(),'Tail edit retained λ😀');await tick();const focused=field();render(messages);
  assert(rows().length===30,'A→B→A never stages an already revealed list again');assert(field()===focused&&document.activeElement===focused&&field().value==='Tail edit retained λ😀','Mutation roundtrip retains exact edit and focus');

  await checkpoint('mutation-roundtrip-tail-edit');
  await fresh();if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('scroll');else{tray().scrollTop=60;tray().dispatchEvent(new Event('scroll'));}assert(rows().length===30,'Scrolling exposes the complete canonical range');assert(tray().scrollTop===60,'Appending retains the reader scroll position');
  await fresh();const last=button('Delete Queued Message 8');last.focus({preventScroll:true});assert(rows().length===8,'Keyboard focus alone must not mount the hidden remainder');if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('Tab');else last.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert(rows().length===30,'Forward Tab reveals remaining rows');assert(probe.queuedTrayNativeAction?rows()[8].contains(document.activeElement):document.activeElement===last,'Tab keeps the next queue row in keyboard order');await checkpoint('native-tab-revealed');
  await fresh();if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('Control+f');else document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));assert(rows().length===30,'Native Find receives every fetched row');if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('Escape');
  await fresh();const text=rows()[0].querySelector<HTMLElement>('[tabindex="0"]')!,selection=document.getSelection()!,range=document.createRange();range.selectNodeContents(text);selection.removeAllRanges();selection.addRange(range);const selected=selection.toString();document.dispatchEvent(new Event('selectionchange'));assert(rows().length===30&&selection.toString()===selected,'Selection reveals all rows without losing selected bytes');selection.removeAllRanges();
  await fresh();window.dispatchEvent(new Event('beforeprint'));assert(rows().length===30,'Print receives every fetched row');

  // The shared helper leaves Main's existing prepend/batch policy unchanged.
  const ids=Array.from({length:20},(_,i)=>'main-'+i);
  flushSync(()=>root.render(<><CssBaseline/><div style={{height:120}}><ChatSurface layout="project" layoutKey="queue-scheduler-main" label="Scheduler Main" initialTranscript={{rowIds:ids}}>{first=>ids.slice(first).map(id=><div key={id} data-scheduler-main style={{height:30}}>{id}</div>)}</ChatSurface></div></>));
  await nextTask();assert(host.querySelectorAll('[data-scheduler-main]').length===8,'Main still begins with eight rows');
  (await nextTask()).run();await until(()=>host.querySelectorAll('[data-scheduler-main]').length===16,'Shared helper preserves Main batch size');
  (await nextTask()).run();await until(()=>host.querySelectorAll('[data-scheduler-main]').length===20,'Shared helper preserves Main completion');

  await fresh();const stale=await nextTask();root.unmount();assert(stale.signal.aborted,'Unmount aborts queued background work');stale.run();await tick();assert(!host.childNodes.length,'Cancelled work cannot restore an unmounted tray');
 }finally{
  try{root.unmount();}catch{}client.clear();host.remove();scheduler.postTask=nativePostTask;if(!schedulerDescriptor)delete schedulerWindow.scheduler;else if(!schedulerDescriptor.get)Object.defineProperty(window,'scheduler',schedulerDescriptor);window.removeEventListener('ponderosa-submission-retry',retry);
  removeCapturedSubmission(pendingId);removeCapturedSubmission(acceptedId);document.getSelection()?.removeAllRanges();
 }
}

/** Runtime/default hydration must not rebuild unchanged queue controls. */
export async function queuedTrayParentHydrationRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const scope='queued-tray-memo-regression',pendingId='queued-tray-memo-pending';
 const message:QueuedConversationMessageDto={deliveryId:'memo-delivery',messageId:'memo-message',conversationId:scope,targetAgentId:'memo-agent',position:1,text:'Exact queued text λ😀',createdAt:'2026-11-07T00:00:00Z',status:'queued'};
 let reads=0,epoch=0;const actions:Array<{kind:string;id:string;text?:string}>=[];
 const props={scope,messages:[message],attachmentNamesForMessage:()=>{reads++;return ['original.txt'];},onSteer:(m:QueuedConversationMessageDto)=>{actions.push({kind:'steer',id:m.deliveryId});},onEdit:(m:QueuedConversationMessageDto,text:string)=>{actions.push({kind:'edit',id:m.deliveryId,text});},onDelete:(m:QueuedConversationMessageDto)=>{actions.push({kind:'delete',id:m.deliveryId});}};
 const render=(extra:Partial<import('react').ComponentProps<typeof QueuedMessageTray>>={})=>flushSync(()=>root.render(<QueryClientProvider client={client}><CssBaseline/><div data-unrelated-runtime-hydration={++epoch}><QueuedMessageTray {...props} {...extra}/></div><input aria-label="Memo sibling draft" defaultValue="Retain draft λ😀"/></QueryClientProvider>));
 const button=(name:string)=>host.querySelector<HTMLButtonElement>('[aria-label="'+name+'"]')!;
 try{
  render();const firstReads=reads;assert(firstReads===1,'Initial real tray renders its exact row');
  for(let i=0;i<5;i++)render();assert(reads===firstReads,'Unrelated parent hydration with equal props skips all row rendering');
  render({busy:true});assert(reads>firstReads&&button('Delete Queued Message 1').disabled,'Busy changes still render and disable actions');
  render();assert(!button('Delete Queued Message 1').disabled,'Clearing busy restores existing controls');
  button('Edit Queued Message 1').click();await until(()=>Boolean(host.querySelector('textarea')),'Memo does not block local edit state');
  const field=host.querySelector<HTMLTextAreaElement>('textarea')!,focused=document.activeElement;
  render();assert(host.querySelector('textarea')===field&&document.activeElement===focused,'Unchanged parent retains edit DOM and focus');
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;setter.call(field,'Updated queued λ😀');field.dispatchEvent(new Event('input',{bubbles:true}));await tick();
  Array.from(host.querySelectorAll('button')).find(n=>n.textContent==='Save')!.click();await until(()=>actions.some(a=>a.kind==='edit'),'Local save still settles');
  assert(actions[0].id===message.deliveryId&&actions[0].text==='Updated queued λ😀','Memo preserves exact edit payload');
  const updated=[{...message,text:'Canonical row refresh λ😀'}];render({messages:updated,attachmentNamesForMessage:()=>{reads++;return ['new.txt','second.txt'];}});
  assert(host.textContent?.includes('Canonical row refresh λ😀')&&host.querySelector('[aria-label="2 Attachments"]'),'Canonical text and attachment metadata remain live');
  let latestDelete='';render({onDelete:m=>{latestDelete=m.deliveryId;}});button('Delete Queued Message 1').click();await until(()=>Boolean(latestDelete),'Changed action callback remains live');assert(latestDelete===message.deliveryId,'Latest callback receives exact delivery');
  render();button('Steer Queued Message 1').click();await until(()=>actions.some(a=>a.kind==='steer'),'Existing steer callback remains live');
  saveCapturedSubmission({version:1,scope,storageKey:'memo-draft',ownerId:'memo-owner',clientId:pendingId,createdAt:1,action:'queue',text:'Captured after memo λ😀',editorText:'Captured after memo λ😀',attachmentNames:[],mentionedAgents:[],newAgentRequested:false,pending:{idempotencyKey:pendingId,fingerprint:'a'.repeat(64)},status:'unknown'} as CapturedSubmission);
  await until(()=>Boolean(host.querySelector('[data-operation-id="'+pendingId+'"]')),'External outbox event still updates a memoized tray');
  removeCapturedSubmission(pendingId);await until(()=>!host.querySelector('[data-operation-id]'),'External outbox removal still updates');
  assert(host.querySelector<HTMLInputElement>('[aria-label="Memo sibling draft"]')!.value==='Retain draft λ😀','Sibling draft bytes remain unchanged');
 }finally{root.unmount();client.clear();host.remove();removeCapturedSubmission(pendingId);}
}


export async function queuedTrayAcceptedEditRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),nativeFetch=globalThis.fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,gcTime:Infinity},mutations:{retry:false}}});
 const original:QueuedConversationMessageDto={deliveryId:'accepted-delivery',messageId:'accepted-message',conversationId:'accepted-chat',targetAgentId:'accepted-agent',position:1,text:'Queued note original',createdAt:'2026-11-08T00:00:00Z',status:'queued'};
 const pendingReceipt={activationId:original.deliveryId,targetAgentId:original.targetAgentId,state:'queued' as const,queuedForNextRun:true as const,attemptCount:1,updatedAt:original.createdAt};
 const deletedReceipt={...pendingReceipt,state:'cancelled' as const,queuedForNextRun:undefined,queueDeletionConfirmed:true as const,updatedAt:'2026-11-08T00:00:01Z'};
 const retained=[{id:original.messageId,communicationEventId:original.messageId,conversationId:original.conversationId,communicationSender:{kind:'user' as const,userId:'local-operator'},text:original.text,createdAt:original.createdAt,deliveryReceipts:[pendingReceipt]}];
 let canonical=[original],writes=0,refetches=0,accepted=false,deleted=false,holdReceipt=false,failedRead=false,release:(()=>void)|undefined,releaseReceipt:(()=>void)|undefined;
 const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw),location.origin),method=init?.method??'GET';
  if(method==='PATCH'){writes++;const body=JSON.parse(String(init?.body));canonical=[{...original,text:body.text}];accepted=true;return json({edited:true,replayed:false,status:'edited'});}
  if(method==='GET'&&url.pathname==='/api/conversations/accepted-chat/queued-messages'){refetches++;if(accepted)await new Promise<void>(resolve=>{release=resolve;});return json(canonical);}
  if(method==='POST'&&url.pathname.endsWith('/message-delivery-receipts')){const receipts=[deleted?deletedReceipt:pendingReceipt];if(holdReceipt)await new Promise<void>(resolve=>{releaseReceipt=resolve;});if(failedRead)throw Error('Controlled readback failure');return json({items:[{communicationEventId:original.messageId,deliveryReceipts:receipts}]});}
  if(method==='POST'&&url.pathname.endsWith('/cancel')){writes++;canonical=[];deleted=true;return json({cancelled:true,replayed:false,status:'cancelled',message:{conversationId:original.conversationId,communicationEventId:original.messageId,deliveryReceipts:[deletedReceipt]}});}
  throw Error('Unexpected queue regression request '+method+' '+url.pathname);
 };
 const ownerSources=[{...retained[0],conversationId:undefined,deliveryReceipts:undefined}];
 function ScopeProbe({scope}:{scope:string}){const messages=useMessageDeliveryReceipts(ownerSources,scope,false);return <output>{messages[0]?.deliveryReceipts?.some(receipt=>receipt.queueDeletionConfirmed)?'hidden':'visible'}</output>;}
 function Surface(){const queue=useQueuedConversationMessagesController('accepted-chat'),messages=useMessageDeliveryReceipts(retained,'accepted-chat');
  const projected=reconcileQueuedProjectMessages(messages.map(message=>({kind:'message' as const,id:message.id,at:message.createdAt,message})),queue.query.data??[]);
  return <><CssBaseline/>{projected.timeline.map(entry=>entry.kind==='message'?<ChatMessageFrame key={entry.id} message={{id:entry.id,author:{kind:'operator'},createdAt:entry.at,body:<ChatMessageBody text={entry.message.text}/>}}/>:null)}<QueuedMessageTray messages={projected.queuedMessages} busy={queue.edit.isPending||queue.cancel.isPending} onEdit={(message,text)=>queue.edit.mutateAsync({deliveryId:message.deliveryId,targetAgentId:message.targetAgentId,text})} onDelete={message=>queue.cancel.mutateAsync(message.deliveryId)} onSteer={()=>{}}/></>;}
 const tray=()=>host.querySelector<HTMLElement>('[aria-label="Queued Messages"]')!;
 const field=()=>host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Edit Queued Message"]');
 const button=(name:string)=>host.querySelector<HTMLButtonElement>('[aria-label="'+name+'"]')!;
 const checkpoint=async(name:string)=>{await (window as Window&{phase2UiCheckpoint?:(name:string)=>Promise<void>}).phase2UiCheckpoint?.(name);};
 try{
  root.render(<QueryClientProvider client={client}><MutationNotificationProvider><Surface/></MutationNotificationProvider></QueryClientProvider>);
  await until(()=>Boolean(button('Edit Queued Message 1')),'Canonical queue supplies its verified position after the receipt fallback');
  button('Edit Queued Message 1').click();await until(()=>Boolean(field()),'Edit opens');
  const input=field()!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Queued note edited');input.dispatchEvent(new Event('input',{bubbles:true}));await tick();
  Array.from(tray().querySelectorAll('button')).find(button=>button.textContent==='Save')!.click();
  await until(()=>accepted&&Boolean(release),'Accepted edit starts canonical refresh');
  assert(field()?.value==='Queued note edited','Accepted edit remains visible while the server projection refreshes');
  assert(field()?.disabled,'Pending accepted edit cannot be changed or submitted twice');
  assert(Array.from(tray().querySelectorAll('button')).find(button=>button.textContent==='Cancel')!.disabled,'Pending refresh cannot expose obsolete text through Cancel');
  await checkpoint('queue-accepted-refresh-pending');
  release!();await until(()=>!field()&&tray().textContent?.includes('Queued note edited')===true,'Canonical refresh replaces editor with accepted text');
  assert(!tray().textContent?.includes('Queued note original'),'Original text never reappears after acceptance');
  await checkpoint('queue-accepted-refreshed');
  accepted=false;holdReceipt=true;void client.invalidateQueries({queryKey:queryKeys.conversations.activeDeliveryReceiptsPrefix(original.conversationId)});
  await until(()=>Boolean(releaseReceipt),'Older receipt read is held before deletion');
  button('Delete Queued Message 1').click();await until(()=>!host.querySelector('[aria-label="Queued Messages"]'),'Delete follows the accepted edit without reverting text');
  assert(!host.querySelector('article'),'Successful deletion has no Cancelled bubble or placeholder');
  holdReceipt=false;releaseReceipt!();await tick();assert(!tray()&&!host.querySelector('article'),'Late pre-deletion read cannot resurrect queue or timeline');
  client.setQueryData(queryKeys.queuedMessages.conversation(original.conversationId),[original]);await tick();assert(!tray()&&!host.querySelector('article'),'Stale queue read loses to canonical deletion receipts');
  failedRead=true;await client.invalidateQueries({queryKey:queryKeys.conversations.activeDeliveryReceiptsPrefix(original.conversationId)});await tick();assert(!tray()&&!host.querySelector('article'),'Failed readback keeps committed deletion without another write');
  failedRead=false;root.render(<QueryClientProvider client={client}><MutationNotificationProvider><Surface key="revisit"/></MutationNotificationProvider></QueryClientProvider>);await tick();assert(!tray()&&!host.querySelector('article'),'Revisit uses the same canonical receipt evidence');
  assert(writes===2&&refetches>=3,'Exactly one edit and one delete despite late reads and revisit');
  client.setQueryData([...queryKeys.conversations.activeDeliveryReceipts('fallback-a',original.messageId,''),'/api/conversations'],{items:[{communicationEventId:original.messageId,deliveryReceipts:[deletedReceipt]}]});
  const probe=(scope:string)=>flushSync(()=>root.render(<QueryClientProvider client={client}><ScopeProbe scope={scope}/></QueryClientProvider>));
  probe('fallback-a');assert(host.textContent==='hidden','Exact fallback owner has its receipt');probe('fallback-b');assert(host.textContent==='visible','Owner change cannot carry a deletion receipt with missing conversation fields');
  probe('fallback-a');setStandaloneProductScope('branches');probe('fallback-a');assert(host.textContent==='visible','Product namespace cannot reuse another product receipt or retained projection');setStandaloneProductScope(undefined);
 }finally{setStandaloneProductScope(undefined);release?.();releaseReceipt?.();root.unmount();client.clear();globalThis.fetch=nativeFetch;host.remove();}
}

/** Capture, lost response, acceptance and retirement update one compact mounted row. */
export async function queuedTrayCaptureContinuityRegression():Promise<void>{
 const scope='queue-continuity',id='queue-continuity-operation',host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const capture={version:1,scope,storageKey:'continuity-draft',ownerId:'owner',clientId:id,createdAt:1,action:'queue',text:'',editorText:'',attachmentNames:['exact.txt'],mentionedAgents:[],newAgentRequested:false,pending:{idempotencyKey:id,fingerprint:'b'.repeat(64),request:{recipientAgentIds:['continuity-agent'],runtime:{activeRunDelivery:'queue'}}},status:'unknown'} as CapturedSubmission;
 const message:QueuedConversationMessageDto={deliveryId:'continuity-delivery',messageId:'continuity-message',communicationEventId:'continuity-event',conversationId:scope,targetAgentId:'continuity-agent',position:1,text:'',attachmentCount:1,createdAt:'2026-11-10T00:00:00Z',status:'queued'};
 let steers=0;const render=(messages:QueuedConversationMessageDto[])=>flushSync(()=>root.render(<QueryClientProvider client={client}><ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueuedMessageTray scope={scope} messages={messages} onSteer={()=>{steers++;}} onEdit={()=>{}} onDelete={()=>{}}/></ThemeProvider></QueryClientProvider>));
 try{
  saveCapturedSubmission(capture);render([]);const row=host.querySelector<HTMLElement>('[data-queue-row]')!,height=row.getBoundingClientRect().height,edit=row.querySelector('[aria-label^="Edit Queued Message"]'),remove=row.querySelector('[aria-label^="Delete"]');
  assert(row&&row.textContent?.includes('exact.txt'),'Attachment-only capture renders immediately in the compact queue row');
  assert(host.querySelectorAll('[data-queue-row]').length===1&&!host.textContent?.includes('Details'),'No alternate capture card or technical Details');
  window.dispatchEvent(new StorageEvent('storage'));await tick();assert(host.querySelector('[data-queue-row]')===row,'Cross-tab notifications retain row identity');
  flushSync(()=>{saveCapturedSubmission({...capture,status:'accepted',communicationId:message.communicationEventId,acceptedDeliveryIds:[message.deliveryId]});root.render(<QueryClientProvider client={client}><ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueuedMessageTray scope={scope} messages={[message]} onSteer={()=>{steers++;}} onEdit={()=>{}} onDelete={()=>{}}/></ThemeProvider></QueryClientProvider>);removeCapturedSubmission(id);});assert(host.querySelectorAll('[data-queue-row]').length===1&&host.querySelector('[data-delivery-id]')===row,'Exact canonical acceptance adopts the captured row without duplication');
  assert(row.querySelector('[aria-label^="Edit Queued Message"]')===edit&&row.querySelector('[aria-label^="Delete"]')===remove,'Existing action controls remain mounted');
  assert(Math.abs(row.getBoundingClientRect().height-height)<1,'Capture and accepted row retain height');
  removeCapturedSubmission(id);await tick();assert(host.querySelector('[data-delivery-id]')===row,'Capture retirement preserves the same canonical row');
  (row.querySelector('[aria-label="Steer Queued Message 1"]') as HTMLButtonElement).click();await tick();assert(steers===1,'Adopted action invokes the existing callback once');
  root.unmount();const fresh=createRoot(host);flushSync(()=>fresh.render(<QueryClientProvider client={client}><QueuedMessageTray scope={scope} messages={[message]} onSteer={()=>{}} onEdit={()=>{}} onDelete={()=>{}}/></QueryClientProvider>));assert(host.querySelectorAll('[data-queue-row]').length===1,'Reload renders only the canonical queue authority');fresh.unmount();
 }finally{try{root.unmount();}catch{}client.clear();host.remove();removeCapturedSubmission(id);}
}

/** Delayed readback cannot manufacture Working; acknowledged readback clears Starting without text. */
export async function messageAcknowledgementReadbackRegression():Promise<void>{
 const {messageDeliveryPhase}=await import('../../apps/web/src/components/messageDeliveryPhase');
 const nativeFetch=globalThis.fetch,host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
 const receipt={activationId:'ack-delivery',targetAgentId:'ack-agent',state:'started' as const,attemptCount:1,updatedAt:'2026-11-10T00:00:00Z'};
 const source=[{id:'ack-message',conversationId:'ack-chat',communicationEventId:'ack-event',deliveryReceipts:[receipt]}];let reads=0,ack=false,release:(()=>void)|undefined;
 globalThis.fetch=async()=>{reads++;if(ack)await new Promise<void>(resolve=>{release=resolve;});return new Response(JSON.stringify({items:[{communicationEventId:'ack-event',deliveryReceipts:[ack?{...receipt,state:'delivered',providerAcknowledged:true,injectionId:'exact-injection',injectionKind:'turn',executionId:'exact-run',updatedAt:'2026-11-10T00:00:01Z'}:receipt]}]}),{headers:{'content-type':'application/json'}});};
 function View(){const rows=useMessageDeliveryReceipts(source,'ack-chat');return <p>{messageDeliveryPhase(rows[0].deliveryReceipts![0])}</p>;}
 try{
  flushSync(()=>root.render(<QueryClientProvider client={client}><View/></QueryClientProvider>));await until(()=>reads===1,'Initial exact receipt read');assert(host.textContent==='Starting','Submission without acknowledgement stays Starting');
  ack=true;void client.invalidateQueries({queryKey:queryKeys.conversations.activeDeliveryReceiptsPrefix('ack-chat')});await until(()=>Boolean(release),'Delayed post-ack read starts');await new Promise(resolve=>setTimeout(resolve,300));assert(host.textContent==='Starting','An invalidation or open socket is not acknowledgement proof');
  release!();await until(()=>host.textContent==='Working','Durable acknowledgement updates the existing row before any reply text');assert(reads===2,'One bounded refresh, no retry loop or history fetch');
 }finally{root.unmount();client.clear();host.remove();globalThis.fetch=nativeFetch;}
}

/** A lost queue response must not return as a pending row after canonical Delete. */
export async function queuedTrayLostAcknowledgementDeletionRegression():Promise<void>{
 const conversationId='lost-queue-chat',scope='agent:lost-queue-agent',id='lost-queue-operation';
 const capture={version:1,scope,apiNamespace:'/api/conversations',storageKey:'lost-queue-draft',ownerId:'lost-owner',clientId:id,createdAt:1,action:'queue',text:'Immutable queued bytes λ😀',editorText:'Immutable queued bytes λ😀',attachmentNames:[],mentionedAgents:[],newAgentRequested:false,dispatchStarted:true,communicationId:'lost-queue-event',pending:{idempotencyKey:id,fingerprint:'b'.repeat(64),captureRevision:4,request:{recipientAgentIds:['lost-queue-agent'],runtime:{activeRunDelivery:'queue'}}},status:'pending'} as CapturedSubmission;
 const queued={activationId:'lost-queue-delivery',targetAgentId:'lost-queue-agent',state:'queued' as const,queuedForNextRun:true as const,attemptCount:1,updatedAt:'2026-11-11T00:00:00Z'};
 const deleted={...queued,state:'cancelled' as const,queuedForNextRun:undefined,queueDeletionConfirmed:true as const,updatedAt:'2026-11-11T00:00:01Z'};
 const source={conversationId,communicationEventId:capture.communicationId,deliveryReceipts:[deleted]};
 const partial={...capture,pending:{...capture.pending,request:{...capture.pending.request!,recipientAgentIds:['lost-queue-agent','another-recipient']}}};
 const proof=capturedQueueReceipt(partial,conversationId,source);
 assert(proof.deletedTargets.has('lost-queue-agent')&&!proof.accepted,'One deleted recipient cannot settle another missing recipient');
 assert(!capturedQueueReceipt(capture,conversationId,{...source,conversationId:'foreign-chat'}).accepted,'Foreign Chat cannot acknowledge a capture');
 assert(!capturedQueueReceipt(capture,conversationId,{...source,communicationEventId:'foreign-source'}).accepted,'Exact publication identity is required');
 assert(!capturedQueueReceipt({...capture,apiNamespace:undefined},conversationId,source).accepted,'Missing product binding cannot authorize automatic adoption');
 assert(!capturedQueueReceipt({...capture,newAgentRequested:true},conversationId,source).accepted,'One publication cannot settle compound creation');
 assert(capturedQueueReceipt(capture,conversationId,{...source,deliveryReceipts:[{...deleted,queueDeletionConfirmed:undefined,providerAcknowledged:true,executionId:'possibly-delivered'}]}).deletedTargets.size===0,'Cancelled state alone never hides possibly delivered work');
 assert(capturedQueueReceipt(capture,conversationId,{...source,deliveryReceipts:[deleted,{...queued,activationId:'newer-attempt'}]}).deletedTargets.size===0,'Ambiguous attempts cannot hide a recipient');
 setStandaloneProductScope('branches');
 assert(!capturedQueueReceipt(capture,conversationId,source).accepted,'Another product cannot adopt core capture evidence');setStandaloneProductScope(undefined);
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 let client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,gcTime:Infinity}}});
 const nativeFetch=globalThis.fetch;let reads=0,writes=0,hold=true,release:(()=>void)|undefined;
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw),location.origin),method=init?.method??'GET';
  if(method==='POST'&&url.pathname===`/api/conversations/${conversationId}/message-delivery-receipts`){
   const body=JSON.parse(String(init?.body));assert(JSON.stringify(body.communicationEventIds)===JSON.stringify([capture.communicationId])&&body.activationIds.length===0,'Only the exact captured source is read');reads++;const stale=hold;if(hold)await new Promise<void>(resolve=>{release=resolve;});return json({items:[{communicationEventId:capture.communicationId,deliveryReceipts:[stale?queued:deleted]}]});
  }
  if(method==='GET'&&url.pathname===`/api/agents/lost-queue-agent/queued-messages`)return json([]);
  if(method==='GET'&&decodeURIComponent(url.pathname)===`/api/conversations/${scope}/draft`)return json({conversationId:scope,ownerId:capture.ownerId,revision:4,text:'Newer editable draft stays intact',attachmentIds:[],pendingSubmissions:[capture.pending]});
  if(method==='PUT'&&decodeURIComponent(url.pathname)===`/api/conversations/${scope}/draft`){
   writes++;const body=JSON.parse(String(init?.body));assert(body.captureMetadataOnly&&body.text==='Newer editable draft stays intact'&&body.retirePendingSubmissionIds.length===1&&body.retirePendingSubmissionIds[0]===id,'Retirement preserves newer text and selects only the original capture');return json({error:'Controlled retirement storage failure'},400);
  }
  throw Error('Unexpected lost-queue request '+method+' '+url.pathname);
 };
 const render=()=>flushSync(()=>root.render(<QueryClientProvider client={client}><QueuedMessageTray scope={scope} conversationId={conversationId} messages={[]} onSteer={()=>{throw Error('No automatic Steer');}} onEdit={()=>{throw Error('No automatic Edit');}} onDelete={()=>{throw Error('No automatic Delete');}}/></QueryClientProvider>));
 const tray=()=>host.querySelector('[aria-label="Queued Messages"]');
 const retirementKey=['captured-retirement','/api/conversations',scope,capture.ownerId,id];
 try{
  saveCapturedSubmission(capture);render();await until(()=>Boolean(release),'Exact cold lost-response read begins');assert(tray(),'Unproved capture remains visible');
  applyQueuedMessageCancellation(client,{cancelled:true,replayed:false,status:'cancelled',message:{conversationId,communicationEventId:capture.communicationId!,deliveryReceipts:[deleted]}});
  await until(()=>!tray()&&readCapturedSubmissions(scope)[0]?.status==='accepted','Exact deletion hides the row and acknowledges the original capture');
  await until(()=>client.getQueryState(retirementKey)?.status==='error','Quiet retirement failure is retained without retrying work');
  assert(readCapturedSubmissions(scope)[0]?.text===capture.text&&!host.querySelector('[role="alert"]'),'Failed metadata cleanup retains original bytes without a user interruption');
  hold=false;release!();await tick();assert(!tray(),'Late queued response cannot revive the canonically deleted row');
  root.unmount();client.clear();client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,gcTime:Infinity}}});root=createRoot(host);render();
  await until(()=>reads===2&&!tray()&&client.getQueryState(retirementKey)?.status==='error','Cold accepted capture re-obtains deletion proof even when cleanup still fails');
  assert(writes===2&&readCapturedSubmissions(scope)[0]?.pending.idempotencyKey===id,'No replay, new operation identity or premature local removal');
 }finally{release?.();root.unmount();client.clear();globalThis.fetch=nativeFetch;host.remove();removeCapturedSubmission(id);setStandaloneProductScope(undefined);}
}
