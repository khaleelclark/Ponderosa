import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Select,Stack,Typography} from '@mui/material';
import type {BrowserConsoleQuery,BrowserConsoleResult,BrowserOperatorRecordingResult,BrowserRecordingData,BrowserRecordingStatus,BrowserRecordingDestination,ConversationDto} from '@ponderosa/core';
import {api} from '../../api';
import {requestJson} from '../../api/real';
import {currentProductScope,productApiPath} from '../../api/productScope';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import type {BrowserEndpointAdapter,BrowserSession} from './browserAdapters';
import {consoleResultValid,recordingArtifactValid,recordingCommandValid,recordingDataValid,recordingStatusValid,recordingDestinationValid,type RecordingCommand} from './browserObservation';

export function BrowserObservations({adapter,session,pageId,busy=false}:{adapter:BrowserEndpointAdapter<BrowserSession>;session?:BrowserSession;pageId?:string;busy?:boolean}) {
 const scope=JSON.stringify([window.location.origin,currentProductScope(),adapter.queryKey,...(adapter.sharedRecording?[adapter.sharedRecording.projectId,adapter.sharedRecording.conversationId??null]:[])]);
 return <ObservationControls key={scope} scope={scope} adapter={adapter} session={session} pageId={pageId} busy={busy}/>;
}
function ObservationControls({scope,adapter,session,pageId,busy}:{scope:string;adapter:BrowserEndpointAdapter<BrowserSession>;session?:BrowserSession;pageId?:string;busy:boolean}) {
 const [storageKey]=useState(()=>{
  const key=`browser-recording:${scope}`;
  if(!adapter.sharedRecording)return key;
  // Retain pre-isolation commands in their original destination scope; never move or clear them on Project switch.
  const legacy=`browser-recording:${JSON.stringify([window.location.origin,currentProductScope(),adapter.queryKey])}`;
  try{
   if(localStorage.getItem(key)!==null||localStorage.getItem(`${key}:destination`)!==null)return key;
   const command=localStorage.getItem(legacy),binding=localStorage.getItem(`${legacy}:destination`);
   const destination:unknown=binding?JSON.parse(binding):command?JSON.parse(command).destinationEvidence:undefined;
   if(recordingDestinationValid(destination)&&destination.projectId===adapter.sharedRecording.projectId&&(!adapter.sharedRecording.conversationId||destination.conversationId===adapter.sharedRecording.conversationId))return legacy;
   if(command&&(!recordingCommandValid(JSON.parse(command))||!recordingDestinationValid(destination)))return legacy;
  }catch{return legacy;}
  return key;
 });
 const [restored]=useState(()=>{try{const bytes=localStorage.getItem(storageKey);if(!bytes)return {};const command:unknown=JSON.parse(bytes);return recordingCommandValid(command)?{command}:{error:'Saved recording command invalid · new attempts held'};}catch{return {error:'Saved recording command unavailable · new attempts held'};}});
 const destinationKey=`${storageKey}:destination`;
 const [binding]=useState(()=>{try{const raw=localStorage.getItem(destinationKey);if(!raw&&!restored.command?.destinationEvidence)return {};const value:unknown=raw?JSON.parse(raw):restored.command!.destinationEvidence;if(!recordingDestinationValid(value)||!adapter.sharedRecording||value.projectId!==adapter.sharedRecording.projectId||adapter.sharedRecording.conversationId&&value.conversationId!==adapter.sharedRecording.conversationId)throw Error();return {value};}catch{return {error:'Saved recording destination invalid · recording held'};}});
 const [bound,setBound]=useState<BrowserRecordingDestination|undefined>(binding.value),[choices,setChoices]=useState<ConversationDto[]>([]),[choice,setChoice]=useState('');
 const shared=adapter.sharedRecording;
 const destination=bound??(shared?.conversationId?{projectId:shared.projectId,conversationId:shared.conversationId}:shared&&choice?{projectId:shared.projectId,conversationId:choice}:undefined);
 const destinationReady=!shared||!!destination;
 const [pending,setPending]=useState<RecordingCommand|undefined>(restored.command);
 const [storageError,setStorageError]=useState(restored.error??binding.error??'');
 const [open,setOpen]=useState(false),[working,setWorking]=useState(false),[message,setMessage]=useState('');
 const [level,setLevel]=useState<BrowserConsoleQuery['level']>(),[consolePage,setConsolePage]=useState<BrowserConsoleResult>();
 const [recording,setRecording]=useState<BrowserRecordingStatus>(),[artifact,setArtifact]=useState<BrowserOperatorRecordingResult>();
 const [checked,setChecked]=useState(false),[unknown,setUnknown]=useState(Boolean(restored.command)),[ack,setAck]=useState(false),[confirm,setConfirm]=useState<RecordingCommand>();
 const fence=useRef(false),live=useRef(''),mounted=useRef(true);
 const authority=session?JSON.stringify([scope,session.id,session.controlEpoch,session.controlOwner,session.status,session.localPaused,session.manualControl,session.privateSignIn]):'';
 live.current=authority;
 const consoleScope=useRef('');consoleScope.current=JSON.stringify([authority,pageId,level]);
 const readOnly=useWorkspaceReadOnly();
 const admitted=!!session&&session.status==='ready'&&session.controlOwner==='operator'&&!session.localPaused&&!session.privateSignIn&&(!session.manualControl||session.manualControl==='automation');
 const available=admitted&&!readOnly&&!busy&&!working&&!!adapter.observations;
 const selected=!!pageId&&!!session?.pages.some(page=>page.id===pageId);
 useLayoutEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
 useEffect(()=>{setConsolePage(undefined);},[authority,pageId,level]);
 useEffect(()=>{setChecked(false);setRecording(undefined);setArtifact(undefined);setConfirm(undefined);setAck(false);if(pending)setUnknown(true);},[authority]);
 const guarded=async(action:()=>Promise<void>,mutation=false)=>{
  if(fence.current||!available)return;
  fence.current=true;setWorking(true);const original=authority;
  try{await action();}catch(error){if(mounted.current){setMessage(`${mutation?'Outcome unknown · inspect status and Project artifacts · ':''}${error instanceof Error?error.message:String(error)}`);if(mutation)setUnknown(true);}}
  finally{fence.current=false;if(mounted.current){setWorking(false);setConfirm(undefined);setAck(false);if(live.current!==original){setChecked(false);setRecording(undefined);setArtifact(undefined);setUnknown(true);setMessage('Browser authority changed · outcome unconfirmed · inspect Project artifacts');}}}
 };
 const context=()=>({sessionId:session!.id,expectedControlEpoch:session!.controlEpoch,...(destination?{destination:{conversationId:destination.conversationId}}:{})});
 
 const clearPending=()=>{localStorage.removeItem(storageKey);setPending(undefined);};
 const inspect=()=>void guarded(async()=>{
  if(!destinationReady)throw Error('Select exact destination Chat');
  const original=authority,result=await adapter.observations!.recordingStatus(context());
  if(live.current!==original||!mounted.current)return;
  if(!result||typeof result!=='object'||(shared&&result.recording&&(!recordingDestinationValid(result.destination)||result.destination.projectId!==destination?.projectId||result.destination.conversationId!==destination?.conversationId))||(result.recording&&!recordingStatusValid(result.recording))||(result.artifact&&(!result.recording||!recordingArtifactValid(result.artifact,adapter.recordingProjectId!,destination))))throw Error('Recording status proof unavailable');
  if(pending){
   if(JSON.stringify(pending.context)!==JSON.stringify(context())||JSON.stringify(pending.destinationEvidence)!==JSON.stringify(destination))throw Error('Original session/epoch changed · command retained');
   const matches=result.recording&&(pending.operation==='start'?result.recording.pageId===pending.pageId&&result.recording.id!==pending.previousRecordingId:result.recording.id===pending.recordingId&&!!result.artifact);
   if(!matches)throw Error('Original outcome unconfirmed · command retained');
   try{clearPending();}catch{setStorageError('Saved recording command could not be cleared · new attempts held');}
  }
  if(shared&&result.recording&&destination){
   setBound(destination);
   try{localStorage.setItem(destinationKey,JSON.stringify(destination));}catch{setStorageError('Recording destination could not be saved · new attempts held');}
  }
  setRecording(result.recording);setArtifact(result.artifact);setChecked(true);setUnknown(false);setMessage(result.artifact?'Managed recording recovered':result.recording?'Original recording recovered':'No recording receipt · status is not crash-durable');
 });
 const send=(command:RecordingCommand)=>void guarded(async()=>{
  if(!destinationReady||storageError||pending||!recordingCommandValid(command)||JSON.stringify(command.context)!==JSON.stringify(context())||(command.operation==='start'&&(command.pageId!==session?.activePageId||command.pageId!==pageId))||(command.operation==='stop'&&command.recordingId!==recording?.id))throw Error('Original recording scope unavailable');
  if(shared&&(!command.destinationEvidence||JSON.stringify(command.destinationEvidence)!==JSON.stringify(destination)))throw Error('Exact destination evidence missing');
  try{if(localStorage.getItem(storageKey))throw Error('Saved command already exists');localStorage.setItem(storageKey,JSON.stringify(command));if(command.destinationEvidence){localStorage.setItem(destinationKey,JSON.stringify(command.destinationEvidence));setBound(command.destinationEvidence);}}catch{setStorageError('Recording command could not be saved · new attempts held');throw Error('Recording command storage unavailable');}
  setPending(command);const original=authority;
  if(command.operation==='start'){
   const result=await adapter.observations!.startRecording({...command.context,pageId:command.pageId});
   if(!recordingStatusValid(result)||result.pageId!==command.pageId||result.id===command.previousRecordingId)throw Error('Recording start receipt differs');
   if(live.current!==original||!mounted.current)return;
   setRecording(result);setArtifact(undefined);
  }else{
   const result=await adapter.observations!.stopRecording({...command.context,recordingId:command.recordingId});
   if(!recordingArtifactValid(result,adapter.recordingProjectId!,command.destinationEvidence))throw Error('Managed artifact receipt differs');
   if(live.current!==original||!mounted.current)return;
   setArtifact(result);
  }
  clearPending();setUnknown(false);setChecked(true);setMessage(command.operation==='start'?'Recording started · stop explicitly to publish':'Managed JPEG-frame JSON published');
 },true);
 const queryConsole=(after?:number)=>void guarded(async()=>{
  if(!selected)throw Error('Select an admitted page');
  const original=consoleScope.current,selectedPage=pageId!,filter=level;
  const result=await adapter.observations!.console({...context(),query:{pageId:selectedPage,limit:50,...(after===undefined?{}:{after}),...(filter?{level:filter}:{})}});
  if(!consoleResultValid(result,selectedPage,after,filter))throw Error('Console evidence unavailable');
  if(consoleScope.current===original&&mounted.current)setConsolePage(result);
 });
 return <Box sx={{flexShrink:0,px:1}}>
  <Button size="small" onClick={()=>setOpen(true)}>Console & recording</Button>
  <Dialog open={open} onClose={()=>setOpen(false)} fullWidth maxWidth="sm">
   <DialogTitle>Console & recording</DialogTitle>
   <DialogContent><Stack spacing={1} sx={{minWidth:0}}>
    <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Page · {pageId??'unavailable'}</Typography>
    {!admitted?<Alert severity="info">Take operator control and resume the browser connection</Alert>:null}
    <Stack direction={{xs:'column',sm:'row'}} spacing={1}>
     <Select size="small" inputProps={{'aria-label':'Console level'}} value={level??'all'} disabled={working} onChange={event=>{setLevel(event.target.value==='all'?undefined:event.target.value as BrowserConsoleQuery['level']);setConsolePage(undefined);}}>
      <MenuItem value="all">All levels</MenuItem>{['log','info','warning','error'].map(value=><MenuItem key={value} value={value}>{value}</MenuItem>)}
     </Select>
     <Button disabled={!available||!selected} onClick={()=>queryConsole()}>Query console</Button>
     <Button disabled={!available||!selected||!consolePage} onClick={()=>queryConsole(consolePage!.next)}>Next console entries</Button>
    </Stack>
    {consolePage?<><Typography variant="caption">Cursor · {consolePage.next} · {consolePage.entries.length} entries</Typography>{consolePage.truncated?<Alert severity="warning">Earlier console entries evicted</Alert>:null}<Box component="ol" aria-label="Console entries" sx={{m:0,pl:3,maxHeight:240,overflow:'auto',overflowWrap:'anywhere'}}>{consolePage.entries.map(entry=><li key={entry.sequence}><Typography variant="caption">{entry.at} · {entry.level} · {entry.pageId}</Typography><Box component="pre" sx={{whiteSpace:'pre-wrap',m:0}}>{entry.text}</Box>{entry.textTruncated?<Typography variant="caption" color="warning.main">Console entry shortened · first 4,000 characters</Typography>:null}</li>)}</Box>{!consolePage.entries.length?<Typography role="status" variant="caption">No matching entries</Typography>:null}</>:null}
    {!adapter.recordingProjectId?<Alert severity="info">Recording destination unavailable</Alert>:<>
     {shared?<><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Producer · Operator · destination {destination?`${destination.projectId} / ${destination.conversationId}`:'select a live Chat'}</Typography>{!shared.conversationId&&!bound?<Stack direction={{xs:'column',sm:'row'}} spacing={1}><Button disabled={!available||!!pending} onClick={()=>void guarded(async()=>{setChoices([]);setChoice('');setChecked(false);const original=authority,chats=await api.listConversations(shared.projectId);if(!mounted.current||live.current!==original)return;setChoices(chats.filter(chat=>chat.projectId===shared.projectId&&!chat.deletedAt&&!chat.executionId));})}>Load destination Chats</Button><Select size="small" inputProps={{'aria-label':'Recording destination Chat'}} value={choice} disabled={working||!!pending} onChange={event=>{setChoice(event.target.value);setChecked(false);setRecording(undefined);setArtifact(undefined);}}><MenuItem value="">Choose Chat</MenuItem>{choices.map(chat=><MenuItem key={chat.id} value={chat.id}>{chat.title} · {chat.id}</MenuItem>)}</Select></Stack>:null}<Typography variant="caption">Current access and active Chat ownership revalidated by server · no Agent sharing</Typography></>:null}
     <Typography variant="caption">JPEG frames · 60 s / 120 frames / 8 MiB limit · no audio</Typography>
     <Stack direction={{xs:'column',sm:'row'}} spacing={1}>
      <Button disabled={!available||!destinationReady} onClick={inspect}>Inspect recording status</Button>
      <Button disabled={!available||!destinationReady||!!storageError||!!pending||unknown||!checked||(!!recording&&!artifact)||!selected||pageId!==session?.activePageId} onClick={()=>setConfirm({context:context(),...(destination?{destinationEvidence:destination}:{}),operation:'start',pageId:pageId!,...(recording?{previousRecordingId:recording.id}:{})})}>Start recording</Button>
      <Button disabled={!available||!destinationReady||!!storageError||!!pending||unknown||!recording||!!artifact} onClick={()=>send({context:context(),...(destination?{destinationEvidence:destination}:{}),operation:'stop',recordingId:recording!.id})}>Stop & publish JSON</Button>
     </Stack>
     {recording?<Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Recording · {recording.id} · {recording.pageId} · {recording.startedAt}</Typography>:null}
     {unknown||pending?<Alert severity="warning">Outcome unconfirmed · no replay · inspect status and Project artifacts</Alert>:null}
     {pending?<Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Original {pending.operation} · session {pending.context.sessionId} · epoch {pending.context.expectedControlEpoch}</Typography>:null}
     {storageError?<Alert severity="error">{storageError}</Alert>:null}
     {unknown||pending?<><FormControlLabel control={<Checkbox checked={ack} disabled={working} onChange={(_,value)=>setAck(value)}/>} label="I inspected Project artifacts; the previous outcome may remain unknown"/><Button disabled={!available||!ack||!!storageError} onClick={()=>{try{clearPending();setUnknown(false);setRecording(undefined);setArtifact(undefined);setChecked(false);setAck(false);setMessage('Previous outcome unresolved · inspect current status before a new attempt');}catch{setStorageError('Saved command could not be cleared · new attempts held');}}}>Allow deliberate new attempt</Button></>:null}
     {artifact&&recording?<RecordingPlayback key={artifact.artifactId} status={recording} artifact={artifact}/>:null}
    </>}
    {message?<Alert severity="info" role="status">{message}</Alert>:null}
   </Stack></DialogContent>
   <DialogActions><Button onClick={()=>setOpen(false)}>Close</Button></DialogActions>
  </Dialog>
  <Dialog open={!!confirm} onClose={()=>{if(!working)setConfirm(undefined);}} fullWidth maxWidth="xs">
   <DialogTitle>Record this page?</DialogTitle><DialogContent><Typography variant="body2">Visible sensitive data may be captured</Typography><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Page · {confirm?.operation==='start'?confirm.pageId:''}</Typography></DialogContent>
   <DialogActions><Button disabled={working} onClick={()=>setConfirm(undefined)}>Cancel</Button><Button disabled={!available} onClick={()=>{if(confirm)send(confirm);}}>Confirm recording</Button></DialogActions>
  </Dialog>
 </Box>;
}
function RecordingPlayback({status,artifact}:{status:BrowserRecordingStatus;artifact:BrowserOperatorRecordingResult}) {
 const [data,setData]=useState<BrowserRecordingData>(),[index,setIndex]=useState(0),[playing,setPlaying]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const frame=data?.frames[index];
 useEffect(()=>{if(!playing||!data)return;const next=data.frames[index+1];if(!next||(index>=0&&!frame)){setPlaying(false);return;}const timer=setTimeout(()=>setIndex(index+1),Math.max(0,next.atMs-(frame?.atMs??0)));return ()=>clearTimeout(timer);},[playing,index,data,frame]);
 return <Stack spacing={1}>
  <Typography variant="caption">{artifact.frames} JPEG frames · {artifact.reason}</Typography>
  <Stack direction={{xs:'column',sm:'row'}} spacing={1}><Button component="a" href={productApiPath(artifact.downloadUrl)} download>Download frame JSON</Button><Button disabled={loading} onClick={()=>{setLoading(true);void requestJson<unknown>(artifact.downloadUrl,{cache:'no-store'}).then(value=>{if(!recordingDataValid(value,status,artifact))throw Error('Managed recording data differs');setData(value);setIndex(0);setPlaying(false);setError('');}).catch(error=>setError(error.message)).finally(()=>setLoading(false));}}>Load playback</Button></Stack>
  {data?<>{!frame?<Typography role="status" variant="caption">Waiting for first frame</Typography>:<><Box component="img" alt={`Recorded page ${status.pageId}, frame ${index+1}`} src={`data:image/jpeg;base64,${frame.jpeg}`} sx={{width:'100%',maxHeight:300,objectFit:'contain'}}/><Typography variant="caption">Frame {index+1}/{data.frames.length} · {frame.atMs} ms</Typography></>}<Stack direction={{xs:'column',sm:'row'}}><Button onClick={()=>{setIndex(-1);setPlaying(true);}}>Play from start</Button><Button onClick={()=>setPlaying(false)}>Pause</Button><Button disabled={playing||index<=0} onClick={()=>setIndex(index-1)}>Previous frame</Button><Button disabled={playing||index===data.frames.length-1} onClick={()=>setIndex(index+1)}>Next frame</Button></Stack></>:null}
  {error?<Alert severity="error">{error}</Alert>:null}
 </Stack>;
}
