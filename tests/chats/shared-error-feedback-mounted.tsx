import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {focusManager,onlineManager,QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Box,CssBaseline,Dialog,DialogContent,ThemeProvider} from '@mui/material';
import {MutationNotificationProvider,useMutationNotification,type MutationNotifier} from '../../apps/web/src/components/MutationNotifications';
import {AssistantSurface} from '../../apps/web/src/AssistantSurface';
import {AssistantEntry,useInitializeAssistant} from '../../apps/web/src/components/AssistantEntry';
import {WorkspaceRefreshProvider,useWorkspaceRefresh} from '../../apps/web/src/components/WorkspaceRefreshContext';
import type {WorkspaceConnectionState} from '../../apps/web/src/hooks/useWorkspaceStream';
import type {AssistantMountWindow} from '../../apps/web/src/assistantMount';
import {Composer} from '../../apps/web/src/components/chat/Composer';
import {DecisionResponseDialog} from '../../apps/web/src/components/decisions/DecisionResponseDialog';
import {QueuedMessageTray} from '../../apps/web/src/components/chat/QueuedMessageTray';
import {readCapturedSubmissions} from '../../apps/web/src/components/chat/submissionOutbox';
import {api} from '../../apps/web/src/api';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {DEFAULT_ASSET_LIMITS} from '@ponderosa/core';
import {createPonderosaTheme} from '../../apps/web/src/theme';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message+"; visible fixture: "+document.body.innerText.slice(-1600)+"; controls: "+[...document.querySelectorAll("button")].map(n=>n.getAttribute("aria-label")||n.textContent).join(","));}
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
async function until(read:()=>boolean,message:string){const end=performance.now()+7000;while(performance.now()<end){if(read())return;await settle();}throw Error(message+"; visible fixture: "+document.body.innerText.slice(-1600)+"; controls: "+[...document.querySelectorAll("button")].map(n=>n.getAttribute("aria-label")||n.textContent).join(","));}
const binding={projectId:'feedback-project',agentId:'feedback-agent',handle:'Feedback',currentHandle:'Feedback',currentTitle:'Feedback Agent'};
const theme=createPonderosaTheme('light');
function closeNotice(){const close=document.querySelector<HTMLButtonElement>('.MuiSnackbar-root [aria-label="Close"]');assert(close,'Shared snackbar Close is reachable');close.click();}
function chooseFile(host:HTMLElement,file:File){const input=host.querySelector<HTMLInputElement>('[type="file"]:not([webkitdirectory])');assert(input,'Real file picker exists');const files=new DataTransfer();files.items.add(file);input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
function press(host:HTMLElement,label:string){const button=host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);assert(button&&!button.disabled,`Action is enabled: ${label}`);button.click();}
function frame(children:React.ReactNode,client?:QueryClient){return <ThemeProvider theme={theme}><CssBaseline/>{client?<QueryClientProvider client={client}><MutationNotificationProvider>{children}</MutationNotificationProvider></QueryClientProvider>:<MutationNotificationProvider>{children}</MutationNotificationProvider>}</ThemeProvider>;}

export async function sharedSnackbarBridgeMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),windowMount=window as AssistantMountWindow,original=windowMount.__ponderosaAssistantMount;
 let core!:MutationNotifier,assistant!:MutationNotifier,child:ReturnType<typeof createRoot>|undefined;
 const metrics=document.documentElement.style.getPropertyValue('--ponderosa-app-viewport-block-size');
 function Core(){core=useMutationNotification();return <Box data-retained-layout sx={{height:240}}>Retained Chat Layout<AssistantSurface colorMode="light" onOpenNavigation={()=>{}} onToggleColorMode={()=>{}} onOpenProviderSettings={()=>{}}/></Box>;}
 function Embedded(){assistant=useMutationNotification();const [draft,setDraft]=useState('Unsaved Assistant Settings');return <Dialog open onClose={()=>{}}><DialogContent><input aria-label="Retained Settings Draft" value={draft} onChange={e=>setDraft(e.target.value)}/></DialogContent></Dialog>;}
 windowMount.__ponderosaAssistantMount={mount(node,props){assert(props.notify,'Core forwards the existing notifier across the actual mount boundary');child=createRoot(node);child.render(<ThemeProvider theme={theme}><MutationNotificationProvider notifier={props.notify}><Embedded/></MutationNotificationProvider></ThemeProvider>);},update(){},unmount(){child?.unmount();child=undefined;},canLeave:()=>true,blockers:()=>[],productScope:()=> 'branches'};
 try{
  flushSync(()=>root.render(frame(<Core/>)));await until(()=>Boolean(assistant),'Embedded root mounts');
  const height=host.querySelector('[data-retained-layout]')!.getBoundingClientRect().height;
  const notice={key:'dev:chat-a:operation',incident:'first',severity:'error' as const,message:'Message Needs Review',description:'Captured work remains in its original Chat.',details:'Long exact diagnostic λ😀 '.repeat(600)};
  core(notice);assistant({...notice,key:'branches:assistant:operation',incident:'second',message:'Attachment Upload Failed'});
  await until(()=>document.querySelectorAll('.MuiSnackbar-root').length===1,'Two roots share one visible snackbar');
  assert(host.querySelector('[data-retained-layout]')!.getBoundingClientRect().height===height,'Snackbar never shifts the retained layout');
  closeNotice();await until(()=>document.querySelector('.MuiSnackbar-root')?.textContent?.includes('Attachment Upload Failed')===true,'Close advances to the independent Assistant action');
  closeNotice();await until(()=>!document.querySelector('.MuiSnackbar-root'),'Close dismisses feedback only');
  for(let i=0;i<3;i++){core(notice);assistant({...notice,key:'branches:assistant:operation',incident:'second'});await settle();}
  assert(!document.querySelector('.MuiSnackbar-root'),'Closed incidents do not reappear on repeat reporting');
  assert(document.querySelector<HTMLInputElement>('[aria-label="Retained Settings Draft"]')?.value==='Unsaved Assistant Settings','Snackbar Close retains the Settings draft and dialog');
  core({...notice,incident:'explicit-retry'});await until(()=>Boolean(document.querySelector('.MuiSnackbar-root')),'Explicit retry can report again');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
  await until(()=>!document.querySelector('.MuiSnackbar-root'),'Keyboard dismissal closes feedback');
  assert(document.querySelector<HTMLInputElement>('[aria-label="Retained Settings Draft"]')?.value==='Unsaved Assistant Settings','Keyboard dismissal never discards Settings');
  document.documentElement.style.setProperty('--ponderosa-app-viewport-block-size',`${Math.max(280,innerHeight-240)}px`);
  core({...notice,incident:'keyboard-open'});await until(()=>Boolean(document.querySelector('.MuiSnackbar-root')),'Keyboard geometry feedback renders');
  const snack=document.querySelector<HTMLElement>('.MuiSnackbar-root')!,rect=snack.getBoundingClientRect();
  assert(rect.bottom<=Math.max(280,innerHeight-240)+1&&rect.left>=0&&rect.right<=innerWidth+1,'Snackbar stays above the simulated keyboard and within the viewport');
  const summary=snack.querySelector('summary')!;summary.click();await settle();const pre=snack.querySelector('pre')!;
  assert(pre.getBoundingClientRect().height<=181&&snack.getBoundingClientRect().bottom<=Math.max(280,innerHeight-240)+1,'Long raw details remain bounded above keyboard');
  assert(snack.querySelector('[role="alert"]'),'Existing accessible error announcement remains present');
 }finally{root.unmount();host.remove();windowMount.__ponderosaAssistantMount=original;if(metrics)document.documentElement.style.setProperty('--ponderosa-app-viewport-block-size',metrics);else document.documentElement.style.removeProperty('--ponderosa-app-viewport-block-size');}
}

export async function composerFailureFeedbackMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const sent:Array<{text:string;files:File[]}> = [];let fail=true;
 const file=new File(['Original exact attachment λ😀'],'retained.txt',{type:'text/plain'});
 try{
  flushSync(()=>root.render(frame(<Composer disabled={false} running={false} allowUnmentionedSend destinationMode="project-chat" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} mentionHandles={[binding.handle]} mentionBindings={[binding]} insertTextRequest={{id:'feedback-draft',text:'#Feedback Original exact draft λ😀'}} onSend={(text,files)=>{sent.push({text,files:[...files]});if(fail)throw Error('Synthetic send refusal. '+ 'diagnostic '.repeat(120));}}/>,client)));
  await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Original exact draft')===true,'Draft loads');await settle();await settle();chooseFile(host,file);await until(()=>host.textContent?.includes('retained.txt')===true,'Original attachment appears');await settle();await settle();assert(host.querySelector('[aria-label="Message"]')?.textContent?.includes('Original exact draft'),'The editable draft is settled before the explicit send');
  const composer=host.querySelector('.ponderosa-composer')!,before=composer.getBoundingClientRect().height;
  press(host,'Send Message');await until(()=>Boolean(host.querySelector('[aria-label="Review Message Error"]'))&&Boolean(document.querySelector('.MuiSnackbar-root')),'One shared snackbar and compact recovery control replace the composer banner');
  assert(!host.querySelector('.MuiAlert-standardError')&&!host.querySelector('.MuiAlert-filledError'),'No duplicate large composer Alert');
  assert(Math.abs(composer.getBoundingClientRect().height-before)<1,'Submission failure does not change composer height');
  closeNotice();await until(()=>!document.querySelector('.MuiSnackbar-root'),'Close leaves recovery reachable');
  assert(sent.length===1&&host.querySelector('[aria-label="Message"]')?.textContent?.includes('Original exact draft'),'Closing feedback keeps draft without resending');
  press(host,'Review Message Error');await until(()=>Boolean(document.querySelector('[role="dialog"]')),'Explanation stays reachable after Close');
  assert(document.querySelector('[role="dialog"]')?.textContent?.includes('Synthetic send refusal'),'Review contains the original diagnostic');
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent==='Close')!.click();await until(()=>!document.querySelector('[role="dialog"]'),'Review closes without replay');
  fail=false;press(host,'Send Message');await until(()=>sent.length===2&&!host.querySelector('[aria-label="Review Message Error"]'),'Successful explicit retry retires obsolete error state');
  assert(sent[1].text===sent[0].text&&sent[1].files[0]===sent[0].files[0]&&await sent[1].files[0].text()===await file.text(),'Retry preserves exact draft and File bytes');
  assert(!document.querySelector('.MuiSnackbar-root'),'Confirmed retry removes its stale failure');
 }finally{root.unmount();client.clear();host.remove();}
}

export async function composerUploadFeedbackMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const original={get:api.getConversationDraft,put:api.putConversationDraft,upload:api.uploadDraftAttachment};let revision=0;
 const requests:Array<{file:File;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];
 const originalUrl=location.href;
 api.getConversationDraft=async(conversationId,ownerId)=>({conversationId,ownerId,revision,text:'',attachmentIds:[],attachments:[],updatedAt:'2026-11-10T00:00:00Z'});
 api.putConversationDraft=async(conversationId,draft)=>({...draft,conversationId,revision:++revision,updatedAt:'2026-11-10T00:00:00Z'});
 api.uploadDraftAttachment=async(_scope,_owner,file)=>new Promise((resolve,reject)=>requests.push({file,resolve,reject}));
 try{
  flushSync(()=>root.render(frame(<Composer disabled={false} running={false} allowUnmentionedSend conversationDraftId="feedback-upload-chat" draftStorageKey="feedback-upload-draft" destinationMode="project-chat" onSend={()=>{throw Error('Upload test must never send');}}/>,client)));
  await settle();const file=new File(['Keep failed original bytes λ😀'],'failed-upload.txt',{type:'text/plain'});chooseFile(host,file);await until(()=>requests.length===1,'One upload begins');
  const composer=host.querySelector('.ponderosa-composer')!,height=composer.getBoundingClientRect().height;
  history.replaceState(null,'','/branches');
  requests[0].reject(Error('Exact upload failure '+ 'detail '.repeat(100)));await until(()=>Boolean(host.querySelector('details summary'))&&document.querySelector('.MuiSnackbar-root')?.textContent?.includes('Attachment Upload Failed')===true,'Upload failure uses shared feedback and persistent item Details');
  assert(Math.abs(composer.getBoundingClientRect().height-height)<1,'Upload failure keeps attachment/composer geometry');
  closeNotice();await until(()=>!document.querySelector('.MuiSnackbar-root'),'Upload feedback closes');
  history.replaceState(null,'',originalUrl);
  const summary=[...host.querySelectorAll<HTMLElement>('details summary')].find(n=>n.textContent?.includes('Failed'))!;assert(summary,'Failed upload Details is reachable on touch and keyboard');summary.click();await settle();assert(host.textContent?.includes('Exact upload failure'),'Original item explanation survives toast dismissal');summary.click();
  const retry=()=>{const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(n=>n.textContent==='Retry');assert(button,'Exact upload Retry remains');button.click();};
  retry();await until(()=>requests.length===2,'Explicit retry issues one request');assert(requests[1].file===requests[0].file,'Retry retains original File identity');
  history.replaceState(null,'','/branches');
  requests[1].reject(Error('Explicit retry failed'));await until(()=>Boolean(document.querySelector('.MuiSnackbar-root')),'New explicit upload attempt reports its result');history.replaceState(null,'',originalUrl);retry();await until(()=>requests.length===3,'Second explicit retry starts');
  requests[2].resolve({id:'feedback-upload-id',conversationId:'feedback-upload-chat',ownerId:'fixture',name:file.name,bytes:file.size,mediaType:file.type,createdAt:'2026-11-10T00:00:00Z'});
  await until(()=>host.textContent?.includes('Uploaded')===true&&!document.querySelector('.MuiSnackbar-root'),'Successful upload retires the same File incident');
  assert(await requests[2].file.text()===await file.text(),'Original bytes retained throughout failure and retry');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;api.uploadDraftAttachment=original.upload;history.replaceState(null,'',originalUrl);}
}

async function capturedFeedbackNavigation(keyed:boolean):Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const original={get:api.getConversationDraft,put:api.putConversationDraft};const drafts=new Map<string,any>(),loaded=new Set<string>();let revision=0;
 api.getConversationDraft=async(conversationId,ownerId)=>{loaded.add(conversationId);return drafts.get(conversationId)??{conversationId,ownerId,revision:0,text:'',attachmentIds:[],attachments:[],updatedAt:'2026-11-10T00:00:00Z'};};
 api.putConversationDraft=async(conversationId,draft)=>{const value={...draft,conversationId,revision:++revision,updatedAt:'2026-11-10T00:00:00Z'};drafts.set(conversationId,value);return value;};
 const sends:Array<{owner:string;key:string;text:string;reject:(e:Error)=>void;resolve:(v:any)=>void}>=[];
 const render=async(owner:string)=>{const tree=(insert:boolean)=>frame(<><Composer key={keyed?owner:undefined} disabled={false} running={false} allowUnmentionedSend projectId="feedback-project" conversationDraftId={owner} draftStorageKey={'feedback-navigation:'+owner} destinationMode="project-chat" defaultDestination={{handle:binding.handle,binding,selectionKey:binding.agentId}} mentionHandles={[binding.handle]} mentionBindings={[binding]} insertTextRequest={insert?{id:owner,text:'#Feedback Exact '+owner+' draft λ😀'}:undefined} onSend={(text,_files,_ids,_owner,context)=>new Promise((resolve,reject)=>sends.push({owner,key:context!.pendingSubmission!.idempotencyKey,text,resolve,reject}))}/><QueuedMessageTray scope={owner} messages={[]} onSteer={()=>{}} onEdit={()=>{}} onDelete={()=>{}}/></>,client);flushSync(()=>root.render(tree(false)));await until(()=>loaded.has(owner)&&Boolean(host.querySelector('.ponderosa-composer:not([aria-busy])')),'Canonical owner draft finishes hydration');await settle();await settle();flushSync(()=>root.render(tree(true)));await until(()=>host.querySelector('[aria-label="Message"]')?.textContent?.includes('Exact '+owner+' draft')===true,'Correct owner draft renders');await settle();await settle();};
 try{
  await render('chat-a');press(host,'Send Message');await until(()=>sends.length===1,'Original captured action reaches handler');const key=sends[0].key;
  await render('chat-b');sends[0].reject(Error('Original Chat A outcome is unconfirmed'));await until(()=>readCapturedSubmissions('chat-a').some(item=>item.error?.includes('Original Chat A')),'Late outcome remains on exact captured owner');
  assert(readCapturedSubmissions('chat-b').length===0&&host.querySelector('[aria-label="Message"]')?.textContent?.includes('Exact chat-b draft'),'Late A failure never rewrites B: '+JSON.stringify({bRecords:readCapturedSubmissions('chat-b').length,editor:host.querySelector('[aria-label="Message"]')?.textContent}));
  closeNotice();window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));await settle();assert(sends.length===1,'Dismissal/reconnection never retries captured work');
  await render('chat-a');const details=[...host.querySelectorAll<HTMLElement>('details summary')].find(n=>n.textContent?.includes('Unconfirmed'))!;assert(details,'Original captured item keeps a persistent explanation');details.click();await settle();assert(host.textContent?.includes('Original Chat A outcome'),'Original details stay reachable after navigation and Close');
  const retry=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Retry')!;assert(retry,'Original captured Retry remains');retry.click();await until(()=>sends.length===2,'Explicit captured Retry starts once');
  assert(sends[1].owner==='chat-a'&&sends[1].key===key&&sends[1].text===sends[0].text,'Retry uses original owner, canonical operation identity and captured text');
  sends[1].resolve({communicationEventId:'feedback-confirmed'});await until(()=>readCapturedSubmissions('chat-a').length===0,'Confirmed result retires only its recovery record');assert(!document.querySelector('.MuiSnackbar-root'),'Successful retry has no obsolete notice');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;}
}


export async function capturedFeedbackNavigationMountedRegression():Promise<void>{await capturedFeedbackNavigation(false);}
export async function capturedFeedbackRemountMountedRegression():Promise<void>{await capturedFeedbackNavigation(true);}


export async function decisionUploadFeedbackMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const original={get:api.getConversationDraft,put:api.putConversationDraft,upload:api.uploadDraftAttachment};let revision=0;
 const requests:Array<{scope:string;owner:string;file:File;resolve:(v:any)=>void;reject:(e:Error)=>void}>=[];
 api.getConversationDraft=async(conversationId,ownerId)=>({conversationId,ownerId,revision,text:'',attachmentIds:[],attachments:[],updatedAt:'2026-11-10T00:00:00Z'});
 api.putConversationDraft=async(conversationId,draft)=>({...draft,conversationId,revision:++revision,updatedAt:'2026-11-10T00:00:00Z'});
 api.uploadDraftAttachment=async(scope,owner,file)=>new Promise((resolve,reject)=>requests.push({scope,owner,file,resolve,reject}));
 const decision={id:'feedback-decision',agentId:'feedback-agent',question:'Retain Exact Question Attachments',mode:'text' as const,status:'pending' as const,options:[],allowOther:true,questions:['question-a','question-b'].map(id=>({id,mode:'text' as const,question:id,options:[],allowOther:true}))};
 try{
  flushSync(()=>root.render(frame(<DecisionResponseDialog decision={decision} open onClose={()=>{}} onRespond={()=>{throw Error('Upload feedback must not submit a Decision');}}/>,client)));
  await until(()=>[...document.querySelectorAll<HTMLButtonElement>('button')].some(b=>b.textContent==='Attach Files'&&!b.disabled),'Original Decision attachment owner is ready');
  const a=new File(['Question A exact bytes'],'question-a.txt');chooseFile(document.body,a);await until(()=>requests.length===1,'Question A upload begins once');
  press(document.body,'Go To Question 2');requests[0].reject(Error('Question A upload failure'));await until(()=>Boolean(document.querySelector('.MuiSnackbar-root')),'Decision shares the existing action snackbar');
  assert(!document.querySelector('[role="dialog"]')?.textContent?.includes('question-a.txt'),'Late A upload status never attaches to current question B');
  closeNotice();press(document.body,'Go To Question 1');await until(()=>Boolean([...document.querySelectorAll('summary')].find(n=>n.textContent?.includes('Failed'))),'Original question retains failed File Details after Close');
  const retry=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Retry')!;assert(retry,'Exact Decision File retry stays reachable');retry.click();await until(()=>requests.length===2,'Explicit Decision retry starts once');
  assert(requests[1].scope===requests[0].scope&&requests[1].owner===decision.id&&requests[1].file===requests[0].file,'Retry retains the original Decision, question and File authority');
  requests[1].resolve({id:'question-a-asset',conversationId:requests[1].scope,ownerId:decision.id,name:a.name,size:a.size,mediaType:'text/plain',createdAt:'2026-11-10T00:00:00Z'});await until(()=>document.querySelector('[role="dialog"]')?.textContent?.includes('Uploaded')===true,'Exact original attachment completes');
  press(document.body,'Go To Question 2');await settle();const b=new File(['Question B exact bytes'],'question-b.txt');chooseFile(document.body,b);await until(()=>requests.length===3,'Independent question B upload begins');requests[2].reject(Error('Question B upload failure'));await until(()=>Boolean(document.querySelector('.MuiSnackbar-root')),'Equal action summaries do not suppress a different question/File incident');
  press(document.body,'Remove question-b.txt');await until(()=>!document.querySelector('.MuiSnackbar-root'),'Explicit removal retires only that failed upload feedback');press(document.body,'Go To Question 1');await until(()=>document.querySelector('[role="dialog"]')?.textContent?.includes('question-a.txt')===true,'Removing B retains original completed question A attachment');
 }finally{root.unmount();client.clear();host.remove();api.getConversationDraft=original.get;api.putConversationDraft=original.put;api.uploadDraftAttachment=original.upload;}
}


export async function assistantSetupReadOnlyRecoveryMountedRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:true,refetchOnReconnect:true}}});
 const originalFetch=window.fetch;let posts=0,gets=0,down=true,initFails=true,refresh!:ReturnType<typeof useWorkspaceRefresh>;
 const bodies:unknown[]=[];
 window.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input),location.href),method=init?.method??(input instanceof Request?input.method:'GET');
  assert(url.pathname==='/api/branches/assistant','Setup fixture owns its exact endpoint');
  if(method==='POST'){posts++;bodies.push(JSON.parse(String(init?.body)));return Response.json(initFails?{error:'Initialization outcome unconfirmed'}:{initialized:true,enabled:true},{status:initFails?503:200});}
  assert(method==='GET','Shared recovery never dispatches a different mutation');gets++;
  return Response.json(down?{error:'Status unavailable'}:{initialized:false,enabled:false},{status:down?503:200});
 };
 const connection={status:'unavailable',phaseEvidenceFresh:false,prolongedDisconnect:true,retrying:false,retry(){}} as unknown as WorkspaceConnectionState;
 function Probe(){useInitializeAssistant();refresh=useWorkspaceRefresh();return <AssistantEntry href="/assistant" onOpen={()=>{}}/>;}
 try{
  flushSync(()=>root.render(frame(<WorkspaceRefreshProvider connection={connection}><Probe/></WorkspaceRefreshProvider>,client)));
  await until(()=>posts===1&&gets>=1&&refresh.shared,'Failed initialization is reconciled by a registered GET status reader');
  focusManager.setFocused(false);onlineManager.setOnline(false);focusManager.setFocused(true);onlineManager.setOnline(true);await settle();await settle();
  assert(posts===1,'Production focus/reconnect defaults never repeat initialization');
  flushSync(()=>root.render(frame(<WorkspaceRefreshProvider connection={connection}><Probe key="sidebar-remount"/></WorkspaceRefreshProvider>,client)));await settle();await settle();
  assert(posts===1,'Failed initializer remount and simultaneous Sidebar/content observers never repeat POST');
  const before=gets;refresh.retry();await until(()=>gets>before&&!refresh.retrying,'Shared Retry performs a real status GET');assert(posts===1,'Shared connection Retry never repeats initialization POST');
  assert(!document.querySelector('[role="alert"]')&&!document.querySelector('.MuiSnackbar-root'),'Background setup/read failure joins the compact outage authority without banners/toasts');
  down=false;const again=gets;refresh.retry();await until(()=>gets>again&&!refresh.retrying&&host.textContent?.includes('Assistant Setup Needs Review')===true,'Verified uninitialized status retains compact explicit setup recovery');assert(posts===1,'GET proof of incomplete setup still does not initialize automatically through shared recovery');
  const disclosure=host.querySelector<HTMLElement>('details summary');assert(disclosure,'Setup review remains reachable');disclosure.click();await settle();
  const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Retry Assistant Setup');assert(button&&!button.disabled,'Setup retry remains an explicit separate action');button.click();await until(()=>posts===2&&Boolean(document.querySelector('.MuiSnackbar-root')),'Failed explicit setup retry announces through the shared snackbar');
  assert(document.querySelector('.MuiSnackbar-root')?.textContent?.includes('Assistant Setup Needs Review'),'Explicit setup failure has the actionable Title Case summary');
  initFails=false;await until(()=>Boolean([...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Retry Assistant Setup'&&!b.disabled)),'Explicit retry settles');const retry=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Retry Assistant Setup')!;retry.click();await until(()=>posts===3&&!host.textContent?.includes('Assistant Setup Needs Review')&&!document.querySelector('.MuiSnackbar-root'),'Confirmed setup retry retires its exact feedback');
  assert(JSON.stringify(bodies)==='[{"initialize":true},{"initialize":true},{"initialize":true}]','Existing initializer body and Singleton route remain unchanged');
 }finally{root.unmount();client.clear();host.remove();window.fetch=originalFetch;focusManager.setFocused(undefined);onlineManager.setOnline(true);}
}
