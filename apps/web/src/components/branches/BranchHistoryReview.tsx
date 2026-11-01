import {useRef,useState} from 'react';
import {useInfiniteQuery,useMutation} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchHistoricalCheckpointDto,BranchHostGraphReviewDto,BranchHostRequestReviewDto,BranchHostRequestAdoption,BranchHostGraphRestoreInput,BranchHistoricalRewindInput} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {historyActionAvailable,historyReviewMatches} from './branchHistoryReview';
import {ConfirmDialog} from '../ConfirmationDialogs';

type Action='adopt'|'restore'|'rewind';
type Review={kind:'request';value:BranchHostRequestReviewDto}|{kind:'graph';value:BranchHostGraphReviewDto};
type Submission={action:Action;body:BranchHostRequestAdoption|BranchHostGraphRestoreInput|BranchHistoricalRewindInput};
export function BranchHistoryReview({branchId,executionId,enabled,onChanged}:{branchId:string;executionId:string;enabled:boolean;onChanged():void}):JSX.Element {
 const [open,setOpen]=useState(false),[checkpoint,setCheckpoint]=useState<BranchHistoricalCheckpointDto>(),[action,setAction]=useState<Action>('adopt'),[requestId,setRequestId]=useState('');
 const [review,setReview]=useState<Review>(),[instruction,setInstruction]=useState(''),[mode,setMode]=useState<'reconcile'|'independent'>('reconcile');
 const [effects,setEffects]=useState(false),[bindings,setBindings]=useState(false),[secrets,setSecrets]=useState(false),[confirm,setConfirm]=useState(false),[receipt,setReceipt]=useState<unknown>();
 const submissionStorageKey=`branch-history-submission:${branchId}:${executionId}`;
 const [pendingSubmission,setPendingSubmission]=useState<Submission|undefined>(()=>{try{return JSON.parse(localStorage.getItem(submissionStorageKey)??'null')??undefined;}catch{return undefined;}});
 const submitting=useRef(false),epoch=useRef(0);
 const base=`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}`;
 const checkpoints=useInfiniteQuery({queryKey:['branch-history-checkpoints',branchId,executionId],initialPageParam:undefined as number|undefined,queryFn:({pageParam})=>requestJson<BranchHistoricalCheckpointDto[]>(`${base}/historical-checkpoints${pageParam===undefined?'':`?before=${pageParam}`}`),getNextPageParam:page=>page.length?Math.min(...page.map(item=>item.id)):undefined,enabled:open,retry:false});
 const clearReview=()=>{epoch.current++;setReview(undefined);setEffects(false);setBindings(false);setSecrets(false);setConfirm(false);setReceipt(undefined);};
 const loadReview=useMutation({mutationFn:async()=>{
  if(!checkpoint||!historyActionAvailable(action,checkpoint))throw new Error('Choose a supported checkpoint for this action.');
  const token=epoch.current,selection={checkpointId:checkpoint.id,expectedHash:checkpoint.contentHash};
  const value:Review=action==='adopt'?{kind:'request',value:await requestJson<BranchHostRequestReviewDto>(`${base}/host-request-review`,{method:'POST',body:JSON.stringify({...selection,requestId:requestId.trim()})})}:{kind:'graph',value:await requestJson<BranchHostGraphReviewDto>(`${base}/host-graph-review`,{method:'POST',body:JSON.stringify(selection)})};
  if(!historyReviewMatches(value,branchId,executionId,checkpoint,requestId.trim()))throw new Error('The review belongs to another source. Reload the checkpoint.');
  return {token,value};
 },onSuccess:result=>{if(result.token!==epoch.current)return;setReview(result.value);setEffects(false);setBindings(false);setSecrets(false);setConfirm(false);}});
 const submit=useMutation({mutationFn:(input:Submission)=>{localStorage.setItem(submissionStorageKey,JSON.stringify(input));setPendingSubmission(input);return requestJson(`${base}/${input.action==='adopt'?'adopt-host-request':input.action==='restore'?'restore-host-graph':'rewind-historical'}`,{method:'POST',body:JSON.stringify(input.body)});},onSuccess:result=>{localStorage.removeItem(submissionStorageKey);setPendingSubmission(undefined);setReceipt(result);setConfirm(false);onChanged();},onError:error=>{
  if(error instanceof ApiRequestError&&error.status>=400&&error.status<500){localStorage.removeItem(submissionStorageKey);setPendingSubmission(undefined);}
  if(error instanceof ApiRequestError&&error.status===409){clearReview();loadReview.mutate();onChanged();}
  setConfirm(false);
 },onSettled:()=>{submitting.current=false;}});
 const unconfirmed=Boolean(pendingSubmission)&&!submit.isPending;
 const locked=submit.isPending||unconfirmed;
 const requests=review?.kind==='request'?[review.value]:review?.value.requests??[];
 const changed=requests.some(item=>item.current.versionChanged||item.current.bindingsChanged||item.current.configurationChanged);
 const needsSecrets=requests.some(item=>item.current.requiredSecretRefs.length>0);
 const available=historyActionAvailable(action,checkpoint);
 const ready=enabled&&available&&Boolean(review)&&effects&&(action!=='adopt'||Boolean(instruction.trim())&&(mode==='reconcile'||!requests.some(item=>item.request.state==='outcome_unknown'))&&(!changed||bindings)&&(!needsSecrets||secrets));
 const apply=()=>{
  if(submitting.current)return;
  if(unconfirmed&&pendingSubmission){submitting.current=true;submit.mutate(pendingSubmission);return;}
  if(!ready||!review||!checkpoint)return;
  const selection={checkpointId:checkpoint.id,expectedHash:checkpoint.contentHash},commandKey=createClientId();
  let input:Submission;
  if(action==='adopt'&&review.kind==='request')input={action,body:{...selection,requestId:review.value.source.requestId,reviewHash:review.value.reviewHash,commandKey,instruction:instruction.trim(),mode,...(changed?{acknowledgeChangedBindings:bindings}:{}),...(needsSecrets?{acknowledgeSecretBindings:secrets}:{})}};
  else if(action==='restore'&&review.kind==='graph')input={action,body:{...selection,reviewHash:review.value.reviewHash,commandKey,reconcileEffects:true}};
  else if(action==='rewind'&&review.kind==='graph')input={action,body:{...selection,commandKey,graphReview:{reviewHash:review.value.reviewHash,reconcileEffects:true}}};
  else return;
  submitting.current=true;submit.mutate(input);
 };
 const reset=()=>{clearReview();loadReview.reset();submit.reset();};
 return <>
  <Button disabled={!enabled} onClick={()=>{if(!pendingSubmission)clearReview();setOpen(true);}}>Review saved work</Button>
  <Dialog open={open} fullWidth maxWidth="md" disableEscapeKeyDown={locked} onClose={()=>{if(!locked){epoch.current++;setOpen(false);}}}>
   <DialogTitle>Review saved work</DialogTitle>
   <DialogContent><Stack spacing={2} sx={{pt:1}}>
    {!enabled&&<Alert severity="warning">Refresh this Run before applying changes.</Alert>}
    {checkpoints.error&&<Alert severity="error" action={<Button onClick={()=>void checkpoints.refetch()}>Reload</Button>}>{checkpoints.error.message}</Alert>}
    <TextField select label="Saved checkpoint" value={checkpoint?.id??''} disabled={locked||loadReview.isPending} onChange={event=>{reset();setCheckpoint(checkpoints.data?.pages.flat().find(item=>item.id===Number(event.target.value)));}}>
     {checkpoints.data?.pages.flat().map(item=><MenuItem key={item.id} value={item.id}>{item.id} · {item.eligibility}{item.restoreSupported?'':' · limited restore'}</MenuItem>)}
    </TextField>
    {checkpoints.isPending&&<Typography role="status">Loading checkpoints…</Typography>}
    {checkpoints.hasNextPage&&<Button disabled={checkpoints.isFetchingNextPage||locked} onClick={()=>void checkpoints.fetchNextPage()}>Older checkpoints</Button>}
    <TextField select label="Action" value={action} disabled={locked||loadReview.isPending} onChange={event=>{reset();setAction(event.target.value as Action);}}>
     <MenuItem value="adopt">Start reviewed Request</MenuItem><MenuItem value="restore" disabled={!historyActionAvailable('restore',checkpoint)}>Restore Request graph</MenuItem><MenuItem value="rewind" disabled={!historyActionAvailable('rewind',checkpoint)}>Rewind Run with Request graph</MenuItem>
    </TextField>
    {checkpoint&&!checkpoint.restoreSupported&&<Alert severity="info">Graph restoration and rewind unavailable for this checkpoint. Individual Request review remains available.</Alert>}
    {action==='adopt'&&<TextField label="Source Request ID" value={requestId} disabled={locked||loadReview.isPending} onChange={event=>{reset();setRequestId(event.target.value);}}/>}
    <Button disabled={!enabled||!available||locked||loadReview.isPending||!checkpoint||action==='adopt'&&!requestId.trim()} onClick={()=>{clearReview();submit.reset();loadReview.mutate();}}>Review current scope</Button>
    {loadReview.error&&<Alert severity="error">{loadReview.error.message}</Alert>}
    {unconfirmed&&!submit.error&&<Alert severity="warning">Earlier submission unconfirmed. Reconcile the retained submission before starting another action.</Alert>}
    {submit.error&&<Alert severity="warning">{unconfirmed?'Submission unconfirmed. Keep this dialog open; reconcile the same submission.':submit.error.message}</Alert>}
    {review&&<>
     <Typography variant="subtitle2">Source: {branchId} · {executionId} · checkpoint {checkpoint?.id}</Typography>
     <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Checkpoint hash: {checkpoint?.contentHash}</Typography>
     <Alert severity="info">Historical facts remain evidence. Completed effects are not replayed.</Alert>
     {requests.map(item=><Stack key={item.source.requestId} spacing={1}>
      <Typography fontWeight={600}>Request {item.source.requestId} · saved {item.request.state} v{item.request.version} · current {item.current.requestState} v{item.current.requestVersion}</Typography>
      <Typography variant="body2">Project {item.request.projectId} · Chat {item.request.conversationId} · recipient {item.request.recipientAgentId} · requester {item.request.requesterAgentId??'User'}</Typography>
      <Typography variant="body2">Current version {item.current.versionId} · bindings {item.current.bindingRevisionId} · {item.current.bindingSha256}</Typography>
      <Typography variant="body2">Changed: {[item.current.versionChanged&&'workflow',item.current.bindingsChanged&&'bindings',item.current.configurationChanged&&'configuration'].filter(Boolean).join(', ')||'none'} · restrictions: {item.current.recipientRestrictions.join(', ')||'none'} · secrets: {item.current.requiredSecretRefs.join(', ')||'none'}</Typography>
      <details><summary>Saved evidence and current configuration</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto',fontSize:12}}>{JSON.stringify({request:item.request.payload,updates:item.updates,artifacts:item.artifacts,configuration:item.current.configuration},null,2)}</Typography></details>
     </Stack>)}
     {review.kind==='graph'&&<details><summary>Joins and continuations ({review.value.joins.length})</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto',fontSize:12}}>{JSON.stringify(review.value.joins,null,2)}</Typography></details>}
     {action==='adopt'&&<>
      <TextField select label="New work" value={mode} disabled={locked} onChange={event=>setMode(event.target.value as typeof mode)}><MenuItem value="reconcile">Reconcile earlier effects</MenuItem><MenuItem value="independent" disabled={requests.some(item=>item.request.state==='outcome_unknown')}>Independent instruction</MenuItem></TextField>
      <TextField multiline minRows={2} label="Fresh instruction" value={instruction} disabled={locked} onChange={event=>setInstruction(event.target.value)}/>
      {changed&&<FormControlLabel control={<Checkbox checked={bindings} disabled={locked} onChange={(_,value)=>setBindings(value)}/>} label="Use the changed current workflow, bindings and configuration"/>}
      {needsSecrets&&<FormControlLabel control={<Checkbox checked={secrets} disabled={locked} onChange={(_,value)=>setSecrets(value)}/>} label="Use the listed current secret bindings for this new work"/>}
     </>}
     <FormControlLabel control={<Checkbox checked={effects} disabled={locked} onChange={(_,value)=>setEffects(value)}/>} label="I reviewed the original scope and reconciled external effects"/>
    </>}
    {receipt!==undefined&&<Alert severity="success"><Typography>Accepted</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(receipt,null,2)}</Typography></Alert>}
   </Stack></DialogContent>
   <DialogActions><Button disabled={locked} onClick={()=>{epoch.current++;setOpen(false);}}>Close</Button>{unconfirmed?<Button onClick={apply}>Reconcile submission</Button>:<Button variant="contained" disabled={!ready||submit.isPending||loadReview.isPending||receipt!==undefined} onClick={()=>setConfirm(true)}>Continue</Button>}</DialogActions>
  </Dialog>
  <ConfirmDialog open={confirm} title={action==='adopt'?'Start reviewed Request?':action==='restore'?'Restore Request graph?':'Rewind Run with reviewed graph?'} confirmLabel="Apply reviewed action" cancelLabel="Back" pending={submit.isPending} confirmDisabled={!ready||loadReview.isPending} error={submit.error?.message} onCancel={()=>{if(!locked)setConfirm(false);}} onConfirm={apply}><Typography>{action==='adopt'?'Creates a fresh Request for the original recipient.':action==='restore'?'Creates mapped Requests and Joins; eligible work may run.':'Creates a new Run with mapped Requests and Joins; eligible work may run.'}</Typography></ConfirmDialog>
 </>;
}
