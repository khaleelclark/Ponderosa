import {createClientId} from '../../clientId';
import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Button,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Paper,Stack,Switch,TextField,Typography} from '@mui/material';
import type {BranchExecutionBudgetDto,BranchExecutionBudgetGrant,BranchExecutionBudgetPolicy,BranchExecutionBudgetUpdate} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {useBranchDraftGuard} from './BranchNavigation';
import {budgetPresentation,validBudgetNumber} from './budgetPresentation';

const countedSources='Scheduled, webhook and filesystem executions, and incoming Branch Calls count when workflow work first starts. Direct manual runs and trigger Run once are exempt. Steps and retries within an execution do not count again.';
export function BranchExecutionBudget({branchId,settings=false}:{branchId:string;settings?:boolean}):JSX.Element {
 const client=useQueryClient(),queryKey=['branch-execution-budget',branchId];
 const query=useQuery({queryKey,queryFn:()=>requestJson<BranchExecutionBudgetDto>(`/api/branches/${branchId}/execution-budget`),refetchInterval:5000});
 const [draft,setDraft]=useState<BranchExecutionBudgetPolicy|null>(),[base,setBase]=useState<BranchExecutionBudgetDto>(),[grantOpen,setGrantOpen]=useState(false),[additional,setAdditional]=useState('1');
 const policyAttempt=useRef<BranchExecutionBudgetUpdate>(),grantAttempt=useRef<BranchExecutionBudgetGrant>(),grantResultLimit=useRef<number>();
 const dirty=draft!==undefined&&Boolean(base)&&JSON.stringify(draft)!==JSON.stringify(base?.policy);
 useBranchDraftGuard(`branch-execution-budget:${branchId}`,settings&&dirty||Boolean(policyAttempt.current)||Boolean(grantAttempt.current));
 useEffect(()=>{if(query.data&&!dirty&&!policyAttempt.current&&(!base||query.data.revision>=base.revision)){setBase(query.data);setDraft(query.data.policy)}},[query.data,dirty,base]);
 const refresh=()=>{void client.invalidateQueries({queryKey});void client.invalidateQueries({queryKey:['branch-executions',branchId]});void client.invalidateQueries({queryKey:['branch-execution']})};
 const save=useMutation({mutationFn:()=>{
   if(!policyAttempt.current){if(!base||draft===undefined)throw new Error('Load the current budget first');policyAttempt.current={commandKey:createClientId(),expectedRevision:base.revision,expectedPeriodId:base.periodId,policy:draft,acknowledgeNewPeriod:true}}
   return requestJson<BranchExecutionBudgetDto>(`/api/branches/${branchId}/execution-budget`,{method:'PUT',body:JSON.stringify(policyAttempt.current)});
 },onSuccess:result=>{policyAttempt.current=undefined;setDraft(result.policy);setBase(result);refresh()},onError:error=>{if(error instanceof ApiRequestError&&error.status>=400&&error.status<500){policyAttempt.current=undefined;refresh()}}});
 const grant=useMutation({mutationFn:()=>{
   if(!grantAttempt.current){const current=query.data;if(!current?.periodId)throw new Error('Load the current budget first');grantResultLimit.current=current.policy!.limit+current.allowance+Number(additional);grantAttempt.current={commandKey:createClientId(),expectedRevision:current.revision,expectedPeriodId:current.periodId,additional:Number(additional)}}
   return requestJson<BranchExecutionBudgetDto>(`/api/branches/${branchId}/execution-budget/allow`,{method:'POST',body:JSON.stringify(grantAttempt.current)});
 },onSuccess:()=>{grantAttempt.current=undefined;grantResultLimit.current=undefined;setGrantOpen(false);setAdditional('1');refresh()},onError:error=>{if(error instanceof ApiRequestError&&error.status>=400&&error.status<500){grantAttempt.current=undefined;grantResultLimit.current=undefined;refresh()}}});
 const presentation=budgetPresentation(query),unavailable=!query.data||Boolean(query.error)||query.isFetching;
 const epochChange=draft!==undefined&&draft!==null&&(!base?.policy||base.policy.period!==draft.period);
 const valid=draft===null||Boolean(draft&&validBudgetNumber(String(draft.limit)));
 const grantValid=validBudgetNumber(additional)&&Boolean(query.data?.policy&&query.data.policy.limit+query.data.allowance+Number(additional)<=1_000_000_000);
 const policyLocked=save.isPending||Boolean(policyAttempt.current);
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={2}>
  <Typography variant="h6">Automatic execution budget</Typography>
  <Typography variant="body2" color="text.secondary">{countedSources}</Typography>
  {query.error?<Alert severity="error" action={<Button onClick={()=>void query.refetch()}>Retry budget</Button>}>Budget could not be refreshed. {query.error.message}</Alert>:<Typography role={!query.data?"status":undefined}>{presentation.message}</Typography>}
  {!query.error&&query.data&&<><Typography>{query.data.heldCount} execution{query.data.heldCount===1?'':'s'} waiting for this budget.</Typography>{query.data.resetsAt?<Typography variant="body2">Next reset: {new Date(query.data.resetsAt).toLocaleString()} ({query.data.resetsAt}). Periods run from their start time, rather than calendar boundaries.</Typography>:query.data.policy&&<Typography variant="body2">Lifetime budget: no automatic reset.</Typography>}</>}
  {settings&&draft!==undefined&&<>
   <FormControlLabel label="Limit automatic executions" control={<Switch checked={draft!==null} disabled={policyLocked||unavailable} onChange={(_,enabled)=>{save.reset();setDraft(enabled?{limit:100,period:'month'}:null)}}/>}/>
   {draft&&<><TextField label="Executions per period" type="number" value={draft.limit} disabled={policyLocked} error={!valid} helperText="A whole number from 1 to 1,000,000,000." onChange={e=>{save.reset();setDraft({...draft,limit:Number(e.target.value)})}}/><TextField select label="Budget period" value={draft.period} disabled={policyLocked} onChange={e=>{save.reset();setDraft({...draft,period:e.target.value as BranchExecutionBudgetPolicy['period']})}}>{(['day','week','month','lifetime'] as const).map(period=><MenuItem key={period} value={period}>{period}</MenuItem>)}</TextField></>}
   {epochChange&&<Alert severity="warning">Saving starts a new budget period with zero usage and extra allowance. Changing only the limit preserves usage and allowance.</Alert>}
   {draft===null&&base?.policy&&<Alert severity="info">Removing this budget releases queued work. Adding a budget again starts a new period.</Alert>}
   <Typography variant="body2">This local policy survives workflow and package updates. Enabling or disabling the Branch does not refill it.</Typography>
   {save.error&&<Alert severity="error">{save.error.message}{policyAttempt.current?' Retry sends the same command safely.':' Refresh the budget and review your changes before saving again.'}</Alert>}
   {save.isSuccess&&<Alert severity="success">Budget saved.</Alert>}
   <Button sx={{alignSelf:'start'}} variant="contained" disabled={save.isPending||(!policyAttempt.current&&(unavailable||!dirty||!valid||base?.revision!==query.data?.revision))} onClick={()=>save.mutate()}>{save.isPending?'Saving…':policyAttempt.current?'Retry budget save':epochChange?'Save and start new period':'Save budget'}</Button>
   {dirty&&base?.revision!==query.data?.revision&&<Alert severity="warning" action={<Button disabled={policyLocked} onClick={()=>{setBase(query.data);setDraft(query.data?.policy);save.reset()}}>Load current budget</Button>}>Budget changed. Load the current budget before saving.</Alert>}
  </>}
  {query.data?.policy&&<Button sx={{alignSelf:'start'}} disabled={unavailable} onClick={()=>{grant.reset();setGrantOpen(true)}}>Allow more executions</Button>}
  <Dialog open={grantOpen} onClose={()=>{if(!grant.isPending&&!grantAttempt.current)setGrantOpen(false)}} fullWidth maxWidth="sm"><DialogTitle>Allow more executions</DialogTitle><DialogContent><Stack component="form" id={`budget-grant-${branchId}`} onSubmit={e=>{e.preventDefault();if(!grant.isPending&&(grantAttempt.current||(!unavailable&&grantValid)))grant.mutate()}} spacing={2} mt={1}>
   <Typography>{budgetPresentation(query).message}. {query.data?.resetsAt?`Expires ${query.data.resetsAt}.`:query.data?.policy?.period==='lifetime'?"Lifetime allowance has no automatic expiry.":"Reset time unavailable."} Eligible waiting work may start immediately.</Typography>
   <Typography>Extra allowance applies only to the current period and expires at rollover. Started or canceled executions are never refunded.</Typography>
   <TextField autoFocus label="Additional executions" type="number" value={additional} disabled={grant.isPending||Boolean(grantAttempt.current)} error={!grantValid} helperText="A positive whole number; base plus extra allowance may not exceed 1,000,000,000." onChange={e=>{setAdditional(e.target.value);grant.reset()}}/>
   {(grantAttempt.current||grantValid)&&query.data?.policy&&<Typography>Resulting effective limit: {grantAttempt.current?grantResultLimit.current:query.data.policy.limit+query.data.allowance+Number(additional)} executions.</Typography>}
   {grant.error&&<Alert severity="error">{grant.error.message}{grantAttempt.current?' Retry sends the same command safely.':' The current budget is being refreshed; review it before trying again.'}</Alert>}
  </Stack></DialogContent><DialogActions><Button disabled={grant.isPending||Boolean(grantAttempt.current)} onClick={()=>setGrantOpen(false)}>Back</Button><Button variant="contained" disabled={grant.isPending||(!grantAttempt.current&&(unavailable||!grantValid))} type="submit" form={`budget-grant-${branchId}`}>{grant.isPending?'Allowing…':grantAttempt.current?'Retry allowance':'Allow executions'}</Button></DialogActions></Dialog>
 </Stack></Paper>;
}
