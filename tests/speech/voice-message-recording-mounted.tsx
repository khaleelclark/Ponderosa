// Controlled component lifecycle regression; no provider or message Send is invoked.
import {StrictMode} from 'react';
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
 const nativeRecorder=window.MediaRecorder,devicesDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
 const host=document.createElement('div'),recordingSlot=document.createElement('div'),nextEditor=document.createElement('input');nextEditor.value='Keep this newer editor interaction';document.body.append(host,recordingSlot,nextEditor);const root=createRoot(host);
 let stopped=0,closed=0,attached:File|undefined,refuse=true,permissionCalls=0,attachmentCalls=0;
 let permission:((stream:MediaStream)=>void)|undefined,rejectPermission:((reason:Error)=>void)|undefined;
 let currentRecorder:{onerror?:()=>void}|undefined;
 const stream={getTracks:()=>[{stop:()=>stopped++}]} as unknown as MediaStream;
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
 const mount=(maxBytes=1024)=>{permission=undefined;rejectPermission=undefined;root.render(<StrictMode><VoiceMessageRecorder maxBytes={maxBytes} onClose={()=>{closed++;root.render(null);}} onAttach={file=>{attachmentCalls++;if(refuse)return 'Draft is full';attached=file;return undefined;}}/></StrictMode>);};
 const recordingSurface=()=>host.querySelector('[role="region"][aria-labelledby]')??recordingSlot.querySelector('[role="region"][aria-labelledby]');
 const closedRecorder=()=>until(()=>!recordingSurface()?true:undefined,'Inline recorder did not unmount');
 try{
  mount();
  const firstPermission=await until(()=>permission,'Opening recording did not request microphone permission');assert(document.activeElement===recordingSurface(),'Opening inline capture must focus its named surface while permission is pending');firstPermission(stream);
  assert(permissionCalls===1,'StrictMode discarded mount must not request duplicate microphone permission');
  const firstFinish=await button('Finish recording');await until(()=>document.activeElement===firstFinish?true:undefined,'Keyboard focus did not advance to Finish');
  assert(recordingSurface()?.querySelector('[role="status"]')?.getAttribute('aria-atomic')==='false'&&recordingSurface()?.querySelector('[aria-live="off"]'),'Elapsed timer must not be live-announced every second');
  firstFinish.click();
  await until(()=>stopped>0?true:undefined,'Finishing did not release microphone tracks');
  await until(()=>document.body.textContent?.includes('Draft is full')?true:undefined,'Finish staging refusal was not shown');
  assert(!closed&&!attached&&attachmentCalls===1,'rejected Finish must retain review and never send');
  assert((await button('Record again'))!==undefined,'Refused audio must remain re-recordable');
  refuse=false;(await button('Use recording')).click();
  await until(()=>closed===1&&attached?true:undefined,'Accepted staging did not close');
  assert(attached?.type==='audio/webm'&&attached.name.endsWith('.webm'),'staged audio retains the actual container');
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
  await button('Finish recording');currentRecorder?.onerror?.();
  await until(()=>document.body.textContent?.includes('Microphone recording failed. Review any captured audio.')?true:undefined,'Capture failure was not visible');
  await button('Use recording');
  assert(attachmentCalls===priorAttachmentCalls,'Capture failure must retain partial review instead of automatically staging');
  (await button('Use recording')).click();await closedRecorder();

  const beforeLimit=attachmentCalls;mount(4);
  (await until(()=>permission,'Limited recording did not request permission'))(stream);
  (await button('Finish recording')).click();
  await until(()=>document.body.textContent?.includes('Recording exceeds the attachment size limit. Record a shorter message.')?true:undefined,'Oversized capture did not explain recovery');
  assert(attachmentCalls===beforeLimit,'Oversized audio must never enter the draft');
  (await button('Discard')).click();await closedRecorder();

  mount();(await until(()=>permission,'Active-discard recording did not request permission'))(stream);
  await button('Finish recording');const beforeDiscard=stopped;
  (await button('Discard')).click();await closedRecorder();
  await until(()=>stopped>beforeDiscard?true:undefined,'Active discard did not stop microphone tracks');
  assert(attachmentCalls===beforeLimit,'Active discard must not stage final recording callbacks');

  // Exercise the real toolbar owner fence, not a manually keyed recorder surrogate.
  let owner='first',captureBlocked=false,refuseOwnedDraft=true;
  const renderOwner=()=>root.render(<StrictMode><DictationControls disabled={false} recordingContainer={recordingSlot} onActiveChange={value=>{captureBlocked=value;}}
   voiceContext={{projectId:'owned-project',conversationId:'owned-chat',selectedAgentId:owner,agents:[],lockAgent:true}}
   onFinalTranscript={()=>{}} onSettlingChange={()=>{}}
   onVoiceAttachment={file=>{if(refuseOwnedDraft)return 'Owned draft busy';attachmentCalls++;attached=file;return undefined;}}/></StrictMode>);
  const recordButton=()=>until(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Record voice message"]')??undefined,'Direct recording action missing');
  permission=undefined;renderOwner();(await recordButton()).click();assert(captureBlocked,'pending permission must synchronously gate submission');
  const oldOwnerPermission=await until(()=>permission,'Owned recording did not request permission');
  const beforeOwnerChange=stopped,stagedBeforeOwnerChange=attachmentCalls;
  owner='second';renderOwner();await closedRecorder();oldOwnerPermission(stream);
  await until(()=>stopped>beforeOwnerChange?true:undefined,'Old-owner late permission did not stop tracks');
  assert(attachmentCalls===stagedBeforeOwnerChange,'Late old-owner permission must never stage into the new owner');
  owner='first';renderOwner();await tick();assert(!recordingSurface(),'Returning to old owner must not reopen recording');
  permission=undefined;(await recordButton()).click();
  (await until(()=>permission,'Active owned recording did not request permission'))(stream);
  await button('Finish recording');const activeOwnerStopped=stopped;
  owner='third';renderOwner();await closedRecorder();
  await until(()=>stopped>activeOwnerStopped?true:undefined,'Owner change did not stop active capture');
  assert(attachmentCalls===stagedBeforeOwnerChange,'An owner change must not stage partial audio or a late stop callback');

  assert(!captureBlocked,'retiring an owner releases its capture gate');
  permission=undefined;(await recordButton()).click();
  (await until(()=>permission,'Partial-review recording did not request permission'))(stream);
  (await button('Finish recording')).click();
  await until(()=>document.body.textContent?.includes('Owned draft busy')?true:undefined,'Inline staging refusal was not retained');
  assert(captureBlocked&&recordingSlot.contains(recordingSurface()),'unresolved partial audio remains inline and blocks submission');
  refuseOwnedDraft=false;const usePartial=await button('Use recording');usePartial.focus();usePartial.click();await closedRecorder();
  await until(()=>!captureBlocked?true:undefined,'Staging the retained recording did not release the Send gate');
  await until(()=>document.activeElement===document.querySelector('button[aria-label="Record voice message"]')?true:undefined,'Closing inline capture did not restore its toolbar trigger');
  permission=undefined;(await recordButton()).click();(await until(()=>permission,'Final focus-preservation recording did not request permission'))(stream);
  (await button('Finish recording')).click();nextEditor.focus();await closedRecorder();await tick();
  assert(document.activeElement===nextEditor&&nextEditor.value==='Keep this newer editor interaction','Finishing must not steal focus or content from a newer editor interaction');
 }finally{
  root.unmount();host.remove();recordingSlot.remove();nextEditor.remove();window.MediaRecorder=nativeRecorder;
  if(devicesDescriptor)Object.defineProperty(navigator,'mediaDevices',devicesDescriptor);else delete (navigator as unknown as {mediaDevices?:MediaDevices}).mediaDevices;
 }
}
