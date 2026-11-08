import {useEffect,useId,useRef,useState} from 'react';
import {Alert,Box,Button,CircularProgress,IconButton,Popover,Slider,Stack,Typography} from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PauseRoundedIcon from '@mui/icons-material/PauseRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import VolumeOffRoundedIcon from '@mui/icons-material/VolumeOffRounded';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import {claimPageCapture} from './captureCoordinator';
import {stopSpeech} from './speechCoordinator';

const controlSx={width:44,height:44,minWidth:44,flexShrink:0};
const time=(value:number)=>{
 const seconds=Math.max(0,Math.floor(value)),minutes=Math.floor(seconds/60);
 return minutes>=60?`${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${minutes}:${String(seconds%60).padStart(2,'0')}`;
};

/** Native audio keeps the shared capture lease; custom controls never preload a whole file. */
export function AudioMessagePlayer({src,label,preload='none',downloadUrl=src}:{src:string;label:string;preload?:'none'|'metadata';downloadUrl?:string}):JSX.Element {
 const audio=useRef<HTMLAudioElement>(null),release=useRef<()=>void>(),optionsId=useId();
 const [error,setError]=useState(''),[retry,setRetry]=useState(0),[playing,setPlaying]=useState(false),[waiting,setWaiting]=useState(false);
 const [elapsed,setElapsed]=useState(0),[duration,setDuration]=useState<number>(),[volume,setVolume]=useState(1),[muted,setMuted]=useState(false),[rate,setRate]=useState(1);
 const [anchor,setAnchor]=useState<HTMLElement|null>(null);
 const relinquish=()=>{release.current?.();release.current=undefined;};
 const readTime=(element:HTMLAudioElement)=>{
  setElapsed(Number.isFinite(element.currentTime)?Math.max(0,element.currentTime):0);
  if(Number.isFinite(element.duration)&&element.duration>0)setDuration(element.duration);
 };
 useEffect(()=>{
  const element=audio.current;setError('');setPlaying(false);setWaiting(false);setElapsed(0);setDuration(undefined);setVolume(1);setMuted(false);setRate(1);
  return()=>{element?.pause();relinquish();};
 },[src,retry]);
 const toggle=()=>{
  const element=audio.current;if(!element)return;
  if(!element.paused){element.pause();return;}
  setError('');setWaiting(true);
  try{void Promise.resolve(element.play()).catch(cause=>{
   if(audio.current!==element)return;
   relinquish();setPlaying(false);setWaiting(false);setError(`Audio playback failed: ${cause instanceof Error?cause.message:String(cause)}. Download the recording or retry.`);
  });}catch(cause){setWaiting(false);setError(`Audio playback failed: ${cause instanceof Error?cause.message:String(cause)}. Download the recording or retry.`);}
 };
 const seek=(_event:Event,value:number|number[])=>{
  const element=audio.current;if(!element||!duration)return;
  try{element.currentTime=Math.min(duration,Math.max(0,Array.isArray(value)?value[0]!:value));readTime(element);}
  catch(cause){setError(`Audio could not seek: ${cause instanceof Error?cause.message:String(cause)}. Try playback again.`);}
 };
 return <Stack role="group" aria-label={label} spacing={0.5} sx={{minWidth:0,maxWidth:'100%'}}>
  <audio key={`${src}:${retry}`} ref={audio} hidden preload={preload} src={src} aria-label={label}
   onPlay={event=>{
    if(!stopSpeech()){event.currentTarget.pause();setWaiting(false);setError('Browser speech could not be stopped. Try playback again.');return;}
    const element=event.currentTarget;release.current=claimPageCapture(()=>element.pause());setPlaying(true);
   }} onPlaying={()=>setWaiting(false)} onWaiting={event=>{if(!event.currentTarget.paused)setWaiting(true);}}
   onLoadedMetadata={event=>readTime(event.currentTarget)} onDurationChange={event=>readTime(event.currentTarget)} onTimeUpdate={event=>readTime(event.currentTarget)}
   onPause={()=>{setPlaying(false);setWaiting(false);relinquish();}}
   onEnded={event=>{const element=event.currentTarget;readTime(element);if(!Number.isFinite(element.duration)&&element.currentTime>0)setDuration(element.currentTime);setPlaying(false);setWaiting(false);relinquish();}}
   onVolumeChange={event=>{setVolume(event.currentTarget.volume);setMuted(event.currentTarget.muted);}}
   onRateChange={event=>setRate(event.currentTarget.playbackRate)}
   onError={()=>{relinquish();setPlaying(false);setWaiting(false);const failure=audio.current?.error;setError(`Audio playback failed${failure?`: ${failure.message||`media error ${failure.code}`}`:''}. Download the recording or retry.`);}}/>
  <Stack direction="row" alignItems="center" spacing={0.5} sx={{p:0.5,minWidth:0,borderRadius:2,bgcolor:'action.hover'}}>
   <IconButton aria-label={playing?'Pause audio':'Play audio'} aria-busy={waiting} onClick={toggle} sx={{...controlSx,bgcolor:'primary.main',color:'primary.contrastText','&:hover':{bgcolor:'primary.dark'}}}>
    {waiting?<CircularProgress size={20} color="inherit"/>:playing?<PauseRoundedIcon/>:<PlayArrowRoundedIcon/>}
   </IconButton>
   <Box sx={{flex:1,minWidth:0,px:0.5}}>
    <Slider aria-label="Audio position" aria-valuetext={duration?`${time(elapsed)} of ${time(duration)}`:'Audio duration is not yet available'} min={0} max={duration??1} step={0.1} value={Math.min(elapsed,duration??0)} disabled={!duration} onChange={seek} sx={{display:'block',height:4,py:2.5,'& .MuiSlider-thumb':{width:12,height:12}}}/>
    <Typography component="span" variant="caption" sx={{display:'block',lineHeight:1,fontVariantNumeric:'tabular-nums',whiteSpace:'nowrap'}} aria-label={`Elapsed ${time(elapsed)}; ${duration?`duration ${time(duration)}`:'duration not yet available'}`}>{time(elapsed)} / {duration?time(duration):'—:—'}</Typography>
   </Box>
   <IconButton aria-label="Playback options" aria-haspopup="dialog" aria-expanded={Boolean(anchor)} aria-controls={anchor?optionsId:undefined} onClick={event=>setAnchor(event.currentTarget)} sx={controlSx}><MoreHorizIcon/></IconButton>
  </Stack>
  <Popover open={Boolean(anchor)} anchorEl={anchor} onClose={()=>setAnchor(null)} anchorOrigin={{vertical:'bottom',horizontal:'right'}} transformOrigin={{vertical:'top',horizontal:'right'}} PaperProps={{id:optionsId,role:'dialog','aria-label':'Audio playback options',sx:{p:1.5,width:272,maxWidth:'calc(100vw - 32px)'}}}>
   <Stack spacing={1}>
    <Stack direction="row" alignItems="center" spacing={1}>
     <IconButton aria-label={muted||volume===0?'Unmute audio':'Mute audio'} sx={controlSx} onClick={()=>{const element=audio.current;if(!element)return;if(element.muted||element.volume===0){element.muted=false;if(element.volume===0)element.volume=1;}else element.muted=true;setMuted(element.muted);setVolume(element.volume);}}>{muted||volume===0?<VolumeOffRoundedIcon/>:<VolumeUpRoundedIcon/>}</IconButton>
     <Slider aria-label="Audio volume" min={0} max={1} step={0.05} value={muted?0:volume} onChange={(_event,value)=>{const element=audio.current;if(!element)return;element.volume=Array.isArray(value)?value[0]!:value;element.muted=false;setVolume(element.volume);setMuted(false);}} sx={{height:4,py:2.5}}/>
    </Stack>
    <Typography variant="caption">Playback speed</Typography>
    <Stack direction="row" spacing={0.25} role="group" aria-label="Playback speed">{[0.75,1,1.25,1.5,2].map(speed=><Button key={speed} size="small" aria-pressed={rate===speed} variant={rate===speed?'contained':'text'} sx={{minWidth:44,minHeight:44,px:0.5}} onClick={()=>{if(audio.current)audio.current.playbackRate=speed;setRate(speed);}}>{speed}×</Button>)}</Stack>
    <Button href={downloadUrl} download onClick={()=>setAnchor(null)} sx={{minHeight:44}}>Download audio</Button>
   </Stack>
  </Popover>
  {error&&<Alert severity="warning" action={<Button sx={{minHeight:44}} onClick={()=>{setAnchor(null);setRetry(value=>value+1);}}>Retry</Button>}>{error}</Alert>}
 </Stack>;
}
