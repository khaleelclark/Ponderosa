import {ChatPane} from "../../apps/web/src/components/chat/ChatPane";
import {ConversationChromeContext} from "../../apps/web/src/components/ConversationChromeContext";
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {CssBaseline,ThemeProvider} from '@mui/material';
import {DEFAULT_ASSET_LIMITS,type ConversationDraftDto} from '@ponderosa/core';
import {api} from '../../apps/web/src/api';
import {ApiRequestError} from '../../apps/web/src/api/types';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {createPonderosaTheme} from '../../apps/web/src/theme';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {Composer} from '../../apps/web/src/components/chat/Composer';
import type {ChatComposerContract} from '../../apps/web/src/components/chat/composerContracts';
import {ChatMessageFrame} from '../../apps/web/src/components/chat/ChatMessageFrame';
import {ChatSurface} from '../../apps/web/src/components/chat/ChatSurface';
import {OutgoingMessageProvider,OutgoingMessageRow,capturedMessageAnchor,type OutgoingCanonicalRow} from '../../apps/web/src/components/chat/OutgoingMessage';
import {QueuedMessageTray} from '../../apps/web/src/components/chat/QueuedMessageTray';
import {readCapturedSubmissions,saveCapturedSubmission,removeCapturedSubmission,type CapturedSubmission} from '../../apps/web/src/components/chat/submissionOutbox';
import {sha256Bytes} from '../../apps/web/src/components/idempotentAttempt';
import '../../apps/web/src/global.css';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message+'; '+document.body.innerText.slice(-2000));}
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
async function until(read:()=>boolean,message:string){const end=performance.now()+6000;while(performance.now()<end){if(read())return;await settle();}assert(false,message);}
const binding={projectId:'timeline-project',agentId:'timeline-agent',handle:'Timeline',currentHandle:'Timeline',currentTitle:'Timeline Agent'};
type ComposerSendContext=NonNullable<Parameters<ChatComposerContract['onSend']>[4]>;
const scope='timeline-chat';
function press(host:HTMLElement,label:string){const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>(node.getAttribute('aria-label')??node.textContent)===label);assert(button&&!button.disabled,'Enabled '+label);button.click();}
async function retryMessage(host:HTMLElement){await until(()=>[...host.querySelectorAll<HTMLButtonElement>('button')].some(button=>button.textContent==='Retry'&&!button.disabled),'Exact message retry settles before admission');press(host,'Retry');}
function canonical(id:string,text:string):OutgoingCanonicalRow{return {id,communicationEventId:id,createdAt:'2026-11-10T23:59:59Z',projectId:binding.projectId,render:createdAt=><ChatMessageFrame message={{id:'canonical-'+id,createdAt,author:{kind:'operator'},body:text}}/>};}
function captured(id:string,time:number,extra:Partial<CapturedSubmission>={}):CapturedSubmission{return {version:1,scope,storageKey:'timeline-draft',ownerId:'timeline-owner',clientId:'timeline-tab',projectId:binding.projectId,createdAt:time,action:'send',text:'Exact '+id,editorText:'Exact '+id,attachmentNames:[],mentionedAgents:[],newAgentRequested:false,pending:{idempotencyKey:id,fingerprint:'a'.repeat(64),captureRevision:0,request:{conversationId:scope,recipientAgentIds:[],runtime:{activeRunDelivery:'steer'}}},status:'failed',...extra};}

function saveJournal(current:ConversationDraftDto|undefined,conversationId:string,input:any):ConversationDraftDto{
 const retired=new Set<string>(input.retirePendingSubmissionIds??[]);
 const pending=new Map((current?.pendingSubmissions??[]).map(item=>[item.idempotencyKey,item]));
 for(const item of input.pendingSubmissions??[])pending.set(item.idempotencyKey,item);
 for(const id of retired)pending.delete(id);
 return {...current,...input,conversationId,ownerId:input.ownerId,revision:(current?.revision??0)+1,updatedAt:'2026-11-10T00:00:00Z',pendingSubmissions:[...pending.values()],retiredPendingSubmissionIds:[...(current?.retiredPendingSubmissionIds??[]),...[...retired].map(idempotencyKey=>({idempotencyKey,retiredAt:'2026-11-10T00:00:00Z'}))]};
}

export async function messageTimelineRecoveryMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const original={get:api.getConversationDraft,put:api.putConversationDraft};let draft:ConversationDraftDto|undefined,retireFails=false,epoch=0;
 api.getConversationDraft=async(conversationId,ownerId)=>draft??{conversationId,ownerId,revision:0,text:'',attachmentIds:[],attachments:[],updatedAt:'2026-11-10T00:00:00Z'};
 api.putConversationDraft=async(conversationId,input)=>{
  if(input.retirePendingSubmissionIds?.length&&retireFails)throw new ApiRequestError(503,'Controlled retirement unavailable');
  if(input.expectedRevision!==(draft?.revision??0))throw new ApiRequestError(409,'Draft revision conflict');
  draft=saveJournal(draft,conversationId,input);return draft;
 };
 const attempts:Array<{text:string;context:ComposerSendContext;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];let rows:OutgoingCanonicalRow[]=[];
 const render=()=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider><OutgoingMessageProvider key={epoch} scope={scope}><div style={{height:480,display:'flex',flexDirection:'column'}}><ChatSurface layout="project" layoutKey="timeline" showOutgoingMessage outgoingInTimeline><OutgoingMessageRow entries={rows}/></ChatSurface></div><Composer disabled={false} running={false} allowUnmentionedSend projectId={binding.projectId} conversationDraftId={scope} draftStorageKey="timeline-draft" destinationMode="project-chat" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} mentionHandles={[binding.handle]} mentionBindings={[binding]} insertTextRequest={{id:'timeline-insert',text:'#Timeline Original exact captured text λ😀'}} onSend={(text,_files,_ids,_owner,context)=>new Promise((resolve,reject)=>attempts.push({text,context:context!,resolve,reject}))}/><QueuedMessageTray scope={scope} messages={[]} onSteer={()=>{}} onEdit={()=>{}} onDelete={()=>{}}/></OutgoingMessageProvider></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
 try{
  render();await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Original exact')===true,'Draft hydrates');await settle();await settle();press(host,'Send Message');await until(()=>attempts.length===1,'Preparation begins');
  const initial=readCapturedSubmissions(scope)[0],anchor=capturedMessageAnchor(initial.pending.idempotencyKey),node=host.querySelector('#'+anchor);assert(node&&node.textContent?.includes('Original exact captured text')&&node.textContent.includes('Sending'),'Immediate normal bubble renders before actual dispatch');assert(!host.querySelector('[aria-label="Queued Messages"]'),'No normal Send recovery tray');assert(node.querySelector('[aria-label="Copy Whole Message"]'),'Sending retains Copy Whole Message');
  attempts[0].reject(Error('Controlled preparation failure'));await until(()=>host.textContent?.includes('Not Sent')===true,'Predispatch failure remains Not Sent');assert(host.querySelector('#'+anchor)===node,'Failure keeps the same timeline anchor');assert(node.querySelector('[aria-label="Copy Whole Message"]'),'Failed retains Copy Whole Message');assert(node.querySelector('time')?.dateTime===new Date(initial.createdAt).toISOString(),'Failure keeps original capture timestamp');await retryMessage(host);await until(()=>attempts.length===2,'Retry begins once');assert(attempts[1].context.pendingSubmission!.idempotencyKey===initial.pending.idempotencyKey&&attempts[1].text===attempts[0].text,'Retry retains exact identity and text');
  await attempts[1].context.beforeDispatch?.({prefix:'timeline',seed:'exact-operation'});attempts[1].reject(new ApiRequestError(503,'Lost response after actual dispatch'));await until(()=>host.textContent?.includes('Delivery Not Confirmed')===true,'Actual dispatch uncertainty is preserved');assert(![...host.querySelectorAll('button')].some(button=>button.textContent==='Remove'),'Unconfirmed input cannot be removed');
  epoch++;render();await until(()=>host.textContent?.includes('Delivery Not Confirmed')===true,'Reload/navigation projects the existing outbox');await retryMessage(host);await until(()=>attempts.length===3,'Exact retry begins after reload');await attempts[2].context.beforeDispatch?.({prefix:'timeline',seed:'exact-operation'});attempts[2].reject(new ApiRequestError(400,'Later definite rejection'));await until(()=>readCapturedSubmissions(scope)[0]?.error==='Later definite rejection','Later rejection settles');assert(readCapturedSubmissions(scope)[0].status==='unknown','Later rejection cannot erase earlier uncertainty');
  await retryMessage(host);await until(()=>attempts.length===4,'Reconciliation retry begins');await attempts[3].context.beforeDispatch?.({prefix:'timeline',seed:'exact-operation'});
  retireFails=true;const id='timeline-'+await sha256Bytes(new TextEncoder().encode('exact-operation'));rows=[canonical(id,attempts[0].text)];render();await until(()=>readCapturedSubmissions(scope)[0]?.status==='accepted','SSE before HTTP proves exact acceptance');assert(host.querySelectorAll('article').length===1,'SSE adopts one visible message');assert(host.querySelector('#'+anchor),'Canonical adoption retains the capture anchor');assert(host.querySelector<HTMLTimeElement>('#'+anchor+' time')?.dateTime===new Date(initial.createdAt).toISOString(),'Canonical adoption keeps original capture time instead of HTTP/retry time');
  attempts[3].resolve({communicationEventId:id});await settle();assert(!host.textContent?.includes('Finish Cleanup')&&!document.body.textContent?.includes('Cleanup Needs Attention'),'Accepted housekeeping never interrupts');assert(!host.querySelector('#'+anchor+' button'),'Canonical row has no obsolete recovery action');retireFails=false;window.dispatchEvent(new Event('online'));await until(()=>readCapturedSubmissions(scope).length===0,'Exact accepted cleanup retries automatically');await settle();assert(attempts.length===4,'Finish Cleanup never repeats accepted work');assert(host.querySelectorAll('article').length===1&&!host.textContent?.includes('Finish Cleanup')&&!host.textContent?.includes('Retry'),'Retirement leaves one canonical message and no dead recovery controls');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;for(const item of readCapturedSubmissions(scope))removeCapturedSubmission(item.pending.idempotencyKey);}
}

export async function messageTimelineCompoundIdentityMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});
 const item=captured('compound',Date.parse('2026-11-10T12:00:00Z'),{newAgentRequested:true,status:'unknown',dispatchStarted:true,pending:{idempotencyKey:'compound',fingerprint:'b'.repeat(64),request:{conversationId:scope,recipientAgentIds:['other-recipient'],runtime:{activeRunDelivery:'steer'}}}});saveCapturedSubmission(item);
 let rows:OutgoingCanonicalRow[]=[];
 const render=()=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><OutgoingMessageProvider scope={scope}><OutgoingMessageRow entries={rows}/></OutgoingMessageProvider></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
 try{
  render();await settle();const opening={...canonical('agent-opening:created-agent','Opening'),creationIdempotencyKey:'compound:new-agent:0'};rows=[opening];render();await settle();assert(readCapturedSubmissions(scope)[0].status==='unknown','Opening cannot settle remaining compound recipients');
  saveCapturedSubmission({...item,communicationId:'exact-followup'});rows=[opening,canonical('exact-followup','Real second communication')];render();await settle();assert(host.querySelectorAll('article').length===2,'Both genuine canonical communications remain');assert(host.querySelectorAll('#'+capturedMessageAnchor('compound')).length===1,'Only one exact operation anchor');assert([...host.querySelectorAll('button')].filter(node=>node.textContent==='Retry').length===1,'One compound recovery affordance');assert(host.querySelectorAll('time[datetime="2026-11-10T12:00:00.000Z"]').length<=2,'Original timestamp is bound only to the adopted operation');
 }finally{root.unmount();client.clear();host.remove();removeCapturedSubmission('compound');}
}

export async function messageTimelineRejectedRemovalMountedRegression():Promise<void>{
 localStorage.setItem("ponderosa.draft.owner.v1","timeline-owner");
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const earlier=captured('blocked-earlier',1,{status:'unknown',dispatchStarted:true}),later=captured('rejected-later',2,{pending:{...captured('x',2).pending, idempotencyKey:'rejected-later',uploads:[{scope:'broadcast',recipients:[{agentId:scope,attachmentIds:['first-upload','second-upload']}]}]}});saveCapturedSubmission(earlier);saveCapturedSubmission(later);
 const original={get:api.getConversationDraft,put:api.putConversationDraft,remove:api.deleteConversationAttachment};
 let draft:any={conversationId:scope,ownerId:later.ownerId,revision:1,clientId:later.clientId,text:'Newer editable draft stays exact',attachmentIds:[],attachments:[],pendingSubmissions:[earlier.pending],updatedAt:'2026-11-10T00:00:00Z'},retirementFails=true;
 const deletes:string[]=[],writes:any[]=[];
 api.getConversationDraft=async()=>draft;
 api.putConversationDraft=async(_scope,input)=>{writes.push(input);if(input.retirePendingSubmissionIds?.length&&retirementFails)throw new ApiRequestError(503,'Controlled retirement failure');draft=saveJournal(draft,_scope,input);return draft;};
 api.deleteConversationAttachment=async(_owner,id)=>{deletes.push(id);throw new ApiRequestError(503,'Garbage collection is unavailable');};

 try{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><OutgoingMessageProvider scope={scope}><OutgoingMessageRow entries={[]}/><Composer disabled={false} running={false} allowUnmentionedSend conversationDraftId={scope} draftStorageKey={later.storageKey} projectId={binding.projectId} onSend={()=>{throw Error('Removal never sends work');}}/></OutgoingMessageProvider></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
  await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Newer editable')===true,'Original draft hydrates');
  const row=()=>host.querySelector<HTMLElement>('#'+capturedMessageAnchor('rejected-later'))!;
  assert(row().textContent?.includes('Waiting'),'Blocked later capture quietly shows waiting');assert(![...row().querySelectorAll('button')].some(button=>button.textContent==='Retry'),'Waiting has no permanently disabled Retry');assert(row().querySelector('a')?.getAttribute('href')==='#'+capturedMessageAnchor('blocked-earlier'),'Ordering points to exact predecessor');assert(row().querySelector('[aria-label="Copy Whole Message"]'),'Waiting retains Copy Whole Message');
  press(row(),'Remove');await until(()=>readCapturedSubmissions(scope).find(item=>item.pending.idempotencyKey==='rejected-later')?.error==='Controlled retirement failure','Failed canonical retirement retains original row');assert(row(),'Retirement failure cannot hide row');
  retirementFails=false;press(row(),'Remove');await until(()=>readCapturedSubmissions(scope).length===1&&!host.querySelector('#'+capturedMessageAnchor('rejected-later')),'Browser-only rejected capture retires atomically');assert(readCapturedSubmissions(scope)[0].pending.idempotencyKey==='blocked-earlier','Earlier uncertainty stays protected');assert(draft.text==='Newer editable draft stays exact','Removal preserves newer editable text');assert(draft.pendingSubmissions.length===1&&draft.pendingSubmissions[0].idempotencyKey==='blocked-earlier','Retirement preserves canonical sibling');assert(deletes.length===0,'Logical removal never awaits recipient asset garbage collection');assert(writes.at(-1).pendingSubmissions.some((item:any)=>item.idempotencyKey==='rejected-later'),'Browser-only identity is registered with exact retirement');

 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;api.deleteConversationAttachment=original.remove;for(const item of readCapturedSubmissions(scope))removeCapturedSubmission(item.pending.idempotencyKey);}
}


export async function messageTimelineEmptyPaneMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});
 const render=(assistant:boolean)=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><ConversationChromeContext.Provider value={assistant?{assistantAgentId:'assistant-empty',statusHost:null,callActionsHost:null}:undefined}><OutgoingMessageProvider scope="assistant-empty" draftScope="agent:assistant-empty"><div style={{height:480,display:'flex',flexDirection:'column'}}><ChatPane messages={[]} fileOwnerAgentId="assistant-empty"/></div></OutgoingMessageProvider></ConversationChromeContext.Provider></QueryClientProvider></ThemeProvider>));
 try{render(true);await settle();assert(host.textContent?.includes('What’s On Your Mind?'),'Empty Assistant keeps existing welcome');render(false);await settle();assert(host.textContent?.includes('Send a message to this agent to start the conversation.'),'Empty ordinary Agent keeps its existing start state');}finally{root.unmount();client.clear();host.remove();}
}

export async function messageRecoveryAttachmentMountedRegression():Promise<void>{
 const {ChatAttachments}=await import('../../apps/web/src/components/chat/ChatAttachments');
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const url=URL.createObjectURL(new Blob(['Readable exact file text λ😀'],{type:'text/plain'}));
 const binary=URL.createObjectURL(new Blob([new Uint8Array([0,1,2])],{type:'application/octet-stream'}));
 const files=[{id:'file-one',agentId:'agent',name:'A deliberately long filename with spaces and unicode λ😀.txt',size:30,mediaType:'text/plain',url,downloadUrl:url},{id:'file-two',agentId:'agent',name:'unsupported.bin',size:3,mediaType:'application/octet-stream',url:binary,downloadUrl:binary}];
 try{for(const mode of ['light','dark'] as const){
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme(mode)}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider><div style={{maxWidth:700,margin:'24px auto'}}><ChatMessageFrame message={{id:'file-chip-message',createdAt:'2026-11-10T00:00:00Z',author:{kind:'operator'},body:'Files stay compact',attachments:files}}/></div></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));await settle();
  const chip=host.querySelector<HTMLElement>('[aria-label="Preview '+files[0].name+'"]')!,options=host.querySelector<HTMLElement>('[aria-label="File Options For '+files[0].name+'"]')!;assert(chip&&options,'Generic files expose preview and touch options');assert(chip.getBoundingClientRect().width<360,'Generic file is a compact chip');assert(document.documentElement.scrollWidth<=innerWidth,'File chips never overflow phone');
  if(matchMedia('(pointer: coarse)').matches){assert(chip.getBoundingClientRect().height>=44&&options.getBoundingClientRect().width>=44,'Coarse pointer keeps44px controls');}
  await (window as Window&{ui018Capture?:(label:string)=>Promise<void>}).ui018Capture?.('file-chips-'+mode);
  chip.click();await until(()=>document.querySelector('[role="dialog"]')?.textContent?.includes('Readable exact file text')===true,'Existing text preview opens');assert(document.querySelector('[aria-label="Download '+files[0].name+'"]')?.getAttribute('href')===url,'Preview Download uses exact attachment');press(document.body,'Close Attachment Preview');await until(()=>!document.querySelector('[role="dialog"]'),'Preview closes');
  chip.focus();chip.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));await until(()=>Boolean(document.querySelector('[role="menu"]')),'ShiftF10 opens exact file menu');assert(document.querySelector('[role="menu"] a')?.getAttribute('href')===url,'Context menu download targets selected file');document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>!document.querySelector('[role="menu"]'),'Context menu closes');
  press(host,'File Options For unsupported.bin');await until(()=>Boolean(document.querySelector('[role="menu"]')),'Touch-accessible file options open');const preview=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==='Preview');preview!.click();await until(()=>document.querySelector('[role="dialog"]')?.textContent?.includes('unsupported.bin')===true,'Unsupported file opens existing information fallback');assert(document.querySelector('[aria-label="Download unsupported.bin"]')?.getAttribute('href')===binary,'Unsupported preview retains Download');press(document.body,'Close Attachment Preview');await until(()=>!document.querySelector('[role="dialog"]'),'Fallback closes');
 }}finally{root.unmount();client.clear();host.remove();URL.revokeObjectURL(url);URL.revokeObjectURL(binary);}
}

export async function messageTimelineAcceptedStorageFailureMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const original={get:api.getConversationDraft,put:api.putConversationDraft,set:Storage.prototype.setItem};let draft:ConversationDraftDto|undefined,failCleanup=true,resolveSend:((value:any)=>void)|undefined,sends=0,epoch=0;let rows:OutgoingCanonicalRow[]=[];
 const acceptedId='accepted-storage-'+await sha256Bytes(new TextEncoder().encode('exact-accepted-storage'));
 api.getConversationDraft=async(conversationId,ownerId)=>draft??{conversationId,ownerId,text:'',attachmentIds:[],revision:0,updatedAt:'2026-11-10T00:00:00Z'};
 api.putConversationDraft=async(conversationId,input)=>{if(input.retirePendingSubmissionIds?.length&&failCleanup)throw new ApiRequestError(503,'Retirement temporarily unavailable');return draft=saveJournal(draft,conversationId,input);};
 Storage.prototype.setItem=function(key,value){if(key.startsWith('ponderosa.submission.v1.')&&JSON.parse(value||'null')?.status==='accepted')throw new Error('Controlled accepted-state storage refusal');return original.set.call(this,key,value);};
 const render=()=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><OutgoingMessageProvider key={epoch} scope={scope}><OutgoingMessageRow entries={rows}/><Composer disabled={false} running={false} allowUnmentionedSend projectId={binding.projectId} conversationDraftId={scope} draftStorageKey="accepted-failure-draft" destinationMode="project-chat" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} mentionHandles={[binding.handle]} mentionBindings={[binding]} insertTextRequest={{id:'accepted-storage-insert',text:'Exactly accepted with slow bookkeeping'}} onSend={async(_text,_files,_ids,_owner,context)=>{await context?.beforeDispatch?.({prefix:"accepted-storage",seed:"exact-accepted-storage"});sends++;return new Promise(resolve=>resolveSend=resolve);}}/></OutgoingMessageProvider></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
 try{render();await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Exactly accepted')===true,'Draft hydrates');await until(()=>Boolean(host.querySelector<HTMLButtonElement>('[aria-label="Send Message"]:not(:disabled)')),'Send becomes eligible');press(host,'Send Message');await until(()=>Boolean(resolveSend),'Send begins');resolveSend!({communicationEventId:acceptedId});await until(()=>host.textContent?.includes('Exactly accepted')===true,'Accepted row remains');await settle();
  const noRecovery=()=>assert(![...host.querySelectorAll('button')].some(button=>['Retry','Remove','Finish Cleanup'].includes(button.textContent??''))&&!document.body.textContent?.includes('Cleanup Needs Attention'),'Confirmed acceptance never exposes obsolete recovery');noRecovery();assert(readCapturedSubmissions(scope).length===1,'Original capture retained during failed housekeeping');
  rows=[canonical(acceptedId,'Exactly accepted with slow bookkeeping')];render();await settle();noRecovery();assert(host.querySelectorAll('article').length===1,'Exact canonical result adopts one row');epoch++;render();await settle();noRecovery();assert(sends===1,'Canonical reload reconciliation never sends again');failCleanup=false;window.dispatchEvent(new Event('online'));await until(()=>readCapturedSubmissions(scope).length===0,'Bookkeeping eventually retires without intervention');noRecovery();
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;Storage.prototype.setItem=original.set;for(const item of readCapturedSubmissions(scope))removeCapturedSubmission(item.pending.idempotencyKey);}
}
