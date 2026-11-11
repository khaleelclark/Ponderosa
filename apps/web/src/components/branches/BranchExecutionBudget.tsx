import {WorkspaceQueryError} from "../WorkspaceQueryError";
import {workspaceRead} from "../../workspaceAvailability";
import {createClientId} from '../../clientId';
import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Paper,Stack,Switch,TextField,Typography} from '@mui/material';
import type {BranchExecutionBudgetDto,BranchExecutionBudgetGrant,BranchExecutionBudgetPolicy,BranchExecutionBudgetUpdate} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {ApiRequestError} from '../../api/types';
import {useMutationNotification,MutationErrorDetails} from '../MutationNotifications';
import {productApiPath} from '../../api/productScope';
import {useBranchDraftGuard} from './BranchNavigation';
import {budgetPresentation,validBudgetNumber} from './budgetPresentation';

const countedSources='Counted once at start · automatic executions + incoming Branch Calls · exempt: manual runs + trigger Run once';
export function BranchExecutionBudget({branchId,settings=false,active=true}:{branchId:string;settings?:boolean;active?:boolean}):JSX.Element {
 const client=useQueryClient(),notify=useMutationNotification(),queryKey=['branch-execution-budget',branchId];
 const query=useQuery({queryKey,queryFn:()=>requestJson<BranchExecutionBudgetDto>(`/api/branches/${branchId}/execution-budget`),enabled:active,refetchInterval:active?5000:false});
 const [draft,setDraft]=useState<BranchExecutionBudgetPolicy|null>(),[base,setBase]=useState<BranchExecutionBudgetDto>(),[grantOpen,setGrantOpen]=useState(false),[additional,setAdditional]=useState('1'),[editing,setEditing]=useState(false);
 const policyAttempt=useRef<BranchExecutionBudgetUpdate>(),grantAttempt=useRef<BranchExecutionBudgetGrant>(),grantResultLimit=useRef<number>();
 const dirty=draft!==undefined&&Boolean(base)&&JSON.stringify(draft)!==JSON.stringify(base?.policy);
 useBranchDraftGuard(`branch-execution-budget:${branchId}`,settings&&dirty||Boolean(policyAttempt.current)||Boolean(grantAttempt.current));
 useEffect(()=>{if(query.data&&!dirty&&!policyAttempt.current&&(!base||query.data.revision>=base.revision)){setBase(query.data);setDraft(query.data.policy)}},[query.data,dirty,base]);
 const refresh=()=>{void client.invalidateQueries({queryKey});void client.invalidateQueries({queryKey:['branch-executions',branchId]});void client.invalidateQueries({queryKey:['branch-execution']})};
 const save=useMutation({mutationFn:()=>{
   if(!policyAttempt.current){if(!base||draft===undefined)throw new Error('Load the current budget first');policyAttempt.current={commandKey:createClientId(),expectedRevision:base.revision,expectedPeriodId:base.periodId,policy:draft,acknowledgeNewPeriod:true}}
   const key=JSON.stringify([productApiPath("/api/branches"),branchId,"save-budget",policyAttempt.current.expectedPeriodId,policyAttempt.current.policy]),incident=createClientId("budget-feedback-");
   return requestJson<BranchExecutionBudgetDto>(`/api/branches/${branchId}/execution-budget`,{method:'PUT',body:JSON.stringify(policyAttempt.current)}).then(result=>{notify({key,message:"",dismiss:true});return result;},error=>{notify({key,incident,severity:"error",message:"Budget Not Saved",description:"Your original budget command is retained where its outcome is unconfirmed. Review it before retrying.",details:error instanceof Error?error.message:String(error)});throw error;});
 },onSuccess:result=>{policyAttempt.current=undefined;setEditing(false);setDraft(result.policy);setBase(result);refresh();notify({key:`branch-execution-budget:${branchId}`,message:"Settings Saved"})},onError:error=>{if(error instanceof ApiRequestError&&error.status>=400&&error.status<500){policyAttempt.current=undefined;refresh()}}});
 const grant=useMutation({mutationFn:()=>{
   if(!grantAttempt.current){const current=query.data;if(!current?.periodId)throw new Error('Load the current budget first');grantResultLimit.current=current.policy!.limit+current.allowance+Number(additional);grantAttempt.current={commandKey:createClientId(),expectedRevision:current.revision,expectedPeriodId:current.periodId,additional:Number(additional)}}
   const key=JSON.stringify([productApiPath("/api/branches"),branchId,"grant-budget",grantAttempt.current.expectedPeriodId,grantAttempt.current.additional]),incident=createClientId("budget-feedback-");
   return requestJson<BranchExecutionBudgetDto>(`/api/branches/${branchId}/execution-budget/allow`,{method:'POST',body:JSON.stringify(grantAttempt.current)}).then(result=>{notify({key,message:"",dismiss:true});return result;},error=>{notify({key,incident,severity:"error",message:"Allowance Needs Review",description:"Your original budget command is retained where its outcome is unconfirmed. Review it before retrying.",details:error instanceof Error?error.message:String(error)});throw error;});
 },onSuccess:()=>{grantAttempt.current=undefined;grantResultLimit.current=undefined;setGrantOpen(false);setAdditional('1');refresh()},onError:error=>{if(error instanceof ApiRequestError&&error.status>=400&&error.status<500){grantAttempt.current=undefined;grantResultLimit.current=undefined;refresh()}}});
 const presentation=budgetPresentation(query),unavailable=!query.data||Boolean(query.error);
 const epochChange=draft!==undefined&&draft!==null&&(!base?.policy||base.policy.period!==draft.period);
 const valid=draft===null||Boolean(draft&&validBudgetNumber(String(draft.limit)));
 const grantValid=validBudgetNumber(additional)&&Boolean(query.data?.policy&&query.data.policy.limit+query.data.allowance+Number(additional)<=1_000_000_000);
 const policyLocked=save.isPending||Boolean(policyAttempt.current);
 const editorVisible=settings&&(editing||dirty||save.isPending||Boolean(save.error)||Boolean(policyAttempt.current));
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Stack direction="row" spacing={1} useFlexGap sx={{alignItems:'center',justifyContent:'space-between',flexWrap:'wrap'}}>
   <Typography variant="subtitle1" fontWeight={650}>Automatic Execution Budget</Typography>
   {settings&&draft!==undefined&&<FormControlLabel sx={{m:0,flexShrink:0}} label="Limit" control={<Switch inputProps={{'aria-label':'Limit Automatic Executions'}} checked={draft!==null} disabled={policyLocked||unavailable} onChange={(_,enabled)=>{save.reset();setEditing(enabled);setDraft(enabled?{limit:100,period:'month'}:null)}}/>}/>}
  </Stack>
  <WorkspaceQueryError read={workspaceRead(`branch:${branchId}`,"Execution Budget",query)}/>{!query.error&&<Stack direction="row" spacing={1} useFlexGap sx={{alignItems:'baseline',justifyContent:'space-between',flexWrap:'wrap'}}>
   <Typography variant="body2" role={!query.data?"status":undefined}>{presentation.message}</Typography>
   {query.data&&<Typography variant="caption" color={query.data.heldCount?'warning.main':'text.secondary'}>{query.data.heldCount} waiting</Typography>}
  </Stack>}
  {editorVisible&&draft!==undefined&&<Stack spacing={1.5}>
   {draft&&<Stack direction={{xs:'column',sm:'row'}} spacing={1.5}><TextField fullWidth label="Executions Per Period" type="number" value={draft.limit} disabled={policyLocked} error={!valid} helperText="A whole number from 1 to 1,000,000,000." onChange={e=>{save.reset();setDraft({...draft,limit:Number(e.target.value)})}}/><TextField fullWidth select label="Budget Period" value={draft.period} disabled={policyLocked} onChange={e=>{save.reset();setDraft({...draft,period:e.target.value as BranchExecutionBudgetPolicy['period']})}}>{(['day','week','month','lifetime'] as const).map(period=><MenuItem key={period} value={period}>{period}</MenuItem>)}</TextField></Stack>}
   {epochChange&&<Alert severity="warning">Saving a new period resets usage + extra allowance; limit-only changes preserve both</Alert>}
   {draft===null&&base?.policy&&<Alert severity="info">Removing budget releases waiting work; re-adding starts a new period</Alert>}
   <MutationErrorDetails title="Budget Save Needs Review" error={save.error}>{policyAttempt.current?'Retry sends the same command safely.':'Refresh the budget and review your changes before saving again.'}</MutationErrorDetails>
   <Stack direction="row" spacing={1} useFlexGap sx={{flexWrap:'wrap'}}><Button variant="contained" disabled={save.isPending||(!policyAttempt.current&&(unavailable||!dirty||!valid||base?.revision!==query.data?.revision))} onClick={()=>save.mutate()}>{save.isPending?'Saving…':policyAttempt.current?'Retry Budget Save':epochChange?'Save And Start New Period':'Save Budget'}</Button>{!dirty&&!policyLocked&&<Button onClick={()=>setEditing(false)}>Done</Button>}</Stack>
   {dirty&&base?.revision!==query.data?.revision&&<Alert severity="warning" action={<Button disabled={policyLocked} onClick={()=>{setBase(query.data);setDraft(query.data?.policy);save.reset()}}>Load Current Budget</Button>}>Budget changed · load current budget before saving</Alert>}
  </Stack>}
  {(settings&&draft&&!editorVisible||query.data?.policy)?<Stack direction="row" spacing={1} useFlexGap sx={{flexWrap:'wrap'}}>{settings&&draft&&!editorVisible&&<Button onClick={()=>setEditing(true)}>Edit Budget</Button>}{query.data?.policy&&<Button disabled={unavailable} onClick={()=>{grant.reset();setGrantOpen(true)}}>Allow More Executions</Button>}</Stack>:null}
  <Box component="details" sx={{'& > summary':{minHeight:44,alignContent:'center',cursor:'pointer',fontSize:'0.8125rem',color:'text.secondary'}}}>
   <Box component="summary">How this budget works</Box>
   <Stack spacing={1} sx={{pb:1}}><Typography variant="body2" color="text.secondary">{countedSources}</Typography>
    {!query.error&&query.data&&(query.data.resetsAt?<Typography variant="body2">Next reset: {new Date(query.data.resetsAt).toLocaleString()} ({query.data.resetsAt}) · period measured from start, not calendar boundary</Typography>:query.data?.policy&&<Typography variant="body2">Lifetime budget: no automatic reset.</Typography>)}
    <Typography variant="body2" color="text.secondary">Workflow updates and Branch toggles do not reset this budget.</Typography>
   </Stack>
  </Box>
  <Dialog open={grantOpen} onClose={()=>{if(!grant.isPending&&!grantAttempt.current)setGrantOpen(false)}} fullWidth maxWidth="sm"><DialogTitle>Allow More Executions</DialogTitle><DialogContent><Stack component="form" id={`budget-grant-${branchId}`} onSubmit={e=>{e.preventDefault();if(!grant.isPending&&(grantAttempt.current||(!unavailable&&grantValid)))grant.mutate()}} spacing={2} mt={1}>
   <Stack spacing={0.5}><Typography>{budgetPresentation(query).message}</Typography><Typography>{query.data?.resetsAt?`Expires ${query.data.resetsAt}`:query.data?.policy?.period==='lifetime'?"Lifetime allowance · no automatic expiry":"Reset time unavailable"}</Typography><Typography>Confirming may start eligible waiting work immediately</Typography></Stack>
   <Typography>Extra allowance expires at rollover · started/canceled executions: no refund</Typography>
   <TextField autoFocus label="Additional Executions" type="number" value={additional} disabled={grant.isPending||Boolean(grantAttempt.current)} error={!grantValid} helperText="A positive whole number; base plus extra allowance may not exceed 1,000,000,000." onChange={e=>{setAdditional(e.target.value);grant.reset()}}/>
   {(grantAttempt.current||grantValid)&&query.data?.policy&&<Typography>Resulting effective limit: {grantAttempt.current?grantResultLimit.current:query.data.policy.limit+query.data.allowance+Number(additional)} executions.</Typography>}
   <MutationErrorDetails title="Allowance Needs Review" error={grant.error}>{grantAttempt.current?'Retry sends the same command safely.':'The current budget is being refreshed; review it before trying again.'}</MutationErrorDetails>
  </Stack></DialogContent><DialogActions><Button disabled={grant.isPending||Boolean(grantAttempt.current)} onClick={()=>setGrantOpen(false)}>Back</Button><Button variant="contained" disabled={grant.isPending||(!grantAttempt.current&&(unavailable||!grantValid))} type="submit" form={`budget-grant-${branchId}`}>{grant.isPending?'Allowing…':grantAttempt.current?'Retry Allowance':'Allow Executions'}</Button></DialogActions></Dialog>
 </Stack></Paper>;
}
