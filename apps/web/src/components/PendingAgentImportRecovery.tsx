import {useState} from 'react';
import {Alert,Button,Paper,Stack,Typography} from '@mui/material';
import type {AgentImportOperationDto} from '@ponderosa/core';
import {api} from '../api';
import {ApiRequestError} from '../api/types';
import {fingerprintAgentImport,sameAgentImportFingerprint} from './agentImportFingerprint';
import {agentImportFingerprintHeader,agentImportOperationMatches,type PendingAgentImport} from './agentImportRecovery';

/** The package itself stays in the selected File; only the bounded identity
 * and reviewed request are retained. 404 never proves an upload did not start. */
export function PendingAgentImportRecovery({entry,initialBlob,disabled=false,onAccepted,onRetired,onDeleted}:{entry:PendingAgentImport;initialBlob?:Blob;disabled?:boolean;onAccepted(entry:PendingAgentImport,operation:AgentImportOperationDto):void;onRetired(entry:PendingAgentImport):void;onDeleted(entry:PendingAgentImport):void}):JSX.Element{
 const [file,setFile]=useState<Blob|undefined>(initialBlob),[fileName,setFileName]=useState(initialBlob?'Original package selected':''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [held,setHeld]=useState<{state:'reserved'|'retired'|'destination_deleted';operationId:string}>();
 const heldStatus=(value:unknown):{state:'reserved'|'retired'|'destination_deleted';operationId:string}|undefined=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const status=value as Record<string,unknown>;
  if((status.state!=='reserved'&&status.state!=='retired'&&status.state!=='destination_deleted')||typeof status.operationId!=='string'||!status.operationId||status.requestId!==entry.requestId||status.projectId!==entry.projectId||status.conversationId!==entry.conversationId||status.product!==entry.product||status.requestFingerprint!==agentImportFingerprintHeader(entry.fingerprint))return;
  return {state:status.state,operationId:status.operationId};
 };

 const verify=(operation:AgentImportOperationDto)=>{
  if(!agentImportOperationMatches(operation,entry))throw Error('The import status does not match the saved request.');
  onAccepted(entry,operation);
 };
 const check=async()=>{
  setBusy(true);setNotice('');setHeld(undefined);
  try{verify(await api.getAgentImportOperationByRequest(entry.projectId,entry.conversationId,entry.requestId));}
  catch(error){
   const status=error instanceof ApiRequestError&&error.status===409?heldStatus(error.body):undefined;
   if(status){setHeld(status);setNotice(status.state==='retired'?'This request was retired; its original files remain preserved.':status.state==='destination_deleted'?'The destination was deleted. The import outcome remains unknown.':'The server is holding this request before admission. You may review the option below.');}
   else setNotice(error instanceof ApiRequestError&&error.status===404?'No matching import status is available yet. The original request may still be in progress.':error instanceof Error?error.message:'Could not check import status.');
  }
  finally{setBusy(false);}
 };
 const retire=async()=>{
  if(!held||held.state!=='reserved')return;setBusy(true);setNotice('');
  try{
   const status=heldStatus(await api.retireHeldAgentImport(entry.projectId,entry.conversationId,entry.requestId,held.operationId));
   if(!status||status.state!=='retired'||status.operationId!==held.operationId)throw Error('The retirement receipt does not match the saved request.');
   setHeld(status);
   try{onRetired(entry);}catch{setNotice('Retirement was confirmed, but the saved browser record could not be updated. Keep browser data and dismiss it after checking again.');}
  }catch(error){setHeld(undefined);setNotice(`Retirement is unconfirmed. Check the request status again. ${error instanceof Error?error.message:''}`);}
  finally{setBusy(false);}
 };
 const dismissRetired=()=>{try{onRetired(entry);}catch{setNotice('Retirement was confirmed, but the saved browser record could not be updated. Keep browser data and try again.');}};
 const retry=async()=>{
  if(!file)return;setBusy(true);setNotice('');
  try{
   const body=new Blob([JSON.stringify(entry.metadata)+'\n',file],{type:'application/vnd.ponderosa.agent-import'});
   if(!sameAgentImportFingerprint(await fingerprintAgentImport(body),entry.fingerprint))throw Error('This is not the original package. Choose the same file to retry.');
   verify(await api.startAgentPackageImport(entry.projectId,file,entry.metadata,entry.requestId,agentImportFingerprintHeader(entry.fingerprint)));
  }catch(error){setNotice(error instanceof Error?error.message:'The original import is still unconfirmed.');}
  finally{setBusy(false);}
 };
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Typography variant="subtitle1">Import awaiting confirmation</Typography>
  <Alert severity="warning">The original request may still be running. Check its status or retry the exact same package; no new import will be started automatically.</Alert>
  {notice&&<Alert severity="info">{notice}</Alert>}
  <Button disabled={busy||disabled} onClick={()=>void check()}>Check import status</Button>
  {held?.state==='reserved'&&<><Alert severity="warning">If the server can prove this request never began an import, you can retire it. The old request cannot be used again; its files stay preserved. A new import would require your separate choice.</Alert>
   <Button disabled={busy||disabled} onClick={()=>void retire()}>Retire held request</Button></>}
  {held?.state==='retired'&&<Button disabled={busy||disabled} onClick={dismissRetired}>Dismiss retired request</Button>}
  {held?.state==='destination_deleted'&&<><Alert severity="warning">The import outcome and any effects remain unknown. Its retained evidence stays on the server. Review any existing files before starting another import.</Alert>
   <Typography variant="body2">Request reference: {entry.requestId}</Typography>
   <Button disabled={busy||disabled} onClick={()=>{try{onDeleted(entry);}catch{setNotice('Could not update the saved browser notice. Keep browser data and try again.');}}}>Dismiss saved notice</Button></>}


  <Button component="label" disabled={busy||disabled}>Choose original package
   <input hidden type="file" accept="application/json,.json" onChange={event=>{const selected=event.target.files?.[0];event.target.value='';setFile(selected);setFileName(selected?.name??'');setNotice('');}}/>
  </Button>
  {fileName&&<Typography variant="body2">{fileName}</Typography>}
  <Button disabled={busy||disabled||!file||Boolean(held)} onClick={()=>void retry()}>{busy?'Checking…':'Retry exact import'}</Button>
 </Stack></Paper>;
}
