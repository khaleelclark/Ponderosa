import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {Accordion,AccordionDetails,AccordionSummary,Alert,Button,Stack,Typography} from '@mui/material';
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

export function BranchTriggerAudit({triggerId,onNavigate,branchId}:{triggerId:string;branchId:string;onNavigate(route:BranchRoute):void}):JSX.Element {
 const pages=useInfiniteQuery({queryKey:['branch-trigger-occurrences',branchId,triggerId],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<TriggerOccurrenceDto[]>(`/api/branches/${branchId}/trigger/occurrences?limit=50${pageParam?'&before='+encodeURIComponent(pageParam):''}`),getNextPageParam:last=>last.length===50?last.at(-1)?.id:undefined,refetchInterval:5000});
 const occurrences={...pages,data:pages.data?.pages.flat()??[]};
 return <Accordion slotProps={{transition:{unmountOnExit:true}}}><AccordionSummary expandIcon={<ExpandMoreIcon/>}><Typography>Trigger occurrences</Typography></AccordionSummary><AccordionDetails><Typography variant="caption">Trigger history, 50 occurrences per page.</Typography>{occurrences.isPending?<Typography>Loading occurrences…</Typography>:occurrences.error?<Alert severity="error" action={<Button onClick={()=>void occurrences.refetch()}>Retry</Button>}>{occurrences.error.message}</Alert>:!occurrences.data.length?<Typography>No trigger occurrences yet.</Typography>:occurrences.data.map(occurrence=><Stack key={occurrence.id}><OccurrenceAudit occurrence={occurrence}/>{occurrence.branchExecutionId&&<Button onClick={()=>onNavigate({branchId,tab:'executions',executionId:occurrence.branchExecutionId})}>Open execution</Button>}</Stack>)}{pages.hasNextPage&&<Button disabled={pages.isFetchingNextPage} onClick={()=>void pages.fetchNextPage()}>Load older occurrences</Button>}</AccordionDetails></Accordion>;
}
