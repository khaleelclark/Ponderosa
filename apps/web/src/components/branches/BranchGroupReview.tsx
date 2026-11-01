import {useEffect,useRef,useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,Typography} from '@mui/material';
import {BranchGroupClient} from '@ponderosa/core';
import type {BranchDefinition,BranchExecutionDetailDto,BranchDisclosureReviewDto,BranchDisclosureReceipt,BranchIssuedGroupCaptureStatus,BranchIssuedGroupDestinationDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {currentProductScope} from '../../api/productScope';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import {disclosureReceiptMatches} from './branchDisclosureReview';
import {groupCaptureMatches,groupDestinationMatches,groupReviewMatches,restoreGroupJournal,type GroupCommand,type GroupJournal} from './branchGroupReview';
type Action='capture'|'prepare'|'approve'|'revoke'|'admit';
const Evidence=({title,value}:{title:string;value:unknown})=><details><summary>{title}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:360,overflow:'auto',fontSize:12}}>{JSON.stringify(value,null,2)}</Typography></details>;
/** One exact two-resource serial flow; retained local keys are recovery, not server discovery. */
export function BranchGroupReview({detail,definition,enabled,onChanged}:{detail:BranchExecutionDetailDto;definition?:BranchDefinition;enabled:boolean;onChanged():void}):JSX.Element {
 const {execution}=detail,branchId=execution.branchId,executionId=execution.id,readOnly=useWorkspaceReadOnly();
 const api=new BranchGroupClient(branchId,executionId,requestJson);
 const storageKey=JSON.stringify(['branch-group',window.location.origin,currentProductScope(),branchId,executionId]);
 const [restored]=useState(()=>restoreGroupJournal(storageKey)),[journal,setJournal]=useState<GroupJournal>(restored.journal),[storageError,setStorageError]=useState(restored.error);
 const [open,setOpen]=useState(false),[capture,setCapture]=useState<BranchIssuedGroupCaptureStatus>(),[target,setTarget]=useState<BranchIssuedGroupDestinationDto>();
 const [review,setReview]=useState<BranchDisclosureReviewDto>(),[receipt,setReceipt]=useState<BranchDisclosureReceipt>(),[reviewed,setReviewed]=useState(false),[effects,setEffects]=useState(false),[confirm,setConfirm]=useState<Action>(),[notice,setNotice]=useState('');
 const fence=useRef(false),epoch=useRef(0);
 const discard=()=>{epoch.current++;setReview(undefined);setReviewed(false);setEffects(false);setConfirm(undefined);};
 useEffect(()=>{discard();},[detail,definition,enabled]);
 const keep=(value:GroupJournal)=>{try{localStorage.setItem(storageKey,JSON.stringify(value));setJournal(value);}catch{setStorageError('Cannot persist exact group input. Preserve browser storage; new changes are blocked.');throw Error('Group input could not be persisted.');}};
 const clearPending=()=>keep({...journal,pending:undefined});
 const acceptCapture=(value:BranchIssuedGroupCaptureStatus)=>{
  if(!journal.capture||!groupCaptureMatches(value,journal.capture))throw Error('Capture identity differs or is outside this two-resource UI. All pins remain held.');
  setCapture(value);
  if(value.state==='retained'&&journal.pending?.kind==='capture')clearPending();
  else if(value.state==='capturing')setNotice('Capture is incomplete. All member cleanup pins stay held; group abandonment and recapture are unavailable here.');
 };
 const acceptTarget=(value:BranchIssuedGroupDestinationDto)=>{
  if(!journal.prepare||!journal.capture||!groupDestinationMatches(value,journal.prepare,executionId,journal.capture.resourceStepIds))throw Error('Group command, checkpoint or both resource identities differ.');
  if(journal.pending?.kind==='admit'&&(value.admissionId!==journal.pending.admissionId||value.state==='admitted'&&value.disclosure.reviewHash!==journal.pending.body.reviewHash))throw Error('Admitted readback differs from original whole-group approval.');
  setTarget(value);
  if(journal.pending?.kind==='prepare'&&['awaiting_disclosure','admitted'].includes(value.state)||journal.pending?.kind==='admit'&&value.state==='admitted')clearPending();
  if(['reserved','import_unknown'].includes(value.state))setNotice('A reserved or uncertain import slot remains held. No reimport, reallocation or mutation retry is available.');
 };
 const refresh=useMutation({retry:false,mutationFn:async()=>{
  discard();setTarget(undefined);setCapture(undefined);setNotice('');
  // Source status, destination and choice reads remain independent when another proof refuses.
  const reads:Promise<unknown>[]=[];
  if(journal.capture)reads.push(api.captureStatus(journal.capture.body.commandKey).then(acceptCapture));
  if(journal.prepare)reads.push(api.inspect(journal.prepare.commandKey).then(acceptTarget));
  if(journal.pending?.kind==='choice'){
   const command=journal.pending;
   reads.push(api.choiceReceipt(command.admissionId,command.body.commandKey).then(value=>{
    if(!disclosureReceiptMatches(value,command.admissionId,command.body))throw Error('Choice receipt differs from original input.');
    setReceipt(value);clearPending();
   }));
  }
  const outcomes=await Promise.allSettled(reads),failures=outcomes.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
  if(failures.length)throw Error(failures.map(r=>r.reason instanceof Error?r.reason.message:String(r.reason)).join(' · '));
 }});
 const preview=useMutation({retry:false,mutationFn:async()=>{
  if(!target)throw Error('Read the exact group destination first.');
  discard();const token=epoch.current,value=await api.review(target.admissionId);
  if(!groupReviewMatches(value,target,branchId,executionId))throw Error('Whole-group facts, identities or policies changed.');
  if(token===epoch.current)setReview(value);
 },onError:()=>discard()});
 const submit=useMutation({retry:false,mutationFn:async(command:GroupCommand)=>{
  const next={...journal,pending:command,...(command.kind==='capture'?{capture:command}:{}),...(command.kind==='prepare'?{prepare:command.body}:{})};
  keep(next);discard();setNotice('');setReceipt(undefined);
  if(command.kind==='capture'){
   await api.capture(command.body);
   // Require the independent no-byte status even after a successful sealing response.
   const value=await api.captureStatus(command.body.commandKey);
   if(!groupCaptureMatches(value,command)||value.state!=='retained')throw Error('Capture remains held or differs from the exact two sources.');
   setCapture(value);keep({...next,pending:undefined});
  }else if(command.kind==='prepare'||command.kind==='admit'){
   const value=command.kind==='prepare'?await api.prepare(command.body):await api.admit(command.body),input=next.prepare;
   if(!input||!next.capture||!groupDestinationMatches(value,input,executionId,next.capture.resourceStepIds)||command.kind==='admit'&&(value.admissionId!==command.admissionId||value.state==='admitted'&&value.disclosure.reviewHash!==command.body.reviewHash))throw Error('Group result differs from retained source and command.');
   setTarget(value);
   if(command.kind==='prepare'&&['awaiting_disclosure','admitted'].includes(value.state)||command.kind==='admit'&&value.state==='admitted')keep({...next,pending:undefined});
   else setNotice('Group outcome remains held. Read its original key; no mutation retry.');
  }else{
   const value=await api.choose(command.admissionId,command.body);
   if(!disclosureReceiptMatches(value,command.admissionId,command.body))throw Error('Group choice receipt differs from original input.');
   setReceipt(value);keep({...next,pending:undefined});setTarget(undefined);
  }
  onChanged();
 },onError:(error,command)=>{
  discard();setNotice(error.message);
  // Choice CAS refusals precede its transactional commit. Other 409s may follow staging.
  if(error instanceof ApiRequestError&&error.status===409&&command.kind==='choice'){clearPending();setTarget(undefined);onChanged();}
 },onSettled:()=>{fence.current=false;setConfirm(undefined);}});
 const busy=refresh.isPending||preview.isPending||submit.isPending;
 const fresh=enabled&&!readOnly&&!storageError&&!journal.pending&&!busy;
 // A presentation bound, never a substitute for the host's exact replay/eligibility checks.
 const serialTwo=Boolean(definition&&!execution.parentExecutionId&&detail.resources.length===2&&detail.paths.length===1&&!detail.paths[0]?.parentPathId&&!detail.paths[0]?.forkInvocationId&&!detail.nextCursor&&!detail.largeEvidenceOmitted&&!definition.controls.some(c=>c.kind==='fork'||c.kind==='join')&&!definition.steps.some(s=>s.kind==='branch_call'));
 const captureReady=fresh&&serialTwo&&!journal.capture&&!journal.prepare&&effects;
 const prepareReady=fresh&&serialTwo&&capture?.state==='retained'&&!journal.prepare&&effects&&['completed','failed','canceled'].includes(execution.state);
 const exact=Boolean(target&&review&&groupReviewMatches(review,target,branchId,executionId));
 const approveReady=fresh&&serialTwo&&exact&&reviewed&&target?.state==='awaiting_disclosure'&&!review?.active;
 const admitReady=fresh&&serialTwo&&exact&&reviewed&&target?.state==='awaiting_disclosure'&&review?.active===true&&target.disclosure.state==='approved'&&target.disclosure.reviewHash===review.reviewHash&&target.disclosure.revision===review.revision;
 const revokeReady=fresh&&target?.disclosure.state==='approved'&&Boolean(target.disclosure.reviewHash);
 const ready=confirm==='capture'?captureReady:confirm==='prepare'?prepareReady:confirm==='approve'?approveReady:confirm==='revoke'?revokeReady:confirm==='admit'?admitReady:false;
 const apply=()=>{
  if(!ready||fence.current)return;let command:GroupCommand;
  if(confirm==='capture')command={kind:'capture',body:{commandKey:createClientId()},resourceStepIds:detail.resources.map(r=>r.stepExecutionId)};
  else if(confirm==='prepare'&&capture?.checkpointId&&capture.checkpointHash)command={kind:'prepare',body:{commandKey:createClientId(),checkpointId:capture.checkpointId,expectedHash:capture.checkpointHash,reconcileEffects:true}};
  else if(confirm==='admit'&&target&&review)command={kind:'admit',admissionId:target.admissionId,body:{commandKey:target.commandKey,reviewHash:review.reviewHash}};
  else if(confirm==='approve'&&target&&review)command={kind:'choice',admissionId:target.admissionId,body:{commandKey:createClientId(),action:'approve',reviewHash:review.reviewHash,expectedRevision:review.revision}};
  else if(confirm==='revoke'&&target?.disclosure.reviewHash)command={kind:'choice',admissionId:target.admissionId,body:{commandKey:createClientId(),action:'revoke',reviewHash:target.disclosure.reviewHash,expectedRevision:target.disclosure.revision}};
  else return;fence.current=true;submit.mutate(command);
 };
 return <>
  <Button onClick={()=>{discard();setOpen(true);}}>Review two-resource group</Button>
  <Dialog open={open} fullWidth maxWidth="md" disableEscapeKeyDown={busy} onClose={()=>{if(!busy){discard();setOpen(false);}}}>
   <DialogTitle>Two-resource group</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    <Alert severity="warning">Preparation reuses the current owner Project directory. It creates a fresh Project with its usual default Chat and two resource Chats, sharing the existing filesystem directory. It creates no separate workspace or working copy.</Alert>
    <Typography>Only two serial generation-zero resources are offered here. More resources, parallel owners, called trees and later generations remain unavailable in this UI. The host independently checks the exact cut, packages, current ownership, drain and policies.</Typography>
    <Alert severity="info">Server discovery of group commands and original capture keys is unavailable. This view can recover only its own keys retained in this browser. Keep browser storage; do not paste or guess IDs.</Alert>
    {(storageError||notice)&&<Alert severity="warning">{storageError||notice}</Alert>}
    {!enabled&&<Alert severity="warning">Refresh this Run before applying changes.</Alert>}
    {journal.pending&&<Alert severity="warning">Unconfirmed {journal.pending.kind}. Original input stays retained. Read its exact command; no mutation is replayed.</Alert>}
    <Button disabled={busy||Boolean(storageError)||!journal.capture&&!journal.prepare} onClick={()=>refresh.mutate()}>Read retained group commands</Button>
    {refresh.error&&<Alert severity="error">{refresh.error.message}</Alert>}
    <Evidence title="Original retained command identities" value={journal}/>
    {capture&&<><Typography>Capture {capture.state} · cleanup held {String(capture.cleanupHeld)} · checkpoint {capture.checkpointId} · {capture.checkpointHash}</Typography><Evidence title="Both exact source seals" value={capture}/></>}
    {!journal.capture&&<>
     {!serialTwo&&<Alert severity="info">A complete current two-resource serial source view is required to offer capture.</Alert>}
     <Evidence title="Current source resource identities" value={detail.resources}/>
    </>}
    {!journal.prepare&&<><FormControlLabel control={<Checkbox checked={effects} disabled={!fresh} onChange={(_,v)=>setEffects(v)}/>} label="I reconciled original external effects; unknown effects remain held"/>
     <Button disabled={!captureReady} onClick={()=>setConfirm('capture')}>Capture exact two-resource cut</Button>
     <Button disabled={!prepareReady} onClick={()=>setConfirm('prepare')}>Prepare held group</Button></>}
    {target&&<>
     <Typography>Admission {target.admissionId} · {target.state} · persisted disclosure {target.disclosure.state}, revision {target.disclosure.revision}</Typography>
     <Evidence title="Both packages and exact fresh resource identities" value={target.resources}/>
     {['reserved','import_unknown'].includes(target.state)&&<Alert severity="warning">Unknown or reserved slots stay held. No reimport or independent member admission.</Alert>}
     <Button disabled={!fresh||!['awaiting_disclosure','admitted'].includes(target.state)} onClick={()=>preview.mutate()}>Review whole-group disclosure</Button>
     <Button color="error" disabled={!revokeReady} onClick={()=>setConfirm('revoke')}>Revoke whole-group disclosure</Button>
    </>}
    {preview.error&&<Alert severity="error">{preview.error.message}</Alert>}
    {review&&exact&&<>
     <Typography sx={{overflowWrap:'anywhere'}}>Whole review {review.reviewHash} · host cut {review.hostCutSha256} · policy hash {review.policyRevision} · revision {review.revision}</Typography>
     <Evidence title="Exact reservation, both packages, fresh maps and both current policies" value={{reservation:review.review.reservation,stage:review.review.stage,policies:review.policy}}/>
     {review.facts.map(f=><Stack key={`${f.kind}:${f.id}`} spacing={.5}>
      <Typography>{f.kind} {f.id} · {f.sha256}</Typography>
      <Typography sx={{overflowWrap:'anywhere'}}>Original participants {f.originalAgentIds.join(', ')} · fresh recipients {f.destinationAgentIds.join(', ')}</Typography>
      <Evidence title="Original actor, audience and exact private fact" value={{actor:f.originalActor,audience:f.originalAudience,content:f.content}}/>
     </Stack>)}
     <FormControlLabel control={<Checkbox checked={reviewed} disabled={!fresh} onChange={(_,v)=>setReviewed(v)}/>} label="I reviewed every original fact, actor, audience, mapped recipient, both resource identities and both current policies"/>
     <Button disabled={!approveReady} onClick={()=>setConfirm('approve')}>Approve whole-group disclosure</Button>
     <Button disabled={!admitReady} onClick={()=>setConfirm('admit')}>Admit whole group</Button>
    </>}
    {receipt&&<Evidence title="Historical choice receipt; current approval requires fresh review" value={receipt}/>}
    {target?.receipt&&<Evidence title="Canonical admitted group provenance and owner receipts" value={target.receipt}/>}
    <Typography variant="caption">Partial capture abandonment, custody release and group retirement are unavailable in this flow. Every unresolved member remains held.</Typography>
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>{discard();setOpen(false);}}>Close</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={Boolean(confirm)} title={confirm==='capture'?'Capture this whole cut?':confirm==='prepare'?'Prepare held group?':confirm==='approve'?'Approve all listed facts?':confirm==='revoke'?'Revoke whole-group disclosure?':'Admit both resources atomically?'} confirmLabel="Confirm exact group action" cancelLabel="Back" pending={submit.isPending} confirmDisabled={!ready} onCancel={()=>setConfirm(undefined)} onConfirm={apply}>
   <Typography>{confirm==='capture'?'Captures both actual private packages. Partial capture retains all cleanup pins and has no abandonment command.':confirm==='prepare'?'Creates held fresh identities using the current Project directory. No separate workspace is created.':confirm==='approve'?'Authorizes every listed historical fact for the exact fresh recipients under both reviewed policies. Approval alone starts no work.':confirm==='revoke'?'Revokes the exact persisted revision without needing package bytes. Previously disclosed facts are not erased.':'Commits one whole mapped graph and both imports, then permits eligible new work. Original external effects are not replayed.'}</Typography>
   <Typography sx={{overflowWrap:'anywhere'}}>Checkpoint {capture?.checkpointId??target?.checkpointId} · {capture?.checkpointHash??target?.checkpointHash} · admission {target?.admissionId} · review {confirm==='revoke'?target?.disclosure.reviewHash:review?.reviewHash}</Typography>
  </ConfirmDialog>
 </>;
}
