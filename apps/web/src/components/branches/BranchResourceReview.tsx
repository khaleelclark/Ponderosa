import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,Checkbox,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {AgentAccessImportReviewDto,BranchResourceCustodyReleaseInput,BranchResourceCustodyReleaseDto,BranchResourceCustodyReleaseStatus,ImportAgentPackageRequest} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {resourceInspectionMatches,resourceReleaseInput,resourceReleaseMatches,type ResourceReviewInspection,type TemporaryCopyHistory} from './branchResourceReview';

type Choice='keep_destination'|'use_source';
type Resolution=NonNullable<ImportAgentPackageRequest['accessSettingsResolution']>;
type CopyApproval={accessSettingsResolution:Resolution;copySourceMemory:boolean;allowFindingsWriteback:boolean;snapshotSha256:string};
type Confirmation={title:string;label:string;content:ReactNode;access?:{payload:Resolution|CopyApproval;scope:string}};
export function BranchResourceReview({branchId,executionId,stepId,enabled,onChanged}:{branchId:string;executionId:string;stepId:string;enabled:boolean;onChanged():void}):JSX.Element {
 const base=`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}/resources/${encodeURIComponent(stepId)}`;
 const storageKey=`branch-resource-release:${branchId}:${executionId}:${stepId}`;
 const [open,setOpen]=useState(false),[choices,setChoices]=useState<Record<string,Choice>>({}),[action,setAction]=useState<Choice|''>(''),[confirm,setConfirm]=useState<'access'|'release'>(),[message,setMessage]=useState('');
 const [retained,setRetained]=useState<BranchResourceCustodyReleaseInput|undefined>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)??'null')??undefined;}catch{return undefined;}});
 const [copyConsent,setCopyConsent]=useState<{scope:string;copySourceMemory:boolean;allowFindingsWriteback:boolean}>();
 const [confirmation,setConfirmation]=useState<Confirmation>(),[copyApproved,setCopyApproved]=useState(false);
 const [releaseStatus,setReleaseStatus]=useState<BranchResourceCustodyReleaseStatus>();
 const fence=useRef(false),ownApprovalRefresh=useRef(false);
 const inspection=useQuery({queryKey:['branch-resource-review',branchId,executionId,stepId],queryFn:async()=>{
  const value=await requestJson<ResourceReviewInspection>(base);
  if(!resourceInspectionMatches(value,branchId,executionId,stepId))throw Error('Resource identity changed. Reload this Run.');
  return value;
 },enabled:open,retry:(failures,error)=>ownApprovalRefresh.current&&failures<2&&error instanceof ApiRequestError&&error.status===409&&error.message==='Resource inspection changed; refresh',retryDelay:200,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const [historyOpen,setHistoryOpen]=useState(false);
 const trace=inspection.data?.temporaryCopyTrace;
 const history=useQuery({queryKey:['branch-copy-history',branchId,executionId,stepId,trace?.sourceAgentId,trace?.copyAgentId,trace?.requestId],enabled:open&&historyOpen&&!inspection.isError&&Boolean(trace?.historyAvailable),retry:false,refetchOnWindowFocus:true,queryFn:async()=>{
  const result=await requestJson<TemporaryCopyHistory>(base+'/copy-history');
  if(!trace||result.sourceAgentId!==trace.sourceAgentId||result.copyAgentId!==trace.copyAgentId||result.requestId!==trace.requestId||!Array.isArray(result.messages)||!Array.isArray(result.runs)||!Array.isArray(result.events))throw Error('Retained history identity changed. Refresh this resource.');
  return result;
 }});
 const refresh=async(afterCopyApproval=false)=>{setHistoryOpen(false);setCopyConsent(undefined);setChoices({});setAction('');setConfirm(undefined);ownApprovalRefresh.current=afterCopyApproval;try{return await inspection.refetch();}finally{ownApprovalRefresh.current=false;}};
 const access=useMutation({retry:false,mutationFn:(resolution:Resolution|CopyApproval)=>requestJson<AgentAccessImportReviewDto>(`${base}/access-review`,{method:'POST',body:JSON.stringify(resolution)}),onSuccess:async(_,submitted)=>{
  const copy='snapshotSha256' in submitted;setCopyApproved(copy);setMessage(copy?'Copy approved. Updating current progress…':'Access choice recorded.');onChanged();const current=await refresh(copy);
  if(copy)setMessage(current.error?'Copy approved for the reviewed snapshot. Current progress could not be loaded; refresh current scope.':current.data?.expertCopyReview&&!current.data.expertCopyReview.consentCurrent?'Copy approval recorded for the reviewed snapshot. Review the current restrictions before approving again.':'Copy approved. Current progress is shown below.');
 },onError:error=>{
  setCopyApproved(false);setMessage(error instanceof ApiRequestError&&error.status===409?`Resource or policy changed. Review the refreshed scope. ${error.message}`:`Access choice unconfirmed. ${error.message}`);onChanged();void refresh();
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
 const expert=value?.expertCopyReview;
 const copyScope=expert&&review?JSON.stringify([branchId,executionId,stepId,review.reviewSha256,expert.sourceAgentId,expert.sourceChatId,expert.copyChatId,expert.snapshotSha256,expert.sourceMemoryAvailable,expert.reviewWithoutMemorySha256]):undefined;
 const copySourceMemory=Boolean(expert?.sourceMemoryAvailable&&copyScope&&copyConsent?.scope===copyScope&&copyConsent.copySourceMemory);
 const allowFindingsWriteback=Boolean(expert?.sourceMemoryAvailable&&copyScope&&copyConsent?.scope===copyScope&&copyConsent.allowFindingsWriteback);
 const chooseCopy=(field:'copySourceMemory'|'allowFindingsWriteback',checked:boolean)=>{if(copyScope)setCopyConsent({scope:copyScope,copySourceMemory,allowFindingsWriteback,[field]:checked});};
 useEffect(()=>{setChoices({});setAction('');setConfirm(undefined);setCopyConsent(undefined);},[copyScope]);
 const busy=access.isPending||release.isPending||inspectRelease.isPending;
 const accessReady=enabled&&!inspection.isFetching&&!inspection.isError&&!retained&&Boolean(review&&value?.destinationChatAvailable&&(expert?!expert.consentCurrent:!value.accessChoiceCurrent))&&(refs.length>0?refs.every(ref=>choices[ref]):Boolean(action));
 const choiceRequired=enabled&&!busy&&!inspection.isFetching&&!inspection.isError&&!retained&&Boolean(review&&value?.destinationChatAvailable&&(expert?!expert.consentCurrent:!value.accessChoiceCurrent));
 const newRelease=Boolean(value&&!inspection.isError&&resourceReleaseInput(value,'preview'));
 const retryReady=Boolean(retained&&releaseStatus&&releaseStatus.state!=='released');
 const prepare=(kind:'access'|'release')=>{
  if(busy||!enabled)return;
  if(kind==='access'&&accessReady&&review){
   const agentActions:Record<string,Choice>={};
   for(const ref of refs){const choice=choices[ref];if(!choice)return;agentActions[ref]=choice;}
   let resolutionAction:Choice;
   if(refs.length)resolutionAction='keep_destination';
   else {if(!action)return;resolutionAction=action;}
   const resolution:Resolution={action:resolutionAction,reviewSha256:expert&&!copySourceMemory?expert.reviewWithoutMemorySha256:review.reviewSha256,...(refs.length?{agentActions}:{})};
   const payload=expert?{accessSettingsResolution:resolution,copySourceMemory,allowFindingsWriteback,snapshotSha256:expert.snapshotSha256}:resolution;
   setConfirmation({title:expert?'Approve this temporary Agent copy?':'Apply reviewed restrictions?',label:expert?'Approve copy':'Apply restrictions',access:{payload,scope:copyScope??review.reviewSha256},content:<Stack spacing={1} sx={{minWidth:0,overflowWrap:'anywhere'}}>
    <Typography>{expert?'Run this workflow job in a temporary copy of the selected Agent. The original Agent is not woken.':'Apply the restrictions you explicitly selected for this destination.'}</Typography>
    <Typography variant="body2">Restrictions: {refs.length?Object.values(agentActions).every(choice=>choice==='keep_destination')?'Keep destination restrictions':'Use the reviewed per-Agent choices':resolutionAction==='keep_destination'?'Keep destination restrictions':'Apply source restrictions'}</Typography>
    {expert&&<><Typography variant="body2">Copy private/team memory: {copySourceMemory?'Yes':'No'}</Typography><Typography variant="body2">Save private findings for later copies: {allowFindingsWriteback?'Yes':'No'}</Typography><Typography variant="body2">This copy uses a fresh temporary workspace.</Typography></>}
    <details><summary>Approval identifiers and hashes</summary><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Destination {value?.destinationChatId} · policy {resolution.reviewSha256}</Typography>{expert&&<Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Source Agent {expert.sourceAgentId} · source Chat {expert.sourceChatId} · snapshot {expert.snapshotSha256}</Typography>}</details>
   </Stack>});setConfirm(kind);
  }else if(kind==='release'){
   setConfirmation({title:retained?'Retry the retained release?':'Release retained checkpoint?',label:'Release checkpoint',content:<Stack spacing={1} sx={{minWidth:0,overflowWrap:'anywhere'}}><Typography>Permanently removes retained package bytes + future restoration · {retained?'Uses the original command, generation and receipt.':'Uses the displayed generation and exact custody receipt.'}</Typography><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Generation {retained?.expectedGeneration??value?.generation} · custody {retained?.expectedCustodyId??value?.custody?.custodyId} · receipt {retained?.expectedReceiptSha256??value?.custody?.receiptSha256}</Typography></Stack>});setConfirm(kind);
  }
 };
 const apply=()=>{
  if(fence.current||busy||!enabled)return;
  if(confirm==='access'&&accessReady&&review&&confirmation?.access){
   if(confirmation.access.scope!==(copyScope??review.reviewSha256)){setMessage('Resource or policy changed. Review the refreshed scope.');void refresh();return;}
   fence.current=true;setConfirm(undefined);setMessage('');access.mutate(confirmation.access.payload);
  }
  else if(confirm==='release'){
   const input=retained?(retryReady?retained:undefined):newRelease&&value&&!inspection.isFetching?resourceReleaseInput(value,createClientId()):undefined;
   if(input){fence.current=true;setMessage('');release.mutate(input);}
  }
 };
 return <>
  <Button size="small" onClick={()=>{setCopyConsent(undefined);setChoices({});setAction('');setMessage('');setCopyApproved(false);setOpen(true);}}>Review resource</Button>
  <Dialog open={open} fullWidth maxWidth="sm" onClose={()=>{if(!busy)setOpen(false);}} disableEscapeKeyDown={busy}>
   <DialogTitle>Resource review</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    <details><summary>Resource identifiers</summary><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Branch {branchId} · Run {executionId} · Step {stepId}</Typography></details>
    {!enabled&&<Alert severity="warning">Refresh this Run before applying changes.</Alert>}
    <Button disabled={busy||inspection.isFetching} onClick={()=>void refresh()}>Refresh current scope</Button>
    {inspection.isFetching&&<Typography role="status">Loading current scope…</Typography>}
    {inspection.error&&<Alert severity="error">{inspection.error.message}</Alert>}
    {message&&<Alert severity="info">{message}</Alert>}
    {copyApproved&&<Button onClick={()=>{setOpen(false);onChanged();}}>View Run progress</Button>}
    {value&&!inspection.isError&&<>
     {value.temporaryCopyActions&&<Stack spacing={1.5} component="section" aria-label="Copy action history" sx={{overflowWrap:'anywhere'}}>
      {value.temporaryCopyActions.approvals.map((approval,index)=><Stack key={`${approval.requestId??'legacy'}:${index}`} spacing={0.5}>
       <Typography variant="subtitle2">Copy approval</Typography>
       <Typography variant="body2">Approved by: {approval.actor?.kind==='user'&&approval.actor.id==='local-operator'?'You (local operator)':'Not recorded'}</Typography>
       <Typography variant="body2">Recorded: {approval.createdAt?new Date(approval.createdAt).toLocaleString():'Not recorded'}</Typography>
       <Typography variant="body2">Reason: {approval.reason==='run_reviewed_temporary_copy'?'Run this workflow job in the reviewed temporary Agent copy.':'Not recorded'}</Typography>
       <Typography variant="body2">Restrictions: {approval.agentActions?'Reviewed per-Agent choices':approval.action==='keep_destination'?'Keep destination restrictions':'Apply source restrictions'}</Typography>
       <Typography variant="body2">Copy private/team memory: {approval.copySourceMemory?'Yes':'No'} · Save private findings: {approval.allowFindingsWriteback?'Yes':'No'}</Typography>
       {(approval.requestId||approval.agentActions)&&<details><summary>Approval details</summary>
        {approval.requestId&&<Typography variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Operator request: {approval.requestId}</Typography>}
        {Object.entries(approval.agentActions??{}).map(([id,choice])=><Typography key={id} variant="caption" sx={{display:'block',overflowWrap:'anywhere'}}>Agent {id}: {choice==='keep_destination'?'Keep destination restrictions':'Apply source restrictions'}</Typography>)}
       </details>}
      </Stack>)}
      {value.temporaryCopyActions.retirement&&<Stack spacing={0.5}>
       <Typography variant="subtitle2">Temporary copy retired</Typography>
       <Typography variant="body2">Actor: {value.temporaryCopyActions.retirement.provenance?'Ponderosa (system)':'Not recorded'}</Typography>
       <Typography variant="body2">Recorded: {new Date(value.temporaryCopyActions.retirement.createdAt).toLocaleString()}</Typography>
       <Typography variant="body2">Reason: {value.temporaryCopyActions.retirement.provenance?.reason==='no_active_work_and_cleanup_completed'?'No active work remained and temporary resource cleanup completed.':'Not recorded'}</Typography>
       <details><summary>Retirement identifier</summary><Typography variant="caption">Checkpoint {value.temporaryCopyActions.retirement.checkpointId}</Typography></details>
      </Stack>}
     </Stack>}
     <Typography>Generation {value.generation} · {value.state} · import {value.importState??'not started'}</Typography>
     <Typography sx={{overflowWrap:'anywhere'}}>Destination Chat: {value.destinationChatId??'not created'}{value.destinationChatId&&!value.destinationChatAvailable?' · unavailable':''}</Typography>
     {trace&&<Stack spacing={1}>
      <Typography variant="subtitle2">Temporary copy record</Typography>
      <details><summary>Copy identifiers</summary><Typography sx={{overflowWrap:'anywhere'}}>Source Agent {trace.sourceAgentId} · Chat {trace.sourceChatId}</Typography>
      <Typography sx={{overflowWrap:'anywhere'}}>Copy Agent {trace.copyAgentId} · Chat {trace.copyChatId} · Request {trace.requestId} · Attempt {trace.attemptId}</Typography></details>
      <Typography variant="subtitle2">Task</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{trace.task.instructions}</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{trace.task.input}</Typography>
      <Typography variant="subtitle2">Result</Typography>{trace.result!==null&&typeof trace.result==='object'?<details><summary>View structured result</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(trace.result,null,2)}</Typography></details>:<Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{trace.result===undefined||trace.result===null?'No recorded result':typeof trace.result==='string'?trace.result:JSON.stringify(trace.result)}</Typography>}
      {trace.historyAvailable?<Button onClick={()=>{setHistoryOpen(true);void history.refetch();}}>View retained history</Button>:<Typography>Retained history is unavailable.</Typography>}
      {historyOpen&&trace.historyAvailable&&<Stack spacing={1}>
       {history.isFetching&&<Typography role="status">Loading retained history…</Typography>}
       {history.error&&<Alert severity="error">{history.error.message}</Alert>}
       {history.data&&!history.error&&!history.isFetching&&<><Typography variant="subtitle2">Retained Runs ({history.data.runs.length})</Typography>{history.data.runs.map((run,index)=><Stack key={run.id}><Typography variant="body2">Run {index+1} · {run.status.replaceAll('_',' ')}</Typography><Typography variant="caption">Created {new Date(run.created_at).toLocaleString()}{run.started_at?` · Started ${new Date(run.started_at).toLocaleString()}`:''}{run.terminal_at?` · Finished ${new Date(run.terminal_at).toLocaleString()}`:''}</Typography></Stack>)}<Typography variant="subtitle2">Retained messages</Typography>{history.data.messages.length===0&&<Typography variant="body2" color="text.secondary">No authored messages in this copy.</Typography>}{history.data.messages.map((message,index)=><Stack key={index}><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>{message.title} · {message.agentId} · {message.role} · {message.createdAt??''}</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{message.text}</Typography></Stack>)}<details><summary>Retained Run history</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(history.data.runs,null,2)}</Typography></details><details><summary>Retained work log</summary>{history.data.events.map((entry,index)=><Stack key={index}><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>{entry.agentId} · {entry.seq} · {entry.ts}</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(entry.event,null,2)}</Typography></Stack>)}</details></>}
      </Stack>}
     </Stack>}
     {value.reviewError&&<Alert severity="warning">{value.reviewError}</Alert>}
     {value.accessChoiceCurrent&&<Alert severity="success">Current access choice recorded.</Alert>}
     {review&&<>
      <Typography variant="body2">Destination restrictions: {review.destination.restrictedCapabilityIds.join(', ')||'none'}</Typography>
      <details><summary>Source settings and current policy</summary><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Current policy hash: {review.reviewSha256}</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto',fontSize:12}}>{JSON.stringify({source:review.source,destination:review.destination},null,2)}</Typography></details>
      {review.source.map(item=><Typography variant="body2" key={item.ref}>Source {item.ref}: {item.settings?.restrictedCapabilityIds?.join(', ')||'No capability restrictions'}</Typography>)}
      {refs.map(ref=><TextField select key={ref} required={choiceRequired} label={`Restrictions: ${ref}`} helperText={choiceRequired&&!choices[ref]?'Choose restrictions to continue.':undefined} value={choices[ref]??''} disabled={busy||Boolean(retained)||inspection.isFetching} onChange={event=>setChoices(current=>({...current,[ref]:event.target.value as Choice}))}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply source restrictions</MenuItem></TextField>)}
      {!refs.length&&<TextField select required={choiceRequired} label="Restrictions" helperText={choiceRequired&&!action?'Choose restrictions to continue.':undefined} value={action} disabled={busy||Boolean(retained)||inspection.isFetching} onChange={event=>setAction(event.target.value as Choice)}><MenuItem value="keep_destination">Keep destination restrictions</MenuItem><MenuItem value="use_source">Apply source restrictions</MenuItem></TextField>}
      {expert&&<Stack spacing={1}>
       <Typography variant="subtitle2">This temporary Agent copy</Typography>
       <Alert severity="info">This copy uses a fresh temporary workspace; source working-folder files are not copied.</Alert>
       <details><summary>Copy source and snapshot</summary><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Original Agent: {expert.sourceAgentId} · source Chat: {expert.sourceChatId} · temporary Chat: {expert.copyChatId}</Typography>
       <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Source snapshot: {expert.snapshotSha256}</Typography></details>
       <FormControlLabel control={<Checkbox checked={expert.consentCurrent?expert.copySourceMemory:copySourceMemory} disabled={busy||Boolean(retained)||inspection.isFetching||expert.consentCurrent||!expert.sourceMemoryAvailable} onChange={(_,checked)=>chooseCopy('copySourceMemory',checked)}/>} label="Copy the original Agent’s private memory and source Chat’s team memory into this temporary Chat"/>
       <FormControlLabel control={<Checkbox checked={expert.consentCurrent?expert.allowFindingsWriteback:allowFindingsWriteback} disabled={busy||Boolean(retained)||inspection.isFetching||expert.consentCurrent||!expert.sourceMemoryAvailable} onChange={(_,checked)=>chooseCopy('allowFindingsWriteback',checked)}/>} label="Allow this copy to save concise private findings for the original Agent and later copies"/>
       <Typography variant="body2">These choices do not grant Global Memory, browser access, or other capabilities.</Typography>
       <Typography variant="body2">Saving findings does not wake the original Agent; each later copy needs its own memory-copy approval to receive them.</Typography>
       {!copySourceMemory&&!expert.consentCurrent&&<Alert severity="info">Continue without inherited memory when this option is unchecked.</Alert>}
       {!expert.sourceMemoryAvailable&&<Alert severity="info">Local Memory is unavailable; this copy can proceed without inherited memory or findings writeback.</Alert>}
       {expert.consentCurrent&&<Alert severity="success">Approval recorded for this exact copy and source snapshot.</Alert>}
      </Stack>}
      {choiceRequired&&(refs.length?refs.some(ref=>!choices[ref]):!action)&&<Typography variant="body2" color="text.secondary">Select restrictions above before confirming.</Typography>}
      <Button disabled={!accessReady||busy} onClick={()=>prepare('access')}>{expert?'Confirm copy access':'Confirm restrictions'}</Button>
     </>}
     {value.custody&&<>
      <Typography variant="subtitle2">Checkpoint {value.custody.checkpointId} · {value.custody.kind} · {value.custody.state}</Typography>
      <Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Custody: {value.custody.custodyId??'pending'} · receipt: {value.custody.receiptSha256??'pending'}</Typography>
      {value.custody.kind==='restoration_source'?<Typography variant="caption">Source custody must be managed from its original owner.</Typography>:<><Typography variant="caption">Referenced checkpoints cannot be released.</Typography><Button color="error" disabled={!enabled||!newRelease||Boolean(retained)||busy||inspection.isFetching} onClick={()=>prepare('release')}>Release retained checkpoint</Button></>}
     </>}
    </>}
    {retained&&<>
     <Alert severity="warning">Release unconfirmed · inspect retained command before retry</Alert>
     <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Command {retained.commandKey} · generation {retained.expectedGeneration} · custody {retained.expectedCustodyId} · receipt {retained.expectedReceiptSha256}</Typography>
     <Button disabled={busy} onClick={()=>inspectRelease.mutate()}>Inspect release outcome</Button>
     {releaseStatus&&<Alert severity={releaseStatus.state==='released'?'success':'warning'}>{releaseStatus.state==='not_found'?'No receipt found · completion unconfirmed':releaseStatus.state==='releasing'?`Release pending or unknown. ${releaseStatus.error??''}`:'Released'}</Alert>}
     {inspectRelease.error&&<Alert severity="error">{inspectRelease.error.message}</Alert>}
     <Button color="error" disabled={!enabled||busy||!retryReady} onClick={()=>prepare('release')}>Retry exact release</Button>
    </>}
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>setOpen(false)}>Close</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={Boolean(confirm)} title={confirmation?.title??''} confirmLabel={confirmation?.label??'Continue'} cancelLabel="Back" pending={access.isPending||release.isPending} confirmDisabled={!enabled||busy||confirm==='access'&&!accessReady||confirm==='release'&&!(retained?retryReady:newRelease&&!inspection.isFetching)} onCancel={()=>setConfirm(undefined)} onConfirm={apply}>
   {confirmation?.content}
  </ConfirmDialog>
 </>;
}
