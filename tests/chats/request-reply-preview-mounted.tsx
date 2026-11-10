// Deferred mounted regression; run only in the existing browser harness when authorized.
import {createRoot} from 'react-dom/client';
import {DirectReplyPreview} from '../../apps/web/src/components/chat/DirectReplyPreview';
import {api} from '../../apps/web/src/api';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {RequestLifecycleCard} from '../../apps/web/src/components/RequestLifecycleCard';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {MessageDeliveryStatus} from '../../apps/web/src/components/MessageDeliveryStatus';
import {ApiRequestError} from '../../apps/web/src/api/types';
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setTimeout(resolve,0));};
export async function requestReplyPreviewRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const originalRead=api.getTextReplyStatus,originalSubscribe=api.subscribeAgent;
 const calls:unknown[][]=[];let wake=()=>{};
 let status:any={messageId:'request',runId:'run',runStatus:'running',memoryExposure:{state:'valid',runId:'run',sessionResetSeq:1,projectGeneration:2,globalGeneration:3},reply:{presentation:'text',purpose:'answer',projectId:'project',conversationId:'chat',agentId:'recipient',messageId:'request',runId:'run',fence:1,streamId:'stream',sequence:1,state:'streaming',text:'Exact private draft',publication:{kind:'request_update',requestId:'request',updateKind:'completed'}}};
 api.getTextReplyStatus=async(...args)=>{calls.push(args);return status;};
 api.subscribeAgent=((_id:unknown,_cursor:unknown,handlers:any)=>{wake=()=>handlers.onStatus?.();return {close(){}};}) as typeof api.subscribeAgent;
 const render=(key:string,state:'in_progress'|'completed'='in_progress')=>root.render(<DirectReplyPreview key={key} projectId="project" agentId="recipient" request={{id:'request',conversationId:'chat',state}}/>);
 try{
  render('valid');await settle();assert(host.textContent==='Exact private draft','exact Request draft displays');assert(calls.every(args=>args.slice(0,3).join('/')==='chat/request/recipient'),'read exact Request route');
  status={...status,reply:{...status.reply,publication:{...status.reply.publication,requestId:'other'}}};wake();await settle();assert(!host.textContent?.includes('Exact private draft'),'foreign Request cannot render');
  status={...status,reply:{...status.reply,publication:{kind:'request_update',requestId:'request',updateKind:'completed'}}};render('memory');await settle();
  status={...status,memoryExposure:{...status.memoryExposure,projectGeneration:4}};wake();await settle();assert(!host.textContent?.includes('Exact private draft'),'memory drift revokes draft');
  render('terminal','completed');await settle();assert(!host.textContent,'canonical terminal Request hides provisional draft');
  status={...status,memoryExposure:undefined};render('missing-context');await settle();assert(!host.textContent?.includes('Exact private draft'),'missing memory validation fails closed');
 }finally{root.unmount();host.remove();api.getTextReplyStatus=originalRead;api.subscribeAgent=originalSubscribe;}
}


const waitFor=async(check:()=>boolean,label:string)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error(label);await new Promise(r=>setTimeout(r,5));}};
const receipt=(state:string,run='run',agent='recipient',activation='activation')=>({activationId:activation,targetAgentId:agent,state,executionId:run,providerAcknowledged:true,injectionKind:'turn',injectionId:'injection',attemptCount:1,updatedAt:'2026-11-09T00:00:00Z',canRetry:true} as any);
const source=(r:any)=>({id:'source',communicationEventId:'source',role:'user',conversationId:'chat',communicationIntent:'user_dm',deliveryReceipts:[r]} as any);
const snapshot=(run='run',agent='recipient',fence=1)=>({messageId:'source',runId:run,runStatus:'running',memoryExposure:{state:'valid',runId:run,sessionResetSeq:1,projectGeneration:2,globalGeneration:3},reply:{presentation:'text',purpose:'answer',replyIntent:'direct_to_user',projectId:'project',conversationId:'chat',agentId:agent,messageId:'source',runId:run,fence,streamId:'stream-'+run,sequence:1,state:'streaming',text:'Exact draft '+run}} as any);

export async function directReplyEligibilityRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const originals={read:api.getTextReplyStatus,subscribe:api.subscribeAgent,retry:api.retryMessageDelivery};let reads=0,opened=0,closed=0,actions=0,wake=()=>{},current=snapshot(),lastSignal:AbortSignal|undefined;
 api.getTextReplyStatus=async(_chat,_message,_agent,signal)=>{reads++;lastSignal=signal;return current;};api.subscribeAgent=((_id:any,_cursor:any,handlers:any)=>{opened++;wake=()=>handlers.onStatus?.();return {close(){closed++;}};}) as any;
 api.retryMessageDelivery=(async()=>{actions++;throw Error('rAw eXpLiCiT Retry Failure');}) as any;
 const render=async(r:any,active=true,messages:any[]=[],second?:any)=>{root.render(<QueryClientProvider client={client}><MessageDeliveryStatus projectId="project" receipts={second?[r,second]:[r]} recipientName={id=>id==='recipient'?'miXeD Agent':'Other Agent'}/><DirectReplyPreview active={active} projectId="project" agentId="recipient" sent={source(r)} messages={messages}/></QueryClientProvider>);await settle();};
 const visibility=(state:'visible'|'hidden')=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:state});document.dispatchEvent(new Event('visibilitychange'));};
 try{
  await render(receipt('run_unconfirmed'));assert(reads===0&&opened===0,'Unconfirmed work starts neither reads nor subscriptions');assert(host.textContent?.includes('Work Unconfirmed')&&!host.querySelector('[role="alert"]'),'Canonical warning remains without a preview alert');assert(host.textContent?.includes('miXeD Agent'),'Agent title casing stays verbatim');
  const retry=[...host.querySelectorAll('button')].find(b=>b.textContent==='Try Work Again');assert(retry,'Existing explicit retry remains');retry!.click();await waitFor(()=>host.textContent?.includes('rAw eXpLiCiT Retry Failure')===true,'Explicit retry failure becomes visible');assert(actions===1,'Only the explicit action may retry work');assert(host.textContent?.includes('rAw eXpLiCiT Retry Failure')&&host.textContent?.includes('Work Unconfirmed'),'Independent retry failure keeps diagnostics and work uncertainty');
  const previous={id:'earlier-reply',communicationEventId:'earlier-reply',role:'assistant',communicationIntent:'user_dm',authorAgentId:'recipient',executionId:'run'};
  await render(receipt('delivered'),true,[previous]);await waitFor(()=>host.textContent?.includes('Exact draft run')===true,'A different source reply on the same Run cannot suppress this preview');
  current={...current,canonicalReplyEventId:'exact-reply'};wake();await settle();await render(receipt('delivered'),true,[previous,{...previous,id:'exact-reply',communicationEventId:'exact-reply'}]);assert(!host.textContent?.includes('Exact draft run')&&closed===opened,'Exact canonical publication closes preview');
  current=snapshot('run2');const recovery={...receipt('recovering'),recoveryExecutionId:'run2'};await render(recovery);await waitFor(()=>host.textContent?.includes('Exact draft run2')===true,'Exact recovery Run can preview');
  current={...current,memoryExposure:{...current.memoryExposure,projectGeneration:99}};wake();await settle();assert(!host.textContent?.includes('Exact draft run2'),'Memory generation invalidates content');const before=reads;
  current=snapshot('run2');await render(recovery,false);await render(recovery,true);visibility('hidden');await settle();visibility('visible');await settle();await new Promise(r=>setTimeout(r,550));assert(reads===before&&!host.textContent?.includes('Exact draft run2'),'Presentation changes cannot clear the exact-owner safety latch');
  current=snapshot('run3');const next=receipt('delivered','run3','recipient','new-activation');await render(next);await waitFor(()=>host.textContent?.includes('Exact draft run3')===true,'A genuinely new canonical attempt resets the latch');
  const sameRunRetry={...next,activationId:'retry-activation',injectionId:'current-steer',injectionKind:'steer'};current=snapshot('run3');current.reply.steeringInjectionId='old-steer';await render(sameRunRetry);assert(!host.textContent?.includes('Exact draft run3'),'A new attempt on the same Run rejects the previous injection before observing it');
  current={...current,reply:{...current.reply,streamId:'current-attempt-stream',steeringInjectionId:'current-steer'}};wake();await waitFor(()=>host.textContent?.includes('Exact draft run3')===true,'Exact new injection may resume after stale snapshot rejection');
  current={...current,reply:{...current.reply,fence:2}};wake();await settle();await render(sameRunRetry,false);await render(sameRunRetry,true);assert(!host.textContent?.includes('Exact draft run3'),'Fence invalidation also survives tab changes');
  await render(receipt('processed','run3'),true,[],receipt('run_unconfirmed','other-run','other-agent','other-activation'));const count=reads;await new Promise(r=>setTimeout(r,550));assert(reads===count&&closed===opened,'Consumed history starts no background preview');assert(host.querySelectorAll('[data-delivery-status-badge]').length===2,'Independent recipient statuses remain separate');assert(actions===1,'No automatic work retry occurred');assert(lastSignal?.aborted,'Cleanup aborts the exact preview read');
 }finally{root.unmount();host.remove();client.clear();visibility('visible');delete (document as any).visibilityState;api.getTextReplyStatus=originals.read;api.subscribeAgent=originals.subscribe;api.retryMessageDelivery=originals.retry;}
}

export async function replyPreviewRateLimitRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});const originalFetch=window.fetch,originalSubscribe=api.subscribeAgent;
 let physical=0,mode:'limit'|'ok'='limit',run='rate-run',opens=0,closes=0;const at:number[]=[];api.subscribeAgent=(()=>{opens++;return {close(){closes++;}};}) as any;
 window.fetch=(async(input:any,init:any)=>{assert(String(input).includes('/reply-streams/'),'Only the exact preview read may reach HTTP');assert(!init?.method||init.method==='GET','Reads never retry work');physical++;at.push(Date.now());return mode==='limit'?new Response(JSON.stringify({error:'request rate limit exceeded RAW miXeD'}),{status:429,headers:{'content-type':'application/json','retry-after':'1'}}):new Response(JSON.stringify(snapshot(run)),{headers:{'content-type':'application/json'}});}) as any;
 const render=async(state:string)=>{root.render(<QueryClientProvider client={client}><MessageDeliveryStatus projectId="project" receipts={[receipt(state,run)]} recipientName={()=>'Agent'}/><DirectReplyPreview projectId="project" agentId="recipient" sent={source(receipt(state,run))} messages={[]}/></QueryClientProvider>);await settle();};
 try{
  await render('delivered');await waitFor(()=>physical===1,'Initial HTTP429 arrives');assert(!host.querySelector('[role="alert"]')&&!host.textContent?.includes('request rate limit exceeded'),'Background limiter error is quiet');mode='ok';await waitFor(()=>host.textContent?.includes('Exact draft rate-run')===true,'Read recovers quietly after Retry-After');assert(at[1]!-at[0]!>=900,'Physical reads honor shared cooldown');assert(host.textContent?.includes('Working'),'Read errors never alter the canonical work state');
  await render('run_unconfirmed');run='new-rate-run';mode='limit';await render('delivered');await waitFor(()=>physical>=3,'A new exact preview can read');const before=physical;await new Promise(r=>setTimeout(r,650));await render('run_unconfirmed');await new Promise(r=>setTimeout(r,550));assert(physical===before&&opens===closes,'Eligibility cleanup aborts a read waiting on cooldown and closes subscriptions');assert(host.textContent?.includes('Work Unconfirmed')&&!host.querySelector('[role="alert"]'),'One canonical warning remains, without duplicate accessible alerts');
  run='recovered-run';mode='ok';await render('delivered');await waitFor(()=>host.textContent?.includes('Exact draft recovered-run')===true,'Eligible exact recovery removes obsolete preview failures');assert(!host.textContent?.includes('request rate limit exceeded'),'Raw read warnings never persist after recovery');
 }finally{root.unmount();host.remove();client.clear();window.fetch=originalFetch;api.subscribeAgent=originalSubscribe;}
}


export async function broadcastAndCollaborationPreviewRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});const oldRead=api.getTextReplyStatus,oldSubscribe=api.subscribeAgent;
 const reads:string[]=[],wakes=new Map<string,()=>void>();let fault:unknown,current={...snapshot('broadcast-run','other-agent'),reply:{...snapshot('broadcast-run','other-agent').reply,replyIntent:'broadcast'}};
 api.getTextReplyStatus=async(_chat,_message,agent)=>{reads.push(agent);if(fault)throw fault;return current;};api.subscribeAgent=((id:any,_cursor:any,handlers:any)=>{wakes.set(id,()=>handlers.onStatus?.());return {close(){}};}) as any;
 const r1=receipt('run_unconfirmed'),r2={...receipt('delivered','broadcast-run','other-agent','other-activation'),canRetry:false};const sent={...source(r1),communicationIntent:'broadcast',deliveryReceipts:[r1,r2]};
 const renderBroadcast=async()=>{root.render(<QueryClientProvider client={client}><MessageDeliveryStatus projectId="project" receipts={[r1,r2]} recipientName={id=>id==='recipient'?'First Agent':'miXeD receiver'}/>{[r1,r2].map(r=><DirectReplyPreview key={r.targetAgentId} projectId="project" sent={sent} agentId={r.targetAgentId} agentTitle={r.targetAgentId==='recipient'?'First Agent':'miXeD receiver'} messages={[]}/>)}</QueryClientProvider>);await settle();};
 try{
  await renderBroadcast();await waitFor(()=>host.textContent?.includes('Exact draft broadcast-run')===true,'Eligible broadcast recipient previews');assert(reads.every(id=>id==='other-agent'),'Uncertain broadcast recipient never polls');assert(host.querySelectorAll('[data-delivery-status-badge]').length===2&&host.textContent?.includes('Work Unconfirmed'),'Independent recipient statuses stay separate');
  fault=new ApiRequestError(403,'rAw denied /ExactPath gpt-5.2');wakes.get('other-agent')!();await waitFor(()=>host.textContent?.includes('Access Denied')===true,'Permanent preview failure has compact structured feedback');assert(host.textContent?.includes('miXeD receiver')&&host.textContent?.includes('rAw denied /ExactPath gpt-5.2'),'Recipient names and diagnostics retain casing');assert(!host.querySelector('[role="alert"]'),'Background preview disclosure never adds a duplicate alert');fault=undefined;wakes.get('other-agent')!();await waitFor(()=>host.textContent?.includes('Exact draft broadcast-run')===true,'Preview read recovers');assert(!host.textContent?.includes('Access Denied'),'Obsolete preview failure is removed');
  const peer={...source(receipt('delivered','peer-run','other-agent')),id:'peer-source',communicationEventId:'peer-source',role:'assistant',authorAgentId:'sender',communicationIntent:'collaboration',communicationSender:{kind:'agent',agentId:'sender'},collaborationRecipients:[{id:'other-agent'}]};current={...snapshot('peer-run','other-agent'),messageId:'peer-source',reply:{...snapshot('peer-run','other-agent').reply,messageId:'peer-source',replyIntent:'collaboration',publication:{kind:'message',intent:'collaboration',recipientAgentIds:['wrong-sender']}}};
  const renderPeer=async(messages:any[]=[])=>{root.render(<QueryClientProvider client={client}><DirectReplyPreview projectId="project" agentId="other-agent" agentTitle="miXeD receiver" peerAgentId="other-agent" sent={peer as any} messages={messages}/></QueryClientProvider>);await settle();};
  await renderPeer();assert(!host.textContent?.includes('Exact draft peer-run'),'Wrong collaboration return recipient remains hidden');current={...current,reply:{...current.reply,publication:{kind:'message',intent:'collaboration',recipientAgentIds:['sender']}}};wakes.get('other-agent')!();await waitFor(()=>host.textContent?.includes('Exact draft peer-run')===true,'Exact peer return route previews');
  current={...current,canonicalReplyEventId:'peer-reply'};wakes.get('other-agent')!();await settle();const canonical={id:'peer-reply',communicationEventId:'peer-reply',role:'assistant',communicationIntent:'collaboration',authorAgentId:'other-agent',executionId:'peer-run',collaborationRecipients:[{id:'wrong-sender'}]};await renderPeer([canonical]);assert(host.textContent?.includes('Exact draft peer-run'),'Wrong canonical return recipient cannot consume preview');await renderPeer([{...canonical,collaborationRecipients:[{id:'sender'}]}]);assert(!host.textContent?.includes('Exact draft peer-run'),'Exact canonical peer publication closes preview');
 }finally{root.unmount();host.remove();client.clear();api.getTextReplyStatus=oldRead;api.subscribeAgent=oldSubscribe;}
}


export async function requestLifecyclePreviewOwnerRegression():Promise<void>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});const originalRead=api.getTextReplyStatus,originalSubscribe=api.subscribeAgent;
 let reads=0,opened=0,closed=0;
 api.getTextReplyStatus=async()=>{reads++;return {...snapshot('request-run'),messageId:'request',reply:{...snapshot('request-run').reply,messageId:'request',text:'Exact Request card draft',replyIntent:undefined,publication:{kind:'request_update',requestId:'request',updateKind:'completed'}}};};
 api.subscribeAgent=((_id:any,_cursor:any,_handlers:any)=>{opened++;return {close(){closed++;}};}) as any;
 const key=queryKeys.agentWork.detail('project','chat','request:request');const data=(state:string)=>({requestLifecycle:{request:{id:'request',state,recipientAgentId:'recipient',text:'rAw Request /ExactPath',updatedAt:'2026-11-09T00:00:00Z'},updates:[]}});
 try{
  client.setQueryData(key,data('in_progress'));root.render(<QueryClientProvider client={client}><RequestLifecycleCard projectId="project" conversationId="chat" requestId="request" state="in_progress" recipientAgentId="recipient" updatedAt="2026-11-09T00:00:00Z" agentTitle={()=>'miXeD Request recipient'} defaultExpanded/></QueryClientProvider>);
  await waitFor(()=>host.textContent?.includes('Exact Request card draft')===true,'Expanded production Request card owns its exact preview');assert(host.textContent?.includes('rAw Request /ExactPath'),'Canonical Request text is unchanged');
  const toggle=()=>host.querySelector<HTMLButtonElement>('[aria-controls="request-lifecycle-request"]')!;
  toggle().click();await settle();const before=reads;await new Promise(r=>setTimeout(r,550));assert(reads===before&&opened===closed,'Collapsing Request card stops its preview subscription and timer');
  toggle().click();await waitFor(()=>reads>before,'Reopening eligible Request can read again');client.setQueryData(key,data('completed'));await settle();const terminal=reads;await new Promise(r=>setTimeout(r,550));assert(reads===terminal&&opened===closed&&!host.textContent?.includes('Exact Request card draft'),'Canonical terminal Request hides old preview and closes reads');
 }finally{root.unmount();host.remove();client.clear();api.getTextReplyStatus=originalRead;api.subscribeAgent=originalSubscribe;}
}
