import {BranchRuntimeOwnerReadback} from './BranchRuntimePackageReview';
import {BranchHistoryReview} from './BranchHistoryReview';
import {BranchDisclosureReview} from './BranchDisclosureReview';
import {BranchGroupReview} from './BranchGroupReview';
import {BranchResourceReview} from './BranchResourceReview';
import {createClientId} from '../../clientId';
import {branchRoutePath} from '../../branchesRouting';
import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {useInfiniteQuery,useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Accordion,AccordionDetails,AccordionSummary,Alert,Box,Button,ButtonBase,Chip,Dialog,DialogActions,DialogContent,DialogTitle,FormControl,FormControlLabel,FormLabel,Menu,MenuItem,Paper,Radio,RadioGroup,Stack,Switch,TextField,Typography} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {notificationPreviewText} from '@ponderosa/core';
import {copyText} from '../../clipboard';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import type {BranchDefinition,BranchExecutionDetailDto,BranchExecutionDto,BranchGateDto,BranchGateResolution,BranchIntervention,BranchStepEvidenceDto,BranchMapItemDto,BranchOperationalSummaryDto,BranchExecutionActionsDto,BranchStepExecutionDto,BranchWaitDto} from '@ponderosa/core';
type ReviewIntervention=Omit<BranchIntervention,'action'>&{action:BranchIntervention['action']|'resolve_guidance';injectionId?:string};
import {requestJson} from '../../api/real';
import {productApiPath} from '../../api/productScope';
import {ApiRequestError} from '../../api/types';
import {BranchLiveOutputs} from './BranchLiveOutput';
import {BranchGraph} from './BranchGraph';
import {attemptReason,BranchStepEvidence,EvidenceText} from './BranchStepEvidence';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {DecisionCard} from '../decisions/DecisionCard';
import type {DecisionPrompt} from '../../decisions';
import {ChatMessageBody} from '../chat/ChatMessages';
import {currentFailedInvocations,nodeName} from './model';
import {SemanticStatus} from '../SemanticStatus';
import {branchExecutionStatus} from './branchRunStatus';
import {branchStepStatus,controlStates,currentExecutionActions,mapItemStatus,shouldPollOperations} from './executionPresentation';
// A valid same-Run actions page may arrive before matching execution details.
class RunActionsRevisionPending extends Error {}
function Gate({gate,label,onChanged,disabled=false,refreshing=false}:{gate:BranchGateDto;label:string;onChanged():void;disabled?:boolean;refreshing?:boolean}):JSX.Element{
 const [text,setText]=useState(gate.proposal),[choice,setChoice]=useState(gate.choices?.[0]??''),[key,setKey]=useState(()=>createClientId());
 const choiceLabel=useId(),choices=gate.choices??[];
 const changeChoice=(value:string)=>{setChoice(value);setKey(createClientId())};
 const resolve=useMutation({mutationFn:(decision:BranchGateResolution['decision'])=>requestJson(`/api/branch-gates/${gate.id}/resolve`,{method:'POST',body:JSON.stringify({commandKey:key,expectedRevision:gate.revision,decision,...(decision==='approve'?(gate.choices?.length?{choice}:gate.editable?{output:text}:{}):{})} satisfies BranchGateResolution)}),onSuccess:onChanged});
 const choicePending=disabled||resolve.isPending||resolve.isSuccess;
 const editable=!choices.length&&gate.editable&&gate.purpose==='approval';
 return <Paper component="section" aria-labelledby={choiceLabel+'-step'} variant="outlined" sx={{p:{xs:1.25,sm:2},borderColor:'warning.main',minWidth:0}}>
  <Stack spacing={1}>
   <Typography id={choiceLabel+'-step'} component="h2" fontWeight={650}>{label}</Typography>
   {(refreshing||gate.purpose==='recovery')&&<Typography role="status" variant="body2">{refreshing?'Refreshing Review…':'A Failed Step Needs Your Decision'}</Typography>}
   <Typography component="div" role="region" aria-label="Review prompt" tabIndex={0}
    sx={{maxHeight:{xs:'4.5rem',sm:'none'},overflowY:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>
    {gate.prompt}
   </Typography>
   {choices.length===1?<Typography variant="body2">If approved · {choice}</Typography>:choices.length>1&&(
    choices.length<=3?<FormControl disabled={choicePending}>
     <FormLabel id={choiceLabel}>If approved</FormLabel>
     <RadioGroup row aria-labelledby={choiceLabel} value={choice} onChange={(_,value)=>changeChoice(value)}>
      {choices.map(option=><FormControlLabel value={option} key={option} control={<Radio size="small"/>} label={option}/>)}
     </RadioGroup>
    </FormControl>:<TextField select label="If approved" disabled={choicePending} value={choice} onChange={e=>changeChoice(e.target.value)}>{choices.map(option=><MenuItem value={option} key={option}>{option}</MenuItem>)}</TextField>
   )}
   {resolve.error&&<Alert severity="error">{/revision|stale|conflict/i.test(resolve.error.message)?'This decision changed while you were reviewing it. Refresh the execution and try again. ':''}{resolve.error.message}</Alert>}
   <Stack direction="row" gap={1} flexWrap="wrap">
    <Button variant="contained" disabled={choicePending} onClick={()=>resolve.mutate(gate.purpose==='recovery'?'retry':'approve')} sx={{minHeight:44}}>{resolve.isPending?'Saving Decision…':gate.purpose==='recovery'?'Retry Step':text!==gate.proposal?'Approve Edited Text':'Approve'}</Button>
    <Button color="error" disabled={choicePending} onClick={()=>resolve.mutate('reject')} sx={{minHeight:44}}>Reject</Button>
   </Stack>
   {(editable||gate.proposal.trim())&&<Box component="details" sx={{minWidth:0,overflowWrap:'anywhere'}}>
    <Typography component="summary" variant="body2" sx={{cursor:'pointer',minHeight:44,py:1.5}}>{editable?'If approved · Edit proposed result':choices.length||gate.purpose==='recovery'?'Supporting evidence':'If approved'}</Typography>
    {editable?<TextField fullWidth label="Proposed Result" disabled={choicePending} multiline minRows={3} maxRows={8} value={text} onChange={e=>{setText(e.target.value);setKey(createClientId())}}/>:
     <EvidenceText text={gate.proposal} markdownFallback/>}
   </Box>}
  </Stack>
 </Paper>;
}
type SavedResult = {available:false}|{available:true;sourceRunId:string;text:string;outputHash:string};
function SavedResultReview({execution,stepExecutionId,disabled,onChanged}:{execution:BranchExecutionDto;stepExecutionId:string;disabled:boolean;onChanged():void}):JSX.Element|null {
 const path=`/api/branch-executions/${execution.id}/steps/${stepExecutionId}/saved-result`;
 const candidate=useQuery({queryKey:['branch-saved-result',execution.id,execution.revision,stepExecutionId],queryFn:()=>requestJson<SavedResult>(path)});
 const [review,setReview]=useState(false);
 const [commandKey]=useState(createClientId);
 const recover=useMutation({mutationFn:(disposition:'completed'|'blocked')=>{
  const saved=candidate.data;
  if(!saved?.available)throw Error('The saved result is unavailable.');
  return requestJson(path,{method:'POST',body:JSON.stringify({commandKey,expectedRevision:execution.revision,
   sourceRunId:saved.sourceRunId,outputHash:saved.outputHash,disposition})});
 },onSuccess:()=>{setReview(false);onChanged()}});
 const saved=candidate.data;
 if(!saved?.available)return null;
 return <>
  <Button disabled={disabled} onClick={()=>setReview(true)}>Review saved result</Button>
  <Dialog open={review} onClose={()=>{if(!recover.isPending)setReview(false)}} fullWidth maxWidth="sm">
   <DialogTitle>Use the result from the finished step</DialogTitle>
   <DialogContent>
    <Typography>The Agent finished and saved this response. You can keep it as the step result or record that the step was blocked.</Typography>
    <Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:300,overflow:'auto'}}>{saved.text}</Typography>
    {recover.error&&<Alert severity="error">{recover.error.message}</Alert>}
   </DialogContent>
   <DialogActions>
    <Button disabled={recover.isPending} onClick={()=>setReview(false)}>Close</Button>
    <Button disabled={disabled||recover.isPending} onClick={()=>recover.mutate('blocked')}>Record as blocked</Button>
    <Button variant="contained" disabled={disabled||recover.isPending} onClick={()=>recover.mutate('completed')}>Use saved result</Button>
   </DialogActions>
  </Dialog>
 </>;
}
/** Presentation-only state retained while the Branch workspace stays open. */
export interface ExecutionPanelViewState {
 selected:string;
 itemSearch:string;
 itemFilter:string;
 itemSort:string;
 itemLimit:number;
 callsExpanded:boolean;
 technicalOpen?:boolean;
 inspectedStep?:BranchStepExecutionDto;
 summaryStepId?:string;
}
export function ExecutionPanel({detail,definition,viewStates,onBudgetSettings,evidenceControls,runLinks,onRerun,rerunDisabled,onMoreResults,loadingMoreResults,authorityFresh=true}:{detail:BranchExecutionDetailDto;definition?:BranchDefinition;authorityFresh?:boolean;viewStates:Map<string,ExecutionPanelViewState>;onBudgetSettings?(branchId?:string):void;evidenceControls?:ReactNode;runLinks?:ReactNode;onRerun?(execution:BranchExecutionDto,input:string):void;rerunDisabled?:boolean;onMoreResults?():void;loadingMoreResults?:boolean}):JSX.Element{
 const client=useQueryClient(),execution=detail.execution;
 // Presentation retention only. The shared Decision response owner reports
 // active/unconfirmed forms; it remains the sole authority for response recovery.
 const [retainedDecisionForms,setRetainedDecisionForms]=useState(()=>new Map<string,DecisionPrompt>());
 const retainDecisionForm=useCallback((decision:DecisionPrompt,retain:boolean)=>setRetainedDecisionForms(previous=>{
  if(retain&&previous.get(decision.id)===decision||!retain&&!previous.has(decision.id))return previous;
  const next=new Map(previous);if(retain)next.set(decision.id,decision);else next.delete(decision.id);return next;
 }),[]);
 const savedView=useRef(viewStates.get(execution.id)).current;
 const firstFailed=currentFailedInvocations(detail)[0];
 const [technicalOpen,setTechnicalOpen]=useState(savedView?.technicalOpen??false),[recoveryOpen,setRecoveryOpen]=useState(false);
 const [inspectedStep,setInspectedStep]=useState<BranchStepExecutionDto|undefined>(savedView?.inspectedStep?.executionId===execution.id?savedView.inspectedStep:undefined);
 const [selected,setSelected]=useState(savedView?.selected??firstFailed?.stepId??'');
 const [actionsAnchor,setActionsAnchor]=useState<HTMLElement|null>(null);
 const [showFullInput,setShowFullInput]=useState(false);
 const [summaryStepId,setSummaryStepId]=useState(savedView?.summaryStepId??'');
 const panel=useRef<HTMLDivElement>(null),tray=useRef<HTMLElement>(null);
 const stepOpener=useRef<HTMLElement>(),stepScroll=useRef<{element:HTMLElement;top:number}>();
 const stepDestination=useRef<string>();
 const focusStep=useRef(false);
 useLayoutEffect(()=>{
  if(summaryStepId){
   if(tray.current)tray.current.scrollTop=0;
   if(focusStep.current){
    tray.current?.scrollIntoView({block:'nearest'});
    tray.current?.focus({preventScroll:true});
   }
   focusStep.current=false;
   return;
  }
  const scroll=stepScroll.current;
  if(scroll)scroll.element.scrollTop=scroll.top;
  stepScroll.current=undefined;
  if(stepDestination.current){
   const destination=document.getElementById(stepDestination.current);
   destination?.focus({preventScroll:true});
   destination?.scrollIntoView({block:'start'});
   stepDestination.current=undefined;
  }else stepOpener.current?.focus({preventScroll:true});
  stepOpener.current=undefined;
 },[summaryStepId]);
 const [showAllResults,setShowAllResults]=useState(false);
 const [showAllSteps,setShowAllSteps]=useState(false);
 const [intervention,setIntervention]=useState<{action:ReviewIntervention['action'];attemptId?:string;occurrenceId?:string;injectionId?:string;snapshotRetry?:boolean;unknown?:boolean}>(),[updateApplied,setUpdateApplied]=useState<''|'applied'|'not_applied'>(''),[reason,setReason]=useState(''),[reconciled,setReconciled]=useState(false),[result,setResult]=useState(''),[failed,setFailed]=useState(false),[target,setTarget]=useState(''),[commandKey,setCommandKey]=useState(()=>createClientId());
 const [itemSearch,setItemSearch]=useState(savedView?.itemSearch??''),[itemFilter,setItemFilter]=useState(savedView?.itemFilter??'all'),[itemSort,setItemSort]=useState(savedView?.itemSort??'index'),[itemLimit,setItemLimit]=useState(savedView?.itemLimit??100),[gateSearch,setGateSearch]=useState(''),[itemEvidenceId,setItemEvidenceId]=useState('');
 const mergeTargets=useInfiniteQuery({queryKey:['branch-merge-targets',execution.branchId,execution.id],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>requestJson<BranchExecutionDto[]>('/api/branches/'+encodeURIComponent(execution.branchId)+'/executions?mergeFor='+encodeURIComponent(execution.id)+(pageParam?'&before='+encodeURIComponent(pageParam):'')),getNextPageParam:last=>last.length===100?last.at(-1)?.id:undefined,enabled:intervention?.action==='merge'});
 const executions=mergeTargets.data?.pages.flat()??[];
 const [callsExpanded,setCallsExpanded]=useState(savedView?.callsExpanded??detail.attempts.filter(attempt=>attempt.calledBranch||attempt.childExecutionId).length<=8);
 useLayoutEffect(()=>{
  viewStates.delete(execution.id);
  viewStates.set(execution.id,{selected,itemSearch,itemFilter,itemSort,itemLimit,callsExpanded,technicalOpen,inspectedStep,summaryStepId});
  if(viewStates.size>25)viewStates.delete(viewStates.keys().next().value!);
 },[viewStates,execution.id,selected,itemSearch,itemFilter,itemSort,itemLimit,callsExpanded,technicalOpen,inspectedStep,summaryStepId]);
 const bundleReference=/^branch-result-bundle:([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(execution.output??'');
 const bundleMatch=bundleReference?.[1]===execution.id?bundleReference:null;
 const operations=useQuery({queryKey:["branch-execution-operations",execution.id],queryFn:async()=>{const value=await requestJson<BranchOperationalSummaryDto>("/api/branch-executions/"+execution.id+"/operations");if(value.executionId!==execution.id)throw new Error("The operational status belongs to another run.");return value},structuralSharing:(saved,next)=>{
  const previous=saved as BranchOperationalSummaryDto|undefined,incoming=next as BranchOperationalSummaryDto;
  return previous&&(previous.revision>incoming.revision||
    previous.revision===incoming.revision&&previous.observedAt>incoming.observedAt)?previous:incoming;
 },refetchInterval:query=>shouldPollOperations(execution.state,query.state.data)?5000:false});
 const retryContext=useMutation({mutationFn:(wait:BranchOperationalSummaryDto['agentWaits'][number])=>{
  const activationId=wait.contextRetryActivationId!;
  const expectedHold=wait.contextRetryKey;
  const commandKey=`step-context:${wait.stepExecutionId}:${expectedHold??activationId}`;
  return requestJson(`/api/branch-executions/${execution.id}/steps/${wait.stepExecutionId}/retry-context`,{
   method:'POST',body:JSON.stringify({requestId:wait.requestId,activationId,expectedRevision:execution.revision,commandKey,expectedHold})
  });
 },onSettled:()=>operations.refetch()});
 const ongoing=['queued','running','waiting'].includes(execution.state);
 const op=operations.data?.revision===execution.revision?operations.data:undefined;
 useEffect(()=>{
  if(ongoing&&operations.data&&operations.data.revision!==execution.revision)
   void client.invalidateQueries({queryKey:['branch-execution-operations',execution.id],exact:true});
 },[client,ongoing,execution.id,execution.revision,operations.data?.revision]);
 const bundle=useQuery({queryKey:['branch-result-bundle',bundleMatch?.[1],bundleMatch?.[2]],queryFn:()=>requestJson<{content:string;contentHash:string}>(`/api/branch-executions/${bundleMatch![1]}/result-bundles/${bundleMatch![2]}`),enabled:Boolean(bundleMatch)});
 const summaryStep=detail.steps.find(step=>step.id===summaryStepId)??(inspectedStep?.id===summaryStepId?inspectedStep:undefined);
 const stepEvidence=useQuery({...stepEvidenceQuery(execution,summaryStepId),enabled:Boolean(summaryStep)});
 const itemEvidence=useQuery({queryKey:['branch-map-item-evidence',execution.id,itemEvidenceId],queryFn:()=>requestJson<BranchMapItemDto>(`/api/branch-executions/${execution.id}/map-items/${encodeURIComponent(itemEvidenceId)}/evidence`),enabled:Boolean(itemEvidenceId)});
 const searchTooLong=itemSearch.trim().length>100;
 const searchedItems=useInfiniteQuery({queryKey:['branch-map-item-search',execution.id,itemSearch.trim()],initialPageParam:0,queryFn:({pageParam})=>requestJson<{items:BranchMapItemDto[];more:boolean}>(`/api/branch-executions/${execution.id}/map-items/search?q=${encodeURIComponent(itemSearch.trim())}&offset=${pageParam}`),getNextPageParam:(last,pages)=>last.more?pages.length*100:undefined,enabled:technicalOpen&&itemSearch.trim().length>0&&!searchTooLong});
 const searchResults=searchedItems.error?undefined:searchedItems.data?.pages.flatMap(page=>page.items);
 const itemStepEvidence=useQuery({queryKey:['branch-map-item-step',execution.id,itemEvidence.data?.stepExecutionId],queryFn:()=>requestJson<BranchStepEvidenceDto>(`/api/branch-executions/${execution.id}/steps/${itemEvidence.data!.stepExecutionId}/evidence`),enabled:Boolean(itemEvidenceId&&itemEvidence.data?.stepExecutionId)});
 const selectedItemStatus=itemEvidence.data?mapItemStatus(itemEvidence.data,itemStepEvidence.data?.attempts??detail.attempts.filter(a=>a.stepExecutionId===itemEvidence.data?.stepExecutionId)):'';
 const readFullOutput=Boolean(detail.executionOutputTruncated&&!bundleMatch&&!detail.publishedResult&&!detail.executionOutputTechnical&&execution.state!=='failed');
 const fullOutput=useQuery({queryKey:['branch-execution-output',execution.id],queryFn:async()=>{
  const requestedRevision=execution.revision;
  return {...await requestJson<{output:string|null}>(`/api/branch-executions/${execution.id}/result`),requestedRevision};
 },enabled:readFullOutput});
 // Keep this Run's cached text mounted through refreshes and errors.
 // The query owns which revision it last requested.
 useEffect(()=>{
  if(readFullOutput&&fullOutput.data&&fullOutput.data.requestedRevision!==execution.revision)
   void client.invalidateQueries({queryKey:['branch-execution-output',execution.id],exact:true});
 },[client,execution.id,execution.revision,readFullOutput,fullOutput.data?.requestedRevision]);
 const fullInput=useQuery({queryKey:['branch-execution-input',execution.id],queryFn:()=>requestJson<{input:string}>(`/api/branch-executions/${execution.id}/input`),enabled:Boolean(detail.executionInputTruncated&&(technicalOpen&&showFullInput||onRerun&&execution.state==='canceled'))});
 const actionsKey=['branch-execution-actions',execution.id];
 const actions=useInfiniteQuery({queryKey:actionsKey,initialPageParam:undefined as string|undefined,queryFn:async({pageParam})=>{
  const page=await requestJson<BranchExecutionActionsDto>('/api/branch-executions/'+execution.id+'/actions'+(pageParam?'?cursor='+encodeURIComponent(pageParam):''));
  if(!page||page.executionId!==execution.id||!Number.isSafeInteger(page.revision)||page.revision<0||typeof page.generation!=='string'||!page.generation||!Array.isArray(page.items))throw new Error('This run changed or returned invalid actions. Refresh its details to load current decisions and failures.');
  // Reject malformed action items before treating revision drift as synchronization.
  currentExecutionActions({id:execution.id,revision:page.revision},[page]);
  if(page.revision!==execution.revision)throw new RunActionsRevisionPending('This run changed; its details are refreshing.');
  return page;
 },getNextPageParam:last=>last.nextCursor,retry:false,refetchInterval:5000});
 const actionsRevisionPending=actions.error instanceof RunActionsRevisionPending;
 const currentActions=currentExecutionActions(execution,actions.data?.pages);
 // Keep same-ID Decision forms mounted while this Run refreshes. Their response
 // owner validates Decisions independently; Branch interventions still require
 // the current Run revision. React Query retains coherent pages during refetch.
 const actionItems=currentActions??currentExecutionActions({id:execution.id,revision:actions.data?.pages[0]?.revision??execution.revision},actions.data?.pages);
 const actionsCurrent=!execution.runtimeData&&!execution.stopping&&authorityFresh&&Boolean(currentActions)&&!actions.error;
 const resolvedGateIds=new Set(authorityFresh?detail.gates.filter(gate=>gate.state==='resolved').map(gate=>gate.id):[]);
 const waitingGates=actionItems?.filter(item=>item.kind==='gate').filter(item=>!resolvedGateIds.has(item.gate.id))??[];
 const approvalSteps=new Set(waitingGates.map(({step})=>step.id));
 const approvalHeadline=ongoing&&!execution.stopping&&waitingGates.length>0&&
  (op?.state==='waiting_human'?op.counts.waitingHuman<=waitingGates.length:!op&&execution.state==='waiting'&&Boolean(detail.waits?.length)&&detail.waits!.every(wait=>wait.kind==='approval'&&wait.stepExecutionId&&approvalSteps.has(wait.stepExecutionId)));
 const otherReviews=(op?.counts.waitingHuman??0)-waitingGates.length;
 const progress=op?[
  op.counts.mapItems&&`${op.counts.mapSettled} of ${op.counts.mapItems} For Each items settled`,
  op.counts.completed&&`${op.counts.completed} ${op.counts.completed===1?'step':'steps'} completed`,
  op.counts.running&&`${op.counts.running} running`,
  op.counts.retrying&&`${op.counts.retrying} retrying`,
  actionsCurrent&&otherReviews>0&&`${otherReviews} waiting for review`,
 ].filter(Boolean):[];
 useEffect(()=>{if(actions.data?.pages[0]&&actions.data.pages[0].revision!==execution.revision)void client.invalidateQueries({queryKey:actionsKey,exact:true})},[client,execution.id,execution.revision]);
 const pendingDecisions=Array.from(new Map<string,DecisionPrompt>([...retainedDecisionForms,...(actionItems?.filter(item=>item.kind==='decision').map(item=>[item.decision.id,item.decision] as const)??[])]).values());
 const guidanceReviews=actionItems?.filter(item=>item.kind==='guidance_review')??[];
 const scheduleUpdates=actionItems?.filter(item=>item.kind==='schedule_update')??[];
 const stopping=execution.stopping;
 const manualWait=op&&['provider_attention','waiting_human','needs_reconciliation'].includes(op.state)
  || detail.waits?.some(wait=>['approval','reconciliation','disabled_branch'].includes(wait.kind));
 const fallback=branchExecutionStatus(execution);
 const headline=execution.runtimeData?{status:'waiting' as const,label:'Imported Runtime Data Held'}
  :stopping||!ongoing?fallback
  :execution.budgetWait?{status:'waiting' as const,label:'Waiting For Budget'}
  :op?.state==='blocked'&&op.agentWaits.some(wait=>wait.state==='context_blocked')?{status:'needs_attention' as const,label:'Blocked'}
  :manualWait?{status:'needs_attention' as const,label:'Needs Attention'}
  :op?.agentWaits.some(wait=>wait.state==='context_recovering')?{status:'waiting' as const,label:'Waiting'}
  :fallback.status==='needs_attention'?fallback
  :op?branchExecutionStatus({...execution,effectiveStatus:op.state==='queued'?'queued':op.counts.running?'running':'waiting'})
  :fallback;
 const explanation=!ongoing||stopping||execution.runtimeData||execution.budgetWait?undefined
  :op?.label??(operations.isPending||operations.data&&!op?'Loading Run Status…':undefined);
 // An accepted Stop/Skip is final: the server refuses step decisions while it drains.
 const attentionAttempts=stopping?[]:actionItems?.filter(item=>item.kind==='attempt')??[];
 const refresh=()=>{void client.invalidateQueries({queryKey:actionsKey,exact:true});void client.invalidateQueries({queryKey:['branch-execution-operations',execution.id]});void client.invalidateQueries({queryKey:['branch-execution',execution.id]});void client.invalidateQueries({queryKey:['branch-executions',execution.branchId]});void client.invalidateQueries({queryKey:['branch-lifecycle-summary',execution.branchId]});void client.invalidateQueries({queryKey:['branches']})};
 const cancel=useMutation({mutationFn:()=>requestJson(`/api/branch-executions/${execution.id}/cancel`,{method:'POST'}),onSuccess:refresh});
 const act=useMutation({mutationFn:(intent:ReviewIntervention)=>requestJson('/api/branch-executions/'+execution.id+'/intervene',{method:'POST',body:JSON.stringify(intent)}),onSuccess:()=>{setIntervention(undefined);refresh()}});
 const interventionUnconfirmed=act.isError&&!(act.error instanceof ApiRequestError&&act.error.status>=400&&act.error.status<500);
 const interventionLocked=!!execution.runtimeData||act.isPending||interventionUnconfirmed;
 const submitIntervention=()=>{
  if(execution.runtimeData||!intervention||act.isPending||(!interventionUnconfirmed&&!actionsCurrent))return;
  const intent:ReviewIntervention=interventionUnconfirmed?act.variables!:{commandKey,expectedRevision:execution.revision,action:intervention.action,reason:intervention.action==='skip'?'Skipped by user':reason,...(intervention.attemptId?{attemptId:intervention.attemptId}:{}),...((intervention.unknown||intervention.action==='resolve_schedule_update'||intervention.action==='resolve_guidance')?{externalEffectsReconciled:reconciled}:{}),...(intervention.action==='resolve_schedule_update'?{occurrenceId:intervention.occurrenceId,updateApplied:updateApplied==='applied'}:{}),...(intervention.action==='resolve_guidance'?{injectionId:intervention.injectionId,updateApplied:updateApplied==='applied'}:{}),...(intervention.action==='resolve_script'?{result:{failed,output:result}}:{}),...(intervention.action==='merge'?{mergedInto:target}:{})};
  return act.mutateAsync(intent);
 };
 const open=(value:NonNullable<typeof intervention>)=>{
  if(act.isPending)return;
  if(interventionUnconfirmed&&act.variables){setIntervention({action:act.variables.action,...(act.variables.attemptId?{attemptId:act.variables.attemptId}:{}),...(act.variables.occurrenceId?{occurrenceId:act.variables.occurrenceId}:{}),...(act.variables.injectionId?{injectionId:act.variables.injectionId}:{}),...(act.variables.action!=='resolve_schedule_update'&&act.variables.action!=='resolve_guidance'&&act.variables.externalEffectsReconciled!==undefined?{unknown:true}:{})});return}
  setIntervention(value);setUpdateApplied('');setReason('');setReconciled(false);setResult('');setFailed(false);setTarget('');setCommandKey(createClientId());act.reset();
 };

 const calls=detail.attempts.filter(a=>a.calledBranch||a.childExecutionId);
 const graphControlStates=controlStates(detail);
 const selectedControl=definition?.controls.find(control=>control.id===selected);
 const selectedDecisions=detail.decisions?.filter(decision=>decision.nodeId===selected)??[];
 const agentWaits=ongoing&&!stopping&&!execution.runtimeData?op?.agentWaits??[]:[];
 const waits:BranchWaitDto[]=ongoing&&!stopping&&!execution.runtimeData?[...(detail.waits??[])]:[];
 for(const agent of agentWaits){
  if(!waits.some(wait=>wait.requestId===agent.requestId))
   waits.push({kind:'agent',requestId:agent.requestId,stepId:agent.stepId,stepExecutionId:agent.stepExecutionId,message:agent.label});
 }
 const stepLabel=(id:string)=>{const node=definition?.steps.find(step=>step.id===id);return node?nodeName(node):id;};
 const providerSettings=branchRoutePath({branchId:execution.branchId,tab:'executions',executionId:execution.id,global:'providers'});
 const stepStatus=(step:BranchStepExecutionDto)=>{
  const wait=waits.find(item=>item.stepExecutionId===step.id);
  return branchStepStatus(step,agentWaits.find(item=>item.stepExecutionId===step.id),
   wait?.kind==='approval'||wait?.kind==='reconciliation'||wait?.kind==='disabled_branch',Boolean(wait));
 };
 const openStep=(step:BranchStepExecutionDto,opener?:HTMLElement)=>{
  if(step.executionId!==execution.id)return;
  const scroller=panel.current?.closest<HTMLElement>('[aria-label="Selected Run"]');
  if(scroller&&!summaryStep)stepScroll.current={element:scroller,top:scroller.scrollTop};
  stepOpener.current=opener;
  setInspectedStep(step);
  setSelected(step.stepId);
  if(summaryStepId===step.id)tray.current?.focus({preventScroll:true});
  else {focusStep.current=true;setSummaryStepId(step.id);}
 };
 const resultHref=(digest:string)=>productApiPath(`/api/branches/${encodeURIComponent(execution.branchId)}/results/${encodeURIComponent(digest)}`);
 const publications=new Map<string,NonNullable<BranchExecutionDetailDto['publishedResult']>>();
 if(detail.publishedResult)publications.set(detail.publishedResult.sha256,detail.publishedResult);
 const files=new Map<string,{label:string;href:string}>();
 const ordinaryResult=Boolean(execution.output?.trim())&&!detail.publishedResult&&!detail.executionOutputTechnical&&execution.state!=='failed';
 const resultTarget=(step:BranchStepExecutionDto)=>{
  if(step.state!=='completed'||step.result?.failed!==false)return undefined;
  if(step.publishedResult)return `branch-result-file-${step.publishedResult.sha256}`;
  if(!step.result.output?.trim()||step.resultOutputTechnical)return undefined;
  if(ordinaryResult&&(step.resultInRun||!detail.executionOutputTruncated&&!step.resultOutputTruncated&&step.result.output===execution.output))return 'branch-run-output';
  return `branch-result-${step.id}`;
 };
 const resultSteps=detail.steps.filter(step=>{
  if(step.state!=='completed'||step.result?.failed!==false)return false;
  if(step.publishedResult)publications.set(step.publishedResult.sha256,step.publishedResult);
  for(const file of step.resultFiles??[])files.set(file.href,file);
  return resultTarget(step)===`branch-result-${step.id}`;
 });
 const openResult=(target:string)=>{
  setShowAllResults(true);
  if(summaryStep){
   stepDestination.current=target;
   setSummaryStepId('');
  }else requestAnimationFrame(()=>{
   const result=document.getElementById(target);
   result?.focus({preventScroll:true});result?.scrollIntoView({block:'start'});
  });
 };
 const sideBySide='@container branch-runs (min-width: 60rem)';
 const recordedReason=execution.state==='failed'||execution.state==='canceled'
  ? execution.waitReason || (execution.state==='failed'&&!detail.executionOutputTechnical?execution.output:undefined)
    || attemptReason(detail.attempts.find(attempt=>attempt.state===execution.state&&attempt.error))
  :undefined;
 const recordedApproval=detail.gates.findLast(gate=>gate.purpose==='approval'&&gate.state==='resolved'&&gate.resolution);
 const recordedApprovalStep=recordedApproval&&detail.steps.find(step=>step.id===recordedApproval.stepExecutionId);
 const selectedResource=summaryStep&&detail.resources?.find(resource=>resource.stepExecutionId===summaryStep.id);
 const technicalOutput=Boolean(detail.executionOutputTechnical||detail.steps.some(step=>step.resultOutputTechnical||step.publishedResult)||detail.attempts.some(attempt=>attempt.scriptEvidence));
 const primaryBlock=agentWaits.find(wait=>wait.state==='context_blocked'||wait.state==='context_uncertain');
 const canManageRun=ongoing&&!stopping&&!execution.runtimeData;
 const hasResults=Boolean(publications.size||files.size||ordinaryResult||resultSteps.length);
 const leadingWait=primaryBlock&&waits.find(wait=>wait.requestId===primaryBlock.requestId);
 const waitRows=(leadingWait?[leadingWait,...waits.filter(wait=>wait!==leadingWait)]:waits).map(wait=>{
  const operational=wait.requestId?agentWaits.find(item=>item.requestId===wait.requestId):undefined;
  if(operational?.state==='agent_running'||wait.kind==='approval'&&wait.stepExecutionId&&approvalSteps.has(wait.stepExecutionId))return null;
  const manual=operational&&['provider_attention','waiting_human','needs_reconciliation'].includes(operational.state)
   || ['approval','reconciliation','disabled_branch'].includes(wait.kind);
  const held=operational?.state==='context_blocked'||operational?.state==='context_uncertain';
  const checking=retryContext.isPending&&retryContext.variables?.requestId===operational?.requestId;
  const retryAt=held||operational?.state==='context_recovering'?undefined:operational?.nextRetryAt??wait.availableAt;
  return <Alert key={wait.requestId??wait.stepExecutionId??wait.message} severity={manual||held?'warning':'info'}>
   {primaryBlock&&operational===primaryBlock?<SemanticStatus status="needs_attention" label={`Blocked · ${stepLabel(operational.stepId)}`}/>:
    <Typography fontWeight={600}>{operational&&wait.stepId?`${stepLabel(wait.stepId)} · ${operational.label}`:wait.message}</Typography>}
   {(operational?.reason??wait.reason??(primaryBlock&&operational===primaryBlock?wait.message:undefined))&&<Typography variant="body2">{operational?.reason??wait.reason??wait.message}</Typography>}
   {retryAt?<Typography variant="body2">Retry eligible {new Date(retryAt).toLocaleString()}.</Typography>
    :operational?.state==='retry_pending'&&operational.label!=='Retry scheduled'&&<Typography variant="body2">An automatic retry is pending.</Typography>}
   {!manual&&!held&&<Typography variant="body2">No action needed.</Typography>}
   {operational?.state==='context_blocked'&&!operational.contextRetryActivationId&&
    <SavedResultReview execution={execution} stepExecutionId={operational.stepExecutionId} disabled={!authorityFresh} onChanged={refresh}/>}
   {held&&operational?.contextRetryActivationId&&<Button disabled={!authorityFresh||retryContext.isPending} variant={operational===primaryBlock?"contained":undefined} size="small" sx={{mt:0.75}} onClick={()=>retryContext.mutate(operational)}>{checking?'Checking session…':'Retry step'}</Button>}
   {held&&retryContext.error&&retryContext.variables?.requestId===operational?.requestId&&<Typography color="error">{retryContext.error.message}</Typography>}
   {held&&!operational?.contextRetryActivationId&&detail.steps.some(item=>item.id===operational?.stepExecutionId)&&<Button onClick={event=>{const step=detail.steps.find(item=>item.id===operational?.stepExecutionId);if(step)openStep(step,event.currentTarget)}}>Inspect step evidence</Button>}
   {operational?.state==='provider_attention'&&<Button href={providerSettings}>Open Provider Settings</Button>}
   {wait.executionId?<Button href={branchRoutePath({tab:'executions',executionId:wait.executionId})}>Open Blocking Execution</Button>
    :wait.branchId?<Button href={branchRoutePath({branchId:wait.branchId,tab:'workflow'})}>{'Open Workflow'}</Button>:null}
  </Alert>;
 }).filter(Boolean);
 return <Box ref={panel} sx={{display:'grid',minWidth:0,gap:2,gridTemplateColumns:'minmax(0,1fr)',
   ...(summaryStep?{[sideBySide]:{gridTemplateColumns:'minmax(0,1fr) minmax(16rem,44%)'}}:{})}}>
 <Stack spacing={2} sx={{minWidth:0,...(summaryStep?{display:'none',[sideBySide]:{display:'flex'}}:{})}}>
  {execution.runtimeData&&<BranchRuntimeOwnerReadback key={`${execution.id}:${execution.runtimeData.manifestSha256}`} planId={execution.runtimeData.planId} branchId={execution.branchId} executionId={execution.id} sourceExecutionId={execution.runtimeData.sourceExecutionId} manifestSha256={execution.runtimeData.manifestSha256}/>}
  {(waitingGates.length>1||Boolean(gateSearch))&&<TextField size="small" label="Find Waiting Decision" value={gateSearch} onChange={event=>setGateSearch(event.target.value)} sx={{maxWidth:340}}/>}
  {waitingGates.filter(item=>!gateSearch.trim()||(item.gate.prompt+' '+stepLabel(item.step.stepId)).toLowerCase().includes(gateSearch.trim().toLowerCase())).map(({gate,step})=><Gate key={gate.id+':'+gate.revision} gate={gate} disabled={!actionsCurrent} refreshing={!actionsCurrent} label={stepLabel(step.stepId)} onChanged={refresh}/>)}
  <Stack spacing={1}>
   <Typography variant="body2" color="text.secondary">{new Date(execution.admittedAt??execution.createdAt).toLocaleString()} · {execution.runtimeData?'Imported held data':execution.admissionSource==='automatic'?'Triggered':execution.admissionSource==='call'?'Called by another workflow':'Manual'}</Typography>
   <Stack direction="row" gap={1} alignItems="center" justifyContent="space-between" flexWrap="wrap">
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" role="status">
     {!primaryBlock&&!approvalHeadline&&<SemanticStatus {...headline}/>}
     {!primaryBlock&&!approvalHeadline&&explanation&&explanation!==headline.label&&<Typography variant="body2" color="text.secondary">{explanation}</Typography>}
    </Stack>
    {canManageRun&&<>
     <Button size="small" aria-haspopup="menu" aria-expanded={Boolean(actionsAnchor)} onClick={event=>setActionsAnchor(event.currentTarget)}>Run actions</Button>
     <Menu anchorEl={actionsAnchor} open={Boolean(actionsAnchor)} onClose={()=>setActionsAnchor(null)} MenuListProps={{'aria-label':'Run actions'}}>
      <MenuItem disabled={cancel.isPending||!authorityFresh} onClick={()=>{setActionsAnchor(null);cancel.mutate()}}>Cancel Run</MenuItem>
      <MenuItem disabled={!actionsCurrent} onClick={()=>{setActionsAnchor(null);open({action:'skip'})}}>Skip Run</MenuItem>
      <MenuItem disabled={!actionsCurrent} onClick={()=>{setActionsAnchor(null);open({action:'merge'})}}>Merge Into Another Run</MenuItem>
     </Menu>
    </>}
    {execution.state==='canceled'&&onRerun&&!execution.runtimeData&&<Button size="small" disabled={rerunDisabled||!authorityFresh||Boolean(detail.executionInputTruncated&&!fullInput.data)}
     onClick={()=>onRerun(execution,fullInput.data?.input??execution.input)}>Run again with edited input</Button>}
   </Stack>
   {recordedApproval?.resolution&&<Typography variant="body2">
    {recordedApprovalStep&&`${stepLabel(recordedApprovalStep.stepId)} · `}{recordedApproval.resolution.decision==='reject'?'Rejected':recordedApproval.resolution.choice?`Approved · ${recordedApproval.resolution.choice}`:'Approved'}
   </Typography>}
   {recordedReason&&<Typography variant="body2" sx={{overflowWrap:'anywhere'}}>{notificationPreviewText(recordedReason)}</Typography>}
   {execution.state==='canceled'&&detail.executionInputTruncated&&fullInput.error&&<Alert severity="warning" action={<Button onClick={()=>void fullInput.refetch()}>Retry</Button>}>Previous input could not be loaded.</Alert>}
   {cancel.isPending&&<Typography role="status">Requesting stop…</Typography>}
   {stopping?<Alert severity={stopping.blocked?'warning':'info'}>{stopping.blocked??`${stopping.outcome==='skipped'?'Skip':stopping.outcome==='merged'?'Merge':'Stop'} accepted. Waiting for this Run's provider work to finish stopping; it will show as ${stopping.outcome==='skipped'?'Skipped':stopping.outcome==='merged'?'Merged':'Canceled'} automatically.`}</Alert>
    :waitRows.length>0?<Stack spacing={1}>{waitRows}</Stack>:ongoing&&!approvalHeadline&&execution.waitReason&&headline.status!=='running'&&<Alert severity="info">{execution.waitReason}</Alert>}
   {!execution.runtimeData&&op&&<>{progress.length>0&&<Typography variant="body2" color="text.secondary">{progress.join(' · ')}</Typography>}{op.additionalAgentWaits>0&&<Typography variant="caption">{op.additionalAgentWaits} more Agent waits are recorded in the run evidence.</Typography>}{op.state==='provider_attention'&&!waits.some(wait=>agentWaits.some(agent=>agent.requestId===wait.requestId&&agent.state==='provider_attention'))&&<Button sx={{alignSelf:'start'}} href={providerSettings}>Open Provider Settings</Button>}</>}
   {operations.error&&<Alert severity="warning" action={<Button onClick={()=>void operations.refetch()}>Retry Status</Button>}>Run status could not refresh. {operations.error.message}</Alert>}
   {cancel.error&&<Alert severity="error">{cancel.error.message}</Alert>}
  </Stack>
  {interventionUnconfirmed&&!intervention&&act.variables&&<Alert severity="warning" action={<Button onClick={()=>open({action:act.variables!.action})}>Reconcile Decision Submission</Button>}>Decision unconfirmed · reopen exact submission before another decision</Alert>}
  {execution.parentExecutionId&&<Button sx={{alignSelf:'start'}} href={branchRoutePath({tab:'executions',executionId:execution.parentExecutionId})}>Open Parent Run</Button>}

  {execution.checkpointInvocation?.durability === 'failed' && <Alert severity="warning">Saving the Run checkpoint failed. The scheduler will retry the save. Check local storage if the failure persists.</Alert>}
  {(execution.budgetWait||detail.waits?.some(wait=>wait.kind==='execution_budget'))&&<Alert severity="warning" action={onBudgetSettings?<Button onClick={()=>onBudgetSettings(execution.budgetWait?.branchId??detail.waits?.find(wait=>wait.kind==='execution_budget')?.branchId)}>Budget Settings</Button>:undefined}>Waiting for automatic execution budget · manual runs exempt</Alert>}
  {execution.budgetExhausted&&<Alert severity={execution.state==='failed'?'error':'warning'}><Typography fontWeight={650}>Workflow Traversal Limit Reached</Typography><Typography>{detail.decisions?.find(decision=>decision.kind==='limit_exhausted')?.message??'Inspect the run decisions and completed Steps before restarting any work.'}</Typography></Alert>}
  {actions.error&&!actionsRevisionPending&&<Alert severity="warning" action={<Button onClick={refresh}>Refresh Run</Button>}>Decisions and failures could not refresh. {actions.error.message}</Alert>}
  {!execution.runtimeData&&(actionsRevisionPending||actionItems&&!actionsCurrent&&!actions.error)&&<Stack direction="row" alignItems="center" gap={1} flexWrap="wrap"><Typography role="status" color="text.secondary">Refreshing Run actions · open decisions are kept</Typography>{actionsRevisionPending&&<Button onClick={refresh}>Refresh Run</Button>}</Stack>}
  {!execution.runtimeData&&!actionItems&&!actions.error&&<Typography role="status" color="text.secondary">Loading current decisions and failures…</Typography>}
  {guidanceReviews.map(update=><Paper key={update.attemptId+':'+update.injectionId} variant="outlined" sx={{p:2,borderColor:'warning.main'}}><Stack spacing={1}><Typography fontWeight={650}>Guidance Delivery Needs Review</Typography><Typography>Inspect Agent work and external effects; delivery is unconfirmed and no separate Agent result is expected.</Typography><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Attempt {update.attemptId} · injection {update.injectionId}</Typography><Button sx={{alignSelf:'start'}} disabled={!actionsCurrent} onClick={()=>open({action:'resolve_guidance',attemptId:update.attemptId,injectionId:update.injectionId})}>Review Guidance Delivery</Button></Stack></Paper>)}
  {scheduleUpdates.map(update=><Paper key={update.occurrenceId+':'+update.injectionId} variant="outlined" sx={{p:2,borderColor:'warning.main'}}><Stack spacing={1}><Typography fontWeight={650}>Scheduled Update Needs Reconciliation</Typography><Typography>Scheduled delivery uncertain · inspect Agent work + external effects before reconciliation</Typography><Typography variant="caption" color="text.secondary">{update.eventCount} scheduled event{update.eventCount===1?'':'s'} · Latest: {new Date(update.lastScheduledAt).toLocaleString()}</Typography><Button sx={{alignSelf:'start'}} disabled={!actionsCurrent} onClick={()=>open({action:'resolve_schedule_update',occurrenceId:update.occurrenceId})}>Reconcile Scheduled Update</Button></Stack></Paper>)}
  {!execution.runtimeData&&pendingDecisions.map(decision=><DecisionCard key={decision.id} decision={decision} onRetentionChange={retainDecisionForm} onResolved={()=>{retainDecisionForm(decision,false);refresh()}}/>)}

  {attentionAttempts.map(({attempt,step,current})=>{const node=definition?.steps.find(node=>node.id===step.stepId),unknown=attempt.state==='outcome_unknown'||attempt.requestOutcomeUnknown,snapshotRetry=attempt.state==='prepared'&&!unknown&&(attempt as typeof attempt&{snapshotRetryAvailable?:boolean}).snapshotRetryAvailable===true;return <Paper key={attempt.id} variant="outlined" sx={{p:2,borderColor:unknown?'warning.main':'error.main'}}><Stack spacing={1}><Typography fontWeight={650}>{node?nodeName(node):step.stepId} · {unknown?'Outcome Needs Reconciliation':snapshotRetry?'Copy Preparation Needs Retry':current?'Step Failed':'Earlier Step Failure'}</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{attemptReason(attempt)||(step.resultOutputTechnical?undefined:step.result?.output)||(unknown?'The operation may already have changed files or external systems. Inspect and reconcile its effects before retrying.':'The Step did not complete successfully.')}</Typography>{attempt.retryBlockedReason&&<Typography variant="body2" color="text.secondary">{attempt.retryBlockedReason}</Typography>}{attempt.childExecutionId&&<Button sx={{alignSelf:'start'}} href={branchRoutePath({tab:'executions',executionId:attempt.childExecutionId})}>Open {attempt.calledBranch?.name??'Called Workflow'} Run</Button>}<Stack direction="row" gap={1} flexWrap="wrap"><Button onClick={event=>openStep(step,event.currentTarget)}>Inspect Details</Button>{current&&!attempt.retryBlockedReason&&(attempt.state!=='prepared'||snapshotRetry)&&<><Button disabled={!actionsCurrent} onClick={()=>open({action:'retry',attemptId:attempt.id,unknown,snapshotRetry})}>{snapshotRetry?'Retry Preparing Copy':unknown?'Retry Anyway':'Retry Step'}</Button>{node?.kind==='script'&&attempt.state==='outcome_unknown'&&<Button disabled={!actionsCurrent} onClick={()=>open({action:'resolve_script',attemptId:attempt.id,unknown:true})}>Mark Observed Result</Button>}</>}</Stack></Stack></Paper>})}
  {detail.resources?.filter(resource=>resource.error).map(resource=><Alert key={resource.stepExecutionId} id={`branch-resource-${resource.stepExecutionId}`} tabIndex={-1} severity="warning"
   action={<BranchResourceReview branchId={execution.branchId} executionId={execution.id} stepId={resource.stepExecutionId} enabled={authorityFresh&&!execution.runtimeData} onChanged={refresh}/>}>
    <Typography fontWeight={600}>{stepLabel(detail.steps.find(step=>step.id===resource.stepExecutionId)?.stepId??resource.templateRef)}</Typography>
    <Typography variant="body2">{resource.error}</Typography>
  </Alert>)}
  {actions.hasNextPage&&<Button sx={{alignSelf:'start'}} disabled={actions.isFetchingNextPage} onClick={()=>void actions.fetchNextPage({cancelRefetch:false})}>{actions.isFetchingNextPage?'Loading…':'Load More Decisions And Failures'}</Button>}
  {hasResults?<Paper component="section" aria-label="Results" variant="outlined" sx={{p:2,minWidth:0}}>
   <Stack spacing={1}>
    <Typography variant="h6">Results</Typography>
    {[...publications.values()].map(result=><Stack key={result.sha256} direction="row" gap={1} alignItems="center">
     <Button id={`branch-result-file-${result.sha256}`} size="small" href={resultHref(result.sha256)} download>{result.label}</Button>
     {result.reused&&<Chip size="small" label="Reused"/>}
    </Stack>)}
    {[...files.values()].map(file=><Button key={file.href} size="small" sx={{alignSelf:'start'}}
     href={productApiPath(file.href)} download>{file.label}</Button>)}
  {ordinaryResult&&<Box id="branch-run-output" tabIndex={-1} sx={{minWidth:0,overflowWrap:'anywhere'}}>{bundleMatch?<>
   {bundle.isPending&&!bundle.data&&<Typography role="status">Loading result…</Typography>}
   {bundle.error&&<Alert severity="error" action={<Button onClick={()=>void bundle.refetch()}>Retry Result</Button>}>The joined result could not be loaded. {bundle.error.message}</Alert>}
   {bundle.data&&<ChatMessageBody text={bundle.data.content} collapseLongMessage={false}/>}
  </>:<>
   {detail.executionOutputTruncated&&(fullOutput.isPending||fullOutput.isFetching)&&<Typography role="status">{fullOutput.data?'Updating result…':'Loading complete result…'}</Typography>}
   {detail.executionOutputTruncated&&fullOutput.error&&<Alert severity="error" action={<Button onClick={()=>void fullOutput.refetch()}>Retry Result</Button>}>{fullOutput.data?'Result could not refresh. Showing the last loaded text.':'The complete result could not be loaded; the preview is shown.'} {fullOutput.error.message}</Alert>}
   <EvidenceText text={detail.executionOutputTruncated&&fullOutput.data?fullOutput.data.output??'(Empty result)':execution.output||'(Empty result)'} markdownFallback/>
  </>}</Box>}


    {resultSteps.slice(0,showAllResults?undefined:5).map(step=><StepResult key={step.id} step={step} execution={execution} label={stepLabel(step.stepId)}/>)}
    {resultSteps.length>5&&<Button sx={{alignSelf:'start'}} onClick={()=>setShowAllResults(value=>!value)}>{showAllResults?'Show Fewer Step Outputs':'Show All Loaded Step Outputs'}</Button>}
   </Stack>
  </Paper>:technicalOutput?<Typography variant="body2" color="text.secondary">No readable result was produced. <Button size="small" href="#branch-run-steps" onClick={event=>{event.preventDefault();document.getElementById('branch-run-steps')?.focus()}}>See Steps</Button></Typography>:
    (primaryBlock||headline.label==='Blocked')&&<Typography variant="body2" color="text.secondary">No output yet.</Typography>}
  <Box id="branch-run-steps" tabIndex={-1} component="section" aria-label="Steps">
   <Typography variant="h6" mb={1}>Steps</Typography>
   <Stack component="ol" spacing={0} sx={{listStyle:'none',m:0,p:0}}>
    {(showAllSteps?detail.steps:detail.steps.slice(-5)).map(step=>{
     const target=resultTarget(step);
     const outcome=step.resultOutputTechnical&&!target?'Technical output':undefined;
     return <Box component="li" key={step.id} sx={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:{xs:0,sm:1},borderBottom:1,borderColor:'divider'}}>
      <ButtonBase onClick={event=>openStep(step,event.currentTarget)} aria-label={`Details for ${stepLabel(step.stepId)}`} aria-expanded={summaryStepId===step.id}
       sx={{display:'flex',flex:'1 0 min(100%, 11rem)',minWidth:0,gap:1,py:1.25,textAlign:'left',justifyContent:'space-between','&:focus-visible':{outline:'2px solid',outlineColor:'primary.main'}}}>
       <Box sx={{minWidth:0,overflowWrap:'anywhere'}}>
        <Typography fontWeight={600}>{stepLabel(step.stepId)}{step.invocation>1?` · Visit ${step.invocation}`:''}</Typography>
        {outcome&&<Typography variant="caption" color="text.secondary">{outcome}</Typography>}
       </Box>
       <SemanticStatus {...stepStatus(step)}/>
      </ButtonBase>
      {target&&<Button size="small" aria-label={`View result for ${stepLabel(step.stepId)}`} onClick={()=>openResult(target)}>View result</Button>}
     </Box>;
    })}
   </Stack>
   {!detail.steps.length&&<Typography color="text.secondary">No step activity has been recorded yet.</Typography>}
   {detail.steps.length>5&&<Button onClick={()=>setShowAllSteps(value=>!value)}>{showAllSteps?'Show Recent Steps':'Show All Loaded Steps'}</Button>}
   {onMoreResults&&<Button disabled={loadingMoreResults} onClick={onMoreResults}>{loadingMoreResults?'Loading older steps…':'Load older steps and outputs'}</Button>}
  </Box>

  {runLinks}
  <Box component="details" open={technicalOpen} onToggle={event=>setTechnicalOpen(event.currentTarget.open)} sx={{borderTop:1,borderColor:'divider',pt:1,'& > summary':{cursor:'pointer',minHeight:44,display:'flex',alignItems:'center',gap:1,'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main'}}}}>
   <Typography component="summary" color="text.secondary" fontWeight={600}>Technical Details<ExpandMoreIcon sx={{ml:'auto',transform:technicalOpen?'rotate(180deg)':undefined}}/></Typography>
   {technicalOpen&&<Stack spacing={2} sx={{pt:1,minWidth:0}}>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
     <Button size="small" onClick={()=>void copyText(execution.id)}>Copy Run ID</Button>
     <Button size="small" href={`/api/branch-executions/${execution.id}/full-detail`} target="_blank" rel="noopener noreferrer">Open Full Evidence (JSON)</Button>
     <Button size="small" aria-expanded={recoveryOpen} onClick={()=>setRecoveryOpen(value=>!value)}>Recovery options</Button>
    </Stack>
    {recoveryOpen&&<Stack direction="row" gap={1} flexWrap="wrap">
     <BranchHistoryReview branchId={execution.branchId} executionId={execution.id} enabled={authorityFresh&&!execution.runtimeData} onChanged={refresh}/>
     <BranchGroupReview detail={detail} definition={definition} enabled={authorityFresh&&!execution.runtimeData} onChanged={refresh}/>
     <BranchDisclosureReview branchId={execution.branchId} executionId={execution.id} enabled={authorityFresh&&!execution.runtimeData} onChanged={refresh} resourceStepIds={detail.resources?.map(resource=>resource.stepExecutionId)??[]}/>
    </Stack>}
    {evidenceControls}
    {ongoing&&<BranchLiveOutputs targets={detail.liveOutputs??[]} labels={Object.fromEntries((definition?.steps??[]).map(step=>[step.id,step.label??step.id]))}/>}
  {calls.length>0&&<Accordion disableGutters expanded={callsExpanded} onChange={(_,expanded)=>setCallsExpanded(expanded)}><AccordionSummary expandIcon={<ExpandMoreIcon/>}><Typography fontWeight={650}>Called Branches · {calls.length}{calls.length>8?` (${calls.filter(a=>a.childExecution?.state==='waiting').length} Waiting)`: ''}</Typography></AccordionSummary><AccordionDetails>{calls.map(a=>{const step=detail.steps.find(step=>step.id===a.stepExecutionId),item=detail.mapItems?.find(item=>item.pathId===step?.pathId);return <Stack key={a.id} direction="row" alignItems="center" gap={1} flexWrap="wrap"><Typography variant="body2">{definition?.steps.find(s=>s.id===step?.stepId)?.label??'Branch Call'}{item?` · For Each item ${item.index+1}: ${item.input.slice(0,80)}`:''} · Attempt {a.number}</Typography>{a.calledBranch&&<Button href={`/branches?branch=${a.calledBranch.id}`}>{a.calledBranch.name}</Button>}{a.childExecutionId?<Button href={`/branches?execution=${a.childExecutionId}`}>Child {a.childExecutionId.slice(0,8)} · {a.childExecution?.state??a.state}</Button>:<Typography>{a.calledBranch?.enabled===false?'Waiting for Branch to be enabled':a.state}</Typography>}</Stack>})}</AccordionDetails></Accordion>}
  {Boolean(detail.maps?.length)&&<Paper id="branch-map-items" variant="outlined" sx={{p:2}}><Typography variant="h6">For Each Items</Typography>
   <Stack direction={{xs:'column',sm:'row'}} spacing={1} mt={1} mb={1}><TextField size="small" label="Find Item Or Number" value={itemSearch} error={searchTooLong} helperText={searchTooLong?"Use 100 characters or fewer.":undefined} onChange={event=>{setItemSearch(event.target.value);setItemLimit(100)}}/><TextField size="small" select label="Show" value={itemFilter} onChange={event=>{setItemFilter(event.target.value);setItemLimit(100)}} sx={{minWidth:170}}><MenuItem value="all">All Items</MenuItem><MenuItem value="failed">Failed</MenuItem><MenuItem value="retrying">Retried</MenuItem><MenuItem value="waiting">Waiting</MenuItem><MenuItem value="outcome_unknown">Unknown Outcome</MenuItem></TextField><TextField size="small" select label="Sort Loaded Items" value={itemSort} onChange={event=>setItemSort(event.target.value)} sx={{minWidth:170}}><MenuItem value="index">Item Order</MenuItem><MenuItem value="attempts">Most Attempts</MenuItem><MenuItem value="duration">Longest Duration</MenuItem></TextField></Stack>
   {searchedItems.error&&itemSearch.trim()&&!searchTooLong&&<Alert severity="warning">Item search failed: {searchedItems.error.message}. Showing matches from loaded items only.</Alert>}
   {detail.maps?.map(map=>{const items=(detail.mapItems??[]).filter(item=>item.mapInvocationId===map.id).sort((a,b)=>a.index-b.index);
    const inspection=(item:BranchMapItemDto)=>{const step=item.stepExecutionId?detail.steps.find(s=>s.id===item.stepExecutionId):detail.steps.filter(s=>s.pathId===item.pathId).at(-1),attempts=step?detail.attempts.filter(a=>a.stepExecutionId===step.id):[],status=mapItemStatus(item,attempts);return {step,attempts,status}};
    const settled=items.filter(item=>['arrived','canceled','failed','completed'].includes(item.state)).length,failed=items.filter(item=>item.result?.failed||inspection(item).status==='failed').length,waiting=items.filter(item=>inspection(item).status==='waiting').length;
    const candidates=itemSearch.trim()&&searchResults?searchResults.filter(item=>item.mapInvocationId===map.id):items;const visible=candidates.filter(item=>{const info=inspection(item),query=itemSearch.trim().toLowerCase(),matchesText=!query||searchResults||(/^\d+$/u.test(query)?String(item.index+1)===query:item.input.toLowerCase().includes(query));return matchesText&&(itemFilter==='all'||itemFilter==='failed'&&(item.result?.failed||info.status==='failed')||itemFilter==='retrying'&&(item.attemptCount??info.attempts.length)>1||itemFilter==='waiting'&&info.status==='waiting'||itemFilter==='outcome_unknown'&&info.status==='outcome_unknown')}).sort((a,b)=>{if(itemSort==='index')return a.index-b.index;const ai=inspection(a).attempts,bi=inspection(b).attempts;if(itemSort==='attempts')return (b.attemptCount??bi.length)-(a.attemptCount??ai.length)||a.index-b.index;const duration=(item:BranchMapItemDto,attempts:typeof ai)=>{const first=item.firstAttemptAt??attempts[0]?.createdAt,last=item.lastAttemptAt??attempts.at(-1)?.updatedAt;return first?Math.max(0,Date.parse(last??execution.updatedAt)-Date.parse(first)):0};return duration(b,bi)-duration(a,ai)||a.index-b.index});
    return <Box id={`branch-map-${map.id}`} key={map.id} mt={1}><Typography fontWeight={650}>{definition?.controls.find(control=>control.id===map.mapId)?.label??map.mapId} · {settled} of {map.itemCount} items shown as settled</Typography><Typography variant="caption" color="text.secondary">{items.length} of {map.itemCount} item records loaded · {failed} failed · {waiting} waiting · list hash {map.itemsHash.slice(0,12)}</Typography><Typography variant="caption" display="block">{itemSearch.trim()&&searchResults?`${visible.length}${searchedItems.hasNextPage?'+':''} matching items across this execution`:`${visible.length} matching loaded items`}{itemSearch.trim()&&searchedItems.isPending?' · searching all item inputs…':''}</Typography><Stack spacing={0.5} mt={1}>{visible.slice(0,itemLimit).map(item=>{const {step,status}=inspection(item);return <Stack key={item.id} direction="row" gap={1} alignItems="center" sx={{py:.5,borderBottom:'1px solid',borderColor:'divider'}}><Typography variant="body2" sx={{minWidth:34}}>{item.index+1}.</Typography><Typography variant="body2" sx={{flex:1,overflowWrap:'anywhere'}}>{item.input}</Typography><Chip size="small" label={status}/><Button size="small" aria-label={`Full Item ${item.index+1}`} onClick={()=>setItemEvidenceId(item.id)}>Full Item</Button>{step&&<Button size="small" aria-label={`Inspect Item ${item.index+1}`} onClick={event=>openStep(step,event.currentTarget)}>Inspect Step</Button>}</Stack>})}</Stack>{visible.length>itemLimit&&<Button onClick={()=>setItemLimit(itemLimit+100)}>Show Next 100 Matching Items</Button>}</Box>})}</Paper>}
  {itemSearch.trim()&&searchResults&&searchResults.some(item=>!detail.maps?.some(map=>map.id===item.mapInvocationId))&&<Paper variant="outlined" sx={{p:2}}><Typography fontWeight={650}>Matches From Earlier For Each Invocations</Typography>{searchResults.filter(item=>!detail.maps?.some(map=>map.id===item.mapInvocationId)).map(item=><Stack key={item.id} direction="row" gap={1} alignItems="center"><Typography sx={{flex:1,overflowWrap:'anywhere'}}>{item.mapId} · item {item.index+1} · {item.input}</Typography><Chip size="small" label={item.state}/><Button size="small" onClick={()=>setItemEvidenceId(item.id)}>Full Item</Button></Stack>)}</Paper>}
  {itemSearch.trim()&&searchedItems.hasNextPage&&<Button onClick={()=>void searchedItems.fetchNextPage()} disabled={searchedItems.isFetchingNextPage} sx={{alignSelf:'flex-start'}}>Load Next 100 Search Matches</Button>}
  {Boolean(detail.decisions?.length)&&<Paper variant="outlined" sx={{p:2}}><Typography variant="h6">Why This Path Ran</Typography><Stack spacing={1}>{detail.decisions?.map(d=><Box key={d.id}><Typography>{d.message}</Typography><Typography variant="caption" color="text.secondary">{new Date(d.at).toLocaleString()}</Typography></Box>)}</Stack></Paper>}
  {definition&&<Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon/>}>Run Graph</AccordionSummary><AccordionDetails><BranchGraph definition={definition} selected={selected} onSelect={id=>{setSelected(id);const step=detail.steps.find(step=>step.stepId===id);if(step)openStep(step,document.activeElement instanceof HTMLElement?document.activeElement:undefined);if(definition.controls.some(control=>control.id===id))requestAnimationFrame(()=>document.getElementById('branch-control-detail')?.scrollIntoView({block:'nearest'}))}} steps={detail.steps} controlStates={graphControlStates}/></AccordionDetails></Accordion>}
  {selectedControl&&<Paper id="branch-control-detail" variant="outlined" sx={{p:2}} aria-live="polite"><Typography fontWeight={650}>{selectedControl.label??selectedControl.id} · {graphControlStates[selectedControl.id]??'Not Run'}</Typography>{selectedControl.kind==='map'&&<><Typography variant="body2">{detail.maps?.filter(map=>map.mapId===selectedControl.id).length??0} For Each invocation(s). Each item's input, retry history, and result are below.</Typography>{detail.maps?.filter(map=>map.mapId===selectedControl.id).map((map,index)=><Button key={map.id} onClick={()=>document.getElementById(`branch-map-${map.id}`)?.scrollIntoView({block:'start'})}>Inspect Invocation {index+1} · {map.itemCount} Item{map.itemCount===1?'':'s'}</Button>)}</>}{selectedDecisions.length?selectedDecisions.map(decision=><Typography key={decision.id} variant="body2" sx={{mt:1}}>{decision.message}</Typography>):selectedControl.kind!=='map'&&<Typography variant="body2" color="text.secondary">No decision in loaded evidence · load older pages if available</Typography>}</Paper>}
  {execution.input&&(detail.executionInputTruncated||execution.input.length>240
   ? <Accordion disableGutters onChange={(_,expanded)=>{if(expanded)setShowFullInput(true)}}><AccordionSummary expandIcon={<ExpandMoreIcon/>}>Run Input</AccordionSummary><AccordionDetails>
      {fullInput.isPending&&detail.executionInputTruncated&&<Typography variant="caption">Loading full input…</Typography>}
      {fullInput.error&&<Alert severity="error" action={<Button onClick={()=>void fullInput.refetch()}>Retry</Button>}>{fullInput.error.message}</Alert>}
      <EvidenceText text={fullInput.data?.input??execution.input}/>
     </AccordionDetails></Accordion>
   : <Box><Typography fontWeight={600}>Run Input</Typography><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{execution.input}</Typography></Box>)}
   {detail.resources?.filter(resource=>!resource.error&&!detail.steps.some(step=>step.id===resource.stepExecutionId)).map(resource=><Stack key={resource.stepExecutionId} direction="row" gap={1} alignItems="center" flexWrap="wrap">
    <Typography variant="body2">{resource.agentIds.length} temporary Agents · {resource.state}</Typography>
    <BranchResourceReview branchId={execution.branchId} executionId={execution.id} stepId={resource.stepExecutionId} enabled={authorityFresh&&!execution.runtimeData} onChanged={refresh}/>
   </Stack>)}
   </Stack>}
  </Box>
  <Dialog open={Boolean(itemEvidenceId)} onClose={()=>setItemEvidenceId('')} fullWidth maxWidth="md"><DialogTitle>For Each Item {itemEvidence.data?itemEvidence.data.index+1:''}</DialogTitle><DialogContent><Stack spacing={1}>{itemEvidence.isPending&&<Typography>Loading full item…</Typography>}{itemEvidence.error&&<Alert severity="error">{itemEvidence.error.message}</Alert>}{itemEvidence.data&&<><Typography variant="caption">Identity {itemEvidence.data.id} · input hash {itemEvidence.data.inputHash} · path {itemEvidence.data.state}{itemEvidence.data.state==='arrived'?' (joined)':''}</Typography><Chip sx={{alignSelf:'start'}} size="small" color={selectedItemStatus==='failed'?'error':'default'} label={selectedItemStatus}/><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:400,overflow:'auto'}}>{itemEvidence.data.input}</Typography>{itemEvidence.data.result?.output!==undefined&&<Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:400,overflow:'auto'}}>Result: {itemEvidence.data.result.output||'(Empty result)'}</Typography>}{itemEvidence.data.stepExecutionId&&<Typography variant="caption">Worker Step {itemEvidence.data.stepExecutionId} · sealed result {itemEvidence.data.sealedResultId??'pending'}</Typography>}{itemStepEvidence.isPending&&itemEvidence.data.stepExecutionId&&<Typography variant="caption">Loading full worker evidence…</Typography>}{itemStepEvidence.error&&<Alert severity="error">{itemStepEvidence.error.message}</Alert>}{itemStepEvidence.data?.attempts.map(attempt=><Box key={attempt.id}><Typography variant="body2" fontWeight={600}>Attempt {attempt.number} · {attempt.state}</Typography>{attempt.error&&<Alert severity="error">{attempt.error}</Alert>}{attempt.calledBranch&&<Button href={`/branches?branch=${attempt.calledBranch.id}`}>{attempt.calledBranch.name}</Button>}{attempt.childExecutionId&&<Button href={`/branches?execution=${attempt.childExecutionId}`}>Open Child Execution {attempt.childExecutionId.slice(0,8)} · {attempt.childExecution?.state??'Unknown State'}</Button>}</Box>)}{itemStepEvidence.data?.result?.output!==undefined&&<Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:400,overflow:'auto'}}>Worker output: {itemStepEvidence.data.result.output||'(Empty result)'}</Typography>}</>}</Stack></DialogContent><DialogActions><Button onClick={()=>setItemEvidenceId('')}>Close</Button></DialogActions></Dialog>
  {intervention&&<ConfirmDialog open title={intervention.action==='resolve_guidance'?'Review Guidance Delivery':intervention.action==='resolve_schedule_update'?'Reconcile Scheduled Update':intervention.action==='resolve_script'?'Record An Observed Script Result':intervention.action==='retry'?(intervention.snapshotRetry?'Retry Preparing Copy':intervention.unknown?'Retry Despite Uncertain Outcome':'Retry This Step'):intervention.action==='merge'?'Merge Execution':'Skip Run'} cancelLabel="Back" maxWidth="sm" confirmLabel={intervention.action==='skip'?'Skip Run':'Apply Decision'} pendingLabel={intervention.action==='skip'?'Skipping…':'Applying…'} pending={act.isPending} error={act.error?.message} confirmDisabled={!interventionUnconfirmed&&(!actionsCurrent||(intervention.action!=='skip'&&!reason.trim())||(intervention.unknown&&!reconciled)||(intervention.action==='merge'&&!target)||((intervention.action==='resolve_schedule_update'||intervention.action==='resolve_guidance')&&(!reconciled||!updateApplied)))} onCancel={()=>setIntervention(undefined)} onConfirm={submitIntervention}><Stack spacing={2} mt={1}>
   {interventionUnconfirmed&&<Alert severity="warning">Decision unconfirmed · deliberate reconciliation resends original fields + submission key</Alert>}
   {intervention?.action==='retry'&&intervention.snapshotRetry&&<Alert severity="info">Retry preparing the same temporary copy reservation after confirmed source changes; no copy was published by those attempts.</Alert>}
   {intervention?.action==='retry'&&!intervention.snapshotRetry&&<Alert severity="info"><Stack spacing={0.5}><Typography>Starts · new Step invocation in this execution · original input + saved definition</Typography><Typography>Retained · earlier result + successful Steps</Typography></Stack><Stack spacing={0.5}><Typography>Retained · existing Agent context</Typography><Typography>Branch Call retry · new child execution · current called definition</Typography><Typography>Warning · earlier side effects remain and may repeat</Typography></Stack>{execution.parentExecutionId&&<Typography sx={{mt:1}}>Parent · waiting: can receive result · already handled: no automatic restart · inspect before retry</Typography>}<Typography sx={{mt:1}}>Apply decision to start · retry eligibility checked by Engine</Typography></Alert>}
   {intervention.action==='resolve_guidance'&&<><Alert severity="warning"><Stack spacing={0.5}><Typography>Delivered · records guidance delivery, not an Agent result</Typography><Typography>Not delivered · keeps this guidance held without automatic resend</Typography><Typography>Both choices retain the original evidence and do not cancel or restart the Agent</Typography></Stack></Alert><Typography variant="caption" sx={{overflowWrap:'anywhere'}}>Attempt {intervention.attemptId} · injection {intervention.injectionId}</Typography><FormControlLabel control={<Switch disabled={interventionLocked} checked={reconciled} onChange={(_,value)=>{if(interventionLocked)return;setReconciled(value);setCommandKey(createClientId())}}/>} label="I have checked and reconciled this guidance’s effects"/><TextField select label="Observed Guidance Delivery" value={updateApplied} disabled={interventionLocked||!reconciled} onChange={event=>{if(interventionLocked||!reconciled)return;setUpdateApplied(event.target.value as typeof updateApplied);setCommandKey(createClientId())}} helperText="Choose only the delivery outcome you verified; no Agent result is assumed."><MenuItem value="">Choose Observed Delivery</MenuItem><MenuItem value="applied">Delivered</MenuItem><MenuItem value="not_applied">Not Delivered · Keep Held</MenuItem></TextField></>}
   {intervention.action==='resolve_schedule_update'&&<><Alert severity="warning"><Stack spacing={0.5}><Typography>Before confirming · inspect Agent work + external effects</Typography><Typography>Applied · consumes scheduled check</Typography><Typography>Not Applied · retains one latest delivery while schedule active</Typography><Typography>Both choices · no Agent cancellation/restart</Typography></Stack></Alert><FormControlLabel control={<Switch disabled={interventionLocked} checked={reconciled} onChange={(_,value)=>{if(interventionLocked)return;setReconciled(value);setCommandKey(createClientId())}}/>} label="I have checked and reconciled the scheduled update’s effects"/><TextField select label="Observed Scheduled Update Outcome" value={updateApplied} disabled={interventionLocked||!reconciled} onChange={event=>{if(interventionLocked||!reconciled)return;setUpdateApplied(event.target.value as typeof updateApplied);setCommandKey(createClientId())}} helperText="Choose the outcome you verified; no result is assumed."><MenuItem value="">Choose Observed Outcome</MenuItem><MenuItem value="applied">Applied</MenuItem><MenuItem value="not_applied">Not Applied</MenuItem></TextField></>}
   {intervention?.action==='merge'&&<Stack spacing={1}>
    {mergeTargets.isPending&&<Typography role="status">Loading eligible runs…</Typography>}
    {mergeTargets.error&&<Alert severity="error" action={<Button onClick={()=>void mergeTargets.refetch()}>Retry Eligible Runs</Button>}>Eligible runs could not be loaded. {mergeTargets.error.message}</Alert>}
    {mergeTargets.data&&!executions.length&&!mergeTargets.error&&<Typography color="text.secondary">No eligible runs are currently available for this workflow.</Typography>}
    <TextField select label="Keep This Execution" value={target} disabled={interventionLocked} onChange={e=>{if(interventionLocked)return;setTarget(e.target.value);setCommandKey(createClientId())}}><MenuItem value="">Select Execution</MenuItem>{target&&!executions.some(e=>e.id===target)&&<MenuItem value={target}>Previously Selected Run {target.slice(0,8)}</MenuItem>}{executions.map(e=><MenuItem key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleString()} · {e.state}</MenuItem>)}</TextField>
    {mergeTargets.hasNextPage&&<Button disabled={mergeTargets.isFetchingNextPage||act.isPending} onClick={()=>void mergeTargets.fetchNextPage({cancelRefetch:false})}>{mergeTargets.isFetchingNextPage?'Loading…':'Load Older Runs'}</Button>}
   </Stack>}
   {intervention?.unknown&&<><Alert severity="warning"><Stack spacing={0.5}><Typography>Outcome unknown · earlier operation may have succeeded</Typography><Typography>Warning · retry may duplicate file changes or external effects</Typography><Typography>Before retry/result · inspect process evidence + reconcile effects</Typography></Stack></Alert><Button disabled={act.isPending} onClick={()=>{const action=attentionAttempts.find(item=>item.attempt.id===intervention?.attemptId),attempt=action?.attempt??detail.attempts.find(a=>a.id===intervention?.attemptId),step=action?.step??detail.steps.find(item=>item.id===attempt?.stepExecutionId);setIntervention(undefined);if(step)openStep(step,stepOpener.current)}}>Inspect Evidence Before Deciding</Button><FormControlLabel control={<Switch disabled={interventionLocked} checked={reconciled} onChange={(_,value)=>{if(interventionLocked)return;setReconciled(value);setCommandKey(createClientId())}}/>} label="I have reconciled the earlier attempt’s effects"/></>}
   {intervention?.action==='resolve_script'&&<><TextField disabled={interventionLocked} label="Observed Output" multiline minRows={4} value={result} onChange={e=>{if(interventionLocked)return;setResult(e.target.value);setCommandKey(createClientId())}}/><FormControlLabel control={<Switch disabled={interventionLocked} checked={failed} onChange={(_,value)=>{if(interventionLocked)return;setFailed(value);setCommandKey(createClientId())}}/>} label="The observed result was a failure"/></>}
   {intervention.action!=='skip'&&<TextField disabled={interventionLocked} label="Reason For This Decision" multiline minRows={2} value={reason} onChange={e=>{if(interventionLocked)return;setReason(e.target.value);setCommandKey(createClientId())}}/>}
  </Stack></ConfirmDialog>}
 </Stack>
 {summaryStep&&<Paper component="aside" ref={tray} data-branch-step-tray id="branch-summary-step" tabIndex={-1} aria-label="Step details" variant="outlined"
  sx={{p:1.5,minWidth:0,alignSelf:'start',gridRow:1,[sideBySide]:{gridColumn:2,position:'sticky',top:0,maxHeight:'75dvh',overflowY:'auto',overscrollBehavior:'contain'}}}>
  <Stack spacing={1.5}>
   <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
    <Typography variant="subtitle1" fontWeight={650} sx={{overflowWrap:'anywhere'}}>{stepLabel(summaryStep.stepId)}</Typography>
    <Button size="small" startIcon={<ArrowBackIcon sx={{[sideBySide]:{display:'none'}}}/>} onClick={()=>setSummaryStepId('')}>
     <Box component="span" sx={{[sideBySide]:{display:'none'}}}>Back to Steps</Box>
     <Box component="span" sx={{display:'none',[sideBySide]:{display:'inline'}}}>Close</Box>
    </Button>
   </Stack>
   <Box><SemanticStatus {...stepStatus(summaryStep)}/></Box>
   {resultTarget(summaryStep)&&<Button size="small" sx={{alignSelf:'start'}} onClick={()=>openResult(resultTarget(summaryStep)!)}>View result</Button>}
   {stepEvidence.isPending&&<Typography variant="body2" role="status">Loading step evidence…</Typography>}
   {stepEvidence.error&&<Alert severity="warning" action={<Button onClick={()=>void stepEvidence.refetch()}>Retry</Button>}>Could not load the full step evidence.</Alert>}
   {stepEvidence.data&&<BranchStepEvidence key={summaryStep.id} evidence={stepEvidence.data} hasReadableResult={Boolean(resultTarget(summaryStep))}/>}
   {detail.gates.filter(gate=>gate.state==='resolved'&&gate.stepExecutionId===summaryStep.id).map(gate=><Box key={gate.id}>
    <Typography fontWeight={600}>{gate.resolution?.decision==='reject'?'Rejected':gate.resolution?.decision==='retry'?'Retry Approved':gate.resolution?.choice?`Selected: ${gate.resolution.choice}`:'Approved'}</Typography>
    <Typography variant="body2">{gate.prompt}</Typography>
   </Box>)}
   {selectedResource&&<Box>
    <Typography variant="body2">{selectedResource.agentIds.length} temporary Agents · {selectedResource.state}</Typography>
    {selectedResource.error
     ? <Alert severity="warning">{selectedResource.error}<Button size="small" onClick={()=>{stepDestination.current=`branch-resource-${selectedResource.stepExecutionId}`;setSummaryStepId('')}}>Go to resource review</Button></Alert>
     : <BranchResourceReview branchId={execution.branchId} executionId={execution.id} stepId={selectedResource.stepExecutionId} enabled={authorityFresh&&!execution.runtimeData} onChanged={refresh}/>}
   </Box>}
  </Stack>
 </Paper>}
 </Box>;
}

function stepEvidenceQuery(execution:BranchExecutionDto,id:string){
 return {
  queryKey:['branch-step-evidence',execution.id,id,execution.revision],
  queryFn:()=>requestJson<BranchStepEvidenceDto>(`/api/branch-executions/${execution.id}/steps/${id}/evidence`),
 };
}

function StepResult({step,execution,label}:{step:BranchStepExecutionDto;execution:BranchExecutionDto;label:string}):JSX.Element {
 const [expanded,setExpanded]=useState(false);
 const output=useQuery({...stepEvidenceQuery(execution,step.id),enabled:expanded});
 return <Box id={`branch-result-${step.id}`} tabIndex={-1} sx={{minWidth:0,overflowWrap:'anywhere'}}>
  <Typography variant="subtitle2">{label}{step.invocation>1?` · Visit ${step.invocation}`:''}</Typography>
  <EvidenceText text={output.data?.result?.output??step.result?.output??''} markdownFallback/>
  {step.resultOutputTruncated&&!expanded&&<Button size="small" onClick={()=>setExpanded(true)}>Read full result</Button>}
  {expanded&&output.isPending&&<Typography variant="body2" role="status">Loading full result…</Typography>}
  {output.error&&<Alert severity="warning" action={<Button onClick={()=>void output.refetch()}>Retry</Button>}>Could not load the full result.</Alert>}
 </Box>;
}
