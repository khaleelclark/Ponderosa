import {MemoryPreserveUnknown} from './MemoryPreserveUnknown';
import {LifecycleDiscovery} from './LifecycleDiscovery';
import {useEffect,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {Alert,Box,Button,MenuItem,Paper,Stack,TextField,Typography} from '@mui/material';
import type {LifecycleDiscoveryPage,MemoryMutationHoldDto,MemoryProvisioningHoldDto} from '@ponderosa/core';
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
 const provisioning=useQuery({queryKey:['lifecycle-memory-provisioning',currentProductScope()],queryFn:()=>requestJson<MemoryProvisioningHoldDto[]>('/api/local-memory/provisioning-holds'),enabled:open,retry:false,refetchOnWindowFocus:false});
 const orphans=useEvidenceInventory<unknown>('orphans','/api/lifecycle/agent-imports/orphan-evidence',open,generation);
 useEffect(()=>{if(custody.isError||memory.isError)setSelected('');},[custody.isError,memory.isError]);
 const custodyIds=custody.isError?[]:custody.data?.pages.flatMap(page=>page.items)??[];
 const orphanEntries=orphans.isError?[]:orphans.data?.pages.flatMap(page=>page.items)??[];
 const items=[...custodyIds.map(id=>({kind:'custody' as const,id,label:`Checkpoint evidence · ${id}`})),...(!memory.isError?memory.data??[]:[]).map(hold=>({kind:'memory' as const,id:hold.id,label:`Memory hold · ${hold.effect?.scope??'legacy unknown scope'} · ${hold.id}`}))];
 const inventoryState=(query:{isError:boolean;isPending:boolean;isFetching:boolean;error:Error|null},count:number,more=false)=>query.isError?`Unavailable · ${query.error?.message} · refresh required`:query.isPending?'Reading inventory…':`${count} loaded · ${query.isFetching?'reading… · ':''}${more?'more available':'end of inventory'}`;
 const disclosureSx={minWidth:0,borderBottom:'1px solid',borderColor:'divider','& > summary':{cursor:'pointer',minHeight:44,py:1.5,overflowWrap:'anywhere'}};
 const target=items.find(item=>JSON.stringify([item.kind,item.id])===selected);
 return <Paper variant="outlined" sx={{p:2.5}}><Stack spacing={2}>
  <Typography component="h2" variant="h6">Recovery Records</Typography>
  <Button sx={{alignSelf:'flex-start'}} onClick={()=>setOpen(value=>!value)} aria-expanded={open}>{open?'Close Lifecycle Inventory':'Review Lifecycle Inventory'}</Button>
  {open&&<>
   <LifecycleDiscovery/>
   <Button disabled={custody.isFetching||memory.isFetching||provisioning.isFetching||orphans.isFetching} onClick={()=>{setSelected('');setGeneration(value=>value+1);void memory.refetch();void provisioning.refetch();}}>Refresh Inventories</Button>
   <Typography variant="body2" color={provisioning.isError?'warning.main':'text.secondary'} sx={{overflowWrap:'anywhere'}}>Memory provisioning holds · {inventoryState(provisioning,provisioning.data?.length??0)}</Typography>
   {!provisioning.isError&&provisioning.data?.map((hold,index)=><Alert severity="warning" key={(hold.chatId??hold.scope)+':'+index}>Memory operation held · {hold.scope==='global'?'Global':hold.scope==='unknown'?'Unknown scope':`Chat ${hold.chatId}`} · {hold.reason} Review memory mutation holds and backend status before taking action.</Alert>)}
   <Box component="details" sx={disclosureSx}>
    <Box component="summary"><Typography component="span" fontWeight={600}>Checkpoint Evidence And Memory Holds</Typography><Typography component="span" variant="body2" color={custody.isError?'warning.main':'text.secondary'} sx={{display:'block'}}>Checkpoint evidence · {inventoryState(custody,custodyIds.length,Boolean(custody.hasNextPage))}</Typography><Typography component="span" variant="body2" color={memory.isError?'warning.main':'text.secondary'} sx={{display:'block'}}>Memory mutation holds · {inventoryState(memory,memory.data?.length??0)}</Typography></Box>
    <Stack spacing={2} sx={{pb:2,minWidth:0}}>
     {custody.error&&<Alert severity="warning">Checkpoint evidence: {custody.error.message} · refresh inventories</Alert>}
     {memory.error&&<Alert severity="warning">Memory mutation holds: {memory.error.message} · refresh inventories</Alert>}
     {custody.hasNextPage&&!custody.isError&&<Button disabled={custody.isFetching} onClick={()=>void custody.fetchNextPage()}>Load More Checkpoint Evidence</Button>}
     <TextField select label="Canonical Retained Identity" value={target?selected:''} onChange={event=>setSelected(event.target.value)}><MenuItem value="">Choose Evidence</MenuItem>{items.map(item=><MenuItem key={JSON.stringify([item.kind,item.id])} value={JSON.stringify([item.kind,item.id])}>{item.label}</MenuItem>)}</TextField>
     {target?.kind==='memory'&&<MemoryPreserveUnknown key={`preserve:${selected}`} id={target.id}/>}
     {target&&<LifecycleReview key={selected} kind={target.kind as LifecycleKind} id={target.id}/>}
    </Stack>
   </Box>
   <Box component="details" sx={disclosureSx}>
    <Box component="summary"><Typography component="span" fontWeight={600}>Preserved Orphan Staging Evidence</Typography><Typography component="span" variant="body2" color={orphans.isError?'warning.main':'text.secondary'} sx={{display:'block'}}>{inventoryState(orphans,orphanEntries.length,Boolean(orphans.hasNextPage))}</Typography></Box>
    <Stack spacing={2} sx={{pb:2,minWidth:0}}>
     {orphans.error&&<Alert severity="warning">Preserved orphan staging evidence: {orphans.error.message} · refresh inventories</Alert>}
     {orphans.data&&!orphans.isError&&<Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(orphanEntries,null,2)}</Typography>}
     {orphans.hasNextPage&&!orphans.isError&&<Button disabled={orphans.isFetching} onClick={()=>void orphans.fetchNextPage()}>Load More Orphan Evidence</Button>}
    </Stack>
   </Box>
   <Typography variant="caption">Original bytes preserved · discovery: exact identities · current review: eligibility</Typography>
  </>}
 </Stack></Paper>;
}
