import {useEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Stack} from '@mui/material';
import {claimPageCapture} from './captureCoordinator';
import {stopSpeech} from './speechCoordinator';

/** Native audio participates in the same page audio/microphone ownership as calls. */
export function AudioMessagePlayer({src,label,preload='none'}:{src:string;label:string;preload?:'none'|'metadata'}):JSX.Element {
 const audio=useRef<HTMLAudioElement>(null),release=useRef<()=>void>();
 const [error,setError]=useState(''),[retry,setRetry]=useState(0);
 const relinquish=()=>{release.current?.();release.current=undefined;};
 useEffect(()=>{setError('');return()=>{audio.current?.pause();relinquish();};},[src]);
 return <Stack spacing={0.5} sx={{minWidth:0,maxWidth:'100%'}}>
  <Box key={`${src}:${retry}`} ref={audio} component="audio" controls preload={preload} src={src} aria-label={label} sx={{width:'100%',maxWidth:'100%',minWidth:0}}
   onPlay={event=>{
    if(!stopSpeech()){event.currentTarget.pause();setError('Browser speech could not be stopped. Try playback again.');return;}
    const element=event.currentTarget;
    release.current=claimPageCapture(()=>element.pause());
   }} onPause={relinquish} onEnded={relinquish} onError={()=>{relinquish();const failure=audio.current?.error;setError(`Audio playback failed${failure?`: ${failure.message||`media error ${failure.code}`}`:''}. Download the recording or retry.`);}}/>
  {error&&<Alert severity="warning" action={<Button onClick={()=>{setError('');setRetry(value=>value+1);}}>Retry</Button>}>{error}</Alert>}
 </Stack>;
}
