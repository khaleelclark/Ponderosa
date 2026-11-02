import {useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {AgentAccessImportReviewDto,BranchResourceInspectionDto,BranchResourceCustodyReleaseInput,BranchResourceCustodyReleaseDto,BranchResourceCustodyReleaseStatus,ImportAgentPackageRequest} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {resourceInspectionMatches,resourceReleaseInput,resourceReleaseMatches} from './branchResourceReview';

type Choice='keep_destination'|'use_source';
export function BranchResourceReview({branchId,executionId,stepId,enabled,onChanged}:{branchId:string;executionId:string;stepId:string;enabled:boolean;onChanged():void}):JSX.Element {
 const base=`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}/resources/${encodeURIComponent(stepId)}`;
 const storageKey=`branch-resource-release:${branchId}:${executionId}:${stepId}`;
 const [open,setOpen]=useState(false),[choices,setChoices]=useState<Record<string,Choice>>({}),[action,setAction]=useState<Choice|''>(''),[confirm,setConfirm]=useState<'access'|'release'>(),[message,setMessage]=useState('');
 const [retained,setRetained]=useState<BranchResourceCustodyReleaseInput|undefined>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)??'null')??undefined;}catch{return undefined;}});
 const [releaseStatus,setReleaseStatus]=useState<BranchResourceCustodyReleaseStatus>();
 const fence=useRef(false);
 const inspection=useQuery({queryKey:['branch-resource-review',branchId,executionId,stepId],queryFn:async()=>{
  const value=await requestJson<BranchResourceInspectionDto>(base);
  if(!resourceInspectionMatches(value,branchId,executionId,stepId))throw Error('Resource identity changed. Reload this Run.');
  return value;
 },enabled:open,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const refresh=async()=>{setChoices({});setAction('');setConfirm(undefined);await inspection.refetch();};
 const access=useMutation({retry:false,mutationFn:(resolution:NonNullable<ImportAgentPackageRequest['accessSettingsResolution']>)=>requestJson<AgentAccessImportReviewDto>(`${base}/access-review`,{method:'POST',body:JSON.stringify(resolution)}),onSuccess:()=>{setMessage('Access choice recorded.');onChanged();void refresh();},onError:error=>{
  setMessage(error instanceof ApiRequestError&&error.status===409?`Resource or policy changed. Review the refreshed scope. ${error.message}`:`Access choice unconfirmed. ${error.message}`);onChanged();void refresh();
 },onSettled:()=>{fence.current=false;}});
 const acceptStatus=(value:BranchResourceCustodyReleaseStatus,input:BranchResourceCustodyReleaseInput)=>{
  if(!resourceReleaseMatches(value,input,stepId))throw Error('Release receipt differs from the retained command. Keep the original input.');
  setReleaseStatus(value);
  if(value.state==='released'){localStorage.removeItem(storageKey);setRetained(undefined);setMessage('Retained checkpoint released.');onChanged();void refresh();}
 };
 const release=useMutation({retry:false,mutationFn:async(input:BranchResourceCustodyReleaseInput)=>{
  localStorage.setItem(storageKey,JSON.stringify(input));setRetained(input);setReleaseStatus(undefined);
  const value=await requestJson<BranchResourceCustodyReleaseDto>(`${base}/checkpoint-custody`,{method:'DELETE',body:JSON.stringify(input)});
  acceptStatus(value,input);return value;
 },onError:error=>{setMessage(error.message);onChanged();if(error instanceof ApiRequestError&&error.status===409)void refresh();},onSettled:()=>{setConfirm(undefined);fence.current=false;}});
 const inspectRelease=useMutation({retry:false,mutationFn:async()=>{
  if(!retained)throw Error('No retained release command.');
  const value=await requestJson<BranchResourceCustodyReleaseStatus>(`${base}/checkpoint-custody?commandKey=${encodeURIComponent(retained.commandKey)}`);
  acceptStatus(value,retained);return value;
 }});
 const value=inspection.data,review=value?.currentPolicyReview,refs=review?.source.filter(item=>item.settings!==undefined).map(item=>item.ref)??[];
 const busy=access.isPending||release.isPending||inspectRelease.isPending;
 const accessReady=enabled&&!inspection.isFetching&&!inspection.isError&&!retained&&Boolean(review&&value?.destinationChatAvailable&&!value.accessChoiceCurrent)&&(refs.length>0?refs.every(ref=>choices[ref]):Boolean(action));
 const newRelease=Boolean(value&&!inspection.isError&&resourceReleaseInput(value,'preview'));
 const retryReady=Boolean(retained&&releaseStatus&&releaseStatus.state!=='released');
 const apply=()=>{
  if(fence.current||busy||!enabled)return;
  if(confirm==='access'&&accessReady&&review){
   const agentActions:Record<string,Choice>={};
   for(const ref of refs){const choice=choices[ref];if(!choice)return;agentActions[ref]=choice;}
   let resolutionAction:Choice;
   if(refs.length)resolutionAction='keep_destination';
   else {if(!action)return;resolutionAction=action;}
   fence.current=true;setConfirm(undefined);setMessage('');access.mutate({action:resolutionAction,reviewSha256:review.reviewSha256,...(refs.length?{agentActions}:{})});
  }
  else if(confirm==='release'){
   const input=retained?(retryReady?retained:undefined):newRelease&&value&&!inspection.isFetching?resourceReleaseInput(value,createClientId()):undefined;
   if(input){fence.current=true;setMessage('');release.mutate(input);}
  }
 };
 return <>
  <Button size="small" onClick={()=>{setChoices({});setAction('');setMessage('');setOpen(true);}}>Review resource</Button>
  <Dialog open={open} fullWidth maxWidth="sm" onClose={()=>{if(!busy)setOpen(false);}} disableEscapeKeyDown={busy}>
   <DialogTitle>Resource review</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    <Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Branch {branchId} · Run {executionId} · Step {stepId}</Typography>
    {!enabled&&<Alert severity="warning">Refresh this Run before applying changes.</Alert>}
    <Button disabled={busy||inspection.isFetching} onClick={()=>void refresh()}>Refresh current scope</Button>
    {inspection.isFetching&&<Typography role="status">Loading current scope…</Typography>}
    {inspection.error&&<Alert severity="error">{inspection.error.message}</Alert>}
    {message&&<Alert severity="info">{message}</Alert>}
    {value&&!inspection.isError&&<>
     <Typography>Generation {value.generation} · {value.state} · import {value.importState??'not started'}</Typography>
     <Typography sx={{overflowWrap:'anywhere'}}>Destination Chat: {value.destinationChatId??'not created'}{value.destinationChatId&&!value.destinationChatAvailable?' · unavailable':''}</Typography>
     {value.reviewError&&<Alert severity="warning">{value.reviewError}</Alert>}
     {value.accessChoiceCurrent&&<Alert severity="success">Current access choice recorded.</Alert>}
     {review&&<>
      <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Current policy hash: {review.reviewSha256}</Typography>
      <Typography variant="body2">Destination restrictions: {review.destination.restrictedCapabilityIds.join(', ')||'none'}</Typography>
      <details><summary>Source settings and current policy</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto',fontSize:12}}>{JSON.stringify({source:review.source,destination:review.destination},null,2)}</Typography></details>
      {review.source.map(item=><Typography variant="body2" key={item.ref}>Source {item.ref}: {item.settings?.restrictedCapabilityIds?.join(', ')||'No capability restrictions'}</Typography>)}
      {refs.map(ref=><TextField select key={ref} label={`Restrictions: ${ref}`} value={choices[ref]??''} disabled={busy||Boolean(retained)||inspection.isFetching} onChange={event=>setChoices(current=>({...current,[ref]:event.target.value as Choice}))}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply source restrictions</MenuItem></TextField>)}
      {!refs.length&&<TextField select label="Restrictions" value={action} disabled={busy||Boolean(retained)||inspection.isFetching} onChange={event=>setAction(event.target.value as Choice)}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply source restrictions</MenuItem></TextField>}
      <Button disabled={!accessReady||busy} onClick={()=>setConfirm('access')}>Confirm restrictions</Button>
     </>}
     {value.custody&&<>
      <Typography variant="subtitle2">Checkpoint {value.custody.checkpointId} · {value.custody.kind} · {value.custody.state}</Typography>
      <Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Custody: {value.custody.custodyId??'pending'} · receipt: {value.custody.receiptSha256??'pending'}</Typography>
      {value.custody.kind==='restoration_source'?<Typography variant="caption">Source custody must be managed from its original owner.</Typography>:<><Typography variant="caption">Referenced checkpoints cannot be released.</Typography><Button color="error" disabled={!enabled||!newRelease||Boolean(retained)||busy||inspection.isFetching} onClick={()=>setConfirm('release')}>Release retained checkpoint</Button></>}
     </>}
    </>}
    {retained&&<>
     <Alert severity="warning">Release unconfirmed · inspect retained command before retry</Alert>
     <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Command {retained.commandKey} · generation {retained.expectedGeneration} · custody {retained.expectedCustodyId} · receipt {retained.expectedReceiptSha256}</Typography>
     <Button disabled={busy} onClick={()=>inspectRelease.mutate()}>Inspect release outcome</Button>
     {releaseStatus&&<Alert severity={releaseStatus.state==='released'?'success':'warning'}>{releaseStatus.state==='not_found'?'No receipt found · completion unconfirmed':releaseStatus.state==='releasing'?`Release pending or unknown. ${releaseStatus.error??''}`:'Released'}</Alert>}
     {inspectRelease.error&&<Alert severity="error">{inspectRelease.error.message}</Alert>}
     <Button color="error" disabled={!enabled||busy||!retryReady} onClick={()=>setConfirm('release')}>Retry exact release</Button>
    </>}
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>setOpen(false)}>Close</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={Boolean(confirm)} title={confirm==='access'?'Apply reviewed restrictions?':retained?'Retry the retained release?':'Release retained checkpoint?'} confirmLabel={confirm==='access'?'Apply restrictions':'Release checkpoint'} cancelLabel="Back" pending={access.isPending||release.isPending} confirmDisabled={!enabled||busy||confirm==='access'&&!accessReady||confirm==='release'&&!(retained?retryReady:newRelease&&!inspection.isFetching)} onCancel={()=>setConfirm(undefined)} onConfirm={apply}>
   <Typography>{confirm==='access'?'Uses the displayed destination policy hash and explicit per-Agent choices.':`Permanently removes retained package bytes + future restoration · ${retained?'Uses the original command, generation and receipt.':'Uses the displayed generation and exact custody receipt.'}`}</Typography>
   {confirm==='access'&&<Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Destination {value?.destinationChatId} · policy {review?.reviewSha256}</Typography>}
   {confirm==='release'&&<Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Generation {retained?.expectedGeneration??value?.generation} · custody {retained?.expectedCustodyId??value?.custody?.custodyId} · receipt {retained?.expectedReceiptSha256??value?.custody?.receiptSha256}</Typography>}
  </ConfirmDialog>
 </>;
}
