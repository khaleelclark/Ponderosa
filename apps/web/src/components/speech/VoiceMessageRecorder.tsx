import {AudioMessagePlayer} from './AudioMessagePlayer';
import {useEffect,useId,useRef,useState} from 'react';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,Stack,Typography} from '@mui/material';
import {claimPageCapture} from './captureCoordinator';
import {stopSpeech} from './speechCoordinator';
import {monitorSpeechSurfaceAccessibility} from './speechSurfaceAccessibility';
import {useUnsavedForm} from '../../reloadSafety';
import {recordingExtension,recordingMimeType} from './voiceRecording';

/** Recording becomes an ordinary durable draft attachment; it never auto-sends. */
export function VoiceMessageRecorder({onAttach,onClose,maxBytes}:{onAttach(file:File):string|undefined;onClose():void;maxBytes:number}):JSX.Element {
 const id=useId(),surface=useRef<HTMLDivElement>(null),alive=useRef(true),generation=useRef(0);
 const recorder=useRef<MediaRecorder>(),tracks=useRef<MediaStream>(),release=useRef<()=>void>(),unwatch=useRef<()=>void>();
 const finishRequested=useRef(false),startRef=useRef<()=>Promise<void>>(async()=>{}),callbacks=useRef({onAttach,onClose});callbacks.current={onAttach,onClose};
 const chunks=useRef<Blob[]>([]),bytes=useRef(0),started=useRef(0);
 const [phase,setPhase]=useState<'ready'|'starting'|'recording'|'stopping'|'review'>('ready');
 const [file,setFile]=useState<File>(),[url,setUrl]=useState<string>(),[error,setError]=useState(''),[seconds,setSeconds]=useState(0);
 useUnsavedForm(id,phase==='starting'||phase==='recording'||phase==='stopping'||Boolean(file));
 const cleanup=()=>{tracks.current?.getTracks().forEach(track=>track.stop());tracks.current=undefined;release.current?.();release.current=undefined;unwatch.current?.();unwatch.current=undefined;};
 const stop=(finish=false)=>{
  finishRequested.current=finish;
  const active=recorder.current;
  if(active&&active.state!=='inactive'){setPhase('stopping');active.stop();}
  else cleanup();
 };
 const stopRef=useRef(stop);stopRef.current=stop;
 useEffect(()=>{
  alive.current=true;
  const mountedGeneration=generation.current;
  // StrictMode's discarded mount must not request microphone permission.
  queueMicrotask(()=>{if(alive.current&&generation.current===mountedGeneration)void startRef.current();});
  return()=>{alive.current=false;generation.current++;finishRequested.current=false;const active=recorder.current;if(active&&active.state!=='inactive')active.stop();cleanup();};
 },[]);
 useEffect(()=>{
  if(!file){setUrl(undefined);return;}
  const next=URL.createObjectURL(file);setUrl(next);return()=>URL.revokeObjectURL(next);
 },[file]);
 useEffect(()=>{
  if(phase!=='recording')return;
  const timer=setInterval(()=>setSeconds(Math.floor((performance.now()-started.current)/1000)),1000);
  return()=>clearInterval(timer);
 },[phase]);
 const stage=(recording:File)=>{
  try{const failure=callbacks.current.onAttach(recording);if(failure){setError(failure);return;}}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));return;}
  callbacks.current.onClose();
 };
 const start=async()=>{
  if(phase==='starting'||phase==='recording'||phase==='stopping')return;
  const epoch=++generation.current;finishRequested.current=false;setError('');setFile(undefined);setSeconds(0);setPhase('starting');
  try{
   if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw new Error('Voice recording is unavailable in this browser.');
   if(!stopSpeech())throw new Error('Stop browser audio before recording.');
   const stream=await navigator.mediaDevices.getUserMedia({audio:true});
   if(!alive.current||epoch!==generation.current){stream.getTracks().forEach(track=>track.stop());return;}
   tracks.current=stream;
   const type=recordingMimeType(value=>MediaRecorder.isTypeSupported(value));
   const active=new MediaRecorder(stream,type?{mimeType:type}:undefined);recorder.current=active;
   chunks.current=[];bytes.current=0;
   active.ondataavailable=event=>{
    if(!alive.current||epoch!==generation.current||!event.data.size)return;
    chunks.current.push(event.data);bytes.current+=event.data.size;
    if(bytes.current>=maxBytes){setError('Recording reached the attachment size limit.');stopRef.current();}
   };
   active.onerror=()=>{if(alive.current&&epoch===generation.current){setError('Microphone recording failed. Review any captured audio.');stopRef.current();}};
   active.onstop=()=>{
    cleanup();
    if(!alive.current||epoch!==generation.current)return;
    const mime=active.mimeType.split(';')[0]||chunks.current[0]?.type.split(';')[0]||'application/octet-stream';
    const blob=new Blob(chunks.current,{type:mime});chunks.current=[];
    if(blob.size>maxBytes){setError('Recording exceeds the attachment size limit. Record a shorter message.');setPhase('ready');return;}
    if(!blob.size){setError('No audio was captured. Try recording again.');setPhase('ready');return;}
    const recording=new File([blob],`Voice message ${new Date().toISOString().replace(/[:.]/g,'-')}.${recordingExtension(mime)}`,{type:mime});
    setFile(recording);setPhase('review');
    if(finishRequested.current)stage(recording);
   };
   release.current=claimPageCapture(()=>{setError('Recording stopped because another audio capture started. Review any captured audio.');stopRef.current();});
   unwatch.current=monitorSpeechSurfaceAccessibility(()=>surface.current,()=>{setError('Recording stopped because this page became inactive.');stopRef.current();});
   started.current=performance.now();active.start(1000);setPhase('recording');
  }catch(cause){cleanup();if(alive.current&&epoch===generation.current){setError(cause instanceof Error?cause.message:String(cause));setPhase('ready');}}
 };
 startRef.current=start;
 const close=()=>{generation.current++;finishRequested.current=false;callbacks.current.onClose();};
 return <Dialog open fullWidth maxWidth="xs" aria-labelledby={`${id}-title`} onClose={phase==='recording'||phase==='stopping'||phase==='starting'?undefined:close}>
  <DialogTitle id={`${id}-title`}>Voice message</DialogTitle><DialogContent ref={surface}><Stack spacing={2}>
   {error&&<Alert severity="warning">{error}</Alert>}
   <Typography role="status">{phase==='recording'?`Recording · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:phase==='starting'?'Opening microphone…':phase==='stopping'?'Finishing recording…':file?'Review recording':'Ready to record'}</Typography>
   {url&&<AudioMessagePlayer src={url} label="Voice message preview" preload="metadata"/>}
  </Stack></DialogContent><DialogActions sx={{flexWrap:'wrap',gap:1}}>
   <Button disabled={phase==='stopping'} onClick={close}>Discard</Button>
   {phase==='recording'?<Button variant="contained" onClick={()=>stop(true)}>Finish recording</Button>:<Button disabled={phase==='starting'||phase==='stopping'} onClick={()=>void start()}>{file?'Record again':'Record'}</Button>}
   {file&&url&&<Button href={url} download={file.name}>Save audio</Button>}
   {file&&<Button variant="contained" onClick={()=>stage(file)}>Use recording</Button>}
  </DialogActions>
 </Dialog>;
}
