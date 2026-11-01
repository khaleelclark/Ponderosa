// Deferred browser regression source; no runner or browser execution in this change.
import {createRoot} from 'react-dom/client';
import {VoiceMessageRecorder} from '../../apps/web/src/components/speech/VoiceMessageRecorder';

const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function voiceMessageRecordingRegression():Promise<void> {
 const nativeRecorder=window.MediaRecorder,devicesDescriptor=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 let stopped=0,closed=0,attached:File|undefined,refuse=true;
 let permission:(stream:MediaStream)=>void=()=>{};
 const stream={getTracks:()=>[{stop:()=>stopped++}]} as unknown as MediaStream;
 class Recorder {
  static isTypeSupported=(mime:string)=>mime==='audio/webm;codecs=opus';
  state='inactive';mimeType='audio/webm;codecs=opus';
  ondataavailable?: (event:{data:Blob})=>void;onstop?:()=>void;onerror?:()=>void;
  start(){this.state='recording';}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['recorded voice'],{type:'audio/webm'})});this.onstop?.();});}
 }
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise<MediaStream>(resolve=>{permission=resolve;})}});
 window.MediaRecorder=Recorder as unknown as typeof MediaRecorder;
 const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text)!;
 const mount=()=>root.render(<VoiceMessageRecorder maxBytes={1024} onClose={()=>{closed++;root.render(null);}} onAttach={file=>{if(refuse)return 'Draft is full';attached=file;return undefined;}}/>);
 try{
  mount();await tick();button('Record').click();await tick();permission(stream);await tick();
  button('Finish recording').click();await tick();await tick();
  assert(stopped>0,'finishing must release microphone tracks');
  button('Attach voice message').click();await tick();
  assert(!closed&&!attached&&document.body.textContent?.includes('Draft is full'),'rejected attachment must retain review instead of discarding audio');
  refuse=false;button('Attach voice message').click();await tick();
  assert(closed===1&&attached?.type==='audio/webm'&&attached.name.endsWith('.webm'),'accepted audio uses its actual container and closes only after attachment');
  mount();await tick();button('Record').click();await tick();button('Discard').click();await tick();
  const prior=stopped;permission(stream);await tick();
  assert(stopped>prior,'late microphone permission after discard must immediately stop tracks');
 }finally{
  root.unmount();host.remove();window.MediaRecorder=nativeRecorder;
  if(devicesDescriptor)Object.defineProperty(navigator,'mediaDevices',devicesDescriptor);else delete (navigator as unknown as {mediaDevices?:MediaDevices}).mediaDevices;
 }
}
