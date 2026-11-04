import {BranchLifecycleReview} from './BranchLifecycleReview';
import {useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,TextField,Typography} from '@mui/material';
import type {AgentImportLifecycleReview,CheckpointCustodyLifecycleEntry,DestinationRetirementReviewDto,DestinationGroupRetirementReviewDto,MemoryMutationReviewDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {currentProductScope} from '../../api/productScope';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import {lifecycleReceiptMatches,restoreLifecycleCommand,type LifecycleCommand} from './lifecycleCommand';
export type LifecycleKind='custody'|'memory'|'import'|'destination'|'group';
type Review=AgentImportLifecycleReview|CheckpointCustodyLifecycleEntry|DestinationRetirementReviewDto|DestinationGroupRetirementReviewDto|MemoryMutationReviewDto;
export function LifecycleReview({kind,id,enabled=true}:{kind:LifecycleKind;id:string;enabled?:boolean}):JSX.Element {
 const destination=kind==='destination'||kind==='group';
 const path=kind==='memory'?`/api/local-memory/mutation-holds/${encodeURIComponent(id)}`:`/api/lifecycle/${kind==='custody'?'checkpoint-custody':kind==='import'?'agent-imports':kind==='group'?'destination-groups':'destinations'}/${encodeURIComponent(id)}`;
 const storageKey=JSON.stringify(['lifecycle-command',window.location.origin,currentProductScope(),path]);
 const [restored]=useState(()=>restoreLifecycleCommand(storageKey));
 const workspaceReadOnly=useWorkspaceReadOnly(),readOnly=workspaceReadOnly||!enabled||Boolean(restored.error);
 const [open,setOpen]=useState(false),[ack,setAck]=useState(false),[note,setNote]=useState(''),[pins,setPins]=useState(false),[confirm,setConfirm]=useState<LifecycleCommand>(),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<LifecycleCommand|undefined>(restored.command);
 const [receipt,setReceipt]=useState<unknown>();
 const fence=useRef(false);
 const review=useQuery({queryKey:['lifecycle-review',path],queryFn:async()=>{
  const value=await requestJson<Review>(path+(destination?'/review':''));
  const actual='custodyId' in value?value.custodyId:'hold' in value?value.hold.id:'operationId' in value?value.operationId:value.admissionId;
  if(kind==='group'&&(!('groupChats' in value)||!Array.isArray(value.groupChats)||!('reservation' in value)||!Array.isArray(value.reservation.resources)||(value.reservation.resources.length<2||value.reservation.resources.length>32)))throw Error('Whole-group evidence or slots unavailable.');
  if(actual!==id)throw Error('Lifecycle identity changed · refresh review');return value;
 },enabled:open,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const refresh=async()=>{setAck(false);setPins(false);setConfirm(undefined);await review.refetch();};
 const keep=(value:LifecycleCommand)=>{localStorage.setItem(storageKey,JSON.stringify(value));setPending(value);};
 const clear=()=>{localStorage.removeItem(storageKey);setPending(undefined);};
 const accept=(command:LifecycleCommand,value:unknown)=>{
  if(!lifecycleReceiptMatches(command,value))throw Error('Receipt differs from retained command · keep original input');
  setReceipt(value);
  if(command.action==='approve'){keep({...command,approved:true});setNotice('Approval recorded · retirement requires separate confirmation');}
  else {clear();setNotice('Canonical lifecycle receipt confirmed · original evidence retained');}
 };
 const send=useMutation({retry:false,mutationFn:async(command:LifecycleCommand)=>{
  if(command.id!==id||command.path!==path||readOnly||!(destination?['approve','retire'].includes(command.action):command.action==='reconcile'))throw Error('Lifecycle scope unavailable.');
  keep(command);const value=await requestJson(`${path}/${command.action}`,{method:'POST',body:JSON.stringify(command.body)});accept(command,value);
 },onError:error=>{setNotice(`Outcome unconfirmed · retain exact command · unknown effects held · ${error.message}`);if(error instanceof ApiRequestError&&error.status===409)void refresh();},onSettled:()=>{fence.current=false;setConfirm(undefined);setAck(false);}});
 const lookup=useMutation({retry:false,mutationFn:async()=>{
  if(!destination||pending&&(pending.id!==id||pending.path!==path))throw Error('Retirement scope unavailable.');
  const value=await requestJson<Record<string,unknown>>(`${path}/receipt`,{cache:'no-store'});
  if(pending)accept({...pending,action:'retire'},value);
  else {
   if(value.admissionId!==id||typeof value.commandKey!=='string'||typeof value.retiredAt!=='string'||kind==='group'&&(!Array.isArray(value.resources)||value.resources.length<2||value.resources.length>32||!Array.isArray(value.groupChats)||typeof value.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.evidenceSha256)))throw Error('Retirement receipt identity or group evidence differs.');
   setReceipt(value);setNotice('Historical retirement receipt · no new-choice authority');
  }
 },onError:error=>setNotice(`Receipt unconfirmed · no mutation retry · ${error.message}`)});
 const value=review.data,busy=send.isPending||lookup.isPending;
 // Validate the exact trimmed value sent to the server before retaining a
 // command. Once sent, an uncertain command remains locked for exact retry.
 const noteLength=note.trim().length;
 const noteMinimum=kind==='memory'?16:kind==='import'?8:0;
 const noteValid=noteMinimum===0||noteLength>=noteMinimum&&noteLength<=4096;
 const valid=Boolean(value&&!review.isError&&!review.isFetching&&!readOnly&&!(receipt&&!pending));
 const reviewHash=value?('reviewHash' in value?value.reviewHash:value.reviewSha256):'';
 const eligible=Boolean(value&&('hold' in value?value.canReconcile:'custodyId' in value?value.state!=='reconciled'&&!value.references.length&&!value.blockers.length:true));
 const command=(action:string):LifecycleCommand|undefined=>{
  if(!value||!valid||!ack||pending||!noteValid)return;
  const commandKey=createClientId();
  const body=destination?{commandKey,expectedReviewHash:reviewHash,releaseSourcePins:pins,authorizeDeletedOwner:true as const}:
   kind==='memory'?{commandKey,reviewSha256:reviewHash,backendDrainEvidence:note.trim(),preserveCurrentBackend:true as const}:
   kind==='import'?{commandKey,reviewSha256:reviewHash,action:action as 'preserve_unresolved'|'retire_mutation_free',note:note.trim()}:
   {commandKey,reviewSha256:reviewHash,preserveEvidence:true as const};
  return {path,id,action:kind==='import'?'reconcile':action,body};
 };
 const stage=(action:string)=>{const next=command(action);if(next)setConfirm(next);};
 return <>
  <Button size="small" onClick={()=>{setPins(false);setAck(false);setConfirm(undefined);setOpen(true);}}>Review {kind==='custody'?'checkpoint evidence':kind==='memory'?'memory hold':kind==='import'?'import custody':kind==='group'?'group retirement':'destination retirement'}</Button>
  <Dialog open={open} fullWidth maxWidth="sm" onClose={()=>{if(!busy){setAck(false);setConfirm(undefined);setOpen(false);}}} disableEscapeKeyDown={busy}><DialogTitle>Lifecycle review</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
   <Typography sx={{overflowWrap:'anywhere'}}>{id}</Typography>
   <Button disabled={busy||review.isFetching} onClick={()=>void refresh()}>Refresh current review</Button>
   {review.isFetching&&<Typography role="status">Reading current evidence…</Typography>}{review.error&&<Alert severity="error">{review.error.message}</Alert>}
   {destination&&<Button disabled={busy} onClick={()=>lookup.mutate()}>Inspect retirement receipt</Button>}
   {restored.error&&<Alert severity="error">{restored.error}</Alert>}
   {notice&&<Alert severity="info">{notice}</Alert>}
   {value&&!review.isError&&<>
    <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Review: {reviewHash}</Typography>
    <details><summary>Exact source, references and host evidence</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12,maxHeight:360,overflow:'auto'}}>{JSON.stringify(value,null,2)}</Typography></details>
    {'blockers' in value&&value.blockers.map((text,index)=><Alert severity="warning" key={index}>{text}</Alert>)}
    {'references' in value&&value.references.length>0&&<Alert severity="warning">Retained source references · pinned throughout review</Alert>}
    {kind==='custody'&&<Typography variant="body2">Preserve every original byte · reconcile active namespace only</Typography>}
    {kind==='memory'&&<><Alert severity="warning">Stop/reconcile remote work first · your drain testimony required · stable readback supplies no drain proof</Alert><TextField multiline minRows={2} label="Observed external backend drain" value={note} disabled={busy||Boolean(pending)} error={noteLength>0&&!noteValid} helperText="Use 16 to 4,096 characters; spaces at the ends are ignored." onChange={event=>{setNote(event.target.value);setAck(false);setConfirm(undefined);}}/>{'hold' in value&&!value.canReconcile&&<Alert severity="warning">{value.reason??'This hold cannot be reconciled; unresolved effects remain held.'}</Alert>}</>}
    {kind==='import'&&<><Typography variant="body2">Unknown effects held without replay · retirement requires mutation-free import proof</Typography><TextField multiline label="Reconciliation note" value={note} disabled={busy||Boolean(pending)} error={noteLength>0&&!noteValid} helperText="Use 8 to 4,096 characters; spaces at the ends are ignored." onChange={event=>{setNote(event.target.value);setAck(false);setConfirm(undefined);}}/></>}
    {kind==='destination'&&'reservation' in value&&<BranchLifecycleReview key={value.reservation.custody.custodyId} source={value.reservation.custody} enabled={enabled}/>}
    {destination&&<>{kind==='group'&&<Alert severity="warning">Whole-group decision · any failed member proof blocks all · policy/native-exit changes invalidate approval · no singular retirement/abandonment loop</Alert>}<Alert severity="warning">Retirement requires completed deletion + global runtime quiescence; preserve-only retirement permanently retains source pins</Alert><FormControlLabel control={<Checkbox checked={pins} disabled={busy||Boolean(pending)||!('canReleaseSourcePins' in value&&value.canReleaseSourcePins)} onChange={(_,checked)=>{setPins(checked);setAck(false);setConfirm(undefined);}}/>} label="Release source pins after all other references retire"/></>}
    <FormControlLabel control={<Checkbox checked={ack} disabled={busy||Boolean(pending)||!valid} onChange={(_,checked)=>setAck(checked)}/>} label="I reviewed this exact scope and evidence"/>
    {!pending&&destination&&<Button disabled={!valid||!ack||busy} onClick={()=>stage('approve')}>Approve retirement choice</Button>}
    {!pending&&!destination&&<Button disabled={!valid||!eligible||!ack||busy||!noteValid} onClick={()=>stage(kind==='import'?'preserve_unresolved':'reconcile')}>{kind==='import'?'Preserve unresolved operation':'Reconcile and preserve evidence'}</Button>}
    {!pending&&kind==='import'&&<Button color="error" disabled={!valid||!ack||busy||!noteValid||!('canRetireMutationFree' in value&&value.canRetireMutationFree)} onClick={()=>stage('retire_mutation_free')}>Retire mutation-free import</Button>}
   </>}
   {receipt!==undefined&&<details><summary>Canonical lifecycle receipt</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(receipt,null,2)}</Typography></details>}
   {pending&&<><Alert severity="warning">Exact command retained · new input locked · no automatic replay</Alert><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>{pending.body.commandKey}</Typography>
    {!destination&&<Typography variant="body2">No receipt GET · inspect current evidence · deliberate retry: unchanged command only</Typography>}
    <Button disabled={busy||readOnly||pending.path!==path||pending.id!==id} onClick={()=>setConfirm(pending.approved?{...pending,action:'retire'}:pending)}>{pending.approved?'Confirm retirement':'Retry exact command'}</Button>
   </>}
  </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>{setAck(false);setConfirm(undefined);setOpen(false);}}>Close</Button></DialogActions></Dialog>
  <ConfirmDialog open={Boolean(confirm)} title={confirm?.action==='retire'?'Retire this destination?':'Apply this lifecycle decision?'} confirmLabel={confirm?.action==='retire'?'Retire destination':'Confirm exact command'} pending={send.isPending} confirmDisabled={readOnly||fence.current} onCancel={()=>setConfirm(undefined)} onConfirm={()=>{if(!confirm||fence.current)return;fence.current=true;send.mutate(confirm);}}><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>Original evidence preserved · unknown effects held without replay · {confirm?JSON.stringify(confirm.body,null,2):''}</Typography></ConfirmDialog>
 </>;
}
