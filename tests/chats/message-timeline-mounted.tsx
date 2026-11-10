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
function captured(id:string,time:number,extra:Partial<CapturedSubmission>={}):CapturedSubmission{return {version:1,scope,storageKey:'timeline-draft',ownerId:'timeline-owner',clientId:'timeline-tab',projectId:binding.projectId,createdAt:time,action:'send',text:'Exact '+id,editorText:'Exact '+id,attachmentNames:[],mentionedAgents:[],newAgentRequested:false,pending:{idempotencyKey:id,fingerprint:'a'.repeat(64),request:{conversationId:scope,recipientAgentIds:[],runtime:{activeRunDelivery:'steer'}}},status:'failed',...extra};}

export async function messageTimelineRecoveryMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const original={get:api.getConversationDraft,put:api.putConversationDraft};let draft:ConversationDraftDto|undefined,retireFails=false,epoch=0;
 api.getConversationDraft=async(conversationId,ownerId)=>draft??{conversationId,ownerId,revision:0,text:'',attachmentIds:[],attachments:[],updatedAt:'2026-11-10T00:00:00Z'};
 api.putConversationDraft=async(conversationId,input)=>{
  if(input.retirePendingSubmissionIds?.length&&retireFails)throw new ApiRequestError(503,'Controlled retirement unavailable');
  if(input.expectedRevision!==(draft?.revision??0))throw new ApiRequestError(409,'Draft revision conflict');
  draft={...draft,...input,conversationId,ownerId:input.ownerId!,revision:(draft?.revision??0)+1,updatedAt:'2026-11-10T00:00:00Z'};return draft;
 };
 const attempts:Array<{text:string;context:ComposerSendContext;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];let rows:OutgoingCanonicalRow[]=[];
 const render=()=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider><OutgoingMessageProvider key={epoch} scope={scope}><div style={{height:480,display:'flex',flexDirection:'column'}}><ChatSurface layout="project" layoutKey="timeline" showOutgoingMessage outgoingInTimeline><OutgoingMessageRow entries={rows}/></ChatSurface></div><Composer disabled={false} running={false} allowUnmentionedSend projectId={binding.projectId} conversationDraftId={scope} draftStorageKey="timeline-draft" destinationMode="project-chat" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} mentionHandles={[binding.handle]} mentionBindings={[binding]} insertTextRequest={{id:'timeline-insert',text:'#Timeline Original exact captured text λ😀'}} onSend={(text,_files,_ids,_owner,context)=>new Promise((resolve,reject)=>attempts.push({text,context:context!,resolve,reject}))}/><QueuedMessageTray scope={scope} messages={[]} onSteer={()=>{}} onEdit={()=>{}} onDelete={()=>{}}/></OutgoingMessageProvider></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
 try{
  render();await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Original exact')===true,'Draft hydrates');await settle();await settle();press(host,'Send Message');await until(()=>attempts.length===1,'Preparation begins');
  const initial=readCapturedSubmissions(scope)[0],anchor=capturedMessageAnchor(initial.pending.idempotencyKey),node=host.querySelector('#'+anchor);assert(node&&node.textContent?.includes('Original exact captured text')&&node.textContent.includes('Sending'),'Immediate normal bubble renders before actual dispatch');assert(!host.querySelector('[aria-label="Queued Messages"]'),'No normal Send recovery tray');
  attempts[0].reject(Error('Controlled preparation failure'));await until(()=>host.textContent?.includes('Not Sent')===true,'Predispatch failure remains Not Sent');assert(host.querySelector('#'+anchor)===node,'Failure keeps the same timeline anchor');assert(node.querySelector('time')?.dateTime===new Date(initial.createdAt).toISOString(),'Failure keeps original capture timestamp');await retryMessage(host);await until(()=>attempts.length===2,'Retry begins once');assert(attempts[1].context.pendingSubmission!.idempotencyKey===initial.pending.idempotencyKey&&attempts[1].text===attempts[0].text,'Retry retains exact identity and text');
  await attempts[1].context.beforeDispatch?.({prefix:'timeline',seed:'exact-operation'});attempts[1].reject(new ApiRequestError(503,'Lost response after actual dispatch'));await until(()=>host.textContent?.includes('Unconfirmed')===true,'Actual dispatch uncertainty is preserved');assert(![...host.querySelectorAll('button')].some(button=>button.textContent==='Remove'),'Unconfirmed input cannot be removed');
  epoch++;render();await until(()=>host.textContent?.includes('Unconfirmed')===true,'Reload/navigation projects the existing outbox');await retryMessage(host);await until(()=>attempts.length===3,'Exact retry begins after reload');await attempts[2].context.beforeDispatch?.({prefix:'timeline',seed:'exact-operation'});attempts[2].reject(new ApiRequestError(400,'Later definite rejection'));await until(()=>readCapturedSubmissions(scope)[0]?.error==='Later definite rejection','Later rejection settles');assert(readCapturedSubmissions(scope)[0].status==='unknown','Later rejection cannot erase earlier uncertainty');
  await retryMessage(host);await until(()=>attempts.length===4,'Reconciliation retry begins');await attempts[3].context.beforeDispatch?.({prefix:'timeline',seed:'exact-operation'});
  const id='timeline-'+await sha256Bytes(new TextEncoder().encode('exact-operation'));rows=[canonical(id,attempts[0].text)];render();await until(()=>readCapturedSubmissions(scope)[0]?.status==='accepted','SSE before HTTP proves exact acceptance');assert(host.querySelectorAll('article').length===1,'SSE adopts one visible message');assert(host.querySelector('#'+anchor),'Canonical adoption retains the capture anchor');assert(host.querySelector<HTMLTimeElement>('#'+anchor+' time')?.dateTime===new Date(initial.createdAt).toISOString(),'Canonical adoption keeps original capture time instead of HTTP/retry time');
  retireFails=true;attempts[3].resolve({communicationEventId:id});await until(()=>host.textContent?.includes('Finish Cleanup')===true,'Accepted message retains actionable retirement failure');retireFails=false;press(host,'Finish Cleanup');await until(()=>readCapturedSubmissions(scope).length===0,'Exact accepted cleanup retires capture');await settle();assert(attempts.length===4,'Finish Cleanup never repeats accepted work');assert(host.querySelectorAll('article').length===1&&!host.textContent?.includes('Finish Cleanup')&&!host.textContent?.includes('Retry'),'Retirement leaves one canonical message and no dead recovery controls');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;for(const item of readCapturedSubmissions(scope))removeCapturedSubmission(item.pending.idempotencyKey);}
}

export async function messageTimelineCompoundIdentityMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});
 const item=captured('compound',Date.parse('2026-11-10T12:00:00Z'),{newAgentRequested:true,status:'unknown',dispatchStarted:true,pending:{idempotencyKey:'compound',fingerprint:'b'.repeat(64),request:{conversationId:scope,recipientAgentIds:['other-recipient'],runtime:{activeRunDelivery:'steer'}}}});saveCapturedSubmission(item);
 let rows:OutgoingCanonicalRow[]=[];
 const render=()=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><OutgoingMessageProvider scope={scope}><OutgoingMessageRow entries={rows}/></OutgoingMessageProvider></QueryClientProvider></ThemeProvider>));
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
 let draft:any={conversationId:scope,ownerId:later.ownerId,revision:1,clientId:later.clientId,text:'Newer editable draft stays exact',attachmentIds:[],attachments:[],pendingSubmissions:[earlier.pending,later.pending],updatedAt:'2026-11-10T00:00:00Z'},cleanupFails=true,retirementFails=true,release:(()=>void)|undefined;
 const deletes:string[]=[],writes:any[]=[];
 api.getConversationDraft=async()=>draft;
 api.putConversationDraft=async(_scope,input)=>{writes.push(input);if(input.retirePendingSubmissionIds?.length&&retirementFails)throw new ApiRequestError(409,'Controlled CAS conflict');draft={...draft,...input,revision:draft.revision+1};return draft;};
 api.deleteConversationAttachment=async(owner,id)=>{assert(owner===scope,'Cleanup retains canonical Chat authority');deletes.push(id);if(id==='first-upload')throw new ApiRequestError(deletes.filter(value=>value===id).length===1?404:409,deletes.filter(value=>value===id).length===1?'asset not found':'sent assets cannot be deleted');if(cleanupFails){await new Promise<void>(resolve=>release=resolve);throw new ApiRequestError(503,'Controlled partial cleanup failure');}};
 try{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><OutgoingMessageProvider scope={scope}><OutgoingMessageRow entries={[]}/><Composer disabled={false} running={false} allowUnmentionedSend conversationDraftId={scope} draftStorageKey={later.storageKey} projectId={binding.projectId} onSend={()=>{throw Error('Removal never sends work');}}/></OutgoingMessageProvider></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
  await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Newer editable')===true,'Original draft hydrates');
  const row=()=>host.querySelector<HTMLElement>('#'+capturedMessageAnchor('rejected-later'))!;
  assert(row().textContent?.includes('Waiting For Earlier Message'),'Blocked later capture explains send order');const retry=[...row().querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='Retry');assert(retry?.disabled,'Blocked Retry cannot dispatch');assert(row().querySelector('a')?.getAttribute('href')==='#'+capturedMessageAnchor('blocked-earlier'),'Ordering link points to exact earliest capture');
  press(row(),'Remove');await until(()=>Boolean(release)&&row().textContent?.includes('Removing')===true,'Removal bypasses send order and visibly progresses');release!();await until(()=>readCapturedSubmissions(scope).find(item=>item.pending.idempotencyKey==='rejected-later')?.error==='Controlled partial cleanup failure','Partial cleanup failure retains exact capture');
  cleanupFails=false;press(row(),'Remove');await until(()=>readCapturedSubmissions(scope).find(item=>item.pending.idempotencyKey==='rejected-later')?.error==='Controlled CAS conflict','Settled assets do not block retry; failed retirement stays visible');assert(row(),'Retirement failure cannot hide the row');
  retirementFails=false;press(row(),'Remove');await until(()=>readCapturedSubmissions(scope).length===1&&!host.querySelector('#'+capturedMessageAnchor('rejected-later')),'Only later rejected capture retires');assert(readCapturedSubmissions(scope)[0].pending.idempotencyKey==='blocked-earlier','Earlier uncertainty stays protected');assert(draft.text==='Newer editable draft stays exact','Removal preserves newer editable text');assert(draft.pendingSubmissions.length===1&&draft.pendingSubmissions[0].idempotencyKey==='blocked-earlier','Exact CAS retirement preserves canonical earlier journal');assert(deletes.length===6,'Three bounded cleanup attempts settle only two exact references');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;api.deleteConversationAttachment=original.remove;for(const item of readCapturedSubmissions(scope))removeCapturedSubmission(item.pending.idempotencyKey);}
}


export async function messageTimelineEmptyPaneMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});
 const render=(assistant:boolean)=>flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><ConversationChromeContext.Provider value={assistant?{assistantAgentId:'assistant-empty',statusHost:null,callActionsHost:null}:undefined}><OutgoingMessageProvider scope="assistant-empty" draftScope="agent:assistant-empty"><div style={{height:480,display:'flex',flexDirection:'column'}}><ChatPane messages={[]} fileOwnerAgentId="assistant-empty"/></div></OutgoingMessageProvider></ConversationChromeContext.Provider></QueryClientProvider></ThemeProvider>));
 try{render(true);await settle();assert(host.textContent?.includes('What’s On Your Mind?'),'Empty Assistant keeps existing welcome');render(false);await settle();assert(host.textContent?.includes('Send a message to this agent to start the conversation.'),'Empty ordinary Agent keeps its existing start state');}finally{root.unmount();client.clear();host.remove();}
}
