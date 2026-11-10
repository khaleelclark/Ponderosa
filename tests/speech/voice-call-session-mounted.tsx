// Real Call, dictation, and speech-coordinator lifecycle in an offline browser.
// Only browser speech devices and the API boundary are synthetic.
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {ThemeProvider} from '@mui/material/styles';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DEFAULT_SPEECH_PREFERENCES, type AgentEvent} from '@ponderosa/core';
import {api} from '../../apps/web/src/api';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {VoiceConversation} from '../../apps/web/src/components/speech/VoiceConversation';
import {claimPageCapture} from '../../apps/web/src/components/speech/captureCoordinator';
import {createPonderosaTheme} from '../../apps/web/src/theme';

function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until<T>(read:()=>T|undefined,message:string,timeout=8000):Promise<T>{
 const deadline=performance.now()+timeout;
 while(performance.now()<deadline){const value=read();if(value!==undefined)return value;await tick();}
 throw Error(message);
}
const agent={id:'mounted-call-agent',projectId:'mounted-call-project',conversationId:'mounted-call-chat',title:'Synthetic Agent'};
interface RecognitionHarness{onspeechend:(()=>void)|null;abortFailure:boolean;result(words:string):void;interim(words:string):void;end():void;silence():()=>void;network():void;permission():void}
interface UtteranceHarness{text:string;finish():void}

async function fixture(run:(f:{
 recognitions:RecognitionHarness[];utterances:UtteranceHarness[];calls:Array<{conversationId:string;request:Record<string,unknown>}>;
 accepted:()=>void;setAccepted:(value:boolean)=>void;publish:(index:number,text:string)=>void;
 status:(patch:Record<string,unknown>)=>void;receipt:(index:number,patch:Record<string,unknown>)=>void;tracks:Array<{readyState:string}>;recovery:string[];
 emit:(event:AgentEvent)=>boolean;
 button:(name:string)=>Promise<HTMLButtonElement>;client:QueryClient;host:HTMLDivElement;
})=>Promise<void>,steeringOnly=false):Promise<void>{
 const speechWindow=window as unknown as {SpeechRecognition?:typeof Recognition;SpeechSynthesisUtterance?:typeof Utterance};
 const nativeRecognition=speechWindow.SpeechRecognition,nativeUtterance=speechWindow.SpeechSynthesisUtterance;
 const tracks:Array<{readyState:string}>=[],recovery:string[]=[];
 const mediaDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{const track={kind:'audio',readyState:'live',stop(){track.readyState='ended';}};tracks.push(track);return {getAudioTracks:()=>[track],getTracks:()=>[track]};}}});
 const synthesisDescriptor=Object.getOwnPropertyDescriptor(window,'speechSynthesis');
 const recognitions:Recognition[]=[],utterances:Utterance[]=[],calls:Array<{conversationId:string;request:Record<string,unknown>}>=[];
 class Recognition {
  continuous=true;interimResults=false;lang='en-US';maxAlternatives=1;
  onstart:(()=>void)|null=null;onend:(()=>void)|null=null;onspeechend:(()=>void)|null=null;
  onresult:((event:unknown)=>void)|null=null;onerror:((event:unknown)=>void)|null=null;
  stopped=0;aborted=0;abortFailure=false;history:Array<unknown>=[];
  constructor(){recognitions.push(this);}
  start(track:MediaStreamTrack){assert(track?.kind==='audio'&&track.readyState==='live','Call recognition must use its owned live track');queueMicrotask(()=>this.onstart?.());}
  stop(){this.stopped++;}
  abort(){this.aborted++;if(this.abortFailure)throw Error('Synthetic browser abort failure');}
  interim(words:string){this.onresult?.({resultIndex:this.history.length,results:[...this.history,{isFinal:false,0:{transcript:words},length:1}]});}
  result(words:string){const resultIndex=this.history.length;this.history.push({isFinal:true,0:{transcript:words},length:1});const event={resultIndex,results:this.history};this.onresult?.(event);this.onresult?.(event);}
  end(){this.onend?.();}
  silence(){const staleEnd=this.onend,staleResult=this.onresult;this.onerror?.({error:'no-speech'});staleEnd?.();return ()=>{staleResult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:'Stale private words'},length:1}]});staleEnd?.();};}
  network(){const staleEnd=this.onend;this.onerror?.({error:'network'});staleEnd?.();}
  permission(){const staleEnd=this.onend;this.onerror?.({error:'not-allowed'});staleEnd?.();}
 }
 class Utterance {
  text:string;lang='en-US';rate=1;onstart:(()=>void)|null=null;onend:(()=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(text:string){this.text=text;}
  finish(){this.onend?.();}
 }
 let accepted=false;const statusPatch:Record<string,unknown>={};const messages:Array<Record<string,unknown>>=[];
 const subscribers=new Set<Parameters<typeof api.subscribeAgent>[2]>();
 const original={getConversation:api.getConversation,getWorkspacePreferences:api.getWorkspacePreferences,sendMultiAgentDirectMessage:api.sendMultiAgentDirectMessage,getVoiceReplyStatus:api.getVoiceReplyStatus,subscribeAgent:api.subscribeAgent};
 const detail=()=>({conversation:{id:agent.conversationId,projectId:agent.projectId},agents:[agent],messages:messages.map(message=>({...message,deliveryReceipts:(message.deliveryReceipts as unknown[]|undefined)?.map(receipt=>({...receipt}))}))});
 const currentStatus=()=>{const last=calls.length-1,reply=messages.find(message=>message.id==='answer-'+last);return {messageId:'input-'+last,runId:'run-one',runStatus:'running',memoryExposure:{state:'disabled',runId:'run-one'},...(reply?{canonicalReplyEventId:reply.id}:{}),...statusPatch};};
 Object.assign(api,{
  getConversation:async()=>detail(),getWorkspacePreferences:async()=>({speech:DEFAULT_SPEECH_PREFERENCES}),
  sendMultiAgentDirectMessage:async(conversationId:string,request:Record<string,unknown>)=>{
   calls.push({conversationId,request});await until(()=>accepted?true:undefined,'Synthetic accepted POST was not released',20000);
   const index=calls.length-1,id='input-'+index;
   const message={id,communicationEventId:id,conversationId,role:'user',text:request.text,createdAt:new Date().toISOString(),deliveryReceipts:[{targetAgentId:agent.id,state:'started',executionId:'run-one',injectionKind:'steer',providerAcknowledged:true}]};
   messages.push(message);return {messageId:id,message,unavailableRecipients:[]};
  },
  getVoiceReplyStatus:async()=>currentStatus(),subscribeAgent:(_id:string,_seq:unknown,handlers:Parameters<typeof api.subscribeAgent>[2])=>{subscribers.add(handlers);return {close(){subscribers.delete(handlers);}};},
 });
 speechWindow.SpeechRecognition=Recognition;
 speechWindow.SpeechSynthesisUtterance=Utterance;
 Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{paused:false,cancel(){},pause(){},resume(){},speak(utterance:Utterance){utterances.push(utterance);queueMicrotask(()=>utterance.onstart?.());}}});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 client.setQueryData(queryKeys.workspacePreferences.all,{speech:DEFAULT_SPEECH_PREFERENCES});
 const button=(name:string)=>until(()=>document.querySelector<HTMLButtonElement>(`[data-ponderosa-call] button[aria-label="${name}"]`)??undefined,'Missing '+name+' call button');
 const publish=(index:number,text:string)=>{
  const sent=messages.find(message=>message.id==='input-'+index);assert(sent,'Cannot publish before acceptance');
  (sent.deliveryReceipts as Array<Record<string,unknown>>)[0]!.state='processed';
  messages.push({id:'answer-'+index,communicationEventId:'answer-'+index,conversationId:agent.conversationId,role:'assistant',communicationIntent:'user_dm',authorAgentId:agent.id,executionId:'run-one',text,createdAt:new Date().toISOString()});
  void client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(agent.conversationId)});
 };
 try{
  root.render(<StrictMode><ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><VoiceConversation {...agent} steeringOnly={steeringOnly} agents={[agent as never]} selectedAgentId={agent.id} lockAgent open startOnOpen onOpenRecovery={id=>recovery.push(id)} onClose={()=>root.render(null)}/></QueryClientProvider></ThemeProvider></StrictMode>);
  await until(()=>recognitions.length===1?true:undefined,'Opening Call did not start one real dictation cycle');
  await run({recognitions,utterances,calls,tracks,recovery,status:patch=>{Object.assign(statusPatch,patch);for(const handlers of subscribers)handlers.onOpen?.();},receipt:(index,patch)=>{const message=messages.find(m=>m.id==='input-'+index);assert(message,'Receipt requires accepted message');Object.assign((message.deliveryReceipts as Array<Record<string,unknown>>)[0]!,patch);void client.invalidateQueries({queryKey:queryKeys.conversations.detailPrefix(agent.conversationId)});},accepted:()=>{accepted=true;},setAccepted:value=>{accepted=value;},publish,button,client,host,
   emit:event=>{for(const handlers of subscribers)handlers.onEvent?.({agentId:agent.id,seq:1,ts:new Date().toISOString(),event});return subscribers.size>0;}});
 }catch(error){throw new Error(String(error)+' '+JSON.stringify({recognitions:recognitions.map(r=>({stopped:r.stopped,aborted:r.aborted})),calls:calls.length,utterances:utterances.map(u=>u.text),surface:document.querySelector('[data-ponderosa-call]')?.textContent}),{cause:error});}finally{
  root.unmount();client.clear();host.remove();Object.assign(api,original);
  if(mediaDescriptor)Object.defineProperty(navigator,'mediaDevices',mediaDescriptor);else delete (navigator as unknown as {mediaDevices?:unknown}).mediaDevices;
  if(nativeRecognition)speechWindow.SpeechRecognition=nativeRecognition;else delete speechWindow.SpeechRecognition;
  if(nativeUtterance)speechWindow.SpeechSynthesisUtterance=nativeUtterance;else delete speechWindow.SpeechSynthesisUtterance;
  if(synthesisDescriptor)Object.defineProperty(window,'speechSynthesis',synthesisDescriptor);else delete (window as unknown as {speechSynthesis?:unknown}).speechSynthesis;
 }
}

export async function voiceCallMountedSessionRegression():Promise<void>{
 await fixture(async f=>{
  const late=f.recognitions[0]!.silence();
  await until(()=>f.recognitions.length===2?true:undefined,'A clean no-speech cycle dropped the open call');
  late();await tick();assert(f.calls.length===0,'Late no-speech callbacks submitted an old or empty turn');
  const first=f.recognitions[1]!;first.result('First synthetic request');first.onspeechend?.();first.end();
  await until(()=>f.calls.length===1?true:undefined,'First final utterance did not submit');
  assert(f.calls[0]!.conversationId===agent.conversationId,'Call changed conversation');
  assert(f.calls[0]!.request.text==='First synthetic request'&&f.calls[0]!.request.activeRunDelivery==='steer'&&f.calls[0]!.request.voiceReply===true,'Call omitted its exact speech turn or steering contract');
  await tick();assert(f.calls.length===1&&f.utterances.length===0,'A duplicate final or pending POST played or submitted early');
  first.result('First synthetic request');first.end();await tick();assert(f.calls.length===1,'Repeated final history resubmitted a turn');
  f.accepted();
  await until(()=>f.utterances.length===1?true:undefined,'Accepted POST did not produce one short receipt');
  assert(f.utterances[0]!.text==='Got your message.','Receipt speech did not match the brief accepted-turn confirmation');
  f.utterances[0]!.finish();await tick();assert(f.utterances.length===1,'Receipt replayed before canonical answer');
  f.publish(0,'First canonical answer.');
  await until(()=>f.utterances.some(item=>item.text==='First canonical answer.')?true:undefined,'Exact canonical answer did not reach speech coordinator');
  f.utterances.find(item=>item.text==='First canonical answer.')!.finish();
  await until(()=>f.recognitions.length===3?true:undefined,'After answer, open call did not resume capture');
  const second=f.recognitions[2]!;second.result('Second synthetic request');second.onspeechend?.();second.end();
  await until(()=>f.calls.length===2?true:undefined,'Second utterance did not submit');
  assert(f.calls[1]!.conversationId===agent.conversationId&&f.calls[1]!.request.idempotencyKey!==f.calls[0]!.request.idempotencyKey,'Second call turn lost conversation or reused submission identity');
  f.publish(1,'Second canonical answer.');
  await until(()=>f.utterances.filter(item=>item.text==='Got your message.').length===2?true:undefined,'Second accepted turn did not get its own receipt');
  f.utterances.filter(item=>item.text==='Got your message.')[1]!.finish();
  await until(()=>f.utterances.some(item=>item.text==='Second canonical answer.')?true:undefined,'Second canonical answer did not play');
  for(const item of f.utterances.slice(2))item.finish();
  await until(()=>f.recognitions.length===4?true:undefined,'Second answer did not return to capture');
  (await f.button('Mute Microphone')).click();await f.button('Unmute Microphone');
  const count=f.recognitions.length;await new Promise(resolve=>setTimeout(resolve,350));assert(f.recognitions.length===count,'Muted call restarted microphone');
  (await f.button('End Call')).click();await until(()=>!document.querySelector('[data-ponderosa-call]')?true:undefined,'End did not close Call');
  assert(f.calls.length===2,'Mute or End submitted extra speech');
 });
}

export async function voiceCallNaturalInterruptionRegression():Promise<void>{
 await fixture(async f=>{
  const finish=(recognition:RecognitionHarness,words:string)=>{recognition.interim(words);recognition.result(words);recognition.onspeechend?.();recognition.end();};
  finish(f.recognitions[0]!,'Keep my opening words.');
  await until(()=>f.calls.length===1&&f.recognitions.length===2?true:undefined,'Call must keep listening while POST is pending');
  finish(f.recognitions[1]!,'Steer while the first response is pending.');
  await until(()=>f.recognitions.length===3?true:undefined,'Call did not preserve listening after a second complete utterance');
  assert(f.calls.length===1,'Unsettled immutable submission must remain single flight');
  f.accepted();
  await until(()=>f.calls.length===2?true:undefined,'Completed second utterance was lost during first HTTP settlement');
  assert(f.calls[0]!.request.text==='Keep my opening words.'&&f.calls[1]!.request.text==='Steer while the first response is pending.','HTTP settlement erased or combined separate utterances');
  assert(f.calls[0]!.request.idempotencyKey!==f.calls[1]!.request.idempotencyKey,'Separate finished utterances need separate identities');
  await until(()=>f.utterances.some(u=>u.text==='Got your message.')?true:undefined,'Accepted voice receipt did not play');
  const active=f.recognitions.at(-1)!;
  active.interim('Got your message.');active.result('Got your message.');active.onspeechend?.();
  await tick();assert(f.calls.length===2,'Own receipt audio created a self-reply');
  for(const utterance of f.utterances)utterance.finish();
  f.publish(1,'Yes, here is the answer.');
  await until(()=>f.utterances.some(u=>u.text==='Yes, here is the answer.')?true:undefined,'Canonical answer did not play');
  assert(document.querySelector('[data-ponderosa-call] [role="status"]')?.textContent==='Speaking to You','Answer playback needs its own truthful status');
  const answer=f.utterances.find(u=>u.text==='Yes, here is the answer.')!;
  active.interim('Actually keep this beginning');
  active.result('Actually keep this beginning and change direction.');active.onspeechend?.();active.end();
  await until(()=>f.calls.length===3?true:undefined,'Natural speech did not interrupt and steer during audio');
  assert(f.calls[2]!.request.text==='Actually keep this beginning and change direction.','Barge-in dropped opening words or duplicated final history');
  assert(f.calls[2]!.request.activeRunDelivery==='steer','Natural follow-up bypassed existing steering');
  answer.finish();await tick();assert(f.calls.length===3,'Late prior playback callback resent speech');
  assert(!Array.from(document.querySelectorAll('[data-ponderosa-call] button')).some(b=>/Talk Now/i.test(b.textContent??'')),'Obsolete Talk Now control remains');
  (await f.button('End Call')).click();
  assert(f.tracks.every(t=>t.readyState==='ended'),'End left an admitted microphone live');
 });
}

export async function voiceCallQuietDeliveryRegression():Promise<void>{
 await fixture(async f=>{
  f.accepted();const recognition=f.recognitions[0]!;
  recognition.result('Synthetic quiet transition.');recognition.onspeechend?.();recognition.end();
  await until(()=>f.utterances.length===1?true:undefined,'Receipt did not play');
  await until(()=>document.querySelector('[data-ponderosa-call] [role="status"]')?.textContent==='Message Received'?true:undefined,'Receipt falsely claimed an Agent answer');
  f.receipt(0,{state:'queued',steeringWaitReason:'context_refresh'});
  await tick();f.utterances[0]!.finish();
  await until(()=>document.querySelector('[data-ponderosa-call] [role="status"]')?.textContent==='Waiting for a Reply'?true:undefined,'Context preparation must use one compact factual status');
  assert(!document.querySelector('[data-ponderosa-call] [role="alert"]'),'Routine context preparation raised an Alert');
  const reply={projectId:agent.projectId,conversationId:agent.conversationId,agentId:agent.id,messageId:'input-0',runId:'run-one',fence:1,streamId:'stream',itemId:'answer-item',providerTurnId:'provider-turn',sequence:1,text:'An incomplete answer. ',state:'streaming' as const};
  assert(f.emit({type:'voice_reply',reply}),'Stream was not attached');
  await until(()=>f.utterances.some(u=>u.text==='An incomplete answer.')?true:undefined,'Streamed answer did not play');
  assert(document.querySelector('[data-ponderosa-call] [role="status"]')?.textContent==='Speaking to You','Stale waiting status survived streamed audio');
  f.receipt(0,{contextRecoveryRequired:true,state:'waiting_for_run'});
  await until(()=>Array.from(document.querySelectorAll('[data-ponderosa-call] button')).find(b=>b.textContent==='Review Recovery in Chat')??undefined,'Partial streamed output hid the canonical recovery action');
  assert(!document.querySelector('[data-ponderosa-call]')?.textContent?.includes('Refreshing the connection'),'Internal transition was mislabeled a connection refresh');
  assert(f.tracks.every(t=>t.readyState==='ended'),'Recovery blocker left microphone capture live');
  const recovery=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ponderosa-call] button')).find(b=>b.textContent==='Review Recovery in Chat')!;
  recovery.click();await tick();assert(f.recovery[0]===agent.id,'Recovery did not open the exact Agent Chat');
  assert(f.calls.length===1,'Recovery navigation resent the accepted message');
 });
}

export async function voiceCallEchoOwnershipRegression():Promise<void>{
 await fixture(async f=>{
  f.accepted();const first=f.recognitions[0]!;first.result('Synthetic echo boundary.');first.onspeechend?.();first.end();
  await until(()=>f.utterances.length===1&&f.recognitions.length===2?true:undefined,'Call did not admit concurrent owned input and audio');
  f.utterances[0]!.finish();
  const reply={projectId:agent.projectId,conversationId:agent.conversationId,agentId:agent.id,messageId:'input-0',runId:'run-one',fence:1,streamId:'stream',itemId:'answer-item',providerTurnId:'provider-turn',sequence:1,text:'Yes, here is the answer. ',state:'streaming' as const};
  assert(f.emit({type:'voice_reply',reply}),'Reply stream missing');
  await until(()=>f.utterances.length===2?true:undefined,'Streaming phrase did not start');
  f.utterances[1]!.finish();
  const active=f.recognitions.at(-1)!;active.result('Yes, here is the answer.');active.onspeechend?.();await tick();
  assert(f.calls.length===1,'Delayed own phrase in an unfinished queue created a self-reply');
  await new Promise(resolve=>setTimeout(resolve,550));
  active.result('Yes');active.onspeechend?.();active.end();
  await until(()=>f.calls.length===2?true:undefined,'Expired echo history swallowed a later genuine short answer');
  assert(f.calls[1]!.request.text==='Yes','Echo filter damaged the real short answer');
  const release=claimPageCapture(()=>{});
  await f.button('Reconnect Call');
  assert(f.tracks.every(t=>t.readyState==='ended'),'Competing ordinary capture did not revoke the duplex call');
  const before=f.calls.length;active.result('Late revoked input');active.end();await tick();assert(f.calls.length===before,'Revoked call callback sent work');
  release();(await f.button('End Call')).click();
 });
}

export async function voiceCallUnknownRecoveryRegression():Promise<void>{
 await fixture(async f=>{
  f.accepted();const first=f.recognitions[0]!;first.result('Synthetic unknown reply.');first.onspeechend?.();first.end();
  await until(()=>f.utterances.length===1?true:undefined,'Receipt missing');f.utterances[0]!.finish();
  f.emit({type:'voice_reply',reply:{projectId:agent.projectId,conversationId:agent.conversationId,agentId:agent.id,messageId:'input-0',runId:'run-one',fence:1,streamId:'stream',itemId:'answer-item',providerTurnId:'provider-turn',sequence:1,text:'Partial answer. ',state:'streaming'}});
  await until(()=>f.utterances.length===2?true:undefined,'Partial answer missing');
  f.status({runStatus:'outcome_unknown'});
  await f.button('Reconnect Call');
  f.receipt(0,{state:'run_unconfirmed',contextRecoveryRequired:true});await tick();
  const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ponderosa-call] button')).filter(b=>b.textContent==='Review Recovery in Chat');
  assert(buttons.length===1,'Unknown outcome lost or duplicated recovery navigation after a late receipt');
  assert(f.tracks.every(t=>t.readyState==='ended'),'Unknown outcome left microphone active');
  buttons[0]!.click();await tick();assert(f.recovery[0]===agent.id&&f.calls.length===1,'Recovery navigation replayed accepted work or opened a foreign Agent');
 });
}

export async function voiceCallDeliberateReplayRegression():Promise<void>{
 await fixture(async f=>{
  f.accepted();const first=f.recognitions[0]!;first.result('Synthetic deliberate replay.');first.onspeechend?.();first.end();
  await until(()=>f.utterances.length===1&&f.recognitions.length===2?true:undefined,'Concurrent input and receipt missing');f.utterances[0]!.finish();
  f.emit({type:'voice_reply',reply:{projectId:agent.projectId,conversationId:agent.conversationId,agentId:agent.id,messageId:'input-0',runId:'run-one',fence:1,streamId:'stream',itemId:'answer-item',providerTurnId:'provider-turn',sequence:1,text:'An answer to replay. ',state:'streaming'}});
  await until(()=>f.utterances.length===2?true:undefined,'Answer playback missing');
  f.recognitions.at(-1)!.interim('Interrupt without submitting');
  (await f.button('Mute Microphone')).click();f.publish(0,'An answer to replay.');
  (await f.button('Transcript')).click();
  const play=await until(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ponderosa-call] button')).find(b=>b.textContent==='Play Reply')??undefined,'Canonical answer must remain available after local interruption');
  play.click();await until(()=>f.utterances.length===3?true:undefined,'Deliberate replay did not speak');
  await until(()=>document.querySelector('[data-ponderosa-call] [role="status"]')?.textContent==='Speaking to You'?true:undefined,'Suppressed automatic audio hid the deliberate replay status');
  assert(f.calls.length===1,'Manual playback repeated accepted work');(await f.button('End Call')).click();
 });
}

export async function voiceCallMountedFatalRegression():Promise<void>{
 await fixture(async f=>{
  f.recognitions[0]!.permission();
  await f.button('Reconnect Call');
  await new Promise(resolve=>setTimeout(resolve,700));
  assert(f.recognitions.length===1&&f.calls.length===0,'Permission denial silently restarted capture or sent work');
  (await f.button('Reconnect Call')).click();
  await until(()=>f.recognitions.length===2?true:undefined,'Explicit reconnect did not resume capture in same Call');
  assert(f.calls.length===0,'Reconnect replayed an unaccepted turn');
  f.recognitions[1]!.result('Discard this interrupted private phrase');
  window.dispatchEvent(new Event('pagehide'));
  await f.button('Reconnect Call');
  const count=f.recognitions.length;await new Promise(resolve=>setTimeout(resolve,700));
  assert(f.recognitions.length===count&&f.calls.length===0,'Backgrounded Call silently restarted or sent');
  (await f.button('Transcript')).click();
  await until(()=>document.querySelector<HTMLTextAreaElement>('[data-ponderosa-call] textarea')??undefined,'Transcript editor did not open');
  assert(!document.querySelector<HTMLTextAreaElement>('[data-ponderosa-call] textarea')?.value.includes('Discard this interrupted private phrase'),'Interrupted words remained in the draft despite the discard notice');
  (await f.button('Reconnect Call')).click();
  await until(()=>f.recognitions.length===count+1?true:undefined,'Reconnect after pagehide did not safely resume listening');
  assert(f.calls.length===0,'Reconnect sent discarded words');
  (await f.button('End Call')).click();
 });
}

export async function voiceCallContextAttributionRegression():Promise<void>{
 for(const hint of ['context_changed','memory_changed'] as const)await fixture(async f=>{
  f.accepted();
  const recognition=f.recognitions[0]!;recognition.result('Synthetic context check');recognition.onspeechend?.();recognition.end();
  await until(()=>f.calls.length===1?true:undefined,'Call input was not accepted');
  const reply={projectId:agent.projectId,conversationId:agent.conversationId,agentId:agent.id,messageId:'input-0',runId:'run-one',streamId:'stream',sequence:1,text:'',state:'open' as const,acceptedAt:new Date().toISOString()};
  await until(()=>f.emit({type:'voice_reply',reply})?true:undefined,'Call stream was not attached');
  if(hint==='context_changed')f.emit({type:'voice_reply',reply:{...reply,state:'failed',failureReason:'context_changed'}});
  else f.emit({type:'memory_changed',projectId:agent.projectId,conversationId:agent.conversationId,runId:'run-one',scope:'chat'});
  await until(()=>document.querySelector('[data-ponderosa-call]')?.textContent?.includes('The reply context changed. Check Chat before continuing.')?true:undefined,'Context invalidation must report the actual breadth of its signal');
  assert(!document.querySelector('[data-ponderosa-call]')?.textContent?.includes('Memory changed during this reply'),'General authority invalidation falsely blamed a memory mutation');
  (await f.button('Reconnect Call')).click();
  await until(()=>f.recognitions.length===2?true:undefined,'Explicit reconnect did not resume capture');
  assert(f.calls.length===1,'Reconnect replayed the interrupted turn');
  (await f.button('End Call')).click();
 });
}

export async function voiceCallMountedProlongedSilenceRegression():Promise<void>{
 await fixture(async f=>{
  // Repeated quiet cycles must never grow into a multi-second deaf interval.
  for(let cycle=0;cycle<7;cycle++){
   const started=performance.now();
   if(cycle%2===0)f.recognitions[cycle]!.silence();
   else f.recognitions[cycle]!.end();
   await new Promise(resolve=>setTimeout(resolve,160));
   assert(f.recognitions.length===cycle+1,'Quiet browser endings restarted capture too rapidly');
   await until(()=>f.recognitions.length===cycle+2?true:undefined,'Quiet Call stopped listening or entered a long cooldown',1300);
   const delay=performance.now()-started;
   assert(delay<1300,'Quiet Call left a long microphone gap: '+Math.round(delay)+'ms');
   assert(f.calls.length===0,'Quiet Call sent an empty turn');
  }
  (await f.button('End Call')).click();
  const count=f.recognitions.length;
  await new Promise(resolve=>setTimeout(resolve,850));
  assert(f.recognitions.length===count,'End allowed a delayed quiet-cycle restart');
 });
}

export async function voiceCallMountedBackoffRegression():Promise<void>{
 await fixture(async f=>{
  for(let cycle=0;cycle<4;cycle++){
   const started=performance.now();
   f.recognitions[cycle]!.network();
   await new Promise(resolve=>setTimeout(resolve,150));
   assert(f.recognitions.length===cycle+1,'Network retry spun without a cooldown');
   if(cycle<3){
    await until(()=>f.recognitions.length===cycle+2?true:undefined,'Recoverable network error lost the open Call',7500);
    assert(performance.now()-started>=[550,1150,2600][cycle]!,'Network retry did not back off after repeated failures');
   }
  }
  await f.button('Reconnect Call');
  assert(f.calls.length===0,'Repeated browser network errors submitted work');
  (await f.button('Reconnect Call')).click();
  await until(()=>f.recognitions.length===5?true:undefined,'Explicit reconnect did not reset the network retry budget');
  f.recognitions[4]!.end();
  (await f.button('Mute Microphone')).click();
  await new Promise(resolve=>setTimeout(resolve,950));
  assert(f.recognitions.length===5,'Mute failed to cancel the natural-end cooldown');
  (await f.button('End Call')).click();
  await new Promise(resolve=>setTimeout(resolve,950));
  assert(f.recognitions.length===5&&f.calls.length===0,'End allowed a delayed microphone restart or empty POST');
 });
}

export async function voiceCallMountedPartialErrorRegression():Promise<void>{
 await fixture(async f=>{
  f.recognitions[0]!.result('Keep this partial utterance for review');
  f.recognitions[0]!.network();
  (await f.button('Transcript')).click();
  await until(()=>document.querySelector<HTMLTextAreaElement>('[data-ponderosa-call] textarea')?.value.includes('Keep this partial utterance for review')?true:undefined,'Finalized partial words were lost after a network error');
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert(f.calls.length===0&&f.recognitions.length===1,'Partial error silently submitted or restarted capture');
  assert(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ponderosa-call] button')).some(button=>button.textContent?.trim()==='Send'&&!button.disabled),'Partial words did not remain reviewable');
  (await f.button('End Call')).click();
 });
}

export async function voiceCallMountedAbortFailureRegression():Promise<void>{
 await fixture(async f=>{
  f.recognitions[0]!.abortFailure=true;f.recognitions[0]!.network();
  await f.button('Reconnect Call');
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert(f.recognitions.length===1&&f.calls.length===0,'Unconfirmed browser abort silently restarted capture');
  (await f.button('End Call')).click();
 });
}

export async function voiceCallMountedMutedReceiptRegression():Promise<void>{
 await fixture(async f=>{
  const recognition=f.recognitions[0]!;recognition.result('Muted synthetic request');recognition.onspeechend?.();recognition.end();
  await until(()=>f.calls.length===1?true:undefined,'Muted-receipt turn did not reach pending POST');
  (await f.button('Mute Microphone')).click();f.accepted();
  await until(()=>document.querySelector('[data-ponderosa-call]')?.textContent?.includes('Waiting for a Reply')?true:undefined,'Accepted muted turn did not await its reply');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert(f.utterances.length===0,'Muted accepted turn spoke an unwanted receipt');
  (await f.button('End Call')).click();
 });
}

export async function voiceCallMountedLateAcceptanceRegression():Promise<void>{
 await fixture(async f=>{
  const first=f.recognitions[0]!;first.result('First request awaiting acceptance');first.onspeechend?.();first.end();
  await until(()=>f.calls.length===1?true:undefined,'First request never reached its pending POST');
  await until(()=>f.recognitions.length===2?true:undefined,'Pending POST must retain a listening call');
  const beforeInterrupt=f.recognitions.length;
  window.dispatchEvent(new Event('pagehide'));
  (await f.button('Reconnect Call')).click();
  const heldStart=await f.button('Start Call');
  assert(heldStart.disabled&&f.recognitions.length===beforeInterrupt&&f.calls.length===1,'Reconnect replayed or replaced an unconfirmed pending turn');
  f.accepted();
  await new Promise(resolve=>setTimeout(resolve,150));
  assert(f.utterances.length===0&&f.recognitions.length===beforeInterrupt,'Late acceptance replayed speech or capture after interruption');
  await until(()=>!heldStart.disabled?true:undefined,'Exact late acceptance did not retire its pending Call identity');
  heldStart.click();
  await until(()=>f.recognitions.length===beforeInterrupt+1?true:undefined,'Late acceptance kept the Call from reconnecting');
  const second=f.recognitions.at(-1)!;second.result('Fresh request after reconnect');second.onspeechend?.();second.end();
  await until(()=>f.calls.length===2?true:undefined,'Reconnect could not send a fresh turn after exact late acceptance');
  assert(f.calls[0]!.conversationId===f.calls[1]!.conversationId&&f.calls[0]!.request.idempotencyKey!==f.calls[1]!.request.idempotencyKey,'Reconnect reused the interrupted submission identity or changed conversation');
  (await f.button('End Call')).click();
 });
}


export async function voiceCallMountedAssistantSteeringRegression():Promise<void>{
 await fixture(async f=>{
  const markers=()=>Object.keys(sessionStorage).filter(key=>key.startsWith('ponderosa.voice.pending.v1:')).sort().map(key=>[key,sessionStorage.getItem(key)]);
  const before=JSON.stringify(markers()),recognition=f.recognitions[0]!;
  recognition.result('/goal-resume');recognition.onspeechend?.();recognition.end();
  await until(()=>document.querySelector('[data-ponderosa-call]')?.textContent?.includes('requires a new Run')?true:undefined,'Assistant voice native command was not held');
  assert(f.calls.length===0&&JSON.stringify(markers())===before,'Native voice work must not retain a delivery marker or reach HTTP');
  (await f.button('Transcript')).click();
  const editor=await until(()=>document.querySelector<HTMLTextAreaElement>('[data-ponderosa-call] textarea')??undefined,'Held voice transcript remains reviewable');
  assert(editor.value==='/goal-resume'&&!editor.disabled,'Rejected native voice words remain editable');
  const setValue=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;
  setValue.call(editor,'An ordinary Assistant voice follow-up');editor.dispatchEvent(new Event('input',{bubbles:true}));await tick();
  const send=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ponderosa-call] button')).find(button=>button.textContent?.trim()==='Send');assert(send&&!send.disabled,'Edited voice follow-up can be deliberately sent');
  f.accepted();send.click();await until(()=>f.calls.length===1?true:undefined,'Ordinary Assistant voice follow-up did not use shared Send');
  assert(f.calls[0]!.request.text==='An ordinary Assistant voice follow-up'&&f.calls[0]!.request.activeRunDelivery==='steer','Assistant voice keeps exact words and existing steering path');
  (await f.button('End Call')).click();
 },true);
}
