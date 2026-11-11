import {PONDEROSA_REPLY_STREAM_TOOL} from '@ponderosa/core';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@mui/material';
import {MutationNotificationProvider} from '../../apps/web/src/components/MutationNotifications';
import {ChatPane} from '../../apps/web/src/components/chat/ChatPane';
import {MainConversationTimeline,CollaborationTimeline} from '../../apps/web/src/components/ConversationView.parts';
import {ChatSurface} from '../../apps/web/src/components/chat/ChatSurface';
import {ConversationChromeContext} from '../../apps/web/src/components/ConversationChromeContext';
import {RequestLifecycleCard} from '../../apps/web/src/components/RequestLifecycleCard';
import {api} from '../../apps/web/src/api';
import {ApiRequestError} from '../../apps/web/src/api/types';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {createPonderosaTheme} from '../../apps/web/src/theme';
import '../../apps/web/src/global.css';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message+'; '+document.body.innerText.slice(-1500));}
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
async function until(read:()=>boolean,message:string){const end=performance.now()+5000;while(performance.now()<end){if(read())return;await settle();}assert(false,message);}
const stamp='2026-11-10T12:00:00.000Z';
const receipt=(state='delivered',agent='agent',run='run')=>({activationId:'activation-'+agent,targetAgentId:agent,executionId:run,state,attemptCount:1,updatedAt:stamp});
const source=(id='input',agent='agent',run='run',intent='user_dm')=>({id,communicationEventId:id,conversationId:'chat',agentId:agent,seq:1,role:'user',communicationIntent:intent,text:'Input '+id,createdAt:stamp,deliveryReceipts:[receipt('delivered',agent,run)]});
const snapshot=(input='input',agent='agent',run='run',stream='stream',text='First **bold** chunk',intent='direct_to_user'):any=>({messageId:input,runId:run,runStatus:'running',memoryExposure:{state:'valid',runId:run,sessionResetSeq:1,projectGeneration:2,globalGeneration:3},reply:{presentation:'text',purpose:'answer',projectId:'project',conversationId:'chat',agentId:agent,messageId:input,runId:run,fence:7,streamId:stream,sequence:1,state:'streaming',text,acceptedAt:stamp,firstTextAt:'2026-11-10T12:00:01.000Z',publication:{kind:'message',intent}}});
const canonical=(status:any,id='final'):any=>({id,communicationEventId:id,conversationId:'chat',agentId:status.reply.agentId,seq:2,role:'assistant',authorAgentId:status.reply.agentId,executionId:status.runId,communicationIntent:status.reply.publication.intent==='direct_to_user'?'user_dm':status.reply.publication.intent,text:status.reply.text,createdAt:'2026-11-10T12:00:04.000Z',replyStream:{streamId:status.reply.streamId,sourceId:status.messageId,runId:status.runId,fence:status.reply.fence}});
async function fixture(run:(f:any)=>Promise<void>){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const oldRead=api.getTextReplyStatus,oldSubscribe=api.subscribeAgent,oldPreferences=api.getWorkspacePreferences;api.getWorkspacePreferences=async()=>({} as any);const statuses=new Map<string,any>(),handlers=new Set<any>();let error:unknown,opened=0,closed=0,reads=0;
 api.getTextReplyStatus=async(_chat,input,agent)=>{reads++;if(error)throw error;const state=statuses.get(input+':'+agent);assert(state,'Exact source lookup '+input+':'+agent);return structuredClone(state);};
 api.subscribeAgent=((agent:any,cursor:any,callbacks:any)=>{opened++;const handler={agent,cursor,callbacks,closed:false};handlers.add(handler);return {close(){if(!handler.closed){handler.closed=true;closed++;handlers.delete(handler);}}};}) as any;
 const render=(element:JSX.Element)=>{flushSync(()=>root.render(<ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><MutationNotificationProvider>{element}</MutationNotificationProvider></QueryClientProvider></ThemeProvider>));};
 const pane=(messages:any[],assistant=false,owner='agent',work:any={})=>render(<ConversationChromeContext.Provider value={assistant?{assistantAgentId:owner,statusHost:null,callActionsHost:null}:undefined}><div style={{height:480,display:'flex',flexDirection:'column'}}><ChatPane {...work} messages={messages} projectId="project" fileOwnerAgentId={owner} agentNameForId={id=>'Real '+id} onOpenAgent={()=>{}} scrollStorageKey={'stable-'+owner}/></div></ConversationChromeContext.Provider>);
 const wake=(agent='agent')=>{for(const handler of [...handlers])if(handler.agent===agent)handler.callbacks.onStatus?.();};
 try{await run({host,client,render,pane,wake,statuses,handlers,setError:(value:unknown)=>{error=value;},counts:()=>({opened,closed,reads})});}
 finally{root.unmount();host.remove();client.clear();api.getTextReplyStatus=oldRead;api.subscribeAgent=oldSubscribe;api.getWorkspacePreferences=oldPreferences;}
}
const row=(host:HTMLElement,agent='agent')=>host.querySelector<HTMLElement>(`article[aria-label="Real ${agent} Message"]`);

export async function directReplyEligibilityRegression():Promise<void>{await fixture(async(f:any)=>{
 let sent=source(),status=snapshot();f.statuses.set('input:agent',status);f.pane([sent],true);await until(()=>Boolean(row(f.host)),'First authorized text is an Assistant agent row');
 const node=row(f.host)!,avatar=node.querySelector('[aria-label="Real agent Avatar"]'),body=node.querySelector('.chat-message-body');assert(avatar&&body&&node.querySelector('strong'),'Actual avatar, name and incremental Markdown use normal frame/body');
 for(const state of ['queued','started','delivered','processed']){sent={...sent,deliveryReceipts:[receipt(state)]};f.pane([sent],true);f.wake();await settle();assert(row(f.host)===node&&node.querySelector('.chat-message-body')===body,'Receipt '+state+' preserves mounted row/body');}
 status={...status,reply:{...status.reply,sequence:2,text:'First **bold** chunk\n\nSecond paragraph'}};f.statuses.set('input:agent',status);f.wake();await until(()=>node.textContent?.includes('Second paragraph')===true,'Second chunk grows normal body');
 status={...status,runStatus:'completed',reply:{...status.reply,state:'completed',sequence:3,canonicalReplyEventId:'final'}};f.statuses.set('input:agent',status);f.wake();await settle();assert(row(f.host)===node&&node.textContent?.includes('Second paragraph'),'Completion keeps text until exact canonical available');
 const unrelated={...canonical(status,'other'),replyStream:undefined,text:'Different result in same Run'};f.pane([sent,unrelated],true);assert(row(f.host)===node,'Same Agent/Run/intent is not reconciliation');
 f.pane([sent,unrelated,canonical(status)],true);await settle();const adopted=f.host.querySelector('#message-final');assert(adopted===node&&node.querySelector('.chat-message-body')===body&&node.querySelector('[aria-label="Real agent Avatar"]')===avatar,'Exact final metadata/actions adopt in the same mounted row');assert(f.host.querySelectorAll('article[aria-label="Real agent Message"]').length===2,'No duplicate provisional reply');assert(f.counts().opened===f.counts().closed,'Exact adoption closes stream reads and subscriptions');
});}

export async function requestReplyPreviewRegression():Promise<void>{await fixture(async(f:any)=>{
 const status=snapshot('request');status.reply.publication={kind:'request_update',requestId:'request',updateKind:'completed'};delete status.reply.replyIntent;f.statuses.set('request:agent',status);
 const key=queryKeys.agentWork.detail('project','chat','request:request');const request={id:'request',state:'in_progress',recipientAgentId:'agent',text:'Private task',updatedAt:stamp,refs:[],version:1};
 const render=(updates:any[]=[],state='in_progress')=>{f.client.setQueryData(key,{requestLifecycle:{request:{...request,state},updates}});f.render(<RequestLifecycleCard projectId="project" conversationId="chat" requestId="request" state={state as any} recipientAgentId="agent" updatedAt={stamp} agentTitle={()=>'Real agent'} defaultExpanded/>);};
 render();await until(()=>f.host.textContent?.includes('First bold chunk')||f.host.textContent?.includes('First **bold** chunk'),'Private stream remains in Request');let item=f.host.querySelector('li')!;assert(item&&item.textContent?.includes('Result In Progress')&&!f.host.querySelector('article'),'No authored/terminal claim or Chat bubble for private draft');
 f.setError(new ApiRequestError(503,'Temporary private read failure'));f.wake();await settle();assert(f.host.querySelector('li')===item&&item.textContent?.includes('First **bold** chunk'),'Transient private read keeps its authorized update');
 f.setError(new ApiRequestError(403,'Private permission denied'));f.wake();await until(()=>f.host.textContent?.includes('Access Denied')===true,'Private read denial has scoped actionable feedback');assert(!item.isConnected,'Denied private content is removed');
 f.setError(undefined);const beforeRetry=f.counts().reads;f.host.querySelector<HTMLButtonElement>('[aria-label="Retry Reply"]')!.click();await until(()=>f.counts().reads>beforeRetry&&Boolean(f.host.querySelector('li')),'Explicit Request Retry performs a fresh authorized read');item=f.host.querySelector('li')!;
 const update={id:'update',kind:'completed',actorKind:'agent',actorId:'agent',text:'Final private result',createdAt:stamp,refs:[],artifacts:[],resultingState:'completed',resultingVersion:2,replyStream:{streamId:'stream',sourceId:'request',runId:'run',fence:7}};
 render([update],'completed');await until(()=>item.textContent?.includes('Final private result')===true,'Private canonical adopts');assert(f.host.querySelector('li')===item&&f.host.querySelectorAll('li').length===1,'Request result retains its mounted private update');assert(f.counts().opened===f.counts().closed,'Private canonical adoption releases observers');
});}

export async function broadcastAndCollaborationPreviewRegression():Promise<void>{await fixture(async(f:any)=>{
 const first=source('one','agent','run','broadcast'),second=source('two','other','run','broadcast');const a=snapshot('one','agent','run','s1','First agent stream','broadcast'),b=snapshot('two','other','run','s2','Second agent stream','broadcast');f.statuses.set('one:agent',a);f.statuses.set('two:other',b);
 const props={projectId:'project',healthByAgentId:new Map(),agentTitle:(id:string)=>'Real '+id,agentIdForHandle:()=>undefined,onOpenAgent:()=>{},mentionAgent:()=>{},markCommunicationVisible:()=>{},notifications:[]};
 const main=(messages:any[])=>f.render(<MainConversationTimeline {...props} mainTimeline={messages.map(message=>({kind:'message',id:'message:'+message.id,at:message.createdAt,message}))}/>);
 main([first]);await until(()=>Boolean(row(f.host)),'Broadcast stream uses standard row');const one=row(f.host)!;main([first,second]);await until(()=>Boolean(row(f.host,'other')),'Second input does not discard earlier stream');assert(row(f.host)===one,'Earlier source remains mounted beside simultaneous Agent');
 main([first,second,canonical(b,'b')]);await settle();assert(row(f.host)===one&&one.textContent?.includes('First agent stream'),'Only exact second result reconciles');
 main([first,second,canonical(b,'b'),canonical(a,'a')]);await settle();assert(f.host.querySelector('#master-message-a')===one,'Main Chat canonical adopts first stream in place');
 const peer={...source('peer','agent','peer-run','collaboration'),role:'assistant',authorAgentId:'sender',communicationSender:{kind:'agent',agentId:'sender'},collaborationRecipients:[{id:'agent',title:'Real agent',available:true}]};const p=snapshot('peer','agent','peer-run','peer-stream','Collaboration stream','collaboration');p.reply.publication.recipientAgentIds=['sender'];f.statuses.set('peer:agent',p);
 const collab=(messages:any[])=>f.render(<CollaborationTimeline {...props} operationalEvents={[]} collaborationMessages={messages}/>);
 collab([peer]);await until(()=>Boolean(row(f.host)),'Supported collaboration uses named standard row');const peerRow=row(f.host);const final={...canonical(p,'peer-final'),collaborationRecipients:[{id:'sender',title:'Real sender',available:true}]};collab([peer,final]);await settle();assert(f.host.querySelector('#master-message-peer-final')===peerRow,'Exact collaboration return adopts mounted row');
 const beforePrivate=f.counts();collab([{...peer,id:'private-linked',communicationEventId:'private-linked',coordinationRequests:[{recordId:'request',state:'in_progress'}]}]);await settle();assert(f.counts().reads===beforePrivate.reads&&f.counts().opened===beforePrivate.opened,'Request-linked collaboration never opens an ordinary Chat stream');
});}

export async function replyPreviewRateLimitRegression():Promise<void>{await fixture(async(f:any)=>{
 const sent=source(),status=snapshot();f.statuses.set('input:agent',status);f.pane([sent]);await until(()=>Boolean(row(f.host)),'Authorized snapshot shown');const node=row(f.host);
 f.setError(new ApiRequestError(503,'Temporary read failure'));f.wake();await settle();assert(row(f.host)===node&&node?.textContent?.includes('First bold chunk'),'Recoverable read failure retains verified content');
 const continued='Newer chunk\n\n'+'A long streamed reply uses the available conversation lane. '.repeat(100);
 f.setError(undefined);f.statuses.set('input:agent',{...status,reply:{...status.reply,sequence:2,text:continued}});f.wake();await until(()=>node?.textContent?.includes('Newer chunk')===true,'Reconnect continues from verified snapshot');f.statuses.set('input:agent',status);f.wake();await settle();assert(node?.textContent?.includes('Newer chunk'),'Older status sequence cannot regress text');
 const body=node!.querySelector('.chat-message-body')!,width=body.getBoundingClientRect().width;
 assert(Math.abs(body.getBoundingClientRect().right-node!.getBoundingClientRect().right)<1,'Streaming long reply fills its lane after the avatar');
 f.pane([sent,canonical({...status,reply:{...status.reply,text:continued+'\n\nCanonical arrived first'}},'early')]);await settle();assert(f.host.querySelector('#message-early')===node&&node?.textContent?.includes('Canonical arrived first'),'Canonical before last stream chunk adopts without duplicate or replay');
 assert(node!.querySelector('.chat-message-body')===body&&Math.abs(body.getBoundingClientRect().width-width)<1,'Canonical completion preserves the mounted body and available reply width');
});}

export async function requestLifecyclePreviewOwnerRegression():Promise<void>{await fixture(async(f:any)=>{
 const sent=source();f.statuses.set('input:agent',snapshot());f.pane([sent]);await until(()=>Boolean(row(f.host)),'Owner stream admitted');const stale=[...f.handlers][0];
 f.pane([source('next','other','other-run')],false,'other');f.statuses.set('next:other',snapshot('next','other','other-run','other-stream','Other owner'));stale.callbacks.onEvent({agentId:'agent',seq:2,event:{type:'voice_reply',reply:snapshot().reply}});await settle();assert(!row(f.host)&&!f.host.textContent?.includes('First bold chunk'),'Navigation fences old owner and late callbacks');
 f.wake('other');await until(()=>Boolean(row(f.host,'other')),'New owner has only its own stream');f.setError(new ApiRequestError(403,'Permission revoked'));f.wake('other');await until(()=>!row(f.host,'other'),'Access revocation removes provisional content');f.setError(undefined);const before=f.counts().reads;f.host.querySelector<HTMLButtonElement>('[aria-label="Retry Reply"]')!.click();await until(()=>f.counts().reads>before&&Boolean(row(f.host,'other')),'Explicit read Retry revalidates only the current owner');stale.callbacks.onStatus();await settle();assert(!row(f.host),'Late old-owner status cannot revive revoked text');
});}

export async function replyStreamAttemptFencesRegression():Promise<void>{await fixture(async(f:any)=>{
 let sent={...source(),deliveryReceipts:[{...receipt(),injectionKind:'steer',injectionId:'steer-one'}]};let status=snapshot();status.reply.steeringInjectionId='steer-one';f.statuses.set('input:agent',status);f.pane([sent]);await until(()=>Boolean(row(f.host)),'First exact steering attempt admitted');
 sent={...sent,deliveryReceipts:[{...receipt(),injectionKind:'steer',injectionId:'steer-two'}]};f.pane([sent]);await settle();assert(!row(f.host),'New steering authority fences old stream');status={...snapshot('input','agent','run','stream-two','Current steering reply'),reply:{...snapshot('input','agent','run','stream-two','Current steering reply').reply,steeringInjectionId:'steer-two'}};f.statuses.set('input:agent',status);f.wake();await until(()=>row(f.host)?.textContent?.includes('Current steering reply')===true,'Stale first status does not poison a new same-Run attempt');
 const handler=[...f.handlers][0];handler.callbacks.onEvent({agentId:'agent',seq:10,event:{type:'memory_changed',projectId:'project',scope:'chat',conversationId:'chat'}});await until(()=>!row(f.host),'Memory invalidation removes authorized text');handler.callbacks.onStatus();await settle();assert(!row(f.host),'Invalidated authority cannot revive from late callbacks');
});}

export async function replyStreamScrollContinuityRegression():Promise<void>{await fixture(async(f:any)=>{
 const history=Array.from({length:20},(_,i)=>({...canonical(snapshot('old-'+i,'history'),'old-'+i),replyStream:undefined,text:'Older message '+i+'\n\n'+('Historical prose. '.repeat(20)),createdAt:new Date(Date.parse(stamp)-100000+i*1000).toISOString()}));
 const status=snapshot();status.reply.acceptedAt='2026-11-10T11:58:00.000Z';status.reply.firstTextAt='2026-11-10T11:58:01.000Z';
 const sent={...source(),createdAt:'2026-11-10T11:58:00.000Z'};f.statuses.set('input:agent',status);f.pane([sent,...history]);await until(()=>Boolean(row(f.host)),'Earlier stream rendered before newer history');await settle();
 const region=f.host.querySelector<HTMLElement>('.chat-scroll-region')!;region.scrollTop=700;region.dispatchEvent(new Event('scroll'));await settle();const bodies=[...region.querySelectorAll<HTMLElement>('.chat-message-body')],top=region.getBoundingClientRect().top,anchor=bodies.find(body=>body.getBoundingClientRect().bottom>top)!;const offset=anchor.getBoundingClientRect().top-top;
 f.statuses.set('input:agent',{...status,reply:{...status.reply,sequence:2,text:'Growing reply\n\n'+('More prose. '.repeat(120))}});f.wake();await until(()=>row(f.host)?.textContent?.includes('Growing reply')===true,'Earlier streaming body grows');await settle();assert(Math.abs(anchor.getBoundingClientRect().top-region.getBoundingClientRect().top-offset)<2,'Growth above the reader preserves their mounted message position');assert(region.scrollTop<region.scrollHeight-region.clientHeight-100,'Reader is not pulled back to latest');
 f.pane([sent,...history,canonical(status)]);await settle();assert(Math.abs(anchor.getBoundingClientRect().top-region.getBoundingClientRect().top-offset)<2,'Final adoption and height contraction keep reading anchor');
});}

export async function replyStreamTerminalSafetyRegression():Promise<void>{await fixture(async(f:any)=>{
 const sent=source(),legacy=snapshot();legacy.runStatus='completed';legacy.reply.state='completed';f.statuses.set('input:agent',legacy);
 f.pane([sent,{...canonical(legacy,'legacy'),replyStream:undefined}]);await settle();assert(f.host.querySelectorAll('article[aria-label="Real agent Message"]').length===1,'Unbound historical completed stream cannot duplicate canonical history');assert(f.counts().opened===f.counts().closed,'Legacy terminal stream releases its read loop');
 const active=snapshot('next','other','next-run','next-stream','Current valid text');f.statuses.set('next:other',active);const next=source('next','other','next-run');f.pane([next],false,'other');await until(()=>Boolean(row(f.host,'other')),'Next owner admitted');f.pane([{...next,deliveryReceipts:[receipt('cancelled','other','next-run')]}],false,'other');await settle();assert(!row(f.host,'other'),'Canonical cancellation removes provisional content immediately');assert(f.counts().opened===f.counts().closed,'Cancellation closes the exact stream subscription');
});}

export async function replyStreamColdHistoryRegression():Promise<void>{await fixture(async(f:any)=>{
 const sent={...source(),deliveryReceipts:[{...receipt(),providerAcknowledged:true,injectionId:'turn-injection',injectionKind:'turn',liveProgress:{text:'Actual progress remains visible',createdAt:stamp,seq:1,recipientHandle:'Agent'}}]},status=snapshot();
 const final=canonical(status);f.pane([sent,final]);await settle();assert(f.counts().opened===0&&f.counts().reads===0,'Cold exact canonical history opens no observer/read loops');assert(f.host.textContent?.includes('Actual progress remains visible'),'Unchanged user-row progress stays visible');
 const fresh={...sent,deliveryReceipts:[{...sent.deliveryReceipts[0],injectionKind:'steer',injectionId:'new-steering'}]};const next=snapshot('input','agent','run','new-stream','Fresh same-Run work');next.reply.steeringInjectionId='new-steering';f.statuses.set('input:agent',next);f.pane([fresh,final]);await until(()=>f.host.textContent?.includes('Fresh same-Run work')===true,'Old canonical source does not suppress new steering attempt in same Run');
 f.setError(new ApiRequestError(503,'Temporary read failure'));f.wake();await settle();assert(f.host.textContent?.includes('Actual progress remains visible'),'Read feedback composes with canonical progress');
});}

export async function assistantActiveReplyContinuityRegression():Promise<void>{await fixture(async(f:any)=>{
 const sent=source(),status=snapshot();f.statuses.set('input:agent',status);
 let run:any={id:'run',agentId:'agent',status:'running',startedAt:stamp,communicationEventId:'input'};
 const activity:any[]=[{id:'call',agentId:'agent',executionId:'run',seq:2,createdAt:stamp,event:{type:'tool_call',id:'transport',name:PONDEROSA_REPLY_STREAM_TOOL.name,input:{}}},{id:'result',agentId:'agent',executionId:'run',seq:3,createdAt:stamp,event:{type:'tool_result',id:'transport',output:JSON.stringify({text:'First **bold** chunk'})}}];
 const earlier:any[]=[];
 const render=(messages:any[],meaningful=false)=>f.pane([...earlier,...messages],true,'agent',{runs:[run],activeExecutionId:run.status==='running'?'run':undefined,activity:meaningful?[...activity,{id:'test',agentId:'agent',executionId:'run',seq:4,createdAt:stamp,event:{type:'test_result',passed:true,summary:'Useful verified work'}}]:activity,runOutput:[{id:'answer',executionId:'run',seq:5,createdAt:stamp,kind:'response',text:'First **bold** chunk'}]});
 render([sent]);await until(()=>Boolean(row(f.host)),'Active Assistant renders its authorized reply');const node=row(f.host)!,body=node.querySelector('.chat-message-body'),avatar=node.querySelector('[aria-label$=" Avatar"]');
 assert(!f.host.querySelector('article[aria-label="Agent Work Details"]'),'Transport-only greeting has no work disclosure');
 let disconnected=false;const observer=new MutationObserver(records=>{if(!node.isConnected||records.some(record=>[...record.removedNodes].some(removed=>removed===node||removed.contains(node))))disconnected=true;});observer.observe(f.host,{childList:true,subtree:true});
 try{
 render([sent],true);await settle();let details=f.host.querySelector<HTMLElement>('article[aria-label="Agent Work Details"]');assert(details&&node.contains(details),'Meaningful work is attached beneath the provisional reply');assert(details.querySelector('[aria-expanded="false"]'),'Active Assistant disclosure starts collapsed');assert(body!.getBoundingClientRect().bottom<=details.getBoundingClientRect().top+1,'Work never precedes the reply body');
 details.querySelector<HTMLButtonElement>('button')!.click();await settle();assert(!f.host.textContent?.includes(PONDEROSA_REPLY_STREAM_TOOL.name),'Internal reply transport stays out of ordinary work details');assert(details.textContent?.includes('Useful verified work')&&!details.textContent?.includes('First bold chunk'),'Meaningful work excludes duplicated answer output');details.querySelector<HTMLButtonElement>('button')!.click();
 const oldReply=canonical(snapshot('older-source','agent','run','older-stream','Earlier result in the same Run'),'older-final');oldReply.createdAt='2026-11-10T11:59:00.000Z';earlier.push(oldReply);render([sent],true);await settle();assert(node.contains(details)&&row(f.host)!.id==='message-older-final','A delayed earlier same-Run reply does not steal the established disclosure');
 for(const state of ['queued','started','delivered']){render([{...sent,deliveryReceipts:[receipt(state)]}],true);await settle();assert(node.isConnected,'Normal delivery transition keeps the same active reply');}
 status.reply={...status.reply,sequence:2,text:'First **bold** chunk\n\nSecond paragraph'};f.statuses.set('input:agent',status);f.wake();await until(()=>node.textContent?.includes('Second paragraph')===true,'Multiple active chunks grow in place');
 render([sent,canonical(status)],true);await settle();assert(f.host.querySelector('#message-final')===node&&node.querySelector('.chat-message-body')===body&&node.querySelector('[aria-label$=" Avatar"]')===avatar,'Canonical publication while active preserves frame, body and avatar');assert(node.contains(details)&&f.host.querySelector('article[aria-label="Agent Work Details"]')===details,'Publication keeps the same disclosure below the same reply');
 run={...run,status:'completed',completedAt:'2026-11-10T12:00:09.000Z'};render([sent,canonical(status)],true);await settle();assert(node.contains(details)&&details!.isConnected,'Completion retains useful collapsed work beneath the reply');assert(f.host.querySelector('#message-final')===node&&!disconnected,'No disconnected interval during publication or completion');
 activity[1].event.isError=true;render([sent,canonical(status)],true);await settle();details!.querySelector<HTMLButtonElement>('button')!.click();await settle();assert(details!.textContent?.includes('Reply Delivery Needs Review')&&!details!.textContent?.includes(PONDEROSA_REPLY_STREAM_TOOL.name),'Failed transport retains a compact review notice while the raw tool remains in advanced audit');
 }finally{observer.disconnect();}
});}

export async function replyPendingEvidenceContinuityRegression():Promise<void>{await fixture(async(f:any)=>{
 const sent=source(),status=snapshot();f.statuses.set('input:agent',status);f.pane([sent],true);await until(()=>Boolean(row(f.host)),'Verified reply initially visible');const node=row(f.host);
 for(const pending of [{...status,memoryExposure:{state:'pending',runId:'run'},reply:{...status.reply,sequence:2,text:'Unverified text must stay hidden'}},{...status,memoryExposure:undefined},{...status,runId:undefined,reply:undefined}]){f.statuses.set('input:agent',pending);f.wake();await settle();assert(row(f.host)===node&&node?.textContent?.includes('First bold chunk'),'Incomplete authority read retains prior verified text without accepting unverified chunks');}
 f.statuses.set('input:agent',{...status,runStatus:'completed',reply:{...status.reply,state:'completed'}});f.wake();await settle();assert(row(f.host)===node,'Missing final binding does not discard a previously authorized reply');
 f.statuses.set('input:agent',{...status,memoryExposure:{...status.memoryExposure,state:'invalid'}});f.wake();await until(()=>!row(f.host),'Verified authority invalidation still fences the visible reply');
});}

export async function replyPendingContradictionRegression():Promise<void>{
 for(const patch of [
  {runId:'replacement-run',memoryExposure:{state:'pending',runId:'replacement-run'}},
  {memoryExposure:{state:'pending',runId:'run',sessionResetSeq:2}},
  {memoryExposure:{state:'pending',runId:'run',projectGeneration:4}},
  {memoryExposure:{state:'pending',runId:'run',globalGeneration:4}},
  {memoryExposure:{state:'pending',runId:'run'},reply:{...snapshot().reply,streamId:'replacement-stream'}},
  {memoryExposure:{state:'pending',runId:'run'},reply:{...snapshot().reply,state:'failed'}},
 ])await fixture(async(f:any)=>{
  const sent=source(),status=snapshot();f.statuses.set('input:agent',status);f.pane([sent],true);await until(()=>Boolean(row(f.host)),'Verified reply admitted before pending contradiction');
  const noRun={...sent,deliveryReceipts:[{...receipt(),executionId:undefined}]};f.pane([noRun],true);await settle();f.statuses.set('input:agent',{...status,...patch});f.wake();await until(()=>!row(f.host),'Supplied conflicting authority fences even when other evidence is pending or missing');
 });
}
