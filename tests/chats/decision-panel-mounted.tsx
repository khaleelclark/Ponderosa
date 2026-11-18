import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CssBaseline,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DEFAULT_ASSET_LIMITS,type DecisionDto} from '@ponderosa/core';
import {api} from '../../apps/web/src/api';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {createPonderosaTheme} from '../../apps/web/src/theme';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {ChatDecisionPanel,DECISION_IDLE_COLLAPSE_MS} from '../../apps/web/src/components/decisions/ChatDecisionPanel';
import {notificationNavigationRoute,revealNotificationDecision} from '../../apps/web/src/notificationNavigation';

function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message+'; '+document.body.innerText.slice(-1400));}
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
async function until(read:()=>boolean,message:string){const end=performance.now()+7000;while(performance.now()<end){if(read())return;await settle();}throw Error(message+'; '+document.body.innerText.slice(-1400));}
function button(host:Element,text:string){const found=[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text);assert(found,'Button exists: '+text);found.click();}
function edit(input:HTMLTextAreaElement,text:string){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));}
function chooseFile(host:Element,file:File){const input=host.querySelector<HTMLInputElement>('input[type=file]:not([webkitdirectory])');assert(input,'Existing answer file picker');const data=new DataTransfer();data.items.add(file);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}
const stamp='2026-11-11T00:00:00Z';
function decision(id='question-a',chat='chat-a',agent='agent-a'):DecisionDto{return {id,projectId:'question-project',conversationId:chat,agentId:agent,mode:'text',status:'pending',question:'Full canonical question '+id,options:[],allowOther:true,createdAt:stamp,updatedAt:stamp} as DecisionDto;}

function fixture(){
 const host=document.createElement('div');host.style.height='calc(100dvh - 100px)';document.body.append(host);const root=createRoot(host);
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});client.setQueryData(queryKeys.assetLimits.all,DEFAULT_ASSET_LIMITS);
 const records=new Map<string,DecisionDto>([['question-a',decision()],['question-b',decision('question-b','chat-b','agent-b')]]);
 const drafts=new Map<string,any>(),calls:{respond:any[];upload:any[];remove:any[];reads:any[]}={respond:[],upload:[],remove:[],reads:[]};
 let owner={conversationId:'chat-a',agentId:'agent-a'},releaseUpload:((value:unknown)=>void)|undefined,uploadAsset:any,holdUpload=false;
 const original={getDecisionAction:api.getDecisionAction,getAssetLimits:api.getAssetLimits,getConversationDraft:api.getConversationDraft,putConversationDraft:api.putConversationDraft,listDecisions:api.listDecisions,respondDecision:api.respondDecision,uploadDraftAttachment:api.uploadDraftAttachment,deleteDraftAttachment:api.deleteDraftAttachment};
 Object.assign(api,{
  getDecisionAction:async()=>({mode:'form',message:'Exact native request',requestedSchema:{type:'object',properties:{answer:{type:'string',title:'Native Answer'}},required:['answer']}}),
  getAssetLimits:async()=>DEFAULT_ASSET_LIMITS,
  getConversationDraft:async(scope:string,id:string)=>{calls.reads.push([scope,id]);const key=scope+':'+id;if(!drafts.has(key))drafts.set(key,{conversationId:scope,ownerId:id,revision:0,text:'',attachmentIds:[],attachments:[]});return drafts.get(key);},
  putConversationDraft:async(scope:string,value:any)=>{const key=scope+':'+value.ownerId,old=drafts.get(key);const next={...old,...value,conversationId:scope,revision:old.revision+1,attachments:value.attachmentIds.map(()=>uploadAsset)};drafts.set(key,next);return next;},
  listDecisions:async(filter:any)=>[...records.values()].filter(value=>(!filter.id||filter.id===value.id)&&(!filter.status||filter.status===value.status)),
  respondDecision:async(id:string,response:any)=>{calls.respond.push([id,response]);const value={...records.get(id)!,status:'resolved',updatedAt:stamp,response:{...response,respondedAt:stamp}};records.set(id,value as DecisionDto);return value;},
  uploadDraftAttachment:async(scope:string,id:string,file:File)=>{calls.upload.push([scope,id,file]);uploadAsset={id:'answer-asset',conversationId:scope,ownerId:id,agentId:scope.slice(6),name:file.name,size:file.size,mediaType:file.type,createdAt:stamp,url:'/owned-answer-asset'};return holdUpload?new Promise(resolve=>releaseUpload=resolve):uploadAsset;},
  deleteDraftAttachment:async(...args:any[])=>{calls.remove.push(args);},
 });
 const nativeSet=window.setTimeout,nativeClear=window.clearTimeout,timers=new Map<number,()=>void>();let sequence=-100;
 window.setTimeout=((handler:TimerHandler,delay?:number,...args:any[])=>{if(delay===DECISION_IDLE_COLLAPSE_MS&&typeof handler==='function'){const id=sequence--;timers.set(id,()=>handler(...args));return id;}return nativeSet(handler,delay,...args);}) as typeof window.setTimeout;
 window.clearTimeout=((id?:number)=>{if(id!==undefined&&timers.delete(id))return;nativeClear(id);}) as typeof window.clearTimeout;
 const render=(next=owner)=>{owner=next;const data=[...records.values()].filter(value=>value.status==='pending');flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider><ChatDecisionPanel projectId="question-project" {...owner} decisions={data} agentTitle={id=>id==='agent-a'?'Real Question Owner':'Other Owner'}/></MutationNotificationProvider></QueryClientProvider></ThemeProvider>));};
 return {host,client,records,drafts,calls,timers,render,holdUpload:()=>{holdUpload=true;},releaseUpload:()=>{assert(releaseUpload,'Owned upload is pending');releaseUpload(uploadAsset);},
  async close(){root.unmount();await settle();assert(timers.size===0,'Idle timer released on owner unmount');client.clear();host.remove();Object.assign(api,original);window.setTimeout=nativeSet;window.clearTimeout=nativeClear;}};
}

export async function decisionPanelDraftAndDismissalMountedRegression():Promise<void>{
 const f=fixture();try{
  f.render();await settle();const panel=f.host.querySelector<HTMLDetailsElement>('details[id="decision:question-a"]');assert(panel?.open,'Canonical pending question opens inline at Chat bottom');
  assert(!f.host.textContent?.includes('Full canonical question question-b'),'Foreign Chat never intrudes');assert(!document.querySelector('[role=dialog]'),'No response modal opens');
  button(panel,'Answer');await until(()=>Boolean(panel.querySelector<HTMLTextAreaElement>('textarea')&&!panel.querySelector<HTMLTextAreaElement>('textarea')!.disabled),'Existing durable answer draft loads');
  const input=panel.querySelector<HTMLTextAreaElement>('textarea')!;assert(document.activeElement===input,'Answer focuses the visible real editor after the draft loads');
  edit(input,'Retained multiline answer λ😀\nsecond line');await until(()=>[...f.drafts.values()].some(value=>value.text.includes('Retained multiline')),'Same existing draft authority saves typed text');
  f.holdUpload();chooseFile(panel,new File(['Exact answer bytes'],'retained-answer.txt',{type:'text/plain'}));await until(()=>f.calls.upload.length===1,'Existing uploader accepts one original File');
  const send=[...panel.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Send Response');assert(send?.disabled,'Submission waits for durable attachment identity');
  button(panel,'Cancel');await until(()=>!panel.open,'Cancel dismisses to compact Answer Question');assert(f.calls.respond.length===0,'Dismissal is never an answer or Skip');
  f.releaseUpload();await until(()=>panel.textContent?.includes('retained-answer.txt')===true,'Late upload remains with its original hidden question');
  panel.querySelector('summary')!.click();await until(()=>panel.open&&Boolean(panel.querySelector<HTMLTextAreaElement>('textarea')?.getClientRects().length),'Compact action reopens the same form');
  assert(panel.querySelector<HTMLTextAreaElement>('textarea')?.value==='Retained multiline answer λ😀\nsecond line','Reopen retains exact answer');await until(()=>document.activeElement===panel.querySelector('textarea'),'Reopen restores editor focus after native toggle');
  assert(f.calls.reads.length===1&&f.calls.upload.length===1,'Reopen neither reloads nor duplicates the answer upload');
  const idle=[...f.timers.values()];assert(idle.length===1,'One owner-scoped idle timer');idle[0]();await until(()=>!panel.open,'Approved idle interval collapses presentation');assert(f.calls.respond.length===0,'Elapsed time cannot answer, skip or approve');
  panel.querySelector('summary')!.click();await until(()=>panel.open,'Question remains reachable');await until(()=>{const b=[...panel.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent==='Send Response');return Boolean(b&&!b.disabled);},'Durable uploaded answer can submit');
  button(panel,'Send Response');await until(()=>f.calls.respond.length===1,'Existing response callback invoked once');assert(f.calls.respond[0][1].text==='Retained multiline answer λ😀\nsecond line','Exact text submitted');assert(f.calls.respond[0][1].attachmentIds[0]==='answer-asset','Exact durable file reference submitted');f.render();await settle();
 }finally{await f.close();}
}

export async function decisionPanelCompetingClientMountedRegression():Promise<void>{
 const f=fixture();try{
  f.render();await settle();const panel=f.host.querySelector<HTMLDetailsElement>('details[id="decision:question-a"]')!;button(panel,'Answer');await until(()=>Boolean(panel.querySelector('textarea')&&!panel.querySelector<HTMLTextAreaElement>('textarea')!.disabled),'Draft opens');
  edit(panel.querySelector('textarea')!,'Do not lose this competing-client draft');await until(()=>[...f.drafts.values()].some(value=>value.text.includes('competing-client')),'Draft persisted');
  button(panel,'Cancel');await until(()=>!panel.open,'Draft owner remains mounted while collapsed');
  f.records.set('question-a',{...f.records.get('question-a')!,status:'resolved',response:{text:'Other client canonical answer',respondedAt:stamp}});
  f.render();await f.client.invalidateQueries({queryKey:queryKeys.decisions.all});await until(()=>!f.host.querySelector('details[id="decision:question-a"]'),'Exact canonical completion releases the retained presentation');
  assert(f.calls.respond.length===0,'Competing completion causes no submit, approval or wake-up');assert([...f.drafts.values()].some(value=>value.text.includes('competing-client')),'Unsubmitted local answer remains in its own draft');
 }finally{await f.close();}
}

export async function decisionPanelOwnerAndNavigationMountedRegression():Promise<void>{
 const f=fixture();try{
  const legacy={...decision('legacy-question'),conversationId:undefined};f.records.set(legacy.id,legacy);f.records.set('explicit-foreign',{...decision('explicit-foreign','chat-b','agent-a')});
  f.render();await settle();assert(Boolean(f.host.querySelector('details[id="decision:legacy-question"]')),'Canonical Agent owner retains missing-Chat Decision');assert(!f.host.textContent?.includes('explicit-foreign'),'Explicit different Chat is never borrowed');const first=f.host.querySelector<HTMLDetailsElement>('details[id="decision:question-a"]')!;button(first,'Answer');await until(()=>Boolean(first.querySelector('textarea')&&!first.querySelector<HTMLTextAreaElement>('textarea')!.disabled),'Original answer ready');
  f.holdUpload();chooseFile(first,new File(['Late original bytes'],'old-owner.txt',{type:'text/plain'}));await until(()=>f.calls.upload.length===1,'Original upload in flight');
  f.render({conversationId:'chat-b',agentId:'agent-b'});await settle();assert(!f.host.textContent?.includes('question-a'),'Owner navigation fences the earlier question');
  f.releaseUpload();await until(()=>f.calls.remove.length===1,'Late old upload cleans only original draft owner');assert(f.calls.remove[0][0]==='agent:agent-a'&&f.calls.remove[0][1]==='question-a','No cleanup against the new owner');assert(!f.host.textContent?.includes('old-owner.txt'),'Late file cannot revive in new Chat');
  const second=f.host.querySelector<HTMLDetailsElement>('details[id="decision:question-b"]')!;second.querySelector('summary')!.click();await until(()=>!second.open,'Question can be compact');
  const notification={kind:'decision',projectId:'question-project',conversationId:'chat-b',decision:{id:'question-b'}} as any;
  const route=notificationNavigationRoute(notification);assert(route?.kind==='conversation'&&route.conversationId==='chat-b'&&route.focusMessageId==='decision:question-b','Notification targets exact owning Chat and question');
  revealNotificationDecision(notification);await until(()=>second.open,'Repeated same-Chat notification reopens native details');assert(f.calls.respond.length===0,'Navigation never submits an answer');
 }finally{await f.close();}
}

export async function decisionPanelUnconfirmedActionMountedRegression():Promise<void>{
 for(const kind of ['approval-option','approval-text','runtime-action']){
  const f=fixture();try{
   const record={...decision(),mode:kind==='runtime-action'?'choice':'approval',allowOther:kind==='approval-text',options:kind==='approval-option'?[{id:'allow',label:'Allow Access'}]:[],...(kind==='runtime-action'?{runtimeAction:{kind:'mcp_elicitation',mode:'form',serverName:'fixture'}}:{})} as DecisionDto;
   f.records.set(record.id,record);f.records.delete('question-b');let release:(()=>void)|undefined,fail=true;
   api.respondDecision=async(id,response)=>{f.calls.respond.push([id,response]);const terminal={...record,status:'resolved',response:{...response,respondedAt:stamp}} as DecisionDto;f.records.set(id,terminal);if(fail)throw Error('Response recorded; action completion was lost');return new Promise(resolve=>release=()=>resolve(terminal));};
   f.render();await settle();const panel=f.host.querySelector<HTMLDetailsElement>('details[id="decision:question-a"]')!;
   let label='Allow Access';
   if(kind==='approval-text'){button(panel,'Something Else');await until(()=>Boolean(panel.querySelector('textarea')&&!panel.querySelector<HTMLTextAreaElement>('textarea')!.disabled),'Approval draft ready');edit(panel.querySelector('textarea')!,'Exact retained approval direction');label='Send Response';}
   if(kind==='runtime-action'){await until(()=>Boolean(panel.querySelector('textarea')),'Real native form loads');edit(panel.querySelector('textarea')!,'Exact native response');label='Submit';}
   button(panel,label);await until(()=>f.calls.respond.length===1&&Boolean(panel.textContent?.includes('completion could not be confirmed')),'Lost action response remains uncertain');
   f.render();await f.client.invalidateQueries({queryKey:queryKeys.decisions.all});await settle();
   assert(Boolean(f.host.querySelector('details[id="decision:question-a"]')),'Canonical terminal cannot unmount unconfirmed action owner');
   const retry=[...panel.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label);assert(retry&&!retry.disabled,'Same exact action retry remains reachable');
   if(kind!=='approval-option')assert(panel.querySelector<HTMLTextAreaElement>('textarea')?.value.includes('Exact'),'Original form input survives terminal reconciliation');
   fail=false;retry.click();await until(()=>f.calls.respond.length===2,'Explicit retry uses existing response path');assert(JSON.stringify(f.calls.respond[0])===JSON.stringify(f.calls.respond[1]),'Same Decision and exact response, no implicit retry');
   f.render();await settle();assert(Boolean(f.host.querySelector('details[id="decision:question-a"]')),'Pending side effect owner survives refresh');assert(release,'Exact retry in flight');release();await until(()=>!f.host.querySelector('details[id="decision:question-a"]'),'Confirmed completion releases attention and exact retry owner');
  }finally{await f.close();}
 }
}
