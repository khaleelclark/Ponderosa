import {AudioMessagePlayer} from './AudioMessagePlayer';
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {Alert,Box,Button,Paper,Stack,Typography} from '@mui/material';
import {claimPageCapture} from './captureCoordinator';
import {stopSpeech} from './speechCoordinator';
import {monitorSpeechSurfaceAccessibility} from './speechSurfaceAccessibility';
import {useUnsavedForm} from '../../reloadSafety';
import {recordingExtension,recordingMimeType} from './voiceRecording';
import {useDictation} from './useDictation';

/** Recording becomes an ordinary durable draft attachment; it never auto-sends. */
export function VoiceMessageRecorder({onAttach,onClose,maxBytes}:{onAttach(file:File,transcript?:string):string|undefined;onClose():void;maxBytes:number}):JSX.Element {
 const id=useId(),surface=useRef<HTMLDivElement>(null),finishButton=useRef<HTMLButtonElement>(null),useRecordingButton=useRef<HTMLButtonElement>(null),alive=useRef(true),generation=useRef(0);
 const recorder=useRef<MediaRecorder>(),tracks=useRef<MediaStream>(),release=useRef<()=>void>(),unwatch=useRef<()=>void>();
 const finishRequested=useRef(false),startRef=useRef<()=>Promise<void>>(async()=>{}),callbacks=useRef({onAttach,onClose});callbacks.current={onAttach,onClose};
 const chunks=useRef<Blob[]>([]),bytes=useRef(0),started=useRef(0);
 const [phase,setPhase]=useState<'ready'|'starting'|'recording'|'stopping'|'review'>('ready');
 const [file,setFile]=useState<File>(),[url,setUrl]=useState<string>(),[error,setError]=useState(''),[seconds,setSeconds]=useState(0);
 const [transcript,setTranscript]=useState(''),[transcriptionSettling,setTranscriptionSettling]=useState(false),recognitionSettling=useRef(false);
 const recordingInput=useMemo(()=>({track:()=>tracks.current?.getAudioTracks()[0]}),[]);
 const transcription=useDictation(words=>setTranscript(previous=>[previous,words].filter(Boolean).join(' ')),settling=>{recognitionSettling.current=settling;setTranscriptionSettling(settling);},surface,true,false,recordingInput);
 const transcriptionRef=useRef(transcription);transcriptionRef.current=transcription;
 useUnsavedForm(id,phase==='starting'||phase==='recording'||phase==='stopping'||Boolean(file));
 const cleanup=()=>{tracks.current?.getTracks().forEach(track=>track.stop());tracks.current=undefined;release.current?.();release.current=undefined;unwatch.current?.();unwatch.current=undefined;};
 const stop=(finish=false)=>{
  finishRequested.current=finish;
  if(finish)transcriptionRef.current.stop();else transcriptionRef.current.abandon();
  if(surface.current?.contains(document.activeElement))surface.current.focus({preventScroll:true});
  const active=recorder.current;
  if(active&&active.state!=='inactive'){setPhase('stopping');active.stop();}
  else cleanup();
 };
 const stopRef=useRef(stop);stopRef.current=stop;
 useEffect(()=>{
  alive.current=true;
  const mountedGeneration=generation.current;
  // StrictMode's discarded mount must not request microphone permission.
  queueMicrotask(()=>{if(alive.current&&generation.current===mountedGeneration){surface.current?.focus({preventScroll:true});void startRef.current();}});
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
 useEffect(()=>{if(!surface.current?.contains(document.activeElement))return;if(phase==='recording')finishButton.current?.focus({preventScroll:true});else if(phase==='review')useRecordingButton.current?.focus({preventScroll:true});},[phase]);
 const stage=(recording:File)=>{
  try{const failure=callbacks.current.onAttach(recording,transcript.trim()||undefined);if(failure){setError(failure);return;}}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));return;}
  callbacks.current.onClose();
 };
 const start=async()=>{
  if(phase==='starting'||phase==='recording'||phase==='stopping'||recognitionSettling.current)return;
  if(surface.current?.contains(document.activeElement))surface.current.focus({preventScroll:true});
  const epoch=++generation.current;finishRequested.current=false;transcriptionRef.current.abandon();cleanup();setTranscript('');setError('');setFile(undefined);setSeconds(0);setPhase('starting');
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
    if(!alive.current||epoch!==generation.current)return;
    // Keep the admitted track/lease until native finalization has settled.
    if(!recognitionSettling.current)cleanup();
    const mime=active.mimeType.split(';')[0]||chunks.current[0]?.type.split(';')[0]||'application/octet-stream';
    const blob=new Blob(chunks.current,{type:mime});chunks.current=[];
    if(blob.size>maxBytes){transcriptionRef.current.abandon();cleanup();setError('Recording exceeds the attachment size limit. Record a shorter message.');setPhase('ready');return;}
    if(!blob.size){transcriptionRef.current.abandon();cleanup();setError('No audio was captured. Try recording again.');setPhase('ready');return;}
    const recording=new File([blob],`Voice message ${new Date().toISOString().replace(/[:.]/g,'-')}.${recordingExtension(mime)}`,{type:mime});
    setFile(recording);setPhase('review');
    // Finish waits for real final recognition before staging; failures retain review.
   };
   release.current=claimPageCapture(()=>{setError('Recording stopped because another audio capture started. Review any captured audio.');stopRef.current();});
   unwatch.current=monitorSpeechSurfaceAccessibility(()=>surface.current,()=>{setError('Recording stopped because this page became inactive.');stopRef.current();});
   started.current=performance.now();active.start(1000);setPhase('recording');transcriptionRef.current.start();
  }catch(cause){cleanup();if(alive.current&&epoch===generation.current){setError(cause instanceof Error?cause.message:String(cause));setPhase('ready');}}
 };
 startRef.current=start;
 useEffect(()=>{if(phase==='recording'&&transcription.status==='stopped'&&!finishRequested.current)setError('Transcription stopped before recording finished. Review or complete the message text before sending.');},[phase,transcription.status]);
 useEffect(()=>{
  if(file&&!transcriptionSettling)cleanup();
  if(file&&finishRequested.current&&!transcriptionSettling){
   finishRequested.current=false;
   // An unavailable/failed recognizer must not silently present an audio ACK as understanding.
   if(transcript.trim()&&!error&&!transcription.error)stage(file);
  }
 },[file,transcriptionSettling,transcript,error,transcription.error]);
 const close=()=>{generation.current++;finishRequested.current=false;callbacks.current.onClose();};
 return <Paper ref={surface} tabIndex={-1} role="region" aria-labelledby={`${id}-title`} variant="outlined"
  sx={{p:1.25,minWidth:0,borderRadius:2,bgcolor:'background.paper'}}>
  <Stack spacing={1}>
   <Stack direction="row" alignItems="center" justifyContent="space-between" useFlexGap flexWrap="wrap" gap={1}>
    <Typography id={`${id}-title`} variant="body2" fontWeight={600}>Voice message</Typography>
    <Stack direction="row" spacing={0.75} alignItems="center" role="status" aria-live="polite" aria-atomic={false}>
     {phase==='recording'&&<Box aria-hidden sx={{width:8,height:8,borderRadius:'50%',bgcolor:'error.main',animation:'voiceCapturePulse 1.2s ease-in-out infinite','@keyframes voiceCapturePulse':{'0%,100%':{opacity:1},'50%':{opacity:0.4}},'@media (prefers-reduced-motion: reduce)':{animation:'none'}}}/>}
     <Typography variant="body2">{phase==='recording'?<>Recording · <Box component="span" aria-live="off">{Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</Box></>:phase==='starting'?'Opening microphone…':phase==='stopping'?'Finishing recording…':file?'Review recording':'Ready to record'}</Typography>
    </Stack>
   </Stack>
   {error&&<Alert severity="warning">{error}</Alert>}
   {(transcription.unavailableReason||transcription.error)&&<Alert severity="warning">{transcription.unavailableReason||transcription.error} Audio is kept. Add or edit the message text before sending; the agent may not be able to understand the recording alone.</Alert>}
   {phase==='review'&&!transcriptionSettling&&!transcript.trim()&&!transcription.error&&!transcription.unavailableReason&&<Alert severity="warning">No transcript was captured. Audio is kept. Add message text or use Dictation before sending.</Alert>}
   {transcriptionSettling&&phase==='review'&&<Typography role="status" variant="body2">Finishing transcript…</Typography>}
   {transcript&&<Typography variant="body2" sx={{whiteSpace:'pre-wrap'}}>Transcript: {transcript}</Typography>}
   {url&&<AudioMessagePlayer src={url} label="Voice Message Preview" preload="metadata"/>}
   <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
    <Button sx={{minHeight:44}} disabled={phase==='stopping'} onClick={close}>Discard</Button>
    {phase==='recording'?<Button ref={finishButton} sx={{minHeight:44}} variant="contained" onClick={()=>stop(true)}>Finish Recording</Button>:<Button sx={{minHeight:44}} disabled={phase==='starting'||phase==='stopping'||transcriptionSettling} onClick={()=>void start()}>{file?'Record Again':'Record'}</Button>}
    {file&&url&&<Button sx={{minHeight:44}} href={url} download={file.name}>Save Audio</Button>}
    {file&&<Button ref={useRecordingButton} sx={{minHeight:44}} variant="contained" disabled={transcriptionSettling} onClick={()=>stage(file)}>Use Recording</Button>}
   </Stack>
  </Stack>
 </Paper>;
}
