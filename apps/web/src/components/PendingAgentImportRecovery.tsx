import {useState} from 'react';
import {Alert,Button,Paper,Stack,Typography} from '@mui/material';
import type {AgentImportOperationDto} from '@ponderosa/core';
import {api} from '../api';
import {ApiRequestError} from '../api/types';
import {fingerprintAgentImport,sameAgentImportFingerprint} from './agentImportFingerprint';
import {agentImportFingerprintHeader,agentImportOperationMatches,type PendingAgentImport} from './agentImportRecovery';

/** The package itself stays in the selected File; only the bounded identity
 * and reviewed request are retained. 404 never proves an upload did not start. */
export function PendingAgentImportRecovery({entry,initialBlob,disabled=false,onAccepted}:{entry:PendingAgentImport;initialBlob?:Blob;disabled?:boolean;onAccepted(entry:PendingAgentImport,operation:AgentImportOperationDto):void}):JSX.Element{
 const [file,setFile]=useState<Blob|undefined>(initialBlob),[fileName,setFileName]=useState(initialBlob?'Original package selected':''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const verify=(operation:AgentImportOperationDto)=>{
  if(!agentImportOperationMatches(operation,entry))throw Error('The import status does not match the saved request.');
  onAccepted(entry,operation);
 };
 const check=async()=>{
  setBusy(true);setNotice('');
  try{verify(await api.getAgentImportOperationByRequest(entry.projectId,entry.conversationId,entry.requestId));}
  catch(error){setNotice(error instanceof ApiRequestError&&error.status===404?'No matching import status is available yet. The original request may still be in progress.':error instanceof Error?error.message:'Could not check import status.');}
  finally{setBusy(false);}
 };
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
  <Button component="label" disabled={busy||disabled}>Choose original package
   <input hidden type="file" accept="application/json,.json" onChange={event=>{const selected=event.target.files?.[0];event.target.value='';setFile(selected);setFileName(selected?.name??'');setNotice('');}}/>
  </Button>
  {fileName&&<Typography variant="body2">{fileName}</Typography>}
  <Button disabled={busy||disabled||!file} onClick={()=>void retry()}>{busy?'Checking…':'Retry exact import'}</Button>
 </Stack></Paper>;
}
