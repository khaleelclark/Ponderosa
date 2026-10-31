import {useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,Paper,Stack,Typography} from '@mui/material';
import type {GlobalMemoryInventoryDto,GlobalMemorySelectionDto,GlobalMemoryTransferReviewDto,PortableGlobalMemorySnapshotDto} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {ConfirmDialog} from './ConfirmationDialogs';

const endpoint='/api/local-memory/global-transfer';
const post=<T,>(action:string,body:unknown)=>requestJson<T>(`${endpoint}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const selectionOf=(snapshot:PortableGlobalMemorySnapshotDto):GlobalMemorySelectionDto=>({chunkIds:snapshot.chunks.map(row=>row.id),conflictIds:snapshot.conflicts.map(row=>row.id)});
export function GlobalMemoryTransfer():JSX.Element {
 const [inventory,setInventory]=useState<GlobalMemoryInventoryDto>();
 const [incoming,setIncoming]=useState<PortableGlobalMemorySnapshotDto>();
 const [selection,setSelection]=useState<GlobalMemorySelectionDto>({chunkIds:[],conflictIds:[]});
 const [review,setReview]=useState<GlobalMemoryTransferReviewDto>();
 const [exportReview,setExportReview]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>();
 const source=incoming??inventory?.snapshot;
 const work=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(undefined);setNotice(undefined);try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const load=()=>work(async()=>{const next=await requestJson<GlobalMemoryInventoryDto>(endpoint);setInventory(next);setIncoming(undefined);setSelection({chunkIds:[],conflictIds:[]});setReview(undefined);});
 const chooseFile=(file:File)=>work(async()=>{
  if(file.size>16*1024*1024)throw Error('The transfer file exceeds 16 MiB.');
  const snapshot=JSON.parse(await file.text()) as PortableGlobalMemorySnapshotDto;
  if(snapshot.schema!=='ponderosa.selected-global-memory.v1'||!Array.isArray(snapshot.chunks)||!Array.isArray(snapshot.conflicts)||snapshot.chunks.length+snapshot.conflicts.length>10000||typeof snapshot.sourcePrincipal!=='string'||[...snapshot.chunks,...snapshot.conflicts].some(row=>!row||typeof row.id!=='string'||typeof row.text!=='string'||!row.stamp||typeof row.stamp!=='object'||!row.metadata||typeof row.metadata!=='object'))throw Error('Choose a selected global-memory transfer file.');
  setIncoming(snapshot);setSelection({chunkIds:[],conflictIds:[]});setReview(undefined);
 });
 const toggle=(kind:'chunkIds'|'conflictIds',id:string)=>{setReview(undefined);setSelection(current=>({...current,[kind]:current[kind].includes(id)?current[kind].filter(value=>value!==id):[...current[kind],id]}));};
 const preview=()=>work(async()=>{if(incoming)setReview(await post<GlobalMemoryTransferReviewDto>('preview',{snapshot:incoming,selection}));});
 const confirmImport=()=>work(async()=>{
  if(!review)return;
  const result=await post<{added:number}>('import',{snapshot:review.snapshot,selection:selectionOf(review.snapshot),reviewHash:review.reviewHash,acknowledge:true});
  setReview(undefined);setNotice(`Transfer complete: ${result.added} records added. Destination permissions and grants remain unchanged.`);
 });
 const confirmExport=()=>work(async()=>{
  if(!inventory)return;
  const snapshot=await post<PortableGlobalMemorySnapshotDto>('export',{selection,inventoryHash:inventory.inventoryHash,acknowledge:true});
  const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='selected-global-memory.ponderosa.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportReview(false);
 });
 return <Paper variant="outlined" sx={{p:2.5}}><Stack spacing={2}>
  <Typography variant="h6" component="h2">Transfer selected global memory</Typography>
  <Typography>Transfer global records separately from an Agent or organization package. Select each fact, required earlier version and conflict to include. Destination facts and conflicts are preserved for explicit resolution; this never overwrites them or changes permissions and read grants.</Typography>
  <Alert severity="warning">Stored text and history may contain sensitive information. Review the selected content before downloading or importing it.</Alert>
  <Stack direction="row" spacing={1}><Button disabled={busy} onClick={load}>Choose local records</Button><Button component="label" disabled={busy}>Choose transfer file<input hidden type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void chooseFile(file);}} /></Button></Stack>
  {source&&<Typography variant="body2">Source: {source.sourcePrincipal}. Nothing is selected automatically.</Typography>}
  {source&&([...source.chunks.map(row=>({row,kind:'chunkIds' as const,label:'Fact'})),...source.conflicts.map(row=>({row,kind:'conflictIds' as const,label:'Conflict'}))]).map(({row,kind,label})=><Paper variant="outlined" key={`${kind}:${row.id}`} sx={{p:1}}>
   <FormControlLabel control={<Checkbox disabled={busy} checked={selection[kind].includes(row.id)} onChange={()=>toggle(kind,row.id)} />} label={`${label}: ${row.id}`} />
   <Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{row.text}</Typography><Typography variant="caption" component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({metadata:row.metadata,provenance:row.stamp},null,2)}</Typography>
  </Paper>)}
  {source&&<Button disabled={busy||!selection.chunkIds.length} onClick={incoming?preview:()=>setExportReview(true)}>{incoming?'Review selected import':'Download selected records'}</Button>}
  {error&&<Alert severity="error">{error}</Alert>}{notice&&<Alert severity="success">{notice}</Alert>}
  <ConfirmDialog open={exportReview} title="Download selected global memory" confirmLabel="Download selected records" pending={busy} error={error} onCancel={()=>setExportReview(false)} onConfirm={confirmExport}><Typography>Download {selection.chunkIds.length} selected facts and {selection.conflictIds.length} conflicts. Stored content may be sensitive. Known credential fields, permissions, grants and live work are excluded.</Typography></ConfirmDialog>
  <ConfirmDialog open={Boolean(review)} title="Review selected global-memory import" confirmLabel="Import reviewed records" pending={busy} error={error} onCancel={()=>setReview(undefined)} onConfirm={confirmImport}>
   <Alert severity="warning">Selected facts and conflict history will be added as parallel records. No existing fact is replaced and no conflict is resolved automatically. A failed multi-record transfer may leave partial additions; review again before retrying.</Alert>
   {review&&<><Typography>Selected source records</Typography>{[...review.snapshot.chunks,...review.snapshot.conflicts].map((row,index)=><Typography key={index} component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({id:row.id,text:row.text,metadata:row.metadata,provenance:row.stamp},null,2)}</Typography>)}<Typography>Existing destination facts and conflicts (preserved)</Typography>{[...review.destination.chunks,...review.destination.conflicts].map((row,index)=><Typography key={index} component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({id:row.id,text:row.text,metadata:row.metadata,provenance:row.stamp},null,2)}</Typography>)}</>}
  </ConfirmDialog>
 </Stack></Paper>;
}
