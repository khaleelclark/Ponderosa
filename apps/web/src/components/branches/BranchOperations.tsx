import {useState} from 'react';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,Stack,Typography} from '@mui/material';
import {useInfiniteQuery} from '@tanstack/react-query';
import type {BranchLifecycleDto,TriggerOccurrenceDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import type {BranchRoute} from '../../branchesRouting';
import {OccurrenceAudit} from '../TriggerOccurrenceAudit';

export function BranchLifecycleStatus({lifecycle,onCancelUpdate,canceling=false}:{lifecycle:BranchLifecycleDto;onCancelUpdate?(id:string):void;canceling?:boolean}):JSX.Element {
 return <Stack spacing={1} role="status">
  {lifecycle.deleting&&<Alert severity="info">Workflow deletion is draining active work.</Alert>}
  {lifecycle.updates.map(update=><Alert key={update.id} severity={update.error?'error':'info'} action={onCancelUpdate?<Button color="inherit" disabled={canceling} onClick={()=>onCancelUpdate(update.id)}>Stop update</Button>:undefined}>Package update is applying. {update.error?`Engine retry pending: ${update.error}`:'Progress is saved; you can return after reload.'}</Alert>)}
  {lifecycle.pendingRemoval.map(resource=><Alert key={resource.id} severity={resource.error?'error':'info'}>{resource.kind} pending retirement · {resource.id}. {resource.error??'Waiting for earlier executions to drain.'}</Alert>)}
 </Stack>;
}

export function BranchTriggerAudit({onNavigate,branchId,diagnostics=[]}:{diagnostics?:BranchLifecycleDto["sourceDiagnostics"];branchId:string;onNavigate(route:BranchRoute):boolean}):JSX.Element {
 const [open,setOpen]=useState(false);
 const pages=useInfiniteQuery({queryKey:['branch-trigger-occurrences',branchId],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<TriggerOccurrenceDto[]>(`/api/branches/${branchId}/trigger/occurrences?limit=50${pageParam?'&before='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.length===50?last.at(-1)?.id:undefined,enabled:open,refetchInterval:open?5000:false});
 const occurrences=pages.data?.pages.flat()??[];
 return <>
  <Button variant="outlined" sx={{minHeight:44}} onClick={()=>setOpen(true)}>Trigger Events</Button>
  <Dialog open={open} onClose={()=>setOpen(false)} fullWidth maxWidth="md" aria-labelledby="branch-trigger-events-title">
   <DialogTitle id="branch-trigger-events-title">Trigger Events</DialogTitle>
   <DialogContent>
    <Typography variant="body2" color="text.secondary" sx={{mb:1}}>Schedule, webhook and file events for this Workflow. Activated means the event was accepted; it does not mean its Run completed.</Typography>
    {diagnostics.map(item=><Alert severity="info" key={item.id}>{item.title}: {item.body}</Alert>)}
    {pages.isPending?<Typography role="status">Loading trigger events…</Typography>:pages.error?<Alert severity="error" action={<Button onClick={()=>void pages.refetch()}>Retry</Button>}>{pages.error.message}</Alert>:!occurrences.length?<Typography>No trigger events yet.</Typography>:occurrences.map(occurrence=><Stack key={occurrence.id}><OccurrenceAudit occurrence={occurrence} runTerminology/>{occurrence.branchExecutionId&&<Button onClick={()=>{if(onNavigate({branchId,tab:'executions',executionId:occurrence.branchExecutionId}))setOpen(false)}}>View Run</Button>}</Stack>)}
    {pages.hasNextPage&&<Button disabled={pages.isFetchingNextPage} onClick={()=>void pages.fetchNextPage()}>Load Older Events</Button>}
   </DialogContent>
   <DialogActions><Button onClick={()=>setOpen(false)}>Close</Button></DialogActions>
  </Dialog>
 </>;
}
