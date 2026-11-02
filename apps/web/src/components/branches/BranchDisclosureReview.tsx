import {BranchGenerationOne} from './BranchGenerationOne';
import {generationHistoryKindLabel,generationOneSelectionMatches,generationOneReceiptProjection,type GenerationOneSelection} from './branchGenerationOne';
import {LifecycleReview} from '../lifecycle/LifecycleReview';
import {useRef,useState} from 'react';
import {useInfiniteQuery,useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {BranchDisclosureChoice,BranchDisclosureReceipt,BranchDisclosureReviewDto,BranchHistoricalCheckpointDto,BranchIssuedDestinationDto,BranchIssuedDestinationInput} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {disclosureCanRevoke,disclosureReceiptMatches,disclosureReviewMatches,historicalFactGeneration} from './branchDisclosureReview';

type Command={kind:'prepare';body:BranchIssuedDestinationInput;generationOne?:GenerationOneSelection}|{kind:'choice';admissionId:string;body:BranchDisclosureChoice}|{kind:'admit';admissionId:string;body:{commandKey:string;reviewHash:string}};
type Action='prepare'|'approve'|'revoke'|'admit';
export function BranchDisclosureReview({branchId,executionId,enabled,onChanged,resourceStepIds=[]}:{branchId:string;executionId:string;enabled:boolean;onChanged():void;resourceStepIds?:string[]}):JSX.Element {
 const base=`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}/destinations`,storageKey=`branch-disclosure-command:${branchId}:${executionId}`;
 const [open,setOpen]=useState(false),[selected,setSelected]=useState(''),[checkpoint,setCheckpoint]=useState<BranchHistoricalCheckpointDto>();
 const [review,setReview]=useState<BranchDisclosureReviewDto>(),[reviewed,setReviewed]=useState(false),[effects,setEffects]=useState(false),[confirm,setConfirm]=useState<Action>();
 const [pending,setPending]=useState<Command|undefined>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)??'null')??undefined;}catch{return undefined;}});
 const [receipt,setReceipt]=useState<BranchDisclosureReceipt|BranchIssuedDestinationDto>(),[notice,setNotice]=useState('');
 const [generationOne,setGenerationOne]=useState<GenerationOneSelection>();
 const fence=useRef(false),epoch=useRef(0);
 const list=useQuery({queryKey:['branch-issued-destinations',branchId,executionId],queryFn:()=>requestJson<BranchIssuedDestinationDto[]>(base),enabled:open,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const checkpoints=useInfiniteQuery({queryKey:['branch-disclosure-checkpoints',branchId,executionId],initialPageParam:undefined as number|undefined,queryFn:({pageParam})=>requestJson<BranchHistoricalCheckpointDto[]>(`/api/branches/${encodeURIComponent(branchId)}/executions/${encodeURIComponent(executionId)}/historical-checkpoints${pageParam===undefined?'':`?before=${pageParam}`}`),getNextPageParam:page=>page.length?Math.min(...page.map(item=>item.id)):undefined,enabled:open,retry:false,refetchOnWindowFocus:false});
 const target=list.data?.find(item=>item.commandKey===selected);
 const discardReview=()=>{epoch.current++;setReview(undefined);setReviewed(false);setEffects(false);setConfirm(undefined);};
 const refresh=async()=>{discardReview();setGenerationOne(undefined);setCheckpoint(undefined);await list.refetch();};
 const preview=useMutation({retry:false,mutationFn:async()=>{
  if(!target||!['awaiting_disclosure','admitted'].includes(target.state))throw Error('Choose a staged destination.');
  const token=epoch.current,value=await requestJson<BranchDisclosureReviewDto>(`${base}/${encodeURIComponent(target.admissionId)}/disclosure`);
  if(!disclosureReviewMatches(value,target,branchId,executionId))throw Error('Disclosure source/destination changed · refresh destinations');
  return {token,value};
 },onSuccess:({token,value})=>{if(token===epoch.current){setReview(value);setReviewed(false);setConfirm(undefined);}},onError:error=>{setReview(undefined);setReviewed(false);setConfirm(undefined);if(error instanceof ApiRequestError&&error.status===409)void list.refetch();}});
 const clearPending=()=>{localStorage.removeItem(storageKey);setPending(undefined);};
 const accept=async(command:Command,value:BranchDisclosureReceipt|BranchIssuedDestinationDto)=>{
  if(command.kind==='choice'){
   if(!('action' in value)||!disclosureReceiptMatches(value,command.admissionId,command.body))throw Error('Disclosure receipt differs from the retained choice.');
   setNotice('');setReceipt(value);clearPending();
  }else{
   if(!('destination' in value)||value.commandKey!==command.body.commandKey||command.kind==='prepare'&&(value.checkpointId!==command.body.checkpointId||value.checkpointHash!==command.body.expectedHash)||command.kind==='admit'&&value.admissionId!==command.admissionId)throw Error('Destination receipt differs from the retained command.');
   if(command.kind==='prepare'&&command.generationOne&&(!generationOneSelectionMatches(command.generationOne,executionId)||command.body.checkpointId!==command.generationOne.capture.checkpointId||command.body.expectedHash!==command.generationOne.capture.checkpointHash||command.body.historicalReviewHash!==command.generationOne.preview.historicalReviewHash||JSON.stringify(value.historicalPartition)!==JSON.stringify(command.generationOne.preview.historicalPartition)))throw Error('Historical selection differs from the saved server capture.');
   setNotice('');setReceipt(value);setSelected(value.commandKey);
   if(command.kind==='prepare'&&['awaiting_disclosure','admitted'].includes(value.state)||command.kind==='admit'&&value.state==='admitted')clearPending();
   else setNotice('Preparation/admission held · no effect retry');
  }
  onChanged();await refresh();
 };
 const submit=useMutation({retry:false,mutationFn:async(command:Command)=>{
  localStorage.setItem(storageKey,JSON.stringify(command));setPending(command);
  const path=command.kind==='prepare'?base:command.kind==='admit'?`${base}/admit`:`${base}/${encodeURIComponent(command.admissionId)}/disclosure`;
  const value=await requestJson<BranchDisclosureReceipt|BranchIssuedDestinationDto>(path,{method:'POST',body:JSON.stringify(command.body)});
  await accept(command,value);
 },onError:error=>{
  setNotice(error.message);setConfirm(undefined);
  if(error instanceof ApiRequestError&&error.status===409){
   // Keep the exact original command for pure receipt recovery after any refusal.
   void refresh();onChanged();
  }
 },onSettled:()=>{fence.current=false;setConfirm(undefined);}});
 const inspect=useMutation({retry:false,mutationFn:async()=>{
  if(!pending)throw Error('No retained command.');
  const path=pending.kind==='choice'?`${base}/${encodeURIComponent(pending.admissionId)}/disclosure?commandKey=${encodeURIComponent(pending.body.commandKey)}`:`${base}?commandKey=${encodeURIComponent(pending.body.commandKey)}`;
  await accept(pending,await requestJson<BranchDisclosureReceipt|BranchIssuedDestinationDto>(path));
 }});
 const readDestination=useMutation({retry:false,mutationFn:async()=>{
  if(!target)throw Error('Choose a destination.');
  const value=await requestJson<BranchIssuedDestinationDto>(`${base}?commandKey=${encodeURIComponent(target.commandKey)}`);
  if(value.commandKey!==target.commandKey||value.admissionId!==target.admissionId)throw Error('Destination receipt scope changed.');
  setReceipt(value);
 }});
 const busy=submit.isPending||inspect.isPending||preview.isPending||readDestination.isPending;
 const locked=busy||Boolean(pending);
 const fresh=enabled&&!list.isFetching&&!list.isError&&!locked;
 const exactReview=Boolean(target&&review&&disclosureReviewMatches(review,target,branchId,executionId));
 const approveReady=fresh&&exactReview&&reviewed&&target?.state==='awaiting_disclosure'&&review?.active!==true;
 const admitReady=fresh&&exactReview&&reviewed&&target?.state==='awaiting_disclosure'&&review?.active===true&&target.disclosure.state==='approved'&&target.disclosure.reviewHash===review.reviewHash&&target.disclosure.revision===review.revision;
 const prepareReady=fresh&&effects&&Boolean(generationOne?generationOneSelectionMatches(generationOne,executionId):checkpoint?.branchId===branchId&&checkpoint.executionId===executionId);
 const revokeReady=fresh&&disclosureCanRevoke(target);
 const ready=confirm==='prepare'?prepareReady:confirm==='approve'?approveReady:confirm==='revoke'?revokeReady:confirm==='admit'?admitReady:false;
 const apply=()=>{
  if(!ready||fence.current)return;
  let command:Command;
  if(confirm==='prepare'&&generationOne)command={kind:'prepare',generationOne,body:{commandKey:createClientId(),checkpointId:generationOne.capture.checkpointId!,expectedHash:generationOne.capture.checkpointHash!,historicalReviewHash:generationOne.preview.historicalReviewHash,reconcileEffects:true}};
  else if(confirm==='prepare'&&checkpoint)command={kind:'prepare',body:{commandKey:createClientId(),checkpointId:checkpoint.id,expectedHash:checkpoint.contentHash,reconcileEffects:true}};
  else if(confirm==='admit'&&target&&review)command={kind:'admit',admissionId:target.admissionId,body:{commandKey:target.commandKey,reviewHash:review.reviewHash}};
  else if(confirm==='approve'&&target&&review)command={kind:'choice',admissionId:target.admissionId,body:{commandKey:createClientId(),action:'approve',reviewHash:review.reviewHash,expectedRevision:review.revision}};
  else if(confirm==='revoke'&&target?.disclosure.reviewHash)command={kind:'choice',admissionId:target.admissionId,body:{commandKey:createClientId(),action:'revoke',reviewHash:target.disclosure.reviewHash,expectedRevision:target.disclosure.revision}};
  else return;
  fence.current=true;setNotice('');setReceipt(undefined);submit.mutate(command);
 };
 return <>
  <Button onClick={()=>{discardReview();setOpen(true);}}>Review fresh destination</Button>
  <Dialog open={open} fullWidth maxWidth="md" disableEscapeKeyDown={busy} onClose={()=>{if(!busy){epoch.current++;setOpen(false);}}}>
   <DialogTitle>Fresh destination review</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    <Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Branch {branchId} · source Run {executionId}</Typography>
    {target&&<LifecycleReview key={`retirement:${target.admissionId}`} kind="destination" id={target.admissionId} enabled={enabled}/> }
    <Alert severity="warning">Reconcile original effects first · unknown effects remain held without replay</Alert>
    {!enabled&&<Alert severity="warning">Refresh this Run before applying changes.</Alert>}
    {notice&&<Alert severity="warning">{notice}</Alert>}
    {pending&&<Alert severity="warning">Unconfirmed command · inspect retained key · no automatic retry</Alert>}
    {pending&&<><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>{pending.kind} · {pending.body.commandKey}</Typography><Button disabled={busy} onClick={()=>inspect.mutate()}>Inspect retained command</Button></>}
    {inspect.error&&<Alert severity="error">{inspect.error.message}</Alert>}
    <Button disabled={busy||list.isFetching} onClick={()=>void refresh()}>Refresh destinations</Button>
    {list.error&&<Alert severity="error">{list.error.message}</Alert>}
    <Typography variant="caption">Latest 50 destinations · exact retained keys available for receipt inspection</Typography>
    <TextField select label="Destination" value={selected} disabled={locked||list.isFetching} onChange={event=>{discardReview();preview.reset();readDestination.reset();setReceipt(undefined);setSelected(event.target.value);}}>
     {list.data?.map(item=><MenuItem key={item.commandKey} value={item.commandKey}>{item.destination.conversationId} · generation {item.destination.resourceGeneration} · {item.state}</MenuItem>)}
    </TextField>
    {target&&<>
     <Typography sx={{overflowWrap:'anywhere'}}>Admission {target.admissionId} · Project {target.destination.projectId} · Chat {target.destination.conversationId} · Run {target.destination.executionId} · Step {target.destination.resourceStepId} · generation {target.destination.resourceGeneration}</Typography>
     <Typography variant="body2">Persisted disclosure: {target.disclosure.state} · revision {target.disclosure.revision} · current eligibility: fresh preview required</Typography>
     {target.state==='import_unknown'&&<Alert severity="warning">Import unknown · destination held · no import retry</Alert>}
     <Stack direction="row" gap={1}><Button disabled={!fresh||!['awaiting_disclosure','admitted'].includes(target.state)} onClick={()=>{discardReview();preview.mutate();}}>Preview disclosure</Button><Button disabled={locked||list.isFetching} onClick={()=>readDestination.mutate()}>Read destination receipt</Button><Button color="error" disabled={!revokeReady} onClick={()=>setConfirm('revoke')}>Revoke disclosure</Button></Stack>
    </>}
    {preview.error&&<Alert severity="error">{preview.error.message}</Alert>}
    {readDestination.error&&<Alert severity="error">{readDestination.error.message}</Alert>}
    {review&&exactReview&&<>
     <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Checkpoint {review.review.reservation.checkpointId} · {review.review.reservation.checkpointHash} · host cut {review.hostCutSha256}</Typography>
     <Typography variant="caption">Current source package generation {review.review.reservation.custody.intent?.resourceGeneration??'unavailable'} · {review.review.reservation.historicalPartition?.length??0} retired generations · fresh numbering preserves consumed attempts</Typography>
     <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Review {review.reviewHash} · policy {review.policyRevision} · revision {review.revision} · active {String(review.active)}</Typography>
     <details><summary>Custody, fresh participant maps and current policy</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto',fontSize:12}}>{JSON.stringify({historicalPartition:review.review.reservation.historicalPartition,custody:review.review.reservation.custody,currentPackageParticipants:review.review.stage,policy:review.policy},null,2)}</Typography></details>
     {review.review.reservation.historicalPartition?.length&&<Alert severity="warning"><Stack spacing={0.5}><Typography>Prior generations · immutable evidence · nondispatchable</Typography><Typography>Fresh maps · current source participants only · consumed attempts and retry limit unchanged</Typography><Typography>Separate requirements · original Project audit access · fresh destination Project ownership</Typography></Stack></Alert>}
     {review.facts.map(fact=><Stack key={`${fact.kind}:${fact.id}`} spacing={.5}>
      <Typography variant="subtitle2">{fact.kind==='historical_generation'?`Retired source generation ${historicalFactGeneration(fact)} · nondispatchable evidence`:fact.kind} {fact.id}</Typography><Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Original participants: {fact.originalAgentIds.join(', ')} · fresh recipients: {fact.destinationAgentIds.join(', ')}</Typography>
      <Typography variant="body2" sx={{overflowWrap:'anywhere'}}>Original actor: {JSON.stringify(fact.originalActor??null)} · original audience: {JSON.stringify(fact.originalAudience)}</Typography>
      <details><summary>Exact historical fact · {fact.sha256}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto',fontSize:12}}>{JSON.stringify(fact.content,null,2)}</Typography></details>
     </Stack>)}
     <FormControlLabel control={<Checkbox checked={reviewed} disabled={locked||list.isFetching} onChange={(_,checked)=>setReviewed(checked)}/>} label="I reviewed the exact historical facts, audiences, fresh recipients and current policy"/>
     <Stack direction="row" gap={1}><Button disabled={!approveReady} onClick={()=>setConfirm('approve')}>Approve disclosure</Button><Button variant="contained" disabled={!admitReady} onClick={()=>setConfirm('admit')}>Admit reviewed destination</Button></Stack>
    </>}
    {resourceStepIds.map(stepId=><BranchGenerationOne key={stepId} branchId={branchId} executionId={executionId} stepId={stepId} enabled={fresh} onSelect={value=>{discardReview();setEffects(false);setCheckpoint(undefined);setGenerationOne(value);}}/>)}
    {generationOne&&<Alert severity="info"><Stack spacing={0.5}><Typography>{generationHistoryKindLabel(generationOne.preview.historyKind)} · source generation {generationOne.preview.generation} · checkpoint {generationOne.capture.checkpointId} · {generationOne.capture.checkpointHash}</Typography><Typography>Historical selection hash · {generationOne.preview.historicalReviewHash}</Typography><Typography>Consumed attempts · {generationOne.preview.consumedAttempts??'not supplied by saved status'} · pinned maximum · {generationOne.preview.maxAttempts??'not supplied by saved status'} · no reset</Typography><Typography>Audit-read required · every original Project + historical Request Project · separate fresh Project ownership</Typography></Stack></Alert>}
    <details><summary>Prepare from saved checkpoint</summary><Stack spacing={2} sx={{pt:1}}>
     <TextField select label="Source checkpoint" value={checkpoint?.id??''} disabled={locked} onChange={event=>{setEffects(false);setGenerationOne(undefined);setCheckpoint(checkpoints.data?.pages.flat().find(item=>item.id===Number(event.target.value)));}}>{checkpoints.data?.pages.flat().map(item=><MenuItem key={item.id} value={item.id}>{item.id} · {item.contentHash}</MenuItem>)}</TextField>
     {checkpoints.error&&<Alert severity="error">{checkpoints.error.message}</Alert>}
     {checkpoints.hasNextPage&&<Button disabled={locked||checkpoints.isFetchingNextPage} onClick={()=>void checkpoints.fetchNextPage()}>Older checkpoints</Button>}
     <Typography variant="caption">Preparation · supported sealed cuts only · fresh participants held pending disclosure approval</Typography>
     <FormControlLabel control={<Checkbox checked={effects} disabled={locked} onChange={(_,checked)=>setEffects(checked)}/>} label="I reconciled original external effects before preparing fresh participants"/>
     <Button disabled={!prepareReady} onClick={()=>setConfirm('prepare')}>Prepare fresh destination</Button>
    </Stack></details>
    {receipt&&<Alert severity="info"><Typography>{'action' in receipt?`${receipt.action} receipt: ${receipt.state} · currently active ${String(receipt.active)}`:`Destination: ${receipt.state}`}</Typography><Typography variant="caption">Historical receipt state does not authorize a new approval or prove original work succeeded.</Typography><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto',fontSize:12}}>{JSON.stringify('destination' in receipt?generationOneReceiptProjection(receipt):receipt,null,2)}</Typography></Alert>}
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>{epoch.current++;setOpen(false);}}>Close</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={Boolean(confirm)} title={confirm==='prepare'?'Prepare held fresh participants?':confirm==='approve'?'Approve this exact disclosure?':confirm==='revoke'?'Revoke persisted disclosure?':'Admit reviewed destination?'} confirmLabel={confirm==='prepare'?'Prepare destination':confirm==='approve'?'Approve exact disclosure':confirm==='revoke'?'Revoke exact choice':'Admit destination'} cancelLabel="Back" pending={submit.isPending} confirmDisabled={!ready} onCancel={()=>setConfirm(undefined)} onConfirm={apply}>
   <Typography>{confirm==='prepare'?'Creates a fresh managed Project, Chat and held participants.':confirm==='approve'?'Permits listed facts to reach exact fresh recipients under reviewed policy, without activation':confirm==='revoke'?'Revokes persisted choice; earlier approval receipts cannot restore it and disclosed facts remain':'Commits mapped Requests/Joins and permits eligible new work, without replaying original effects'}</Typography>
   <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>{confirm==='prepare'?`Checkpoint ${generationOne?.capture.checkpointId??checkpoint?.id} · ${generationOne?.capture.checkpointHash??checkpoint?.contentHash} · historical selection ${generationOne?.preview.historicalReviewHash??'none'}`:`Admission ${target?.admissionId} · hash ${confirm==='revoke'?target?.disclosure.reviewHash:review?.reviewHash} · revision ${confirm==='revoke'?target?.disclosure.revision:review?.revision}`}</Typography>
  </ConfirmDialog>
 </>;
}
