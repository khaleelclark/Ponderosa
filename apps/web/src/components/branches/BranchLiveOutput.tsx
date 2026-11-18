import {AgentResponseText} from '../chat/AgentResponseText';
import {Alert,Paper,Stack,Typography} from '@mui/material';
import type {BranchLiveOutputDto} from '@ponderosa/core';
import {useAgent} from '../../hooks/queries';
import {useAgentStream} from '../../hooks/useAgentStream';
import {RunOutputFullText} from '../activity/ActivityOutput';

export function BranchLiveOutputs({targets,labels}:{targets:BranchLiveOutputDto[];labels:Record<string,string>}):JSX.Element {
 const agents=[...new Set(targets.map(target=>target.agentId))];
 return <>{agents.map(agentId=><BranchLiveOutput key={agentId} targets={targets.filter(target=>target.agentId===agentId)} labels={labels}/>)}</>;
}

/** One subscription per Agent; work telemetry never becomes a Step result. */
export function BranchLiveOutput({targets,labels}:{targets:BranchLiveOutputDto[];labels:Record<string,string>}):JSX.Element {
 const owner=targets[0]!;
 const agent=useAgent(owner.agentId),stream=useAgentStream(owner.agentId,owner.projectId);
 return <Stack spacing={1}>{targets.map(target=>{
  const entries=agent.data?.runOutput?.filter(entry=>entry.executionId===target.runId&&entry.kind==='response')??[];
  return <Paper key={target.attemptId+':'+target.runId} variant="outlined" sx={{p:2}}><Stack spacing={1}>
   <Typography fontWeight={650}>{labels[target.stepId]??target.stepId} · Live work</Typography>
   {agent.error&&<Alert severity="error">{agent.error.message}</Alert>}
   {stream.connectionStatus!=='live'&&<Typography role="status">{stream.connectionStatus==='connecting'?'Connecting…':'Live updates unavailable; reconnecting…'}</Typography>}
   {!entries.length&&<Typography color="text.secondary">Waiting for output…</Typography>}
   {entries.map(entry=><RunOutputFullText key={entry.id} segment={entry} render={text=><AgentResponseText text={text} completed={entry.completed} projectId={owner.projectId} fileScope={{agentId:owner.agentId}}/>}/>)}
  </Stack></Paper>;
 })}</Stack>;
}
