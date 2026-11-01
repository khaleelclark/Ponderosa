import {MemoryPreserveUnknown} from './MemoryPreserveUnknown';
import {LifecycleDiscovery} from './LifecycleDiscovery';
import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Alert,Button,MenuItem,Paper,Stack,TextField,Typography} from '@mui/material';
import type {MemoryMutationHoldDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {LifecycleReview,type LifecycleKind} from './LifecycleReview';
/** On-demand canonical inventories; no operator-entered lifecycle identities. */
export function LifecyclePanel():JSX.Element {
 const [open,setOpen]=useState(false),[selected,setSelected]=useState('');
 const custody=useQuery({queryKey:['lifecycle-custody-list'],queryFn:()=>requestJson<string[]>('/api/lifecycle/checkpoint-custody'),enabled:open,retry:false,refetchOnWindowFocus:false});
 const memory=useQuery({queryKey:['lifecycle-memory-list'],queryFn:()=>requestJson<MemoryMutationHoldDto[]>('/api/local-memory/mutation-holds'),enabled:open,retry:false,refetchOnWindowFocus:false});
 const orphans=useQuery({queryKey:['lifecycle-orphan-evidence'],queryFn:()=>requestJson<unknown[]>('/api/lifecycle/agent-imports/orphan-evidence'),enabled:open,retry:false,refetchOnWindowFocus:false});
 const items=[...(custody.data??[]).map(id=>({kind:'custody' as const,id,label:`Checkpoint evidence · ${id}`})),...(memory.data??[]).map(hold=>({kind:'memory' as const,id:hold.id,label:`Memory hold · ${hold.effect?.scope??'legacy unknown scope'} · ${hold.id}`}))];
 const target=items.find(item=>JSON.stringify([item.kind,item.id])===selected);
 return <Paper variant="outlined" sx={{p:2.5}}><Stack spacing={2}>
  <Typography component="h2" variant="h6">Retained evidence and unresolved effects</Typography>
  <Button sx={{alignSelf:'flex-start'}} onClick={()=>setOpen(value=>!value)} aria-expanded={open}>{open?'Close lifecycle inventory':'Review lifecycle inventory'}</Button>
  {open&&<>
   <LifecycleDiscovery/>
   <Button disabled={custody.isFetching||memory.isFetching||orphans.isFetching} onClick={()=>{setSelected('');void custody.refetch();void memory.refetch();void orphans.refetch();}}>Refresh inventories</Button>
   {[custody.error,memory.error,orphans.error].filter(Boolean).map((error,index)=><Alert severity="warning" key={index}>{error?.message}</Alert>)}
   <TextField select label="Canonical retained identity" value={target?selected:''} onChange={event=>setSelected(event.target.value)}><MenuItem value="">Choose evidence</MenuItem>{items.map(item=><MenuItem key={JSON.stringify([item.kind,item.id])} value={JSON.stringify([item.kind,item.id])}>{item.label}</MenuItem>)}</TextField>
   {target?.kind==='memory'&&<MemoryPreserveUnknown key={`preserve:${selected}`} id={target.id}/>}
   {target&&<LifecycleReview key={selected} kind={target.kind as LifecycleKind} id={target.id}/>}
   {orphans.data&&<details><summary>Preserved orphan staging evidence ({orphans.data.length})</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(orphans.data,null,2)}</Typography></details>}
   <Typography variant="caption">Original bytes preserved · discovery: exact identities · current review: eligibility</Typography>
  </>}
 </Stack></Paper>;
}
