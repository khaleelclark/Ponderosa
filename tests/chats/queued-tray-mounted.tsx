import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CssBaseline} from '@mui/material';
import {QueuedMessageTray} from '../../apps/web/src/components/chat/QueuedMessageTray';
import {ChatSurface} from '../../apps/web/src/components/chat/ChatSurface';
import {saveCapturedSubmission,removeCapturedSubmission,type CapturedSubmission} from '../../apps/web/src/components/chat/submissionOutbox';
import type {QueuedConversationMessageDto} from '@ponderosa/core';

const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(read:()=>boolean,message:string){const end=performance.now()+5000;while(performance.now()<end){if(read())return;await tick();}throw Error(message);}
export async function queuedTrayColdMountRegression():Promise<void>{
 const probe=window as Window&{queuedTrayCheckpoint?:(name:string)=>Promise<void>;queuedTrayNativeAction?:(action:string)=>Promise<void>};
 const checkpoint=async(name:string)=>{await probe.queuedTrayCheckpoint?.(name);};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const scope='queued-tray-regression',pendingId='queued-tray-pending',acceptedId='queued-tray-accepted';
 const scheduler=(window as unknown as {scheduler:{postTask:(run:()=>void,options:{signal:AbortSignal;priority:string})=>Promise<void>}}).scheduler;
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
 const render=(rows=messages)=>flushSync(()=>root.render(<>
  <CssBaseline/><input aria-label="Synthetic retained draft" defaultValue="Keep this draft λ😀"/>
  <QueuedMessageTray key={epoch} scope={scope} messages={rows} onSteer={m=>{steers.push(m.deliveryId);}} onEdit={(m,text)=>{edits.push({id:m.deliveryId,text});}} onDelete={m=>{deletes.push(m.deliveryId);}} agentNameForId={()=>'Synthetic Agent'}/>
 </>));
 const tray=()=>host.querySelector<HTMLElement>('[aria-label="Queued messages"]')!;
 const rows=()=>Array.from(tray().querySelectorAll<HTMLElement>('[data-queue-row]:not([data-operation-id])'));
 const capturedRows=()=>tray().querySelectorAll('[data-operation-id]');
 const button=(name:string)=>tray().querySelector<HTMLButtonElement>('[aria-label="'+name+'"]')!;
 const field=()=>tray().querySelector<HTMLTextAreaElement>('textarea[aria-label^="Edit queued message"]')!;
 const nextTask=async()=>{await until(()=>tasks.some(t=>!t.done&&!t.signal.aborted),'Missing background batch');return tasks.find(t=>!t.done&&!t.signal.aborted)!;};
 const fresh=async()=>{epoch++;render([]);assert(rows().length===0&&capturedRows().length===2,'Empty server state retains both browser intents until an exact canonical receipt deduplicates acceptance');render();await nextTask();assert(rows().length===8,'Only the first eight canonical rows mount while background work is held');assert(capturedRows().length===1,'Unconfirmed intent is immediate and accepted duplicate is excluded');assert(tray().getAttribute('aria-busy')==='true','Finite loading is announced');};
 const changeText=(input:HTMLTextAreaElement,value:string)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
 try{
  saveCapturedSubmission(captured(pendingId,'unknown'));saveCapturedSubmission(captured(acceptedId,'accepted',['delivery-1']));
  await fresh();await checkpoint('initial-eight');
  if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('edit-first');else button('Edit queued message 1').click();await until(()=>Boolean(field())&&document.activeElement===field(),'Early edit must focus normally');
  assert(rows().length===8,'Early pointer edit must not synchronously mount the offscreen remainder');
  await checkpoint('early-edit-eight');
  changeText(field(),'Early edit λ😀');await tick();
  if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('save');else Array.from(tray().querySelectorAll('button')).find(n=>n.textContent==='Save')!.click();
  await until(()=>edits.length===1&&!field(),'Early edit settles');assert(edits[0].id==='delivery-1'&&edits[0].text==='Early edit λ😀','Exact early edit callback is preserved');assert(rows().length===8,'Saving an early row does not force all rows');
  for(const count of [16,24,30]){(await nextTask()).run();await until(()=>rows().length===count,'Background batch did not append '+count+' rows');}
  await checkpoint('complete-thirty');
  assert(tray().getAttribute('aria-busy')!=='true','All canonical rows finish without interaction');
  assert(rows().map(n=>n.querySelector<HTMLElement>('[tabindex="0"]')?.textContent).join('|')===messages.map(m=>m.text).join('|'),'All exact texts and order survive');
  button('Steer queued message 30').click();button('Delete queued message 30').click();
  await until(()=>steers.length===1&&deletes.length===1,'Tail actions settle');assert(steers[0]==='delivery-30'&&deletes[0]==='delivery-30','Tail actions keep exact identity');
  Array.from(tray().querySelectorAll('button')).find(n=>n.textContent==='Retry')!.click();assert(retries[0]===pendingId,'Unconfirmed retry keeps exact operation');
  assert(host.querySelector<HTMLInputElement>('[aria-label="Synthetic retained draft"]')!.value==='Keep this draft λ😀','The sibling draft is unchanged');

  await fresh();const prefix={...messages[0],deliveryId:'new-prefix',messageId:'new-prefix',position:0,text:'Transient prefix'};
  render([prefix,...messages]);assert(rows().length===31,'ID mutation reveals every current row before paint');
  button('Edit queued message 30').click();await until(()=>Boolean(field())&&document.activeElement===field(),'Tail edit focuses');
  changeText(field(),'Tail edit retained λ😀');await tick();const focused=field();render(messages);
  assert(rows().length===30,'A→B→A never stages an already revealed list again');assert(field()===focused&&document.activeElement===focused&&field().value==='Tail edit retained λ😀','Mutation roundtrip retains exact edit and focus');

  await checkpoint('mutation-roundtrip-tail-edit');
  await fresh();if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('scroll');else{tray().scrollTop=60;tray().dispatchEvent(new Event('scroll'));}assert(rows().length===30,'Scrolling exposes the complete canonical range');assert(tray().scrollTop===60,'Appending retains the reader scroll position');
  await fresh();const last=button('Delete queued message 8');last.focus({preventScroll:true});assert(rows().length===8,'Keyboard focus alone must not mount the hidden remainder');if(probe.queuedTrayNativeAction)await probe.queuedTrayNativeAction('Tab');else last.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert(rows().length===30,'Forward Tab reveals remaining rows');assert(probe.queuedTrayNativeAction?rows()[8].contains(document.activeElement):document.activeElement===last,'Tab keeps the next queue row in keyboard order');await checkpoint('native-tab-revealed');
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
  try{root.unmount();}catch{}host.remove();scheduler.postTask=nativePostTask;window.removeEventListener('ponderosa-submission-retry',retry);
  removeCapturedSubmission(pendingId);removeCapturedSubmission(acceptedId);document.getSelection()?.removeAllRanges();
 }
}
