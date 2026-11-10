import {useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Stack,TextField,Typography} from '@mui/material';
import type {MemoryMutationHoldDto,MemoryMutationPreserveUnknownReceipt} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {currentProductScope} from '../../api/productScope';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import {memoryPreserveCommandValid,memoryPreserveHoldValid,memoryPreserveReceiptMatches,restoreMemoryPreserveCommand,type MemoryPreserveCommand} from './memoryPreserveUnknown';
class PreserveCommandNotSent extends Error {}
class PreserveReceiptStorageFailed extends Error {}
const receiptStorageMessage='The preserve decision was confirmed, but your browser could not update its saved record. The original memory outcome is still unknown and the hold remains.';
export function MemoryPreserveUnknown({id}:{id:string}):JSX.Element {
 const key=JSON.stringify(['memory-preserve-unknown',window.location.origin,currentProductScope(),id]);
 const [restored]=useState(()=>restoreMemoryPreserveCommand(key,id));
 const [open,setOpen]=useState(false),[reason,setReason]=useState(''),[ack,setAck]=useState(false),[confirm,setConfirm]=useState<MemoryPreserveCommand>();
 const [pending,setPending]=useState(restored.command),[receipt,setReceipt]=useState<MemoryMutationPreserveUnknownReceipt>(),[notice,setNotice]=useState(''),[storageError,setStorageError]=useState('');
 const readOnly=useWorkspaceReadOnly()||Boolean(restored.error)||Boolean(storageError),fence=useRef(false);
 const inventory=useQuery({queryKey:['memory-preserve-inventory',id],queryFn:async()=>{
  const list=await requestJson<MemoryMutationHoldDto[]>('/api/local-memory/mutation-holds',{cache:'no-store'});
  if(!Array.isArray(list)||list.filter(hold=>hold?.id===id).length!==1)throw Error('Original hold unavailable');
  const hold=list.find(hold=>hold.id===id)!;
  if(!memoryPreserveHoldValid(hold,id))throw Error('Exact Preserve unknown evidence unavailable');
  return hold;
 },enabled:open,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const accept=(command:MemoryPreserveCommand,value:unknown)=>{
  if(!memoryPreserveReceiptMatches(command,value))throw Error('Disposition differs from original command');
  // Receipt verification confirms the preservation decision only; it does
  // not establish the original memory operation's outcome.
  setReceipt(value);
  try{localStorage.removeItem(key);}catch{throw new PreserveReceiptStorageFailed();}
  setPending(undefined);setNotice('Decision recorded · outcome unknown · original hold unsettled');
 };
 const send=useMutation({retry:false,mutationFn:async(command:MemoryPreserveCommand)=>{
  if(readOnly||!memoryPreserveCommandValid(command,id))throw new PreserveCommandNotSent('This decision is unavailable. No request was sent this time; any earlier attempt may still be unresolved.');
  const existing=restoreMemoryPreserveCommand(key,id);
  if(existing.error){setStorageError(existing.error);throw new PreserveCommandNotSent('The saved decision could not be read. No request was sent this time. Preserve browser data and reload the page.');}
  if(existing.command&&JSON.stringify(existing.command)!==JSON.stringify(command)){setPending(existing.command);throw new PreserveCommandNotSent('Another decision is already saved. No request was sent this time; inspect the original disposition before retrying.');}
  try{localStorage.setItem(key,JSON.stringify(command));}catch{setStorageError('Original command could not be saved · mutation held');throw new PreserveCommandNotSent('Could not save this decision in your browser. No request was sent this time. Free browser storage and reload; any earlier attempt may still be unresolved.');}
  setPending(command);
  const value=await requestJson(`/api/local-memory/mutation-holds/${encodeURIComponent(id)}/preserve-unknown`,{method:'POST',body:JSON.stringify(command.body)});
  accept(command,value);
 },onError:error=>setNotice(error instanceof PreserveCommandNotSent?error.message:error instanceof PreserveReceiptStorageFailed?receiptStorageMessage:`Outcome unconfirmed · exact command held · ${error.message}`),onSettled:()=>{fence.current=false;setConfirm(undefined);setAck(false);}});
 const lookup=useMutation({retry:false,mutationFn:async()=>{
  if(!pending)throw Error('No original command');
  const result=await inventory.refetch();
  if(result.error||!result.data)throw result.error??Error('Original inventory unavailable');
  if(result.data.sha256!==pending.holdSha256||result.data.preserveUnknownReviewSha256!==pending.body.reviewSha256)throw Error('Original hold changed · command retained');
  if(!result.data.disposition)throw Error('No disposition confirmed · original command retained');
  accept(pending,result.data.disposition);
 },onError:error=>setNotice(error instanceof PreserveReceiptStorageFailed?receiptStorageMessage:`Disposition unconfirmed · no replay · ${error.message}`)});
 const hold=inventory.data,busy=send.isPending||lookup.isPending;
 const valid=Boolean(hold&&!inventory.isError&&!inventory.isFetching&&!readOnly&&!pending&&!receipt&&!hold.disposition);
 const stage=()=>{
  if(!valid||!ack||!hold||reason.trim().length<16||reason.length>4096)return;
  setConfirm({id,holdSha256:hold.sha256,body:{commandKey:createClientId(),reviewSha256:hold.preserveUnknownReviewSha256!,reason,preserveUnknown:true}});
 };
 const close=()=>{if(!busy){setOpen(false);setAck(false);setConfirm(undefined);}};
 return <>
  <Button size="small" onClick={()=>{setOpen(true);setAck(false);}}>Preserve Unknown</Button>
  <Dialog open={open} fullWidth maxWidth="sm" onClose={close} disableEscapeKeyDown={busy}><DialogTitle>Preserve Unknown Memory Outcome</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
   <Alert severity="warning">Outcome unknown · hold remains unsettled · capture stays blocked · backend unchanged</Alert>
   <Typography sx={{overflowWrap:'anywhere'}}>{id}</Typography>
   {(restored.error||storageError)&&<Alert severity="error">{restored.error||storageError}</Alert>}
   {inventory.error&&<Alert severity="error">{inventory.error.message}</Alert>}
   {notice&&<Alert severity="info">{notice}</Alert>}
   <Button disabled={busy||inventory.isFetching} onClick={()=>{setAck(false);setConfirm(undefined);void inventory.refetch();}}>Refresh Original Hold</Button>
   {inventory.isFetching&&<Typography role="status">Reading original hold…</Typography>}
   {hold&&!inventory.isError&&<details><summary>Exact Original Hold And Disposition</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(hold,null,2)}</Typography></details>}
   {!pending&&!receipt&&!hold?.disposition&&<>
    <TextField multiline minRows={2} label="Reason For Preserving Uncertainty" value={reason} disabled={busy||!valid} onChange={event=>{setReason(event.target.value);setAck(false);setConfirm(undefined);}}/>
    <FormControlLabel control={<Checkbox checked={ack} disabled={busy||!valid} onChange={(_,checked)=>setAck(checked)}/>} label="Keep the original hold; completion and backend drain are unverified"/>
    <Button disabled={busy||!valid||!ack||reason.trim().length<16||reason.length>4096} onClick={stage}>Record Preserve Unknown</Button>
   </>}
   {pending&&<><Alert severity="warning">Exact command retained · no automatic retry · new input locked</Alert><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(pending,null,2)}</Typography>
    <Button disabled={busy||inventory.isFetching} onClick={()=>lookup.mutate()}>Inspect Original Disposition</Button>
    <Button disabled={busy||readOnly} onClick={()=>setConfirm(pending)}>Repeat Exact Preserve Unknown Command</Button>
   </>}
   {(receipt||!pending&&!inventory.isError&&hold?.disposition)&&<Alert severity="warning">Preserve unknown recorded · hold unsettled · no completion or drain proof</Alert>}
   {receipt&&<details><summary>Exact Preserve Unknown Receipt</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(receipt,null,2)}</Typography></details>}
  </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={close}>Close</Button></DialogActions></Dialog>
  <ConfirmDialog open={Boolean(confirm)} title="Preserve this unknown outcome?" confirmLabel="Confirm Preserve Unknown" pending={send.isPending} confirmDisabled={readOnly||fence.current} onCancel={()=>setConfirm(undefined)} onConfirm={()=>{if(!confirm||fence.current)return;fence.current=true;send.mutate(confirm);}}><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>Hold stays unsettled · no backend mutation · {confirm?JSON.stringify(confirm,null,2):''}</Typography></ConfirmDialog>
 </>;
}
