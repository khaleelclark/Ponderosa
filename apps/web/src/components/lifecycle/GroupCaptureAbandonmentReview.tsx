import {useRef,useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,Typography} from '@mui/material';
import type {LifecycleGroupCaptureEntry,CheckpointGroupCaptureAbandonmentReviewDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {currentProductScope} from '../../api/productScope';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import {groupAbandonmentStorageKey,groupCaptureAbandonmentPath,groupAbandonmentReviewMatches,groupAbandonmentHeld,groupAbandonmentReceiptMatches,groupAbandonmentReceiptSummary,restoreGroupAbandonment,retainedGroupAbandonments,type GroupAbandonmentCommand} from './groupCaptureAbandonment';
const Evidence=({title,value}:{title:string;value:unknown})=><details><summary>{title}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(value,null,2)}</Typography></details>;
export function GroupCaptureAbandonmentReview({entry,recoveryOnly=false}:{entry:LifecycleGroupCaptureEntry;recoveryOnly?:boolean}):JSX.Element {
 const key=groupAbandonmentStorageKey(window.location.origin,currentProductScope(),entry);
 const [restored]=useState(()=>restoreGroupAbandonment(key,entry)),[pending,setPending]=useState(restored.command);
 const [open,setOpen]=useState(false),[review,setReview]=useState<CheckpointGroupCaptureAbandonmentReviewDto>(),[ack,setAck]=useState(false),[confirm,setConfirm]=useState<GroupAbandonmentCommand>(),[notice,setNotice]=useState(''),[receipt,setReceipt]=useState<unknown>();
 const readOnly=useWorkspaceReadOnly()||Boolean(restored.error),fence=useRef(false),epoch=useRef(0);
 const reset=()=>{epoch.current++;setReview(undefined);setAck(false);setConfirm(undefined);};
 const preview=useMutation({retry:false,mutationFn:async()=>{
  reset();const token=epoch.current;
  const value=await requestJson<CheckpointGroupCaptureAbandonmentReviewDto>('/api/lifecycle/checkpoint-capture-groups/abandonment-review',{method:'POST',body:JSON.stringify({executionId:entry.executionId,captureKey:entry.captureKey})});
  if(!groupAbandonmentReviewMatches(value,entry))throw Error('Whole-group identity or member evidence differs; refresh discovery explicitly.');
  if(token===epoch.current)setReview(value);
 },onError:error=>{reset();setNotice(error.message);}});
 const send=useMutation({retry:false,mutationFn:async(command:GroupAbandonmentCommand)=>{
  if(readOnly||commandInvalid(command))throw Error('Whole-group original command unavailable.');
  localStorage.setItem(key,JSON.stringify(command));setPending(command);reset();setNotice('');
  const value=await requestJson(groupCaptureAbandonmentPath,{method:'POST',body:JSON.stringify(command.input)});
  if(!groupAbandonmentReceiptMatches(command,value))throw Error('Receipt differs from the original whole-group command or package inventory.');
  setReceipt(groupAbandonmentReceiptSummary(value));localStorage.removeItem(key);setPending(undefined);setNotice('Whole-group abandonment confirmed · original bytes retained · disk space and history were not reclaimed');
 },onError:error=>{setNotice(`Outcome unconfirmed · all group SQL cleanup pins held · partial filesystem progress supplies no success proof · ${error.message}`);if(error instanceof ApiRequestError&&error.status===409)reset();},onSettled:()=>{fence.current=false;setConfirm(undefined);setAck(false);}});
 function commandInvalid(command:GroupAbandonmentCommand):boolean {
  return command.input.executionId!==entry.executionId||command.input.captureKey!==entry.captureKey||command.input.preserveEvidence!==true||command.input.reviewSha256!==command.review.reviewSha256||!groupAbandonmentReviewMatches(command.review,entry)||groupAbandonmentHeld(command.review);
 }
 const busy=preview.isPending||send.isPending,ready=!readOnly&&!busy&&!pending&&!recoveryOnly&&!receipt&&ack&&Boolean(review&&!groupAbandonmentHeld(review));
 return <><Button onClick={()=>{reset();setOpen(true);}}>{recoveryOnly?'Recover Retained Whole-Group Command':'Review Whole-Group Capture Abandonment'}</Button>
  <Dialog open={open} fullWidth maxWidth="md" disableEscapeKeyDown={busy} onClose={()=>{if(!busy){reset();setOpen(false);}}}><DialogTitle>Whole-Group Capture Abandonment</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
   <Typography sx={{overflowWrap:'anywhere'}}>Source Run {entry.executionId} · raw stored capture key {entry.captureKey} · {entry.sourceOwner} · evidence {entry.evidenceSha256}</Typography>
   <Alert severity="warning"><Stack spacing={0.5}><Typography>Whole group · {entry.sources.length} resources · discovered: {entry.capturedCheckpointIds.length} captured / {entry.sources.length-entry.capturedCheckpointIds.length} uncaptured</Typography><Typography>Package evidence · current review required · all original bytes + uncaptured identities preserved</Typography><Typography>No disk reclamation · history retirement · source deletion · external-effect replay</Typography></Stack></Alert>
   <Alert severity="warning">Unknown effects / stale references / partial filesystem or SQL outcomes · whole group pinned · no separate release or singular fallback</Alert>
   {recoveryOnly&&<Alert severity="info">Historical saved identity · committed/removed owners may be absent from discovery · exact saved command only</Alert>}
   <Evidence title="Every Original Source And Captured Member Identity" value={entry}/>
   {restored.error&&<Alert severity="error">{restored.error}</Alert>}{notice&&<Alert severity="warning">{notice}</Alert>}
   <Button disabled={busy||Boolean(pending)||recoveryOnly||Boolean(receipt)} onClick={()=>preview.mutate()}>Refresh Whole-Group Abandonment Review</Button>
   {review&&<><Evidence title="Whole-Group Capture And Branch Revisions, All Package Files, References And Blockers" value={review}/>{groupAbandonmentHeld(review)&&<Alert severity="warning">The whole group remains held by reviewed references or blockers.</Alert>}
    <FormControlLabel control={<Checkbox checked={ack} disabled={readOnly||busy||Boolean(pending)} onChange={(_,value)=>{setAck(value);setConfirm(undefined);}}/>} label="I reviewed every captured and uncaptured member, file inventory, revision and blocker; preserve all evidence"/>
    <Button color="error" disabled={!ready} onClick={()=>{if(ready&&review)setConfirm({entry,review,input:{executionId:entry.executionId,captureKey:entry.captureKey,commandKey:createClientId(),reviewSha256:review.reviewSha256,preserveEvidence:true}});}}>Abandon Reviewed Whole-Group Capture</Button>
   </>}
   {pending&&<><Alert severity="warning">Original whole-group command retained · no receipt GET · recovery: confirm unchanged POST/hash/key</Alert><Evidence title="Original Saved Whole-Group Command And Reviewed Inventory" value={pending}/><Button disabled={busy||readOnly} onClick={()=>setConfirm(pending)}>Recover Exact Whole-Group Command</Button></>}
   {receipt!==undefined&&<Evidence title="Canonical Whole-Group Disposition And Retained Package Proofs" value={receipt}/>}
  </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>{reset();setOpen(false);}}>Close</Button></DialogActions></Dialog>
  <ConfirmDialog open={Boolean(confirm)} title="Preserve evidence and abandon the whole group?" confirmLabel="Confirm Whole-Group Abandonment" cancelLabel="Back" pending={send.isPending} confirmDisabled={readOnly||busy||Boolean(!pending&&!ready)} onCancel={()=>setConfirm(undefined)} onConfirm={()=>{if(!confirm||fence.current||readOnly||busy||!pending&&!ready)return;fence.current=true;send.mutate(confirm);}}>
   <Typography>Confirm one command for every captured/uncaptured member; bytes retained and all SQL pins held through partial filesystem progress</Typography><Evidence title="Exact Unchanged Command" value={confirm?.input}/>
  </ConfirmDialog>
 </>;
}
export function RetainedGroupCaptureAbandonments():JSX.Element {
 const [saved,setSaved]=useState(()=>retainedGroupAbandonments(window.location.origin,currentProductScope()));
 return <Stack spacing={1}><Button onClick={()=>setSaved(retainedGroupAbandonments(window.location.origin,currentProductScope()))}>Read Saved Whole-Group Abandonment Commands</Button>{saved.error&&<Alert severity="warning">{saved.error}</Alert>}{saved.entries.map(entry=><Stack key={JSON.stringify([entry.executionId,entry.captureKey])}><Typography sx={{overflowWrap:'anywhere'}}>Saved source {entry.executionId} · {entry.captureKey}</Typography><GroupCaptureAbandonmentReview entry={entry} recoveryOnly/></Stack>)}</Stack>;
}
