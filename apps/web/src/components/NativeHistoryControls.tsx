import {useEffect,useRef,useState} from 'react';
import {Alert,Box,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Paper,Select,Stack,Typography} from '@mui/material';
import type {AgentDto,HistoryReceipt,NativeHistoryInventory,NativeHistoryOperationResponse,NativeHistoryCancelResponse,NativeHistoryTrackingResponse,NativeHistoryTrackingRequest} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {currentProductScope} from '../api/productScope';
import {createClientId} from '../clientId';
import {useWorkspaceReadOnly} from './WorkspaceReadOnlyContext';
import {nativeHistoryHash,nativeInventoryValid,nativeReceiptMatches,nativeSavedCommandValid,nativePreviewFresh,nativeTrackingValid,type SavedNativeHistoryCommand} from './nativeHistory';

export function NativeHistoryControls({agent,onOpenAgent}:{agent:AgentDto;onOpenAgent(id:string):void}) {
 const scope=JSON.stringify([window.location.origin,currentProductScope(),agent.id]);
 return <NativeHistoryPanel key={scope} scope={scope} agent={agent} onOpenAgent={onOpenAgent}/>;
}
function NativeHistoryPanel({scope,agent,onOpenAgent}:{scope:string;agent:AgentDto;onOpenAgent(id:string):void}) {
 const path=`/api/agents/${encodeURIComponent(agent.id)}/native-history`,key=`native-history:${scope}`,trackingKey=`${key}:tracking`;
 const [restored]=useState(()=>{try{const raw=localStorage.getItem(key);if(!raw)return {};const command:unknown=JSON.parse(raw);return nativeSavedCommandValid(command,agent.id)?{command}:{error:'Saved native command invalid · actions held'};}catch{return {error:'Saved native command unavailable · actions held'};}});
 const [saved,setSaved]=useState<SavedNativeHistoryCommand|undefined>(restored.command),[storageError,setStorageError]=useState(restored.error??'');
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [inventory,setInventory]=useState<NativeHistoryInventory>(),[receipt,setReceipt]=useState<HistoryReceipt>();
 const [checkpoint,setCheckpoint]=useState(''),[cut,setCut]=useState(''),[target,setTarget]=useState('');
 const [rewindAck,setRewindAck]=useState(false),[forkAck,setForkAck]=useState(false),[confirm,setConfirm]=useState<SavedNativeHistoryCommand|'cancel'>(),[now,setNow]=useState(Date.now());
 const [tracking,setTracking]=useState<NativeHistoryTrackingResponse>(),[trackingChoice,setTrackingChoice]=useState(false),[trackingPending,setTrackingPending]=useState(false),[trackingError,setTrackingError]=useState('');
 const fence=useRef(false),mounted=useRef(true),owner=useRef('');
 const identity=JSON.stringify([agent.id,agent.projectId,agent.conversationId,agent.activeEngine,agent.workingCopy.rootPath,agent.workingCopy.state]);owner.current=identity;
 const readOnly=useWorkspaceReadOnly();
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
 useEffect(()=>{setInventory(undefined);setReceipt(undefined);setCheckpoint('');setCut('');setTarget('');setConfirm(undefined);setRewindAck(false);setForkAck(false);setTracking(undefined);},[identity]);
 useEffect(()=>{if(!open)return;const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[open]);
 const guarded=async(action:()=>Promise<void>)=>{
  if(fence.current)return;fence.current=true;setBusy(true);const original=identity;
  try{await action();}catch(error){if(mounted.current)setNotice(error instanceof Error?error.message:String(error));}
  finally{fence.current=false;if(mounted.current){setBusy(false);setConfirm(undefined);setRewindAck(false);setForkAck(false);if(owner.current!==original){setInventory(undefined);setReceipt(undefined);setTracking(undefined);setNotice('Agent identity changed · inspect original command · no replay');}}}
 };
 const current=()=>mounted.current&&owner.current===identity;
 const save=(command:SavedNativeHistoryCommand)=>{
  try{const bytes=localStorage.getItem(key);if(bytes&&(!saved||JSON.stringify(JSON.parse(bytes))!==JSON.stringify(saved)))throw Error('Original command conflict');localStorage.setItem(key,JSON.stringify(command));setSaved(command);}
  catch{setStorageError('Exact command could not be saved · native actions held');throw Error('Command storage unavailable · no POST sent');}
 };
 const accept=async(command:SavedNativeHistoryCommand,value:unknown)=>{
  if(!await nativeReceiptMatches(command,value))throw Error('Receipt differs from original command · outcome unknown · original key retained');
  if(!current())return;
  const r=value as HistoryReceipt;setReceipt(r);setNow(Date.now());
  setNotice(r.state==='started'?'Native outcome unknown · source held · no replay':r.kind==='fork'&&r.state==='prepared'?'Preparation only · source held · send a new human message to target':r.kind==='fork'&&r.state==='opened'?'Native context opened · acceptance unconfirmed · source effects unchanged':r.state==='cancelled'?'Unstarted preparation cancelled · no native work started':r.result?.native?.canRewind===false?'Native refusal · restoration unconfirmed':'Native receipt recorded · full restoration not proven');
 };
 const inspectInventory=()=>void guarded(async()=>{
  setInventory(undefined);setCheckpoint('');setCut('');setTarget('');setRewindAck(false);setForkAck(false);
  const value=await requestJson<unknown>(path,{cache:'no-store'});
  if(!await nativeInventoryValid(value,agent))throw Error('Exact native boundary/catalog unavailable');
  if(current()){setInventory(value as NativeHistoryInventory);setNotice('Canonical catalog loaded · server revalidates all actions');}
 });
 const inspectOriginal=()=>void guarded(async()=>{
  if(!saved)throw Error('No saved original command');setReceipt(undefined);
  const value=await requestJson<NativeHistoryOperationResponse>(`${path}?key=${encodeURIComponent(saved.body.idempotencyKey)}`,{cache:'no-store'});
  await accept(saved,value?.receipt);
 });
 const send=(command:SavedNativeHistoryCommand)=>void guarded(async()=>{
  if(readOnly||storageError||!inventory||inventory.held||!await nativeInventoryValid(inventory,agent)||!nativeSavedCommandValid(command,agent.id)||JSON.stringify(command.boundary)!==JSON.stringify(inventory.boundary)||command.body.boundaryHash!==inventory.boundaryHash||await nativeHistoryHash(command.boundary)!==command.body.boundaryHash)throw Error('Exact current native boundary unavailable · no POST sent');
  if(saved&&(!receipt||!terminal(receipt)))throw Error('Original command held · inspect original key');
  const body=command.body;
  if(body.operation==='preview'&&(!inventory.catalog.fileRewindSupported||!inventory.catalog.checkpoints.some(v=>v.messageId===body.checkpointId)))throw Error('Exact tracked checkpoint unavailable');
  if(command.body.operation==='rewind'&&(!command.preview||!nativePreviewFresh(command.preview.receipt,inventory,command.body.checkpointId)||!await nativeReceiptMatches({boundary:command.boundary,body:command.preview.body},command.preview.receipt)))throw Error('Physical preview expired or differs · no POST sent');
  if(body.operation==='fork'&&(!inventory.catalog.transcriptForkSupported||!inventory.catalog.forkPoints.includes(body.throughId)||!inventory.eligibleTargets.some(v=>v.agentId===body.targetAgentId)))throw Error('Exact completed cut or empty target unavailable');
  save(command);setReceipt(undefined);setInventory(undefined);setNotice('Original command saved · outcome unconfirmed');
  try{const value=await requestJson<NativeHistoryOperationResponse>(path,{method:'POST',body:JSON.stringify(command.body)});await accept(command,value?.receipt);}
  catch(error){throw Error(`Outcome unconfirmed · inspect original key · no replay · ${error instanceof Error?error.message:String(error)}`);}
 });
 const cancel=()=>void guarded(async()=>{
  if(readOnly||storageError||!saved||!receipt||receipt.kind!=='fork'||receipt.state!=='prepared'||!await nativeReceiptMatches(saved,receipt))throw Error('Only an exact unstarted preparation can be cancelled');
  const original={...saved,cancelRequested:true as const};save(original);setReceipt(undefined);setInventory(undefined);
  try{const value=await requestJson<NativeHistoryCancelResponse>(`${path}/cancel-preparation`,{method:'POST',body:JSON.stringify({key:saved.body.idempotencyKey})});if(value?.nativeInvoked!==false||value.receipt?.state!=='cancelled')throw Error('Cancellation proof unavailable');await accept(original,value.receipt);}
  catch(error){throw Error(`Cancellation unconfirmed · inspect original key · no replay · ${error instanceof Error?error.message:String(error)}`);}
 });
 const readTracking=()=>void guarded(async()=>{
  const value=await requestJson<unknown>(`${path}/tracking`,{cache:'no-store'});if(!nativeTrackingValid(value))throw Error('Tracking preference evidence unavailable');
  let raw:string|null;try{raw=localStorage.getItem(trackingKey);if(raw){const input:unknown=JSON.parse(raw);if(!validTrackingInput(input))throw Error('invalid');if(input.enabled===value.preference.enabled){localStorage.removeItem(trackingKey);setTrackingPending(false);}else setTrackingPending(true);}else setTrackingPending(false);}catch{setTrackingError('Saved tracking preference unavailable · changes held');throw Error('Tracking command storage unavailable');}
  if(current()){setTracking(value);setTrackingChoice(value.preference.enabled);setNotice(raw?'Current preference observed · previous save has no operation receipt':'Tracking preference loaded · next native session only');}
 });
 const saveTracking=()=>void guarded(async()=>{
  if(readOnly||!tracking||trackingPending||trackingError)throw Error('Inspect current tracking preference before saving');
  const input:NativeHistoryTrackingRequest={enabled:trackingChoice};
  try{if(localStorage.getItem(trackingKey))throw Error('pending');localStorage.setItem(trackingKey,JSON.stringify(input));}catch{setTrackingError('Tracking command could not be saved · change held');throw Error('No tracking POST sent');}
  setTrackingPending(true);
  try{const value=await requestJson<unknown>(`${path}/tracking`,{method:'POST',body:JSON.stringify(input)});if(!nativeTrackingValid(value)||value.preference.enabled!==input.enabled)throw Error('Preference response differs');if(!current())return;localStorage.removeItem(trackingKey);setTrackingPending(false);setTracking(value);setNotice('Preference saved · next native session only · no session opened');}
  catch(error){throw Error(`Tracking save unconfirmed · inspect preference · no retry · ${error instanceof Error?error.message:String(error)}`);}
 });
 const available=!busy&&!readOnly&&!storageError&&!!inventory&&!inventory.held&&(!saved||!!receipt&&terminal(receipt));
 const preview=saved?.body.operation==='preview'?receipt:receipt?saved?.preview?.receipt:undefined;
 const fresh=nativePreviewFresh(preview,inventory,checkpoint,now);
 const prepare=(operation:'rewind'|'fork')=>{
  if(!inventory||(operation==='rewind'?!rewindAck:!forkAck))return;
  if(operation==='rewind'&&saved?.body.operation==='preview'&&preview&&fresh)setConfirm({boundary:inventory.boundary,body:{operation:'rewind',idempotencyKey:createClientId('native-rewind:'),boundaryHash:inventory.boundaryHash,checkpointId:checkpoint,previewKey:preview.key,acknowledgeFileChanges:true},preview:{body:saved.body,receipt:preview}});
  if(operation==='fork')setConfirm({boundary:inventory.boundary,body:{operation:'fork',idempotencyKey:createClientId('native-fork:'),boundaryHash:inventory.boundaryHash,targetAgentId:target,throughId:cut,acknowledgeHistoryCopy:true}});
 };
 return <Paper variant="outlined" sx={{p:2}}>
  <Button onClick={()=>setOpen(true)}>Native File History & Transcript Fork</Button>
  <Dialog open={open} onClose={()=>{if(!busy)setOpen(false);}} fullWidth maxWidth="md">
   <DialogTitle>Native File History & Transcript Fork</DialogTitle>
   <DialogContent><Stack spacing={1.5} sx={{minWidth:0}}>
    <Evidence label="Source Agent" value={agent.id}/><Evidence label="Chat" value={agent.conversationId}/><Evidence label="Working Folder" value={agent.workingCopy.rootPath}/>
    {agent.activeEngine==='claude'?<>
     <Typography variant="subtitle2">Future Claude file tracking</Typography>
     <Button disabled={busy} onClick={readTracking}>Inspect Tracking Preference</Button>
     {tracking?<><Evidence label="Next Native Session" value={tracking.preference.enabled?'Tracking enabled':'Tracking disabled'}/><Evidence label="Preference Updated" value={tracking.preference.updatedAt}/><Evidence label="Retained Session" value={tracking.currentSession?.sessionId}/><Evidence label="Retained Startup Flag" value={tracking.currentSession?String(tracking.currentSession.trackingEnabled):'Unconfirmed'}/><Typography variant="caption">Startup configuration only · backup availability unproven</Typography><FormControlLabel control={<Checkbox checked={trackingChoice} disabled={busy||readOnly||trackingPending||!!trackingError} onChange={(_,checked)=>setTrackingChoice(checked)}/>} label="Track Supported Editor Changes In The Next Native Session"/><Button disabled={busy||readOnly||trackingPending||!!trackingError||trackingChoice===tracking.preference.enabled} onClick={saveTracking}>Save For Next Native Session</Button><Typography variant="caption">No restart · no retroactive backups · disabling retains existing backups</Typography></>:null}
     {trackingPending?<Alert severity="warning">Tracking save unconfirmed · inspect preference · no retry</Alert>:null}{trackingError?<Alert severity="error">{trackingError}</Alert>:null}
    </>:<Alert severity="info">Codex tracked-file rewind unavailable · transcript fork follows native capability</Alert>}
    <Stack direction={{xs:'column',sm:'row'}} spacing={1}><Button disabled={busy} onClick={inspectInventory}>Inspect Native History</Button><Button disabled={busy||!saved} onClick={inspectOriginal}>Inspect Original Command</Button></Stack>
    {inventory?<>
     <Evidence label="Native Session" value={inventory.boundary.sessionId}/><Evidence label="Completed source Run / fence" value={`${inventory.boundary.runId} / ${inventory.boundary.fence}`}/><Evidence label="Contract Hash" value={inventory.boundary.toolContractHash}/><Evidence label="Boundary Hash" value={inventory.boundaryHash}/><Evidence label="Source Held" value={String(inventory.held)}/><Evidence label="Catalog Startup Tracking Flag" value={inventory.catalog.trackingEnabled===undefined?'Unconfirmed':String(inventory.catalog.trackingEnabled)}/><Evidence label="Native file rewind / transcript fork" value={`${inventory.catalog.fileRewindSupported} / ${inventory.catalog.transcriptForkSupported}`}/>
     {!inventory.catalog.fileRewindSupported?<Alert severity="info">Tracked-file rewind unavailable for this retained session</Alert>:<>
      <Select size="small" displayEmpty inputProps={{'aria-label':'Native File Checkpoint'}} value={checkpoint} disabled={!available} onChange={event=>{setCheckpoint(event.target.value);setRewindAck(false);setForkAck(false);}}><MenuItem value="">Select Exact Tracked Checkpoint</MenuItem>{inventory.catalog.checkpoints.map(point=><MenuItem key={point.messageId} value={point.messageId} sx={{whiteSpace:'normal',overflowWrap:'anywhere'}}>{point.messageId}</MenuItem>)}</Select>
      {!inventory.catalog.checkpoints.length?<Typography variant="caption">No retained tracked checkpoints</Typography>:null}
      <Button disabled={!available||!checkpoint} onClick={()=>send({boundary:inventory.boundary,body:{operation:'preview',idempotencyKey:createClientId('native-preview:'),boundaryHash:inventory.boundaryHash,checkpointId:checkpoint}})}>Preview Tracked File Rewind</Button>
      <Evidence label="Current Write Permission" value="Not exposed by catalog · server rechecks policy, managed writers and physical facts"/>
      <FormControlLabel control={<Checkbox checked={rewindAck} disabled={!available||!fresh} onChange={(_,checked)=>setRewindAck(checked)}/>} label="Tracked files may be restored or deleted; conversation and external effects stay unchanged"/>
      <Button disabled={!available||!rewindAck||!fresh} onClick={()=>prepare('rewind')}>Rewind Tracked Files</Button>
     </>}
     {inventory.catalog.transcriptForkSupported?<>
      <Select size="small" displayEmpty inputProps={{'aria-label':'Completed Native Fork Boundary'}} value={cut} disabled={!available} onChange={event=>{setCut(event.target.value);setRewindAck(false);setForkAck(false);}}><MenuItem value="">Select Completed Native Boundary</MenuItem>{inventory.catalog.forkPoints.map(id=><MenuItem key={id} value={id} sx={{whiteSpace:'normal',overflowWrap:'anywhere'}}>{id}</MenuItem>)}</Select>
      <Select size="small" displayEmpty inputProps={{'aria-label':'Empty Fork Target Agent'}} value={target} disabled={!available} onChange={event=>{setTarget(event.target.value);setRewindAck(false);setForkAck(false);}}><MenuItem value="">Select Server-Verified Empty Agent</MenuItem>{inventory.eligibleTargets.map(item=><MenuItem key={item.agentId} value={item.agentId} sx={{whiteSpace:'normal',overflowWrap:'anywhere'}}>Empty Agent · {item.agentId}</MenuItem>)}</Select>
      {!inventory.eligibleTargets.length?<Typography variant="caption">No eligible empty Agent · use ordinary Agent creation in this Chat</Typography>:null}
      <Typography variant="caption">Same Chat, engine and folder · server revalidates emptiness</Typography>
      <FormControlLabel control={<Checkbox checked={forkAck} disabled={!available||!cut||!target} onChange={(_,checked)=>setForkAck(checked)}/>} label="Copy transcript context only; old tools, Requests, effects and grants gain no authority"/>
      <Button disabled={!available||!cut||!target||!forkAck} onClick={()=>prepare('fork')}>Fork Transcript Into New Agent</Button>
     </>:<Alert severity="info">Transcript fork unavailable for this retained session</Alert>}
    </>:null}
    {saved?<><Evidence label="Original operation / key" value={`${saved.body.operation} / ${saved.body.idempotencyKey}`}/><Evidence label="Original Boundary Hash" value={saved.body.boundaryHash}/><Evidence label="Original session / Run / fence" value={`${saved.boundary.sessionId} / ${saved.boundary.runId} / ${saved.boundary.fence}`}/><Evidence label="Original Project / Chat / engine" value={`${saved.boundary.projectId} / ${saved.boundary.conversationId} / ${saved.boundary.engine}`}/><Evidence label="Original Working Folder" value={saved.boundary.rootPath}/><Evidence label="Original Contract Hash" value={saved.boundary.toolContractHash}/><Evidence label={saved.body.operation==='fork'?'Original transcript cut / target':'Original Checkpoint'} value={saved.body.operation==='fork'?`${saved.body.throughId} / ${saved.body.targetAgentId}`:saved.body.checkpointId}/>{!receipt?<Alert severity="warning">Outcome unconfirmed · exact-key readback required · no POST replay</Alert>:<ReceiptEvidence receipt={receipt}/>}{saved.cancelRequested&&receipt?.state!=='cancelled'?<Alert severity="warning">Cancellation unconfirmed · inspect original key</Alert>:null}</>:null}
    {preview?<PreviewEvidence receipt={preview} now={now}/>:null}
    {receipt?.kind==='fork'&&saved?.body.operation==='fork'?<>
     <Typography variant="caption">Preparation is not work · source held until native boundary permits progress</Typography>
     <Typography variant="caption">A new human message to the target starts its scheduler Run</Typography>
     <Button onClick={()=>onOpenAgent(saved.body.operation==='fork'?saved.body.targetAgentId:'')}>Open Target Agent</Button>
     <Button disabled={busy||readOnly||!!storageError||receipt.state!=='prepared'} onClick={()=>setConfirm('cancel')}>Cancel Unstarted Preparation</Button>
    </>:null}
    {saved&&receipt&&terminal(receipt)?<Button disabled={busy||readOnly} onClick={()=>{try{localStorage.removeItem(key);setSaved(undefined);setReceipt(undefined);setInventory(undefined);setCheckpoint('');setCut('');setTarget('');setRewindAck(false);setForkAck(false);setNotice('Inspect current catalog for a separate operation');}catch{setStorageError('Original command could not be cleared · actions held');}}}>Start A New Review</Button>:null}
    {storageError?<Alert severity="error">{storageError}</Alert>:null}
    <Typography variant="caption">No Branch restore · no original Run or external-effect settlement</Typography>
    {notice?<Alert severity="info" role="status">{notice}</Alert>:null}
   </Stack></DialogContent>
   <DialogActions><Button disabled={busy} onClick={()=>setOpen(false)}>Close</Button></DialogActions>
  </Dialog>
  <Dialog open={!!confirm} onClose={()=>{if(!busy)setConfirm(undefined);}} fullWidth maxWidth="sm">
   <DialogTitle>{confirm==='cancel'?'Cancel Unstarted Preparation?':confirm?.body.operation==='rewind'?'Restore Or Delete Tracked Files?':'Prepare Transcript Fork?'}</DialogTitle>
   <DialogContent><Stack spacing={1}>{confirm==='cancel'?<Evidence label="Original Fork Key" value={saved?.body.idempotencyKey}/>:confirm?<><Evidence label="Exact Boundary Hash" value={confirm.body.boundaryHash}/>{confirm.body.operation==='rewind'?<><Evidence label="Checkpoint / preview key" value={`${confirm.body.checkpointId} / ${confirm.body.previewKey}`}/><Typography variant="body2">Tracked files may be restored or deleted</Typography><Typography variant="caption">Conversation and external effects unchanged · independent host writers are not locked</Typography></>:confirm.body.operation==='fork'?<><Evidence label="Completed Native Boundary" value={confirm.body.throughId}/><Evidence label="Empty Target Agent" value={confirm.body.targetAgentId}/><Typography variant="body2">Prepare context only · hold source · no work starts</Typography><Typography variant="caption">Send a separate new human message to start the target</Typography></>:null}</>:null}</Stack></DialogContent>
   <DialogActions><Button disabled={busy} onClick={()=>setConfirm(undefined)}>Back</Button><Button disabled={busy||readOnly} onClick={()=>{if(confirm==='cancel')cancel();else if(confirm)send(confirm);}}>Confirm Native Action</Button></DialogActions>
  </Dialog>
 </Paper>;
}
const terminal=(receipt:HistoryReceipt)=>receipt.state==='completed'||receipt.state==='cancelled'||receipt.state==='opened';
function validTrackingInput(value:unknown):value is NativeHistoryTrackingRequest {return !!value&&typeof value==='object'&&Object.keys(value).length===1&&typeof (value as NativeHistoryTrackingRequest).enabled==='boolean';}
function Evidence({label,value}:{label:string;value:unknown}) {return <Typography variant="caption" sx={{overflowWrap:'anywhere'}}><strong>{label}</strong> · {value===undefined?'Unavailable':String(value)}</Typography>;}
function ReceiptEvidence({receipt}:{receipt:HistoryReceipt}) {return <Stack spacing={.5}>
 <Evidence label="Receipt / state" value={`${receipt.id} / ${receipt.state}`}/><Evidence label="Created" value={receipt.createdAt}/><Evidence label="Request Hash" value={receipt.requestHash}/><Evidence label="Input Hash" value={receipt.inputHash}/>
 {receipt.kind==='fork'?<><Evidence label="Target Agent" value={receipt.targetAgentId}/><Evidence label="Target Run / fence" value={receipt.targetRunId?`${receipt.targetRunId} / ${receipt.targetFence}`:undefined}/><Evidence label={receipt.result?.nativeSessionId?'Observed Fresh Native ID':'Reserved Native ID · Unobserved'} value={receipt.newSessionId}/><Evidence label="Native context accepted / replay authorized" value={receipt.result?`${receipt.result.contextAccepted} / ${receipt.result.replayAuthorized}`:'Not observed / false'}/><Typography variant="caption">Normal Run snapshot acceptance unconfirmed</Typography></>:<><Evidence label="Native outcome / canRewind" value={`${receipt.result?.native?.outcome??'Unavailable'} / ${receipt.result?.native?.canRewind??'Unavailable'}`}/><Evidence label="Native Error" value={receipt.result?.native?.error}/><Evidence label="Insertions / deletions / skipped links" value={`${receipt.result?.native?.insertions??'Unavailable'} / ${receipt.result?.native?.deletions??'Unavailable'} / ${receipt.result?.native?.skippedLinks??'Unavailable'}`}/></>}
 </Stack>;}
function PreviewEvidence({receipt,now}:{receipt:HistoryReceipt;now:number}) {return <Stack spacing={.5}>
 <Typography variant="subtitle2">Saved Physical Preview</Typography><Evidence label="Preview Key" value={receipt.key}/><Evidence label="Created / 60-second expiry" value={`${receipt.createdAt} / ${new Date(Date.parse(receipt.createdAt)+60000).toISOString()}`}/><Evidence label="Age / time window" value={`${Math.max(0,Math.floor((now-Date.parse(receipt.createdAt))/1000))} s / ${now>=Date.parse(receipt.createdAt)&&now-Date.parse(receipt.createdAt)<=60000}`}/><Evidence label="Exact Boundary Hash" value={receipt.result?.boundaryHash}/>
 <Box component="ul" sx={{m:0,pl:2,overflowWrap:'anywhere'}} aria-label="Native Changed Files">{receipt.result?.native?.filesChanged?.map((path,index)=><li key={index}>{path}</li>)}</Box>
 <Box component="pre" aria-label="Physical File And Ancestor Evidence" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:280,overflow:'auto',m:0}}>{receipt.result?.facts?JSON.stringify(receipt.result.facts,null,2):'Physical evidence unavailable'}</Box>
 <Typography variant="caption">Ancestors · [path, device, inode, mode, uid, gid] · hashes bind current bytes</Typography>
 </Stack>;}
