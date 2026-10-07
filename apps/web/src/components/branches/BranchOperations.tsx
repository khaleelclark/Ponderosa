import {Alert,Button,Paper,Stack,Typography} from '@mui/material';
import {useQuery} from '@tanstack/react-query';
import type {BranchDto,BranchLifecycleDto} from '@ponderosa/core';
import {realApi} from '../../api/real';
import {queryKeys} from '../../queryKeys';
import {isOpenAttention} from '../../attention';
import type {BranchRoute} from '../../branchesRouting';
import {OccurrenceAudit} from '../TriggerOccurrenceAudit';

export function BranchOperations({branches,onNavigate}:{branches:BranchDto[];onNavigate(route:BranchRoute):void}):JSX.Element {
 const attention=useQuery({queryKey:queryKeys.notifications.all,queryFn:()=>realApi.listNotifications(undefined,50),refetchInterval:5000});
 // Home previews 50 notifications and the loaded directory; the shared inbox and directory pagination expose older records.
 const items=attention.data?.items.filter(isOpenAttention)??[];
 const working=branches.filter(branch=>(branch.activeExecutions??0)>0);
 return <Stack spacing={2}>
  <Paper variant="outlined" sx={{p:2}}><Typography variant="h6">Needs Attention</Typography>{attention.isPending?<Typography>Loading decisions and delivery issues…</Typography>:attention.error?<Alert severity="error" action={<Button onClick={()=>void attention.refetch()}>Retry</Button>}>{attention.error.message}</Alert>:items.length?items.map(item=><Stack key={item.id} direction="row" alignItems="center" gap={1}><Typography sx={{flex:1}}>{item.title}</Typography>{item.branchId&&<Button onClick={()=>onNavigate({branchId:item.branchId,tab:'executions'})}>Review Branch</Button>}</Stack>):<Typography color="text.secondary">Nothing in the current notification page needs your attention.</Typography>}<Typography variant="caption" color="text.secondary">Open Notifications to review decisions, delivery details, and older attention items.</Typography></Paper>
  <Paper variant="outlined" sx={{p:2}}><Typography variant="h6">Working Now</Typography>{working.length?working.map(branch=><Button key={branch.id} onClick={()=>onNavigate({branchId:branch.id,tab:'executions'})}>{branch.name} · {branch.activeExecutions} active</Button>):<Typography color="text.secondary">No active executions in the loaded workflow directory.</Typography>}</Paper>
 </Stack>;
}

export function BranchLifecycleStatus({lifecycle,onCancelUpdate,canceling=false}:{lifecycle:BranchLifecycleDto;onCancelUpdate?(id:string):void;canceling?:boolean}):JSX.Element {
 return <Stack spacing={1} role="status">
  {lifecycle.deleting&&<Alert severity="info">Workflow deletion is draining active work.</Alert>}
  {lifecycle.updates.map(update=><Alert key={update.id} severity={update.error?'error':'info'} action={onCancelUpdate?<Button color="inherit" disabled={canceling} onClick={()=>onCancelUpdate(update.id)}>Stop update</Button>:undefined}>Package update is applying. {update.error?`Engine retry pending: ${update.error}`:'Progress is saved; you can return after reload.'}</Alert>)}
  {lifecycle.pendingRemoval.map(resource=><Alert key={resource.id} severity={resource.error?'error':'info'}>{resource.kind} pending retirement · {resource.id}. {resource.error??'Waiting for earlier executions to drain.'}</Alert>)}
 </Stack>;
}

export function BranchTriggerAudit({triggerId,onNavigate,branchId}:{triggerId:string;branchId:string;onNavigate(route:BranchRoute):void}):JSX.Element {
 const occurrences=useQuery({queryKey:['branch-trigger-occurrences',triggerId],queryFn:()=>realApi.listTriggerOccurrences(triggerId,50),refetchInterval:5000});
 return <Paper variant="outlined" sx={{p:2}}><Typography variant="h6">Trigger occurrences</Typography><Typography variant="caption">Latest 50 occurrences, from canonical trigger history.</Typography>{occurrences.isPending?<Typography>Loading occurrences…</Typography>:occurrences.error?<Alert severity="error" action={<Button onClick={()=>void occurrences.refetch()}>Retry</Button>}>{occurrences.error.message}</Alert>:!occurrences.data.length?<Typography>No trigger occurrences yet.</Typography>:occurrences.data.map(occurrence=><Stack key={occurrence.id}><OccurrenceAudit occurrence={occurrence}/>{occurrence.branchExecutionId&&<Button onClick={()=>onNavigate({branchId,tab:'executions',executionId:occurrence.branchExecutionId})}>Open execution</Button>}</Stack>)}</Paper>;
}
