import {useEffect,useState} from 'react';
import {useInfiniteQuery} from '@tanstack/react-query';
import {Alert,Button,MenuItem,Paper,Stack,TextField,Typography} from '@mui/material';
import type {LifecycleDiscoveryPage,LifecycleImportEntry,LifecycleDestinationEntry,LifecycleCaptureEntry,LifecycleGroupCaptureEntry} from '@ponderosa/core';
import {currentProductScope} from '../../api/productScope';
import {requestJson} from '../../api/real';
import {LifecycleReview} from './LifecycleReview';
import {BranchLifecycleReview} from './BranchLifecycleReview';
import {GroupCaptureAbandonmentReview,RetainedGroupCaptureAbandonments} from './GroupCaptureAbandonmentReview';
import {groupCaptureEntryValid} from './groupCaptureAbandonment';
import {lifecycleDiscoveryPage} from './lifecycleDiscovery';
type Kind='imports'|'destinations'|'captures'|'groupCaptures';
type Entry=LifecycleImportEntry|LifecycleDestinationEntry|LifecycleCaptureEntry|LifecycleGroupCaptureEntry;
const routes={imports:'agent-imports',destinations:'destinations',captures:'checkpoint-captures',groupCaptures:'checkpoint-capture-groups'};
const titles={imports:'Import operations',destinations:'Destination admissions',captures:'Source capture intents',groupCaptures:'Whole-group capture intents'};
const identity=(entry:Entry)=>'sources' in entry?JSON.stringify([entry.executionId,entry.captureKey]):'operationId' in entry?entry.operationId:'admissionId' in entry?entry.admissionId:JSON.stringify([entry.captureKey,entry.source]);
const label=(entry:Entry)=>'sources' in entry?`${entry.captureKey} · ${entry.executionId} · ${entry.sources.length} resources · ${entry.sourceOwner}`:'operationId' in entry?`${entry.operationId} · ${entry.owner.project}/${entry.owner.conversation} · ${entry.status}`:'admissionId' in entry?`${entry.group?'Group':'Singular'} ${entry.admissionId} · ${entry.sourceOwner} · ${entry.state}`:`${entry.captureKey} · ${entry.source.sourceChatId} · ${entry.sourceOwner}`;
/** Each collection owns its cursor and selection; destination failure never blocks source discovery. */
function Inventory({kind}:{kind:Kind}):JSX.Element {
 const [generation,setGeneration]=useState(0),[selected,setSelected]=useState('');
 const query=useInfiniteQuery({queryKey:['lifecycle-discovery',currentProductScope(),kind,generation],initialPageParam:undefined as {cursor:string;revision:string}|undefined,
  queryFn:async({pageParam})=>{const page=lifecycleDiscoveryPage(await requestJson<LifecycleDiscoveryPage<Entry>>(`/api/lifecycle/${routes[kind]}?limit=50${pageParam?`&cursor=${encodeURIComponent(pageParam.cursor)}`:''}`,{cache:'no-store'}),pageParam?.revision);if(kind==='groupCaptures'&&!page.items.every(item=>groupCaptureEntryValid(item as LifecycleGroupCaptureEntry)))throw Error('Invalid whole-group source inventory; restart explicitly.');return page;},
  getNextPageParam:last=>last.nextCursor?{cursor:last.nextCursor,revision:last.revision}:undefined,
  retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false,staleTime:Infinity,gcTime:0});
 useEffect(()=>{if(query.isError)setSelected('');},[query.isError]);
 const pages=query.data?.pages??[],items=query.isError?[]:pages.flatMap(page=>page.items),target=items.find(item=>identity(item)===selected),revision=pages[0]?.revision;
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={2}>
  <Typography component="h3" variant="subtitle1">{titles[kind]}</Typography>
  <Button disabled={query.isFetching} onClick={()=>{setSelected('');setGeneration(value=>value+1);}}>Restart {titles[kind].toLowerCase()}</Button>
  {query.isFetching&&<Typography role="status">Reading canonical inventory…</Typography>}
  {query.error&&<Alert severity="warning">{query.error.message} · selections + confirmations cleared · explicitly restart inventory</Alert>}
  {!query.isError&&<>
   <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Loaded {items.length} · revision {revision??'pending'} · {query.isPending?'reading first page':query.hasNextPage?'more entries available':'end of inventory'}</Typography>
   {Boolean(pages[0]?.unverifiedEvidenceCount)&&<Alert severity="warning">{pages[0].unverifiedEvidenceCount} unverified evidence files · quarantined/unrecognized · no selectable operation IDs</Alert>}
   <TextField select label={titles[kind]} value={target?selected:''} disabled={query.isFetching} onChange={event=>setSelected(event.target.value)}><MenuItem value="">Choose canonical identity</MenuItem>{items.map(item=><MenuItem key={identity(item)} value={identity(item)}>{label(item)}</MenuItem>)}</TextField>
   {query.hasNextPage&&<Button disabled={query.isFetching} onClick={()=>void query.fetchNextPage()}>Load more {titles[kind].toLowerCase()}</Button>}
  </>}
  {target&&<Stack key={JSON.stringify([generation,revision,identity(target)])} spacing={2}>
   {'operationId' in target?<>
    <Typography sx={{overflowWrap:'anywhere'}}>Operation {target.operationId} · Project {target.owner.projectId} ({target.owner.project}) · Chat {target.owner.conversationId} ({target.owner.conversation}) · product {target.product} · status {target.status} · phase {target.phase} · evidence {target.evidenceOrigin} · lifecycle {target.lifecycleState??'none'}</Typography>
    <LifecycleReview kind="import" id={target.operationId}/>
   </>:'admissionId' in target?<>
    <Typography sx={{overflowWrap:'anywhere'}}>{target.group?'Whole group':'Singular'} admission {target.admissionId} · Branch {target.branchId} · source Run {target.sourceExecutionId} ({target.sourceOwner}) · checkpoint {target.checkpointId} · {target.checkpointHash} · {target.state}</Typography>
    {target.destinations.map((slot,index)=><Typography key={JSON.stringify([index,slot.conversationId,slot.resourceStepId])} sx={{overflowWrap:'anywhere'}}>Slot {index+1} · source Chat {slot.sourceChatId} · Project {slot.projectId} ({slot.project}) · Chat {slot.conversationId} ({slot.conversation}) · Run {slot.executionId} · Step {slot.resourceStepId}</Typography>)}
    <LifecycleReview kind={target.group?'group':'destination'} id={target.admissionId}/>
   </>:'sources' in target?<>
    <Typography sx={{overflowWrap:'anywhere'}}>Whole-group capture {target.captureKey} · source Run {target.executionId} · owner {target.sourceOwner} · {target.state}</Typography>
    <details><summary>Full canonical group sources and captured checkpoint identities</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify({sources:target.sources,capturedCheckpointIds:target.capturedCheckpointIds},null,2)}</Typography></details>
    <GroupCaptureAbandonmentReview entry={target}/>
   </>:<>
    <Typography sx={{overflowWrap:'anywhere'}}>Capture {target.captureKey} · source owner {target.sourceOwner} · Branch {target.branchId??'retained identity only'} · {target.state}</Typography>
    <details><summary>Full canonical capture source</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(target.source,null,2)}</Typography></details>
    <BranchLifecycleReview source={target.source} captureKey={target.captureKey}/>
   </>}
   <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Evidence SHA256 {target.evidenceSha256}</Typography>
   <Alert severity="info">Retained identity · audit only · no deletion/drain/authority/eligibility proof · current review required</Alert>
  </Stack>}
 </Stack></Paper>;
}
export function LifecycleDiscovery():JSX.Element {
 return <Stack spacing={2}>
  <Typography>Discovery · current / deleted-owner / retained identities + hashes · load all pages · eligibility requires current review</Typography>
  <Inventory kind="imports"/>
  <Inventory kind="destinations"/>
  <Inventory kind="captures"/>
  <Inventory kind="groupCaptures"/>
  <RetainedGroupCaptureAbandonments/>
  <Alert severity="warning">Abandonment · reviewed unsealed whole groups only · fully retained/unknown groups held · no history/disk reclamation or singular loop</Alert>
 </Stack>;
}
