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
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
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
 const closedDialog=()=>until(()=>!document.querySelector('[role="dialog"]')?true:undefined,'Recorder did not unmount');
 try{
  mount();
  (await until(()=>permission,'Opening recording did not request microphone permission'))(stream);
  assert(permissionCalls===1,'StrictMode discarded mount must not request duplicate microphone permission');
  (await button('Finish recording')).click();
  await until(()=>stopped>0?true:undefined,'Finishing did not release microphone tracks');
  await until(()=>document.body.textContent?.includes('Draft is full')?true:undefined,'Finish staging refusal was not shown');
  assert(!closed&&!attached&&attachmentCalls===1,'rejected Finish must retain review and never send');
  assert((await button('Record again'))!==undefined,'Refused audio must remain re-recordable');
  refuse=false;(await button('Use recording')).click();
  await until(()=>closed===1&&attached?true:undefined,'Accepted staging did not close');
  assert(attached?.type==='audio/webm'&&attached.name.endsWith('.webm'),'staged audio retains the actual container');
  await closedDialog();

  const priorAttachmentCalls=attachmentCalls;mount();
  const latePermission=await until(()=>permission,'Second microphone permission was not requested');
  (await button('Discard')).click();await closedDialog();
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
  (await button('Use recording')).click();await closedDialog();

  const beforeLimit=attachmentCalls;mount(4);
  (await until(()=>permission,'Limited recording did not request permission'))(stream);
  (await button('Finish recording')).click();
  await until(()=>document.body.textContent?.includes('Recording exceeds the attachment size limit. Record a shorter message.')?true:undefined,'Oversized capture did not explain recovery');
  assert(attachmentCalls===beforeLimit,'Oversized audio must never enter the draft');
  (await button('Discard')).click();await closedDialog();

  mount();(await until(()=>permission,'Active-discard recording did not request permission'))(stream);
  await button('Finish recording');const beforeDiscard=stopped;
  (await button('Discard')).click();await closedDialog();
  await until(()=>stopped>beforeDiscard?true:undefined,'Active discard did not stop microphone tracks');
  assert(attachmentCalls===beforeLimit,'Active discard must not stage final recording callbacks');

  // Exercise the real toolbar owner fence, not a manually keyed recorder surrogate.
  let owner='first';
  const renderOwner=()=>root.render(<StrictMode><DictationControls disabled={false}
   voiceContext={{projectId:'owned-project',conversationId:'owned-chat',selectedAgentId:owner,agents:[],lockAgent:true}}
   onFinalTranscript={()=>{}} onSettlingChange={()=>{}}
   onVoiceAttachment={file=>{attachmentCalls++;attached=file;return undefined;}}/></StrictMode>);
  const recordButton=()=>until(()=>document.querySelector<HTMLButtonElement>('button[aria-label="Record voice message"]')??undefined,'Direct recording action missing');
  permission=undefined;renderOwner();(await recordButton()).click();
  const oldOwnerPermission=await until(()=>permission,'Owned recording did not request permission');
  const beforeOwnerChange=stopped,stagedBeforeOwnerChange=attachmentCalls;
  owner='second';renderOwner();await closedDialog();oldOwnerPermission(stream);
  await until(()=>stopped>beforeOwnerChange?true:undefined,'Old-owner late permission did not stop tracks');
  assert(attachmentCalls===stagedBeforeOwnerChange,'Late old-owner permission must never stage into the new owner');
  owner='first';renderOwner();await tick();assert(!document.querySelector('[role="dialog"]'),'Returning to old owner must not reopen recording');
  permission=undefined;(await recordButton()).click();
  (await until(()=>permission,'Active owned recording did not request permission'))(stream);
  await button('Finish recording');const activeOwnerStopped=stopped;
  owner='third';renderOwner();await closedDialog();
  await until(()=>stopped>activeOwnerStopped?true:undefined,'Owner change did not stop active capture');
  assert(attachmentCalls===stagedBeforeOwnerChange,'An owner change must not stage partial audio or a late stop callback');
 }finally{
  root.unmount();host.remove();window.MediaRecorder=nativeRecorder;
  if(devicesDescriptor)Object.defineProperty(navigator,'mediaDevices',devicesDescriptor);else delete (navigator as unknown as {mediaDevices?:MediaDevices}).mediaDevices;
 }
}
