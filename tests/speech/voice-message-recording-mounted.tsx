// Deferred browser regression source; no runner or browser execution in this change.
import {createRoot} from 'react-dom/client';
import {VoiceMessageRecorder} from '../../apps/web/src/components/speech/VoiceMessageRecorder';

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
 let stopped=0,closed=0,attached:File|undefined,refuse=true;
 let permission:((stream:MediaStream)=>void)|undefined;
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
 const button=(text:string)=>until(
  ()=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text),
  'Missing '+text+' button',
 );
 const mount=()=>root.render(<VoiceMessageRecorder maxBytes={1024} onClose={()=>{closed++;root.render(null);}} onAttach={file=>{if(refuse)return 'Draft is full';attached=file;return undefined;}}/>);
 try{
  mount();(await button('Record')).click();
  (await until(()=>permission,'Microphone permission was not requested'))(stream);
  (await button('Finish recording')).click();
  await until(()=>stopped>0?true:undefined,'Finishing did not release microphone tracks');
  (await button('Attach voice message')).click();
  await until(()=>document.body.textContent?.includes('Draft is full')?true:undefined,'Attachment refusal was not shown');
  assert(!closed&&!attached,'rejected attachment must retain review instead of discarding audio');
  refuse=false;(await button('Attach voice message')).click();
  await until(()=>closed===1&&attached?true:undefined,'Accepted attachment did not close');
  assert(attached?.type==='audio/webm'&&attached.name.endsWith('.webm'),'accepted audio uses its actual container and closes only after attachment');
  permission=undefined;mount();(await button('Record')).click();
  const latePermission=await until(()=>permission,'Second microphone permission was not requested');
  (await button('Discard')).click();
  await until(()=>closed===2?true:undefined,'Discard did not close the recorder');
  const prior=stopped;latePermission(stream);
  await until(()=>stopped>prior?true:undefined,'Late microphone permission after discard did not stop tracks');
 }finally{
  root.unmount();host.remove();window.MediaRecorder=nativeRecorder;
  if(devicesDescriptor)Object.defineProperty(navigator,'mediaDevices',devicesDescriptor);else delete (navigator as unknown as {mediaDevices?:MediaDevices}).mediaDevices;
 }
}
