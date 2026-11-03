import {MemoryPreserveUnknown} from './MemoryPreserveUnknown';
import {LifecycleDiscovery} from './LifecycleDiscovery';
import {useEffect,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {Alert,Button,MenuItem,Paper,Stack,TextField,Typography} from '@mui/material';
import type {LifecycleDiscoveryPage,MemoryMutationHoldDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {currentProductScope} from '../../api/productScope';
import {lifecycleDiscoveryPage} from './lifecycleDiscovery';
import {LifecycleReview,type LifecycleKind} from './LifecycleReview';

function useEvidenceInventory<T>(kind:string,path:string,enabled:boolean,generation:number){
 return useInfiniteQuery({queryKey:['lifecycle-evidence',currentProductScope(),kind,generation],enabled,
  initialPageParam:undefined as {cursor:string;revision:string}|undefined,
  queryFn:async({pageParam})=>lifecycleDiscoveryPage(await requestJson<LifecycleDiscoveryPage<T>>(`${path}?limit=50${pageParam?`&cursor=${encodeURIComponent(pageParam.cursor)}`:''}`,{cache:'no-store'}),pageParam?.revision),
  getNextPageParam:last=>last.nextCursor?{cursor:last.nextCursor,revision:last.revision}:undefined,
  retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false,staleTime:Infinity,gcTime:0});
}
/** On-demand canonical inventories; no operator-entered lifecycle identities. */
export function LifecyclePanel():JSX.Element {
 const [open,setOpen]=useState(false),[selected,setSelected]=useState(''),[generation,setGeneration]=useState(0);
 const custody=useEvidenceInventory<string>('custody','/api/lifecycle/checkpoint-custody',open,generation);
 const memory=useQuery({queryKey:['lifecycle-memory-list',currentProductScope()],queryFn:()=>requestJson<MemoryMutationHoldDto[]>('/api/local-memory/mutation-holds'),enabled:open,retry:false,refetchOnWindowFocus:false});
 const orphans=useEvidenceInventory<unknown>('orphans','/api/lifecycle/agent-imports/orphan-evidence',open,generation);
 useEffect(()=>{if(custody.isError||memory.isError)setSelected('');},[custody.isError,memory.isError]);
 const custodyIds=custody.isError?[]:custody.data?.pages.flatMap(page=>page.items)??[];
 const orphanEntries=orphans.isError?[]:orphans.data?.pages.flatMap(page=>page.items)??[];
 const items=[...custodyIds.map(id=>({kind:'custody' as const,id,label:`Checkpoint evidence · ${id}`})),...(!memory.isError?memory.data??[]:[]).map(hold=>({kind:'memory' as const,id:hold.id,label:`Memory hold · ${hold.effect?.scope??'legacy unknown scope'} · ${hold.id}`}))];
 const target=items.find(item=>JSON.stringify([item.kind,item.id])===selected);
 return <Paper variant="outlined" sx={{p:2.5}}><Stack spacing={2}>
  <Typography component="h2" variant="h6">Retained evidence and unresolved effects</Typography>
  <Button sx={{alignSelf:'flex-start'}} onClick={()=>setOpen(value=>!value)} aria-expanded={open}>{open?'Close lifecycle inventory':'Review lifecycle inventory'}</Button>
  {open&&<>
   <LifecycleDiscovery/>
   <Button disabled={custody.isFetching||memory.isFetching||orphans.isFetching} onClick={()=>{setSelected('');setGeneration(value=>value+1);void memory.refetch();}}>Refresh inventories</Button>
   {[custody.error,memory.error,orphans.error].filter(Boolean).map((error,index)=><Alert severity="warning" key={index}>{error?.message} · refresh inventories</Alert>)}
   <Typography variant="caption">Checkpoint evidence: {custodyIds.length} loaded · {custody.isError?'refresh required':custody.isPending?'reading':custody.hasNextPage?'more available':'end of inventory'}</Typography>
   {custody.hasNextPage&&!custody.isError&&<Button disabled={custody.isFetching} onClick={()=>void custody.fetchNextPage()}>Load more checkpoint evidence</Button>}
   <TextField select label="Canonical retained identity" value={target?selected:''} onChange={event=>setSelected(event.target.value)}><MenuItem value="">Choose evidence</MenuItem>{items.map(item=><MenuItem key={JSON.stringify([item.kind,item.id])} value={JSON.stringify([item.kind,item.id])}>{item.label}</MenuItem>)}</TextField>
   {target?.kind==='memory'&&<MemoryPreserveUnknown key={`preserve:${selected}`} id={target.id}/>}
   {target&&<LifecycleReview key={selected} kind={target.kind as LifecycleKind} id={target.id}/>}
   {orphans.data&&!orphans.isError&&<details><summary>Preserved orphan staging evidence ({orphanEntries.length} loaded · {orphans.hasNextPage?'more available':'end of inventory'})</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(orphanEntries,null,2)}</Typography></details>}
   {orphans.hasNextPage&&!orphans.isError&&<Button disabled={orphans.isFetching} onClick={()=>void orphans.fetchNextPage()}>Load more orphan evidence</Button>}
   <Typography variant="caption">Original bytes preserved · discovery: exact identities · current review: eligibility</Typography>
  </>}
 </Stack></Paper>;
}
