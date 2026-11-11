import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Box,CssBaseline,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Composer} from '../../apps/web/src/components/chat/Composer';
import {ComposerRuntimeSelector} from '../../apps/web/src/components/ComposerRuntimeSelector';
import {ChatMessageFrame} from '../../apps/web/src/components/chat/ChatMessageFrame';
import {ChatMessageBody} from '../../apps/web/src/components/chat/ChatMessages';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {QueuedMessageTray} from '../../apps/web/src/components/chat/QueuedMessageTray';
import {saveCapturedSubmission,removeCapturedSubmission,type CapturedSubmission} from '../../apps/web/src/components/chat/submissionOutbox';
import {createPonderosaTheme,ponderosaSurfaceVariables} from '../../apps/web/src/theme';
import {useAgentMessageController} from '../../apps/web/src/components/useAgentMessageController';
import {DEFAULT_ASSET_LIMITS,type AgentDto,type ConversationDraftDto} from '@ponderosa/core';
import {api} from '../../apps/web/src/api';
import {queryKeys} from '../../apps/web/src/queryKeys';
import '../../apps/web/src/global.css';

function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
async function until(check:()=>boolean,message:string){const end=performance.now()+5000;while(performance.now()<end){if(check())return;await settle();}throw Error(message);}
async function enter(editor:HTMLElement,ctrl=false){editor.focus();editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,ctrlKey:ctrl,bubbles:true,cancelable:true}));await settle();}
const binding={projectId:'assistant-project',agentId:'assistant-agent',handle:'Actual-Assistant',currentHandle:'Actual-Assistant',currentTitle:'Actual Assistant'};
const reviewHref='/projects/assistant-project/agents/assistant-agent?view=chat';

export async function assistantMessagesSteeringMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});
 let epoch=0,fail=false;const sends:Array<{text:string;files:File[]}>=[],queues:string[]=[];let dispatchController:ReturnType<typeof useAgentMessageController>['submitAgentMessage'];let persisted=0;
 function Controller(){const controller=useAgentMessageController({agentId:binding.agentId,steeringOnly:true,model:'fixture',effort:'',speed:'',onNotice(){},onChatSelected(){}});dispatchController=controller.submitAgentMessage;return null;}
 const render=async(text='Keep exact follow-up λ😀',assistant=true)=>{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider>
   <Controller/>
   <Composer key={++epoch} assistantMessages={assistant} queueReviewHref={reviewHref} destinationMode="fixed" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} disabled={false} running={false} agentResponding allowUnmentionedSend
    insertTextRequest={{id:String(epoch),text}} onSend={(body,files)=>{sends.push({text:body,files:[...files]});if(fail)throw Error('Controlled steering failure');}}
    onQueue={body=>{queues.push(body);}}/>
   {!assistant&&<QueuedMessageTray scope="local:assistant-retained" messages={[]} onSteer={()=>{}} onEdit={()=>{}} onDelete={()=>{}}/>}
  </MutationNotificationProvider></QueryClientProvider></ThemeProvider>));await settle();await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes(text)===true,'Exact draft appears');return host.querySelector<HTMLElement>('[aria-label="Message"]')!;
 };
 const retainedId='assistant-retained-queue';
 try{
  let editor=await render();const original=editor.textContent;
  assert(!host.querySelector('[aria-label="Queue Message"]'),'Busy Assistant has no Queue button');await enter(editor,true);
  assert(sends.length===0&&queues.length===0&&editor.textContent===original,'Ctrl+Enter retains draft without Send, Queue or newline');
  const files=new DataTransfer();const file=new File(['preserved attachment bytes'],'steering.txt',{type:'text/plain'});files.items.add(file);
  const input=host.querySelector<HTMLInputElement>('[aria-label="Choose Files"]')!;input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>host.textContent?.includes('steering.txt')===true,'Attachment appears');
  fail=true;host.querySelector<HTMLButtonElement>('[aria-label="Send Message"]')!.click();await until(()=>Boolean(host.querySelector('[aria-label="Review Message Error"]')),'Failed steering keeps compact Review');host.querySelector<HTMLButtonElement>('[aria-label="Review Message Error"]')!.click();await until(()=>document.querySelector('[role="dialog"]')?.textContent?.includes('Controlled steering failure')===true,'Original steering failure remains reachable after the snackbar');[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent==='Close')!.click();await until(()=>!document.querySelector('[role="dialog"]'),'Review closes without retrying');
  assert(editor.textContent===original&&host.textContent?.includes('steering.txt')&&sends[0].files[0]===file,'Failed steering retains exact draft and File');
  await enter(editor,true);assert(sends.length===1&&queues.length===0,'Ctrl+Enter cannot retry a failed Send');
  fail=false;host.querySelector<HTMLButtonElement>('[aria-label="Send Message"]')!.click();await until(()=>sends.length===2,'Explicit Send retries steering');assert(sends[1].text===sends[0].text&&sends[1].files[0]===file,'Retry keeps exact inputs');
  editor=await render('/goal-resume');const sendCount=sends.length,nativeDraft=editor.textContent;host.querySelector<HTMLButtonElement>('[aria-label="Send Message"]')!.click();await until(()=>host.textContent?.includes('requires a new Run')===true,'Native next-Run command is held before capture');assert(sends.length===sendCount&&queues.length===0&&editor.textContent===nativeDraft,'Native work is not implicitly enqueued');
  editor=await render();const owner=localStorage.getItem('ponderosa.draft.owner.v1');assert(owner,'Actual Composer creates the browser draft owner');
  const item:CapturedSubmission={version:1,scope:'local:assistant-retained',ownerId:owner,clientId:'retained-client',storageKey:'synthetic-retained',createdAt:1,action:'queue',text:'Original queued bytes λ😀',editorText:'Original queued bytes λ😀',attachmentNames:['original.txt'],mentionedAgents:[binding],newAgentRequested:false,status:'unknown',dispatchStarted:true,pending:{fingerprint:'a'.repeat(64),idempotencyKey:retainedId,request:{recipientAgentIds:[binding.agentId],runtime:{activeRunDelivery:'queue'}}}};
  saveCapturedSubmission(item);await settle();const key='ponderosa.submission.v1.'+retainedId,before=localStorage.getItem(key);
  assert(!host.querySelector('[data-queue-row]')&&!host.querySelector('a[href="'+reviewHref+'"]'),'An outbox-only Queue item does not introduce an Assistant queue or technical recovery menu');
  window.dispatchEvent(new CustomEvent('ponderosa-submission-retry',{detail:retainedId}));await settle();assert(localStorage.getItem(key)===before&&queues.length===0&&sends.length===sendCount,'Retained unknown Queue bytes and effects stay untouched');
  for(const mode of ['steer','queue'] as const){let rejected=false;try{await dispatchController!(mode)(item.text,[],[],undefined,{pendingSubmission:item.pending,persistPendingSubmission:async()=>{persisted++;}});}catch{rejected=true;}assert(rejected&&persisted===0,'Controller rejects retained Queue before persistence or transport');}
  editor=await render('Ordinary Agent keeps queueing',false);await until(()=>Boolean(host.querySelector('[data-queue-row]')),'The ordinary Agent surface retains the original Queue inspection');assert(host.textContent?.includes(item.text)&&localStorage.getItem(key)===before&&queues.length===0&&sends.length===sendCount,'Inspection preserves original captured bytes without implicit dispatch');removeCapturedSubmission(retainedId);await settle();await enter(editor,true);await until(()=>queues.length===1,'Ordinary Agent retains Ctrl+Enter queue');assert(sends.length===sendCount,'Ordinary shortcut never sends');
 }finally{removeCapturedSubmission(retainedId);root.unmount();client.clear();host.remove();}
 await assistantPendingQueueDraftReview();
}

async function assistantPendingQueueDraftReview():Promise<void>{
 const scope='assistant-pending-queue',owner=localStorage.getItem('ponderosa.draft.owner.v1')!,file=new File(['Exact retained Queue attachment λ😀'],'original-queue.txt',{type:'text/plain'});
 const pending={fingerprint:'c'.repeat(64),idempotencyKey:'assistant-pending-queue-key',request:{recipientAgentIds:[binding.agentId],runtime:{activeRunDelivery:'queue' as const}}};
 const attachment={id:'assistant-pending-attachment',conversationId:scope,ownerId:owner,name:file.name,bytes:file.size,mediaType:file.type,createdAt:'2026-11-11T00:00:00Z'};
 let draft:ConversationDraftDto={conversationId:scope,ownerId:owner,clientId:'original-client',revision:1,text:'Original pending Queue text λ😀',attachmentIds:[attachment.id],attachments:[attachment],pendingSubmission:pending,updatedAt:attachment.createdAt};
 const original={get:api.getConversationDraft,put:api.putConversationDraft,download:api.downloadDraftAttachment},originalPending=JSON.stringify(pending),writes:unknown[]=[];
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);let sends=0,queues=0,downloads=0;
 api.getConversationDraft=async(id,requestedOwner)=>{assert(id===scope&&requestedOwner===owner,'Canonical draft read keeps exact owner');return draft;};
 api.downloadDraftAttachment=async(value)=>{assert(value.id===attachment.id,'Original immutable attachment is restored');downloads++;return file;};
 api.putConversationDraft=async(id,value)=>{assert(id===scope,'Draft persistence keeps exact owner');writes.push(value);draft={...draft,...value,revision:draft.revision+1};return draft;};
 try{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><Composer assistantMessages queueReviewHref={reviewHref} projectId={binding.projectId} conversationDraftId={scope} draftStorageKey={scope} disabled={false} running={false} agentResponding destinationMode="fixed" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} onSend={()=>{sends++;}} onQueue={()=>{queues++;}}/></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
  await until(()=>Boolean(host.querySelector('a[href="'+reviewHref+'"]')),'Canonical pending Queue exposes its existing owner-bound review link');
  assert(host.querySelector('a')?.textContent==='Review Retained Queue Submission In Agent Chat','Valid pending-draft review stays distinct from the removed tray menu');
  const editor=host.querySelector<HTMLElement>('[aria-label="Message"]')!;assert(editor.textContent===draft.text&&host.textContent?.includes(file.name)&&downloads===1,'Exact pending text and original attachment restore once');
  await enter(editor,true);const send=host.querySelector<HTMLButtonElement>('[aria-label="Send Message"]');send?.click();await settle();
  assert(sends===0&&queues===0&&!host.querySelector('[data-queue-row]'),'Assistant cannot dispatch or convert the retained pending Queue');
  assert(JSON.stringify(draft.pendingSubmission)===originalPending&&draft.attachmentIds[0]===attachment.id&&await file.text()==='Exact retained Queue attachment λ😀','Review retains exact key, Queue runtime and file reference');
  assert(writes.every(value=>!(value as ConversationDraftDto).pendingSubmission||JSON.stringify((value as ConversationDraftDto).pendingSubmission)===originalPending),'Any ordinary draft persistence preserves original submission authority');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;api.downloadDraftAttachment=original.download;}
}

export async function assistantMessagesLayoutMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{enabled:false,retry:false}}});const evidence:unknown[]=[];
 const agent={id:binding.agentId,projectId:binding.projectId,conversationId:'assistant-chat',title:binding.currentTitle,handle:binding.handle} as AgentDto;
 function Controls(){const [model,setModel]=useState('fixture'),[effort,setEffort]=useState('low');return <ComposerRuntimeSelector engine="codex" engines={[{id:'codex',label:'Fixture engine'}]} model={model} models={[{id:'fixture',label:'Fixture model'},{id:'other',label:'Other fixture model'}]} effort={effort} efforts={[{id:'low',label:'Low'},{id:'high',label:'High'}]} scopeLabel="Actual Assistant Next Run" selectionKey={binding.agentId} onModelChange={setModel} onEffortChange={setEffort} onReset={()=>{setModel('fixture');setEffort('low');}}/>;}
 try{
  for(const mode of ['light','dark'] as const){const theme=createPonderosaTheme(mode,'assistant');flushSync(()=>root.render(<ThemeProvider theme={theme}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider>
   <Box sx={{...ponderosaSurfaceVariables(mode),'--assistant-outgoing':theme.palette.primary.main,'--assistant-on-outgoing':theme.palette.primary.contrastText,width:'min(1200px, 100%)',minWidth:0,bgcolor:'background.default',p:1}}>
    <ChatMessageFrame assistantMessages message={{id:'assistant-incoming',author:{kind:'agent',name:binding.currentTitle},createdAt:'2026-11-09T00:00:00Z',body:<ChatMessageBody text="Actual authored reply with readable prose."/>}}/>
    <ChatMessageFrame assistantMessages message={{id:'assistant-user',author:{kind:'operator'},attachments:[{id:'visual-file',name:'readable.txt',mediaType:'text/plain',size:42,downloadUrl:'#owned-text-preview'}],createdAt:'2026-11-09T00:00:00Z',body:<ChatMessageBody text={'A short green bubble with [link](https://example.invalid).\n\n```ts\n'+ 'code_'.repeat(160)+'\n```\n\n| Field | Value |\n| --- | --- |\n| Exact | Contained |'}/>}}/>
    <Composer assistantMessages disabled={false} running={false} controls={<Controls/>} enableVoiceDictation voiceContext={{projectId:binding.projectId,conversationId:'assistant-chat',agents:[agent],selectedAgentId:binding.agentId,lockAgent:true}} destinationMode="fixed" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} onSend={()=>{}}/>
   </Box>
  </MutationNotificationProvider></QueryClientProvider></ThemeProvider>));await settle();await settle();
   const composer=host.querySelector<HTMLElement>('.ponderosa-composer')!,shell=host.querySelector<HTMLElement>('[data-composer-input-shell]')!,plus=host.querySelector<HTMLElement>('[aria-label="Add Attachment Or Capability"]')!,wave=host.querySelector<HTMLButtonElement>('button[aria-label="Voice Options"]')!,runtime=host.querySelector<HTMLElement>('[data-composer-runtime]')!,editor=host.querySelector<HTMLElement>('[aria-label="Message"]')!;
   assert(plus.getBoundingClientRect().right<=shell.getBoundingClientRect().left,'Plus is outside the pill');assert(runtime.getBoundingClientRect().right<=wave.getBoundingClientRect().left+1,'Real runtime selector is immediately before waveform');
   assert(wave&&host.querySelectorAll('button[aria-label="Voice Options"]').length===1&&!host.querySelector('[aria-label="Record Voice Message"]'),'One waveform replaces separate microphone');
   assert(!/Message Assistant directly|Ctrl\+Enter|New Agent|Reply To/.test(composer.textContent??''),'No helper, queue hint or recipient switching');
   assert(getComputedStyle(shell).borderRadius==='28px','Compact rounded input surface');assert(getComputedStyle(host.querySelector('#assistant-user .chat-message-body')!).backgroundColor!==getComputedStyle(host.querySelector('#assistant-incoming .chat-message-body')!).backgroundColor,'Green outgoing and muted incoming bubbles differ');
   assert(host.querySelector('[aria-label="Actual Assistant Avatar"]'),'Real Agent identity is preserved');
   const avatar=host.querySelector('[aria-label="Actual Assistant Avatar"]')!.getBoundingClientRect(),incomingBody=host.querySelector('#assistant-incoming .chat-message-body')!.getBoundingClientRect();
   assert(avatar.bottom<=incomingBody.bottom+1&&avatar.bottom>=incomingBody.bottom-8&&avatar.top<incomingBody.bottom,'Agent avatar sits beside the bubble tail, independently of its actions');

   const card=host.querySelector<HTMLElement>('#assistant-user .chat-attachment-card')!,download=card.querySelector<HTMLElement>('[aria-label="File Options For readable.txt"]')!;
   assert(getComputedStyle(card).backgroundColor!==getComputedStyle(host.querySelector('#assistant-user .chat-message-body')!).backgroundColor&&getComputedStyle(download).color!==getComputedStyle(card).backgroundColor,'Outgoing attachment controls use a readable standard surface');

   const label=runtime.querySelector<HTMLElement>('[data-runtime-label]')!,icon=runtime.querySelector<HTMLElement>('[data-runtime-icon]')!;
   assert(composer.getBoundingClientRect().width<520?getComputedStyle(label).display==='none'&&getComputedStyle(icon).display!=='none':getComputedStyle(label).display!=='none','Existing responsive speedometer/label transition');
   wave.click();await settle();assert(document.querySelector('[role="menu"]')?.textContent?.includes('Voice Conversation')&&document.querySelector('[role="menu"]')?.textContent?.includes('Record Voice Message'),'Waveform retains conversation and recording choices');document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await until(()=>!document.querySelector('[role="menu"]'),'Voice menu closes');
   assert(document.documentElement.scrollWidth<=innerWidth,'No phone overflow');editor.focus();await settle();
   evidence.push({mode,composer:composer.getBoundingClientRect().toJSON(),pill:shell.getBoundingClientRect().toJSON(),plus:plus.getBoundingClientRect().toJSON(),runtime:runtime.getBoundingClientRect().toJSON(),wave:wave.getBoundingClientRect().toJSON()});
   await (window as Window&{assistantMessagesCheckpoint?:(mode:string)=>Promise<void>}).assistantMessagesCheckpoint?.(mode);
  }
  (window as Window&{assistantMessagesEvidence?:unknown[]}).assistantMessagesEvidence=evidence;
 }finally{root.unmount();client.clear();host.remove();}
}

/** A held Core read must not restore the old name after the isolated runtime saves. */
export async function assistantNameRefreshMountedRegression():Promise<void>{
 const [{AssistantEntry},{AssistantSurface}]=await Promise.all([import('../../apps/web/src/components/AssistantEntry'),import('../../apps/web/src/AssistantSurface')]);
 const oldStatus={initialized:true,enabled:true,app:{agentId:'named-assistant',title:'Original Assistant'}};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const originalFetch=window.fetch,bridge=window as typeof window&{__ponderosaAssistantMount?:import('../../apps/web/src/assistantMount').AssistantMountApi};
 const previousBridge=bridge.__ponderosaAssistantMount;let props:import('../../apps/web/src/assistantMount').AssistantMountProps|undefined,release:(()=>void)|undefined,reads=0,posts=0,aborted=false;
 window.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  if(url.pathname!=='/api/branches/assistant')throw Error('Unexpected name refresh fixture request: '+url.pathname);
  if(init?.method==='POST'){posts++;return Response.json(oldStatus);}
  reads++;
  if(reads===1)return new Promise<Response>((resolve,reject)=>{
   release=()=>resolve(Response.json(oldStatus));
   init?.signal?.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Old read cancelled','AbortError'));},{once:true});
  });
  return Response.json({...oldStatus,app:{...oldStatus.app,title:'Saved Pine Partner'}});
 };
 bridge.__ponderosaAssistantMount={productScope:()=> 'branches',mount(_host,next){props=next;},update(next){props=next;},unmount(){},canLeave:()=>true,blockers:()=>[]};
 client.setQueryData(['assistant-status'],oldStatus);
 try{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider><AssistantEntry href="/assistant" onOpen={()=>{}}/><AssistantSurface colorMode="light" onOpenNavigation={()=>{}} onToggleColorMode={()=>{}} onOpenProviderSettings={()=>{}}/></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));
  await until(()=>Boolean(release&&props?.onIdentityChanged),'The old Core read is held while the runtime is mounted');
  props!.onIdentityChanged!();
  await until(()=>host.textContent?.includes('Saved Pine Partner')===true,'Sidebar adopts the fresh canonical name');
  assert(aborted&&reads===2,'The pre-rename GET is physically cancelled and replaced exactly once');
  release!();await settle();assert(host.textContent?.includes('Saved Pine Partner')&&!host.textContent?.includes('Original Assistant'),'Late old data cannot restore a stale name');
  assert(posts===1,'Identity refresh never replays the initialization mutation');
 }finally{root.unmount();client.clear();window.fetch=originalFetch;if(previousBridge)bridge.__ponderosaAssistantMount=previousBridge;else delete bridge.__ponderosaAssistantMount;host.remove();}
}

export async function sidebarScrollRetentionMountedRegression():Promise<void>{
 const {SharedSidebarPanel}=await import('../../apps/web/src/components/WorkspaceSidebar.parts');
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),memory={scrollTop:140,starsCollapsed:false};
 const render=async(ready:boolean,busy:boolean,count:number,key='chats')=>{
  flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><Box sx={{height:260,width:300,display:'flex'}}><SharedSidebarPanel key={key} title="Chats" icon={null} drawer={false} presentation={memory} scrollReady={ready} busy={busy} searchLabel="Search Chats" searchValue="" onSearchValueChange={()=>{}} starredRows={null} allRows={Array.from({length:count},(_,index)=><Box key={index} sx={{height:40}}>Chat {index}</Box>)}/></Box></ThemeProvider>));await settle();return host.querySelector<HTMLElement>('.ponderosa-scroll')!;
 };
 try{
  let list=await render(false,true,0);assert(list.scrollTop===0&&memory.scrollTop===140,'Unresolved empty geometry cannot erase a retained offset');
  list=await render(true,false,20);assert(Math.abs(list.scrollTop-140)<2,'Initial verified rows restore the saved offset');
  list=await render(true,true,20);list.scrollTop=240;list.dispatchEvent(new Event('scroll',{bubbles:true}));await settle();assert(memory.scrollTop===240,'Populated background refresh keeps actual user scrolling');
  list=await render(true,false,30);assert(Math.abs(list.scrollTop-240)<2,'Finishing background refresh cannot jump back to an older offset');
  await render(false,true,0,'other');assert(memory.scrollTop===240,'Remount during unresolved loading keeps the current offset');list=await render(true,false,30,'other');assert(Math.abs(list.scrollTop-240)<2,'Remounted list restores after its rows become available');
 }finally{root.unmount();host.remove();}
}
