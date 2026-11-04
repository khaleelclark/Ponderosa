import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,TextField,Typography} from '@mui/material';
import {useQueryClient} from '@tanstack/react-query';
import {useEffect,useRef,useState} from 'react';
import type {CommunicationEvent,MessageDeliveryReceiptDto} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {currentProductScope} from '../api/productScope';
import {createClientId} from '../clientId';
import {queryKeys} from '../queryKeys';
import {sha256Bytes} from './idempotentAttempt';

type Review={projectId:string;activationId:string;agentId:string;conversationId:string;runId:string;injectionId:string;
 originalTask:{communication:CommunicationEvent};originalSteer:{communication:CommunicationEvent};
 effectInventory:{effects:Array<{id?:string;kind:string;outcome:string;detail:string}>;nativeTail:string;sourceWork:string;replayAuthorized:false};
 reviewSha256:string;originalOutcome:'unknown';replayAuthorized:false};
type Receipt={accepted:true;sourceActivationId:string;activationId:string;sourceRunId:string;injectionId:string;originalOutcome:'unknown';replayAuthorized:false;reviewSha256:string;commandSha256:string;activationState:string};
type Status={status:'review_required';review:Review}|{status:'continuation_recorded';receipt:Receipt};
type Saved={version:1;product:'dev'|'branches';projectId:string;activationId:string;agentId:string;runId:string;injectionId:string;reviewSha256:string;idempotencyKey:string;reviewNote?:string};

const storageName=(product:string,projectId:string,activationId:string)=>`ponderosa.reviewed-continuation.v1:${product}:${encodeURIComponent(projectId)}:${encodeURIComponent(activationId)}`;
const isText=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256;
function readSaved(name:string,product:'dev'|'branches',projectId:string,receipt:MessageDeliveryReceiptDto):Saved|undefined {
 const raw=localStorage.getItem(name);if(raw===null)return undefined;
 let value:unknown;
 try{value=JSON.parse(raw);}catch{throw Error('Saved continuation information is unreadable. Preserve browser data and check its status.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Saved continuation information is invalid. Preserve browser data.');
 const s=value as Saved;
 if(!['activationId,agentId,idempotencyKey,injectionId,product,projectId,reviewSha256,runId,version','activationId,agentId,idempotencyKey,injectionId,product,projectId,reviewNote,reviewSha256,runId,version'].includes(Object.keys(s).sort().join(','))||
   s.version!==1||s.product!==product||s.projectId!==projectId||s.activationId!==receipt.activationId||
   s.agentId!==receipt.targetAgentId||s.injectionId!==receipt.injectionId||!isText(s.runId)||!isText(s.idempotencyKey)||! /^[a-f0-9]{64}$/.test(s.reviewSha256)||(s.reviewNote!==undefined&&(typeof s.reviewNote!=='string'||new TextEncoder().encode(s.reviewNote).length>16000)))
  throw Error('Saved continuation information does not match this instruction. Preserve browser data.');
 return s;
}
function saveExact(name:string,saved:Saved):void {
 const bytes=JSON.stringify(saved),prior=localStorage.getItem(name);
 if(prior!==null&&prior!==bytes)throw Error('A different continuation is already saved. Preserve browser data and check its status.');
 if(prior===null){
  try{localStorage.setItem(name,bytes);}catch(cause){throw Error(`Continuation could not be saved. No request was sent. ${cause instanceof Error?cause.message:''}`);}
 }
 if(localStorage.getItem(name)!==bytes)throw Error('Continuation could not be saved. No request was sent.');
}
function validCommunication(value:unknown,projectId:string,conversationId:string):value is CommunicationEvent {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const event=value as CommunicationEvent;
 return typeof event.text==='string'&&event.projectId===projectId&&event.sender?.kind==='user'&&
  event.conversationId===conversationId&&
  (event.attachments===undefined||(Array.isArray(event.attachments)&&event.attachments.every(file=>file&&isText(file.id)&&typeof file.name==='string'))) &&
  (event.artifactIds===undefined||(Array.isArray(event.artifactIds)&&event.artifactIds.every(isText)))&&
  (event.document===undefined||(!!event.document&&isText(event.document.id)&&typeof event.document.title==='string'));
}
function validReview(review:Review,projectId:string,receipt:MessageDeliveryReceiptDto):boolean {
 return !!review&&review.projectId===projectId&&review.activationId===receipt.activationId&&review.agentId===receipt.targetAgentId&&
  review.injectionId===receipt.injectionId&&isText(review.conversationId)&&isText(review.runId)&&/^[a-f0-9]{64}$/.test(review.reviewSha256)&&
  review.originalOutcome==='unknown'&&review.replayAuthorized===false&&validCommunication(review.originalTask?.communication,projectId,review.conversationId)&&
  validCommunication(review.originalSteer?.communication,projectId,review.conversationId)&&Array.isArray(review.effectInventory?.effects)&&
  review.effectInventory.replayAuthorized===false&&review.effectInventory.nativeTail==='unknown'&&review.effectInventory.sourceWork==='held_unknown'&&
  review.effectInventory.effects.every(effect=>effect&&typeof effect.kind==='string'&&typeof effect.outcome==='string'&&typeof effect.detail==='string');
}
function validReceipt(value:Receipt,original:MessageDeliveryReceiptDto,saved?:Saved):boolean {
 return !!value&&value.accepted===true&&value.sourceActivationId===original.activationId&&isText(value.activationId)&&
  value.injectionId===original.injectionId&&isText(value.sourceRunId)&&(!saved||saved.runId===value.sourceRunId)&&
  value.originalOutcome==='unknown'&&value.replayAuthorized===false&&/^[a-f0-9]{64}$/.test(value.reviewSha256)&&
  /^[a-f0-9]{64}$/.test(value.commandSha256)&&
  ['pending','attached','consumed','failed','outcome_unknown','cancelled','retry_pending'].includes(value.activationState);
}
/** Backend payloadHash sorts these flat fields before hashing their UTF-8 JSON. */
export async function reviewedContinuationCommandSha256(saved:Saved):Promise<string> {
 const input={activationId:saved.activationId,effectsReviewed:true,idempotencyKey:saved.idempotencyKey,projectId:saved.projectId,
  ...(saved.reviewNote!==undefined?{reviewNote:saved.reviewNote}:{}),reviewSha256:saved.reviewSha256};
 return sha256Bytes(new TextEncoder().encode(JSON.stringify(input)));
}
function Communication({label,value}:{label:string;value:CommunicationEvent}):JSX.Element {
 return <Stack spacing={0.5}><Typography fontWeight={650}>{label}</Typography>
  <Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value.text||'(Attachment-only message)'}</Typography>
  {(value.attachments??[]).map((file,index)=><Typography variant="body2" key={file.id??index}>Attachment: {file.name||file.id}{file.unavailable?' · unavailable':''}</Typography>)}
  {(value.artifactIds??[]).map(id=><Typography variant="body2" key={id}>Referenced file: {id}</Typography>)}
  {value.document&&<Typography variant="body2">Referenced document: {value.document.title??value.document.id}</Typography>}
 </Stack>;
}

/** The server retains and scopes both original messages. This UI never asks
 * the person to reconstruct them and never replays the uncertain operation. */
export function ReviewedContinuationDialog({projectId,receipt,onClose,onOpenAgent}:{projectId:string;receipt:MessageDeliveryReceiptDto;onClose():void;onOpenAgent?(agentId:string):void}):JSX.Element {
 const client=useQueryClient(),product=currentProductScope(),name=storageName(product,projectId,receipt.activationId);
 const endpoint=`/api/projects/${encodeURIComponent(projectId)}/message-deliveries/${encodeURIComponent(receipt.activationId)}/reviewed-continuation`;
 const [status,setStatus]=useState<Status>(),[saved,setSaved]=useState<Saved>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checked,setChecked]=useState(false),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[sameCommand,setSameCommand]=useState<boolean>();
 const lock=useRef(false),mounted=useRef(true),statusGeneration=useRef(0);
 const load=async(existing?:Saved):Promise<Status>=>{
  const generation=++statusGeneration.current;
  const result=await requestJson<Status>(endpoint,{cache:'no-store'});
  if(result?.status==='review_required'&&!validReview(result.review,projectId,receipt))throw Error('The original task or instruction could not be verified. No continuation was requested.');
  if(result?.status==='continuation_recorded'&&!validReceipt(result.receipt,receipt,existing))throw Error('The continuation receipt could not be verified. Preserve browser data and check again.');
  if(result?.status!=='review_required'&&result?.status!=='continuation_recorded')throw Error('Continuation status is unavailable. No new request was sent.');
  const matches=result.status==='continuation_recorded'&&existing?result.receipt.reviewSha256===existing.reviewSha256&&result.receipt.commandSha256===await reviewedContinuationCommandSha256(existing):undefined;
  if(mounted.current&&generation===statusGeneration.current){setSameCommand(matches);setStatus(result);if(result.status==='continuation_recorded')setError('');}return result;
 };
 useEffect(()=>{
  mounted.current=true;
  void (async()=>{try{const original=readSaved(name,product,projectId,receipt);if(mounted.current)setSaved(original);await load(original);}catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'Could not read continuation status.');}})();
  return()=>{mounted.current=false;};
 },[name]);
 // A lost response can settle later. Read status again; never resubmit on a timer.
 useEffect(()=>{
  if(!saved||status?.status!=='review_required')return;
  const timer=window.setInterval(()=>{if(!lock.current)void load(saved).catch(()=>{});},3000);
  return()=>window.clearInterval(timer);
 },[saved,status?.status,name]);
 const refresh=async()=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{const original=readSaved(name,product,projectId,receipt);setSaved(original);await load(original);}catch(cause){setError(cause instanceof Error?cause.message:'Could not read continuation status.');}finally{lock.current=false;setBusy(false);}};
 const submit=async()=>{
  if(lock.current||status?.status!=='review_required'||missingAttachments)return;
  const review=status.review;
  if(!saved&&!checked)return;
  if(saved&&(saved.reviewSha256!==review.reviewSha256||saved.runId!==review.runId||saved.injectionId!==review.injectionId)){
   setError('The saved continuation and current review differ. Preserve the original request and inspect its status.');return;
  }
  lock.current=true;setBusy(true);setError('');setNotice('');
  let command=saved;
  try{
   if(command){
    const original=readSaved(name,product,projectId,receipt);
    if(!original||JSON.stringify(original)!==JSON.stringify(command))throw Error('Saved continuation changed. Preserve the original request.');
   }
   const current=await load(command);
   if(current.status==='continuation_recorded')return;
   if(current.review.reviewSha256!==review.reviewSha256){setChecked(false);throw Error('The review changed. Read the current task and effects again.');}
   if(!command){
    const next:Saved={version:1,product,projectId,activationId:receipt.activationId,agentId:receipt.targetAgentId,runId:review.runId,injectionId:review.injectionId,reviewSha256:review.reviewSha256,idempotencyKey:createClientId(),...(note?{reviewNote:note}:{})};
    saveExact(name,next);command=next;setSaved(next);
   }
   const payload={reviewSha256:command.reviewSha256,effectsReviewed:true,idempotencyKey:command.idempotencyKey,...(command.reviewNote!==undefined?{reviewNote:command.reviewNote}:{})};
   const result=await requestJson<Status>(endpoint,{method:'POST',body:JSON.stringify(payload)});
   if(result?.status!=='continuation_recorded'||!validReceipt(result.receipt,receipt,command))throw Error('Continuation response could not be verified. Check status before retrying.');
   const matches=result.receipt.reviewSha256===command.reviewSha256&&result.receipt.commandSha256===await reviewedContinuationCommandSha256(command);
   statusGeneration.current++;setSameCommand(matches);setStatus(result);
   setNotice(matches?'Continuation authorized. The earlier outcome and effects remain unknown.':'A different continuation was authorized. Your saved request was not confirmed.');
   await Promise.all([client.invalidateQueries({queryKey:queryKeys.agents.detailPrefix(receipt.targetAgentId)}),client.invalidateQueries({queryKey:queryKeys.conversations.detailAll}),client.invalidateQueries({queryKey:queryKeys.inboxAll})]);
  }catch(cause){
   if(command){try{const result=await load(command);if(result.status==='continuation_recorded')return;}catch{/* Preserve the exact command until status is readable. */}}
   setError(command?`${cause instanceof Error?cause.message:'Continuation status is unavailable.'} Check status or retry the same request; the original work was not replayed.`:cause instanceof Error?cause.message:'Continuation could not be saved.');
  }finally{lock.current=false;if(mounted.current)setBusy(false);}
 };
 const review=status?.status==='review_required'?status.review:undefined;
 const unknown=review?.effectInventory.effects.filter(effect=>effect.outcome==='unknown')??[];
 const missingAttachments=Boolean(review&&[...(review.originalTask.communication.attachments??[]),...(review.originalSteer.communication.attachments??[])].some(file=>file.unavailable));
 return <Dialog open onClose={busy?undefined:onClose} fullWidth maxWidth="sm" aria-busy={busy||undefined}>
  <DialogTitle>Review interrupted work</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
   {error&&<Alert severity="error">{error}</Alert>}{notice&&<Alert severity="info">{notice}</Alert>}
   {!status&&!error&&<Typography role="status">Loading original work…</Typography>}
   {status?.status==='continuation_recorded'&&<Alert severity={sameCommand===false?'warning':'info'}>{sameCommand===false?'A different continuation was authorized. Your saved request was not confirmed. ':'Continuation authorized · '}{status.receipt.activationState.replaceAll('_',' ')}. The original outcome and effects remain unknown.</Alert>}
   {review&&<>
    <Communication label="Original task" value={review.originalTask.communication}/>
    <Communication label="Unconfirmed instruction" value={review.originalSteer.communication}/>
    <Alert severity="warning">The instruction and earlier external effects may or may not have happened. Continuing does not repeat the earlier instruction or authorize replay of uncertain actions.</Alert>
    {missingAttachments&&<Alert severity="error">An original attachment is unavailable. Continuation is held until it can be recovered.</Alert>}
    {unknown.length>0&&<Stack spacing={0.5}><Typography fontWeight={650}>Effects needing review</Typography>{unknown.map((effect,index)=><Typography key={index} variant="body2">{effect.kind.replaceAll('_',' ')} · {effect.detail}{effect.id?' · Reference: '+effect.id:''}</Typography>)}</Stack>}
    {!saved&&<TextField label="Notes about uncertain effects (optional)" multiline minRows={2} value={note} onChange={event=>setNote(event.target.value)} helperText="Add anything the Agent needs to know before continuing." error={new TextEncoder().encode(note).length>16000}/>}
    {!saved&&<FormControlLabel control={<Checkbox checked={checked} onChange={event=>setChecked(event.target.checked)}/>} label="I reviewed the uncertainty and want the Agent to continue the original task."/>}
    {saved&&<Typography variant="body2" sx={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>A continuation request is saved. Check its status or retry the same request.{saved.reviewNote?" Notes: "+saved.reviewNote:""}</Typography>}
   </>}
  </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>Close</Button>{onOpenAgent&&<Button disabled={busy} onClick={()=>onOpenAgent(receipt.targetAgentId)}>Open Agent chat</Button>}<Button disabled={busy} onClick={()=>void refresh()}>Check status</Button>
   {review&&<Button variant="contained" disabled={busy||missingAttachments||(!saved&&!checked)||(!saved&&new TextEncoder().encode(note).length>16000)} onClick={()=>void submit()}>{saved?'Retry same request':'Continue task'}</Button>}
  </DialogActions>
 </Dialog>;
}
