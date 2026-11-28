import {useEffect,useRef,useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,Typography} from '@mui/material';
import {BranchGroupClient} from '@ponderosa/core';
import type {BranchTreeGroupCaptureStatus,BranchGroupDiscoveryItem,BranchDefinition,BranchExecutionDetailDto,BranchDisclosureReviewDto,BranchDisclosureReceipt,BranchIssuedGroupDestinationDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {currentProductScope} from '../../api/productScope';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import {disclosureReceiptMatches} from './branchDisclosureReview';
import {GroupJournalAudit} from './GroupJournalAudit';
import {treeCut,treePreviewSupported,captureResourceIds,type GroupCaptureCut,type GroupCaptureStatus,groupPreviewSupported,groupCaptureMatches,groupDestinationMatches,groupReviewMatches,restoreGroupJournal,type GroupCommand,type GroupJournal} from './branchGroupReview';
type Action='capture'|'prepare'|'approve'|'revoke'|'admit';
const Evidence=({title,value}:{title:string;value:unknown})=><details><summary>{title}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:360,overflow:'auto',fontSize:12}}>{JSON.stringify(value,null,2)}</Typography></details>;
/** Whole-group actions use server eligibility and exact retained command identities. */
export function BranchGroupReview({detail,definition,enabled,onChanged}:{detail:BranchExecutionDetailDto;definition?:BranchDefinition;enabled:boolean;onChanged():void}):JSX.Element {
 const {execution}=detail,branchId=execution.branchId,executionId=execution.id,readOnly=useWorkspaceReadOnly();
 const api=new BranchGroupClient(branchId,executionId,requestJson);
 const storageKey=JSON.stringify(['branch-group',window.location.origin,currentProductScope(),branchId,executionId]);
 const [restored]=useState(()=>restoreGroupJournal(storageKey)),[journal,setJournal]=useState<GroupJournal>(restored.journal),[storageError,setStorageError]=useState(restored.error);
 const [open,setOpen]=useState(false),[capture,setCapture]=useState<GroupCaptureStatus>(),[target,setTarget]=useState<BranchIssuedGroupDestinationDto>();
 const [review,setReview]=useState<BranchDisclosureReviewDto>(),[receipt,setReceipt]=useState<BranchDisclosureReceipt>(),[reviewed,setReviewed]=useState(false),[effects,setEffects]=useState(false),[confirm,setConfirm]=useState<Action>(),[notice,setNotice]=useState('');
 const [cut,setCut]=useState<GroupCaptureCut>(),[cutReviewed,setCutReviewed]=useState(false);
 const [treeInventory,setTreeInventory]=useState<(BranchTreeGroupCaptureStatus&{commandKey:string})[]>();
 const supportedCut=(value:GroupCaptureCut)=>treeCut(value)?treePreviewSupported(value):groupPreviewSupported(value);
 const captureRead=(command:Extract<GroupCommand,{kind:'capture'}>)=>command.scope==='owner_tree'?api.treeCaptureStatus(command.body.commandKey):api.captureStatus(command.body.commandKey);
 const [audit,setAudit]=useState<unknown>();
 const [inventory,setInventory]=useState<{kind:'captures'|'admissions';items:BranchGroupDiscoveryItem[];nextCursor?:string}>();
 const fence=useRef(false),epoch=useRef(0);
 const discard=()=>{epoch.current++;setReview(undefined);setReviewed(false);setCut(undefined);setCutReviewed(false);setEffects(false);setConfirm(undefined);};
 useEffect(()=>{discard();},[detail,definition,enabled]);
 const keep=(value:GroupJournal)=>{try{localStorage.setItem(storageKey,JSON.stringify(value));setJournal(value);}catch{setStorageError('Exact group input not saved · preserve browser storage · new changes blocked');throw Error('Group input could not be persisted.');}};
 const clearPending=()=>keep({...journal,pending:undefined});
 const acceptCapture=(value:GroupCaptureStatus)=>{
  if(!journal.capture||!groupCaptureMatches(value,journal.capture))throw Error('Capture identity differs/outside 2–32-resource bound · all pins held');
  setCapture(value);
  if(value.state==='retained'&&journal.pending?.kind==='capture')clearPending();
  else if(value.state==='capturing')setNotice('Capture incomplete · all cleanup pins held · no abandonment/recapture here');
 };
 const acceptTarget=(value:BranchIssuedGroupDestinationDto)=>{
  if(!journal.prepare||!groupDestinationMatches(value,journal.prepare,executionId,journal.capture?.resourceStepIds??value.resources?.map(r=>r.custody.intent.resourceStepId)??[],journal.capture))throw Error('Group command, checkpoint or every resource identity differ.');
  if(journal.pending?.kind==='admit'&&(value.admissionId!==journal.pending.admissionId||value.state==='admitted'&&value.disclosure.reviewHash!==journal.pending.body.reviewHash))throw Error('Admitted readback differs from original whole-group approval.');
  setTarget(value);
  if(journal.pending?.kind==='prepare'&&['awaiting_disclosure','admitted'].includes(value.state)||journal.pending?.kind==='admit'&&value.state==='admitted')clearPending();
  if(['reserved','import_unknown'].includes(value.state))setNotice('Reserved/uncertain import slot held · no reimport/reallocation/mutation retry');
 };
 const refresh=useMutation({retry:false,mutationFn:async()=>{
  discard();setTarget(undefined);setCapture(undefined);setNotice('');
  // Source status, destination and choice reads remain independent when another proof refuses.
  const reads:Promise<unknown>[]=[];
  if(journal.capture)reads.push(captureRead(journal.capture).then(acceptCapture));
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
 const discover=useMutation({retry:false,mutationFn:async(input:{kind:'captures'|'admissions';more?:boolean})=>{
  discard();const token=epoch.current,page=await api.discover(input.kind,input.more?inventory?.nextCursor:undefined);
  if(!page||!Array.isArray(page.items)||page.items.length>50||page.nextCursor!==undefined&&typeof page.nextCursor!=='string'||page.items.some(r=>r.kind!==input.kind||!r.branchId||!r.executionId||!Number.isSafeInteger(r.resourceCount)||typeof r.ownerPresent!=='boolean'||r.resourceCount<2||r.resourceCount>32||!['exact','unsupported_legacy_key'].includes(r.discovery)||r.discovery==='exact'&&!r.commandKey))throw Error('Invalid discovery page; restart the collection.');
  if(token!==epoch.current)return;
  if(input.more&&page.nextCursor===inventory?.nextCursor)throw Error('Discovery cursor did not advance; restart explicitly.');
  setInventory({kind:input.kind,items:[...(input.more?inventory?.items??[]:[]),...page.items],nextCursor:page.nextCursor});
 },onError:()=>{setInventory(undefined);setAudit(undefined);setTarget(undefined);setCapture(undefined);discard();}});
 const recover=useMutation({retry:false,mutationFn:async(row:BranchGroupDiscoveryItem)=>{
  if(journal.pending||storageError||row.discovery!=='exact'||!row.commandKey)throw Error('Resolve any pending command before selecting another.');
  discard();setTarget(undefined);setCapture(undefined);setReceipt(undefined);setAudit(undefined);
  const scoped=new BranchGroupClient(row.branchId,row.executionId,requestJson),local=row.branchId===branchId&&row.executionId===executionId;
  if(row.kind==='captures'){
   const value=await scoped.captureStatus(row.commandKey);
   const command:Extract<GroupCommand,{kind:'capture'}>={kind:'capture',body:{commandKey:row.commandKey,reviewHash:row.reviewHash??'',versionId:row.versionId??''},resourceStepIds:value.sources.map(r=>r.resourceStepId)};
   if(!row.reviewHash||!/^[a-f0-9]{64}$/.test(row.reviewHash)||!row.versionId?.trim()||value.sources.length!==row.resourceCount||!groupCaptureMatches(value,command)||row.checkpointId!==undefined&&(row.checkpointId!==value.checkpointId||row.checkpointHash!==value.checkpointHash))throw Error('Discovered capture differs from exact status · all pins held');
   if(local){keep({capture:command});setCapture(value);}else setAudit({identity:row,status:value});
   if(value.state==='capturing')setNotice('Partial capture held · no capture replay/abandonment here');
  }else{
   if(!row.checkpointId||!row.checkpointHash)throw Error('Missing canonical checkpoint identity.');
   // Discovery supplies readback identity, not optional original import settings; never POST this preparation.
   const input={commandKey:row.commandKey,checkpointId:row.checkpointId,expectedHash:row.checkpointHash,reconcileEffects:true as const},value=await scoped.inspect(row.commandKey);
   if(value.admissionId!==row.admissionId||value.resources.length!==row.resourceCount||!groupDestinationMatches(value,input,row.executionId,value.resources.map(r=>r.custody.intent.resourceStepId)))throw Error('Discovered admission differs from exact command readback.');
   if(local){keep({prepare:input});setTarget(value);}else setAudit({identity:row,destination:value});
  }
 },onError:error=>{discard();setNotice(error.message);setAudit(undefined);setTarget(undefined);setCapture(undefined);}});
 const treeDiscovery=useMutation({retry:false,mutationFn:async()=>{
  discard();setTreeInventory(undefined);setCapture(undefined);const token=epoch.current,page=await api.discoverTreeCaptures();
  if(!page||!Array.isArray(page.items)||page.items.length>100||new Set(page.items.map(r=>r.commandKey)).size!==page.items.length||page.items.some(r=>!r.commandKey||!r.sources?.some(s=>s.executionId===executionId)||!groupCaptureMatches(r,{kind:'capture',scope:'owner_tree',body:{commandKey:r.commandKey,reviewHash:r.reviewHash,versionId:r.versionId},resourceStepIds:r.sources?.map(s=>s.resourceStepId)??[],treeSources:r.sources})))throw Error('Invalid canonical tree inventory; explicitly rediscover.');
  if(token===epoch.current)setTreeInventory(page.items);
 },onError:()=>{setTreeInventory(undefined);setCapture(undefined);discard();}});
 const treeRecovery=useMutation({retry:false,mutationFn:async(row:BranchTreeGroupCaptureStatus&{commandKey:string})=>{
  if(journal.pending||storageError)throw Error('Original pending command must resolve first.');
  discard();setCapture(undefined);setTarget(undefined);
  const command:Extract<GroupCommand,{kind:'capture'}>={kind:'capture',scope:'owner_tree',body:{commandKey:row.commandKey,reviewHash:row.reviewHash,versionId:row.versionId},resourceStepIds:row.sources.map(s=>s.resourceStepId),treeSources:row.sources,checkpointId:row.checkpointId,checkpointHash:row.checkpointHash};
  const value=await api.treeCaptureStatus(row.commandKey);
  if(!groupCaptureMatches(value,command))throw Error('Canonical tree selection changed; keep pins held.');
  keep({capture:command});setCapture(value);
 },onError:error=>{setTreeInventory(undefined);setCapture(undefined);discard();setNotice(error.message);}});
 const capturePreview=useMutation({retry:false,mutationFn:async(scope?:'owner_tree')=>{
  discard();const token=epoch.current,value=await (scope==='owner_tree'?api.previewTreeCapture():api.previewCapture());
  if(!supportedCut(value)||treeCut(value)&&!value.owners.some(o=>o.executionId===executionId&&o.branchId===branchId))throw Error('Unsupported or invalid server resource inventory.');
  if(token===epoch.current)setCut(value);
 },onError:()=>{setTreeInventory(undefined);discard();}});
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
   await (command.scope==='owner_tree'?api.captureTree(command.body):api.capture(command.body));
   // Require the independent no-byte status even after a successful sealing response.
   const value=await captureRead(command);
   if(!groupCaptureMatches(value,command)||value.state!=='retained')throw Error('Capture remains held or differs from the exact resource inventory.');
   setCapture(value);keep({...next,pending:undefined});
  }else if(command.kind==='prepare'||command.kind==='admit'){
   const value=command.kind==='prepare'?await api.prepare(command.body):await api.admit(command.body),input=next.prepare;
   if(!input||!groupDestinationMatches(value,input,executionId,next.capture?.resourceStepIds??value.resources?.map(r=>r.custody.intent.resourceStepId)??[],next.capture)||command.kind==='admit'&&(value.admissionId!==command.admissionId||value.state==='admitted'&&value.disclosure.reviewHash!==command.body.reviewHash))throw Error('Group result differs from retained source and command.');
   setTarget(value);
   if(command.kind==='prepare'&&['awaiting_disclosure','admitted'].includes(value.state)||command.kind==='admit'&&value.state==='admitted')keep({...next,pending:undefined});
   else setNotice('Group outcome held · read original key · no mutation retry');
  }else{
   const value=await api.choose(command.admissionId,command.body);
   if(!disclosureReceiptMatches(value,command.admissionId,command.body))throw Error('Group choice receipt differs from original input.');
   setReceipt(value);keep({...next,pending:undefined});setTarget(undefined);
  }
  onChanged();
 },onError:(error,command)=>{
  discard();setNotice(error.message);
  if(error instanceof ApiRequestError&&error.status===409){setInventory(undefined);setTreeInventory(undefined);}
  // Choice CAS refusals precede its transactional commit. Other 409s may follow staging.
  if(error instanceof ApiRequestError&&error.status===409&&command.kind==='choice'){clearPending();setTarget(undefined);onChanged();}
 },onSettled:()=>{fence.current=false;setConfirm(undefined);}});
 const busy=refresh.isPending||preview.isPending||submit.isPending||discover.isPending||recover.isPending||treeDiscovery.isPending||treeRecovery.isPending||capturePreview.isPending;
 const fresh=enabled&&!readOnly&&!storageError&&!journal.pending&&!busy;
 const captureReady=fresh&&Boolean(cut&&supportedCut(cut))&&cutReviewed&&!journal.capture&&!journal.prepare&&effects;
 const prepareReady=fresh&&capture?.state==='retained'&&!journal.prepare&&effects&&['completed','failed','canceled'].includes(execution.state);
 const exact=Boolean(target&&review&&groupReviewMatches(review,target,branchId,executionId));
 const approveReady=fresh&&exact&&reviewed&&target?.state==='awaiting_disclosure'&&!review?.active;
 const admitReady=fresh&&exact&&reviewed&&target?.state==='awaiting_disclosure'&&review?.active===true&&target.disclosure.state==='approved'&&target.disclosure.reviewHash===review.reviewHash&&target.disclosure.revision===review.revision;
 const revokeReady=fresh&&target?.disclosure.state==='approved'&&Boolean(target.disclosure.reviewHash);
 const ready=confirm==='capture'?captureReady:confirm==='prepare'?prepareReady:confirm==='approve'?approveReady:confirm==='revoke'?revokeReady:confirm==='admit'?admitReady:false;
 const apply=()=>{
  if(!ready||fence.current)return;let command:GroupCommand;
  if(confirm==='capture'&&cut)command={kind:'capture',body:{commandKey:createClientId(),reviewHash:cut.reviewHash,versionId:cut.versionId},resourceStepIds:captureResourceIds(cut),preview:cut,...(treeCut(cut)?{scope:'owner_tree' as const}:{})};
  else if(confirm==='prepare'&&capture?.checkpointId&&capture.checkpointHash)command={kind:'prepare',body:{commandKey:createClientId(),checkpointId:capture.checkpointId,expectedHash:capture.checkpointHash,reconcileEffects:true}};
  else if(confirm==='admit'&&target&&review)command={kind:'admit',admissionId:target.admissionId,body:{commandKey:target.commandKey,reviewHash:review.reviewHash}};
  else if(confirm==='approve'&&target&&review)command={kind:'choice',admissionId:target.admissionId,body:{commandKey:createClientId(),action:'approve',reviewHash:review.reviewHash,expectedRevision:review.revision}};
  else if(confirm==='revoke'&&target?.disclosure.reviewHash)command={kind:'choice',admissionId:target.admissionId,body:{commandKey:createClientId(),action:'revoke',reviewHash:target.disclosure.reviewHash,expectedRevision:target.disclosure.revision}};
  else return;fence.current=true;submit.mutate(command);
 };
 return <>
  <Button onClick={()=>{discard();setOpen(true);}}>Review Resource Group</Button>
  <Dialog open={open} fullWidth maxWidth="md" disableEscapeKeyDown={busy} onClose={()=>{if(!busy){discard();setOpen(false);}}}>
   <DialogTitle>Resource Group</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
    <Typography>Preview which Chats and Agents can be captured together, or look up a retained group.</Typography>
    <Typography variant="body2">A fresh group shares the existing Project directory. Preparing it creates a Project and its resource Chats, with no separate workspace or working copy.</Typography>
    {recover.error&&<Alert severity="error">{recover.error.message}</Alert>}
    {(storageError||notice)&&<Alert severity="warning">{storageError||notice}</Alert>}
    {!enabled&&<Alert severity="warning">Refresh this Run before applying changes.</Alert>}
    {journal.pending&&<Alert severity="warning">Unconfirmed {journal.pending.kind} · original input retained · read exact command · no mutation replay</Alert>}
    {(journal.capture||journal.prepare)&&<Button disabled={busy||Boolean(storageError)} onClick={()=>refresh.mutate()}>Read Retained Group Commands</Button>}
    {refresh.error&&<Alert severity="error">{refresh.error.message}</Alert>}
    {(journal.pending||journal.capture||journal.prepare)&&<Evidence title="Retained Command And Readback Identities" value={journal}/>}
    {capture&&<><Typography>Capture {capture.state} · {'cleanupHeld' in capture?(capture.cleanupHeld?'cleanup held':'cleanup released'):'owner deletion held by the tree journal'}</Typography><Evidence title="Saved capture and source seals" value={capture}/></>}
    {!journal.capture&&<>
     <Button disabled={!fresh||Boolean(journal.prepare)} onClick={()=>capturePreview.mutate(undefined)}>Preview Authoritative Capture Cut</Button><Button disabled={!fresh||Boolean(journal.prepare)} onClick={()=>capturePreview.mutate('owner_tree')}>Preview Called Owner Tree</Button>
     {capturePreview.error&&<Alert severity="error">{capturePreview.error.message}</Alert>}
     {cut&&<><Evidence title="Exact Capture Preview: Every Resource, Participant And Cut Hash" value={cut}/><FormControlLabel control={<Checkbox checked={cutReviewed} disabled={!fresh} onChange={(_,v)=>setCutReviewed(v)}/>} label="I reviewed the complete server capture inventory and exact cut hashes"/></>}
    </>}
    {!journal.prepare&&<><FormControlLabel control={<Checkbox checked={effects} disabled={!fresh} onChange={(_,v)=>setEffects(v)}/>} label="I reconciled original external effects; unknown effects remain held"/>
     <Button disabled={!captureReady} onClick={()=>setConfirm('capture')}>Capture Exact Resource Cut</Button>
     <Button disabled={!prepareReady} onClick={()=>setConfirm('prepare')}>Prepare Held Group</Button></>}
    <details><summary>Scope and limits</summary><Stack spacing={0.5} sx={{mt:1}}>
     <Typography>Standalone capture supports 2–32 generation-zero resources on supported paths.</Typography>
     <Typography>Called-tree capture supports one resource in the manual parent and one in its serial ASYNC or SYNC child.</Typography>
     <Typography>Each owner requires original Project audit access, current policy and fresh acceptance budget. Restart discovery if its page changed.</Typography>
    </Stack></details>
    <Stack direction="row" gap={1} flexWrap="wrap"><Button disabled={busy} onClick={()=>discover.mutate({kind:'captures'})}>Restart Capture Discovery</Button><Button disabled={busy} onClick={()=>discover.mutate({kind:'admissions'})}>Restart Admission Discovery</Button></Stack>
    <Button disabled={busy} onClick={()=>treeDiscovery.mutate()}>Discover Called-Tree Captures</Button>
    {treeDiscovery.error&&<Alert severity="error">{treeDiscovery.error.message} · restart tree discovery explicitly</Alert>}
    {treeInventory?.length===0&&<Typography color="text.secondary">No retained called-tree captures were found.</Typography>}
    {treeInventory?.map(row=><Stack key={row.commandKey}><Evidence title="Canonical owner-tree capture; evidence only" value={row}/><Button disabled={busy||Boolean(journal.pending)||Boolean(storageError)} onClick={()=>treeRecovery.mutate(row)}>Read Exact Called-Tree Capture</Button></Stack>)}
    {discover.error&&<Alert severity="error">{discover.error.message} · stale selection + confirmation cleared · restart explicitly</Alert>}
    {inventory&&<><Typography>{inventory.items.length?'Retained records across source runs':'No retained group records were found.'}</Typography>{inventory.items.map((row,i)=><Stack key={`${row.branchId}:${row.executionId}:${row.commandKey??i}`}><Evidence title={`${row.state} · ${row.resourceCount} Resources · Source Owner ${row.ownerPresent?'Current':'retained / absent'}`} value={row}/><GroupJournalAudit key={JSON.stringify(row.auditSelection)} row={row} api={api} onRead={discard} onStale={()=>{discard();setInventory(undefined);setAudit(undefined);setTarget(undefined);setCapture(undefined);setNotice('Historical selector/evidence refused · restart group discovery explicitly · no inferred audit/action');}}/>{row.discovery==='unsupported_legacy_key'?<Typography>Unsupported legacy capture: original key unavailable; no guessed recovery.</Typography>:<Button disabled={busy||Boolean(journal.pending)||Boolean(storageError)} onClick={()=>recover.mutate(row)}>Read Discovered {row.kind==='captures'?'Capture':'Admission'} Command</Button>}{(row.branchId!==branchId||row.executionId!==executionId)&&<Typography>Other source Run · audit only here · disclosure: open source Run · lifecycle: Settings</Typography>}</Stack>)}{inventory.nextCursor&&<Button disabled={busy} onClick={()=>discover.mutate({kind:inventory.kind,more:true})}>Load More Group Commands</Button>}</>}
    {Boolean(audit)&&<Evidence title="Canonical readback from another source Run; no action authorization" value={audit}/>}
    {target&&<>
     <Typography>Group destination · {target.state.replaceAll('_',' ')} · disclosure {target.disclosure.state.replaceAll('_',' ')}</Typography>
     {target.reviewEvidence?.state==='verified'&&<Typography variant="body2">{target.reviewEvidence.ancestry==='prospective'?'Prospective ancestry · reserved parent link':'Committed ancestry · actual parent foreign keys verified'}</Typography>}
     <Evidence title="Saved group evidence and receipts" value={target}/>
     {['reserved','import_unknown'].includes(target.state)&&<Alert severity="warning">Unknown/reserved slots held · no reimport or separate member admission</Alert>}
     <Button disabled={!fresh||!['awaiting_disclosure','admitted'].includes(target.state)} onClick={()=>preview.mutate()}>Review Whole-Group Disclosure</Button>
     <Button color="error" disabled={!revokeReady} onClick={()=>setConfirm('revoke')}>Revoke Whole-Group Disclosure</Button>
    </>}
    {preview.error&&<Alert severity="error">{preview.error.message}</Alert>}
    {review&&exact&&<>
     <Typography>{review.facts.length} fact{review.facts.length===1?'':'s'} to review before disclosure.</Typography>
     <Evidence title="Exact facts, participants and current policy" value={{reviewHash:review.reviewHash,hostCutSha256:review.hostCutSha256,policyRevision:review.policyRevision,revision:review.revision,review:review.review,facts:review.facts,policy:review.policy}}/>
     <FormControlLabel control={<Checkbox checked={reviewed} disabled={!fresh} onChange={(_,v)=>setReviewed(v)}/>} label="I reviewed every original fact, actor, audience, mapped recipient, resource identity, saved owner evidence and current policy"/>
     <Button disabled={!approveReady} onClick={()=>setConfirm('approve')}>Approve Whole-Group Disclosure</Button>
     <Button disabled={!admitReady} onClick={()=>setConfirm('admit')}>Admit Whole Group</Button>
    </>}
    {receipt&&<Evidence title="Historical choice receipt; current approval requires fresh review" value={receipt}/>}
    <Typography variant="caption">Unavailable here · partial abandonment · custody release · group retirement · unresolved members held</Typography>
   </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>{discard();setOpen(false);}}>Close</Button></DialogActions>
  </Dialog>
  <ConfirmDialog open={Boolean(confirm)} title={confirm==='capture'?'Capture this whole cut?':confirm==='prepare'?'Prepare held group?':confirm==='approve'?'Approve all listed facts?':confirm==='revoke'?'Revoke whole-group disclosure?':'Admit all resources atomically?'} confirmLabel="Confirm Exact Group Action" cancelLabel="Back" pending={submit.isPending} confirmDisabled={!ready} onCancel={()=>setConfirm(undefined)} onConfirm={apply}>
   <Typography>{confirm==='capture'?'Captures every private package; partial capture keeps all cleanup pins, with no abandonment here':confirm==='prepare'?'Creates held fresh identities in the current Project directory; no separate workspace':confirm==='approve'?'Authorizes every listed fact for exact fresh recipients under all reviewed policies, without starting work':confirm==='revoke'?'Revokes exact persisted revision without package bytes; previously disclosed facts remain':'Commits whole mapped graph + all imports and permits eligible new work, without original-effect replay'}</Typography>
   <details><summary>Confirmation evidence</summary><Typography sx={{overflowWrap:'anywhere'}}>Capture cut {cut?.reviewHash} · version {cut?.versionId} · resources {cut?captureResourceIds(cut).length:undefined} · Checkpoint {capture?.checkpointId??target?.checkpointId} · {capture?.checkpointHash??target?.checkpointHash} · admission {target?.admissionId} · review {confirm==='revoke'?target?.disclosure.reviewHash:review?.reviewHash}</Typography></details>
  </ConfirmDialog>
 </>;
}
