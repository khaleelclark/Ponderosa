// Controlled component lifecycle regression; no provider or message Send is invoked.
import {StrictMode} from 'react';
import {ThemeProvider} from '@mui/material/styles';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ConversationChromeContext} from '../../apps/web/src/components/ConversationChromeContext';
import {createPonderosaTheme} from '../../apps/web/src/theme';
import {api} from '../../apps/web/src/api';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {DEFAULT_SPEECH_PREFERENCES} from '@ponderosa/core';
import {createRoot} from 'react-dom/client';
import {VoiceMessageRecorder} from '../../apps/web/src/components/speech/VoiceMessageRecorder';
import {DictationControls} from '../../apps/web/src/components/speech/DictationControls';

const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until<T>(read:()=>T|undefined,message:string):Promise<T>{
 const deadline=performance.now()+5000;
 while(performance.now()<deadline){const value=read();if(value!==undefined)return value;await tick();}
 throw new Error(message);
}
export async function voiceMessageRecordingRegression():Promise<void> {
 const speechWindow=window as unknown as {SpeechRecognition?:new()=>unknown};
 const nativeRecognition=speechWindow.SpeechRecognition,nativeRecorder=window.MediaRecorder,devicesDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
 const recognitionInstances:Recognition[]=[];
 class Recognition {constructor(){recognitionInstances.push(this);}continuous=true;interimResults=false;lang='en-US';maxAlternatives=1;onstart?:()=>void;onresult?:(event:unknown)=>void;onend?:()=>void;onerror?:()=>void;start(){queueMicrotask(()=>this.onstart?.());}stop(){queueMicrotask(()=>{this.onresult?.({results:[{isFinal:true,0:{transcript:'Controlled recorded speech'},length:1}]});this.onend?.();});}abort(){} }
 speechWindow.SpeechRecognition=Recognition;
 const host=document.createElement('div'),recordingSlot=document.createElement('div'),nextEditor=document.createElement('input');nextEditor.value='Keep this newer editor interaction';document.body.append(host,recordingSlot,nextEditor);const root=createRoot(host);
 let stopped=0,closed=0,attached:File|undefined,attachedTranscript:string|undefined,refuse=true,permissionCalls=0,attachmentCalls=0;const insertedTranscripts:string[]=[];
 let permission:((stream:MediaStream)=>void)|undefined,rejectPermission:((reason:Error)=>void)|undefined;
 let currentRecorder:{onerror?:()=>void}|undefined;
 const stream={getTracks:()=>[{stop:()=>stopped++}],getAudioTracks:()=>[{readyState:'live'}]} as unknown as MediaStream;
 class Recorder {
  static isTypeSupported=(mime:string)=>mime==='audio/webm;codecs=opus';
  state='inactive';mimeType='audio/webm;codecs=opus';
  ondataavailable?: (event:{data:Blob})=>void;onstop?:()=>void;onerror?:()=>void;
  constructor(){currentRecorder=this;}
  start(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['recorded voice'],{type:'audio/webm'})});this.onstop?.();});}
 }
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>{permissionCalls++;return new Promise<MediaStream>((resolve,reject)=>{permission=resolve;rejectPermission=reject;});}}});
 window.MediaRecorder=Recorder as unknown as typeof MediaRecorder;
 const button=(text:string)=>until(
  ()=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text),
  'Missing '+text+' button',
 );
 const mount=(maxBytes=1024)=>{permission=undefined;rejectPermission=undefined;root.render(<StrictMode><VoiceMessageRecorder maxBytes={maxBytes} onClose={()=>{closed++;root.render(null);}} onAttach={(file,transcript)=>{attachmentCalls++;if(refuse)return 'Draft is full';attached=file;attachedTranscript=transcript;return undefined;}}/></StrictMode>);};
 const recordingSurface=()=>host.querySelector('[role="region"][aria-labelledby]')??recordingSlot.querySelector('[role="region"][aria-labelledby]');
 const closedRecorder=()=>until(()=>!recordingSurface()?true:undefined,'Inline recorder did not unmount');
 try{
  mount();
  const firstPermission=await until(()=>permission,'Opening recording did not request microphone permission');assert(document.activeElement===recordingSurface(),'Opening inline capture must focus its named surface while permission is pending');firstPermission(stream);
  assert(permissionCalls===1,'StrictMode discarded mount must not request duplicate microphone permission');
  const firstFinish=await button('Finish Recording');await until(()=>document.activeElement===firstFinish?true:undefined,'Keyboard focus did not advance to Finish');
  assert(recordingSurface()?.querySelector('[role="status"]')?.getAttribute('aria-atomic')==='false'&&recordingSurface()?.querySelector('[aria-live="off"]'),'Elapsed timer must not be live-announced every second');
  firstFinish.click();
  await until(()=>stopped>0?true:undefined,'Finishing did not release microphone tracks');
  await until(()=>document.body.textContent?.includes('Draft is full')?true:undefined,'Finish staging refusal was not shown');
  assert(!closed&&!attached&&attachmentCalls===1,'rejected Finish must retain review and never send');
  assert((await button('Record Again'))!==undefined,'Refused audio must remain re-recordable');
  refuse=false;(await button('Use Recording')).click();
  await until(()=>closed===1&&attached?true:undefined,'Accepted staging did not close');
  assert(attached?.type==='audio/webm'&&attached.name.endsWith('.webm'),'staged audio retains the actual container');assert(attachedTranscript==='Controlled recorded speech','recognized words must accompany the admitted audio');
  await closedRecorder();

  const priorAttachmentCalls=attachmentCalls;mount();
  const latePermission=await until(()=>permission,'Second microphone permission was not requested');
  (await button('Discard')).click();await closedRecorder();
  const prior=stopped;latePermission(stream);
  await until(()=>stopped>prior?true:undefined,'Late permission after discard did not stop tracks');
  assert(attachmentCalls===priorAttachmentCalls,'Discarded permission must not stage audio');

  mount();(await until(()=>rejectPermission,'Permission rejection was not controllable'))(new Error('Microphone permission denied for this test'));
  await until(()=>document.body.textContent?.includes('Microphone permission denied for this test')?true:undefined,'Permission failure was not visible');
  (await button('Record')).click();
  (await until(()=>permission,'Explicit permission retry was not requested'))(stream);
  await button('Finish Recording');currentRecorder?.onerror?.();
  await until(()=>document.body.textContent?.includes('Microphone recording failed. Review any captured audio.')?true:undefined,'Capture failure was not visible');
  await button('Use Recording');
  assert(attachmentCalls===priorAttachmentCalls,'Capture failure must retain partial review instead of automatically staging');
  (await button('Use Recording')).click();await closedRecorder();

  const beforeLimit=attachmentCalls;mount(4);
  (await until(()=>permission,'Limited recording did not request permission'))(stream);
  (await button('Finish Recording')).click();
  await until(()=>document.body.textContent?.includes('Recording exceeds the attachment size limit. Record a shorter message.')?true:undefined,'Oversized capture did not explain recovery');
  assert(attachmentCalls===beforeLimit,'Oversized audio must never enter the draft');
  (await button('Discard')).click();await closedRecorder();

  mount();(await until(()=>permission,'Active-discard recording did not request permission'))(stream);
  await button('Finish Recording');const beforeDiscard=stopped;
  (await button('Discard')).click();await closedRecorder();
  await until(()=>stopped>beforeDiscard?true:undefined,'Active discard did not stop microphone tracks');
  assert(attachmentCalls===beforeLimit,'Active discard must not stage final recording callbacks');

  // Exercise the real toolbar owner fence, not a manually keyed recorder surrogate.
  let owner='first',captureBlocked=false,refuseOwnedDraft=true,inlineVoiceOptions=false;
  const renderOwner=()=>root.render(<StrictMode><DictationControls disabled={false} inlineVoiceOptions={inlineVoiceOptions} recordingContainer={recordingSlot} onActiveChange={value=>{captureBlocked=value;}}
   voiceContext={{projectId:'owned-project',conversationId:'owned-chat',selectedAgentId:owner,agents:[],lockAgent:true}}
   onFinalTranscript={words=>insertedTranscripts.push(words)} onSettlingChange={()=>{}}
   onVoiceAttachment={file=>{if(refuseOwnedDraft)return 'Owned draft busy';attachmentCalls++;attached=file;return undefined;}}/></StrictMode>);
  const recordButton=()=>until(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Record Voice Message"]')??undefined,'Direct recording action missing');
  permission=undefined;renderOwner();(await recordButton()).click();assert(captureBlocked,'pending permission must synchronously gate submission');
  const oldOwnerPermission=await until(()=>permission,'Owned recording did not request permission');
  const beforeOwnerChange=stopped,stagedBeforeOwnerChange=attachmentCalls;
  owner='second';renderOwner();await closedRecorder();oldOwnerPermission(stream);
  await until(()=>stopped>beforeOwnerChange?true:undefined,'Old-owner late permission did not stop tracks');
  assert(attachmentCalls===stagedBeforeOwnerChange,'Late old-owner permission must never stage into the new owner');
  owner='first';renderOwner();await tick();assert(!recordingSurface(),'Returning to old owner must not reopen recording');
  permission=undefined;(await recordButton()).click();
  (await until(()=>permission,'Active owned recording did not request permission'))(stream);
  await button('Finish Recording');const activeOwnerStopped=stopped,lateOldOwnerResult=recognitionInstances.at(-1)?.onresult,transcriptsBeforeOwnerChange=insertedTranscripts.length;
  owner='third';renderOwner();await closedRecorder();
  await until(()=>stopped>activeOwnerStopped?true:undefined,'Owner change did not stop active capture');
  lateOldOwnerResult?.({results:[{isFinal:true,0:{transcript:'Late old-owner speech'},length:1}]});await tick();
  assert(attachmentCalls===stagedBeforeOwnerChange&&insertedTranscripts.length===transcriptsBeforeOwnerChange,'An owner change must not stage partial audio or late transcript/stop callbacks');

  assert(!captureBlocked,'retiring an owner releases its capture gate');
  permission=undefined;(await recordButton()).click();
  (await until(()=>permission,'Partial-review recording did not request permission'))(stream);
  (await button('Finish Recording')).click();
  await until(()=>document.body.textContent?.includes('Owned draft busy')?true:undefined,'Inline staging refusal was not retained');
  assert(captureBlocked&&recordingSlot.contains(recordingSurface()),'unresolved partial audio remains inline and blocks submission');
  refuseOwnedDraft=false;const usePartial=await button('Use Recording');usePartial.focus();usePartial.click();await closedRecorder();
  await until(()=>!captureBlocked?true:undefined,'Staging the retained recording did not release the Send gate');
  await until(()=>document.activeElement===document.querySelector('button[aria-label="Record Voice Message"]')?true:undefined,'Closing inline capture did not restore its toolbar trigger');
  permission=undefined;(await recordButton()).click();(await until(()=>permission,'Final focus-preservation recording did not request permission'))(stream);
  (await button('Finish Recording')).click();nextEditor.focus();await closedRecorder();await tick();
  assert(document.activeElement===nextEditor&&nextEditor.value==='Keep this newer editor interaction','Finishing must not steal focus or content from a newer editor interaction');

  // Assistant reuses this same recorder through its single waveform menu.
  inlineVoiceOptions=true;renderOwner();await tick();
  assert(!document.querySelector('button[aria-label="Record Voice Message"]'),'Inline Assistant controls have no second microphone button');
  const waveform=await until(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Voice Options"]')??undefined,'Assistant waveform trigger missing');
  waveform.focus();waveform.click();
  const recordChoice=await until(()=>Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(node=>node.textContent?.includes('Record Voice Message')),'Waveform recording choice missing');
  permission=undefined;recordChoice.click();assert(captureBlocked,'Waveform recording synchronously gates submission');
  (await until(()=>permission,'Waveform recording did not request permission'))(stream);
  const beforeWaveAttachment=attachmentCalls;(await button('Finish Recording')).click();await closedRecorder();
  assert(attachmentCalls===beforeWaveAttachment+1,'Waveform recording stages through the existing draft attachment callback once');
  await until(()=>document.activeElement===waveform?true:undefined,'Closing waveform recording restores its actual trigger');

 }finally{
  root.unmount();host.remove();recordingSlot.remove();nextEditor.remove();window.MediaRecorder=nativeRecorder;if(nativeRecognition)speechWindow.SpeechRecognition=nativeRecognition;else delete speechWindow.SpeechRecognition;
  if(devicesDescriptor)Object.defineProperty(navigator,'mediaDevices',devicesDescriptor);else delete (navigator as unknown as {mediaDevices?:MediaDevices}).mediaDevices;
 }
}


export async function voiceCallHeaderFocusRegression():Promise<void>{
 const speechWindow=window as unknown as {SpeechRecognition?:new()=>unknown};const originalRecognition=speechWindow.SpeechRecognition;
 const devicesDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{const track={kind:'audio',readyState:'live',stop(){track.readyState='ended';}};return {getAudioTracks:()=>[track],getTracks:()=>[track]};}}});
 let captureStarts=0,sends=0;
 class Recognition {continuous=true;interimResults=false;lang='en-US';maxAlternatives=1;onstart?:()=>void;onend?:()=>void;start(){captureStarts++;queueMicrotask(()=>this.onstart?.());}stop(){queueMicrotask(()=>this.onend?.());}abort(){queueMicrotask(()=>this.onend?.());}}
 speechWindow.SpeechRecognition=Recognition;
 const host=document.createElement('div'),header=document.createElement('header'),slot=document.createElement('div'),newer=document.createElement('input');header.textContent='Controlled contact';header.append(slot);document.body.append(header,host,newer);
 const root=createRoot(host),client=new QueryClient({defaultOptions:{queries:{retry:false}}}),agent={id:'call-focus-agent',projectId:'call-focus-project',conversationId:'call-focus-chat',title:'Controlled contact'};
 const originals={getConversation:api.getConversation,getWorkspacePreferences:api.getWorkspacePreferences,sendMultiAgentDirectMessage:api.sendMultiAgentDirectMessage};
 Object.assign(api,{getConversation:async()=>({conversation:{id:agent.conversationId,projectId:agent.projectId},agents:[agent],messages:[]}),getWorkspacePreferences:async()=>({speech:DEFAULT_SPEECH_PREFERENCES}),sendMultiAgentDirectMessage:async()=>{sends++;throw Error('Call focus fixture must never submit');}});
 client.setQueryData(queryKeys.workspacePreferences.all,{speech:DEFAULT_SPEECH_PREFERENCES});
 const render=(disabled=false)=>root.render(<StrictMode><ThemeProvider theme={createPonderosaTheme('light')}><QueryClientProvider client={client}><ConversationChromeContext.Provider value={{statusHost:null,callActionsHost:slot}}><DictationControls disabled={disabled} voiceContext={{projectId:agent.projectId,conversationId:agent.conversationId,agents:[agent as never],selectedAgentId:agent.id,lockAgent:true}} onFinalTranscript={()=>{throw Error('No final speech in call focus fixture');}} onSettlingChange={()=>{}}/></ConversationChromeContext.Provider></QueryClientProvider></ThemeProvider></StrictMode>);
 try{
  render();const handset=await until(()=>slot.querySelector<HTMLButtonElement>('button[aria-label="Call"]')??undefined,'Contact handset did not portal into the real header');
  assert(handset.getBoundingClientRect().width>=44&&handset.getBoundingClientRect().height>=44,'Header handset must provide a 44px target');
  handset.focus();handset.click();await until(()=>document.querySelector('[role="dialog"]')??undefined,'Header Call did not open the actual call stage');
  await until(()=>captureStarts===1?true:undefined,'Explicit header opening did not start capture exactly once');
  await tick();assert(captureStarts===1,'StrictMode must not request duplicate capture');
  const mute=document.querySelector<HTMLButtonElement>('button[aria-label="Mute Microphone"]');assert(mute,'Call mute control missing');mute!.click();
  await until(()=>document.querySelector('button[aria-label="Unmute Microphone"]')??undefined,'Call did not enter its truthful muted state');
  const end=document.querySelector<HTMLButtonElement>('button[aria-label="End Call"]');assert(end,'Call End control missing');end!.focus();end!.click();
  await until(()=>!document.querySelector('[role="dialog"]')?true:undefined,'End did not close the call');
  await until(()=>document.activeElement===handset?true:undefined,'End after mute did not restore the actual header handset');
  assert(sends===0,'Opening, muting and ending cannot submit a call turn');
  handset.click();await until(()=>captureStarts===2?true:undefined,'Second deliberate handset opening did not capture once');
  const secondEnd=await until(()=>document.querySelector<HTMLButtonElement>('button[aria-label="End Call"]')??undefined,'Second End missing');
  secondEnd.focus();secondEnd.click();newer.focus();await until(()=>!document.querySelector('[role="dialog"]')?true:undefined,'Second End did not close');await tick();
  assert(document.activeElement===newer,'Ending a call must not steal focus from a newer editor interaction');
  newer.focus();render(true);await tick();assert(document.activeElement===newer,'A later read-only render must preserve newer focus');assert(handset.disabled,'Read-only/supplied-disabled gating must disable the header handset');
 }finally{if(devicesDescriptor)Object.defineProperty(navigator,'mediaDevices',devicesDescriptor);else delete (navigator as unknown as {mediaDevices?:unknown}).mediaDevices;root.unmount();client.clear();Object.assign(api,originals);host.remove();header.remove();newer.remove();if(originalRecognition)speechWindow.SpeechRecognition=originalRecognition;else delete speechWindow.SpeechRecognition;}
}
