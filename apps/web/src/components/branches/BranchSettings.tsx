import {createPortal} from 'react-dom';
import {WorkspaceQueryError} from "../WorkspaceQueryError";
import {workspaceRead} from "../../workspaceAvailability";
import {useReportWorkspaceRead} from "../WorkspaceRefreshContext";
import {useBranchDraftGuard} from './BranchNavigation';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Accordion,AccordionDetails,AccordionSummary,Alert,Box,Button,Checkbox,FormControlLabel,Paper,Stack,Switch,TextField,Typography} from "@mui/material";
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type {BranchConfiguration,BranchDefinition,BranchDto,BranchLifecycleDto} from "@ponderosa/core";
import {requestJson} from "../../api/real";
import {ApiRequestError} from "../../api/types";
import {ResourceDeletionDialog} from "../ConfirmationDialogs";
import {useMutationNotification} from "../MutationNotifications";
import {CapabilityPolicyEditor} from "../CapabilityPolicyEditor";
import {BranchExecutionBudget} from './BranchExecutionBudget';
import {BranchDeletionStatus,BranchInstallationUpdateStatus} from './BranchOperations';
import {ExecutionControlHelp} from './ExecutionControlHelp';

export function useBranchAvailability(branchId?:string) {
 const client=useQueryClient();
 const availability=useMutation({
  mutationKey:['branch-availability',branchId],
  mutationFn:({id,enabled}:{id:string;enabled:boolean})=>requestJson<BranchDto>(`/api/branches/${id}/availability`,{method:"PUT",body:JSON.stringify({enabled})}),
  onSuccess:next=>{client.setQueryData(["branch",next.id],next)},
  onSettled:(_data,_error,{id})=>Promise.all([client.invalidateQueries({queryKey:["branch",id],exact:true}),client.invalidateQueries({queryKey:["branches"]}),client.invalidateQueries({queryKey:["branch-lifecycle-summary",id]})]),
 });
 useBranchDraftGuard(`branch-availability:${branchId}`,availability.isPending);
 return availability;
}

export function BranchAvailability({branch,mutation,disabled,onDisable}:{branch:BranchDto;mutation:ReturnType<typeof useBranchAvailability>;disabled:boolean;onDisable():void}):JSX.Element {
 const enabled=branch.enabled!==false;
 const pending=mutation.isPending&&mutation.variables?.id===branch.id;
 const error=mutation.variables?.id===branch.id?mutation.error:undefined;
 return <Stack sx={{alignSelf:'start',minWidth:0}}>
  <FormControlLabel sx={{m:0,gap:.5,minHeight:32,'& .MuiFormControlLabel-label':{fontSize:12}}}
   label={enabled?'Enabled':'Disabled'}
   control={<Switch size="small" checked={enabled} disabled={pending||disabled} inputProps={{role:'switch','aria-label':'Workflow availability','aria-describedby':!enabled||pending||error?'branch-availability-feedback':undefined}}
    onChange={(_,next)=>{if(next)mutation.mutate({id:branch.id,enabled:true});else onDisable()}}/>}/>
  {(pending||error||!enabled)&&<Typography id="branch-availability-feedback" role={error?'alert':'status'} variant="caption" color={error?'error.main':'text.secondary'} sx={{overflowWrap:'anywhere'}}>
   {pending?'Saving availability…':error?error.message:'Enable to run once.'}
  </Typography>}
 </Stack>;
}

export function BranchLocalLimits({branch,definition,active=true}:{branch:BranchDto;definition?:BranchDefinition;active?:boolean}):JSX.Element {
 return <BranchConfigurationEditor key={branch.id} branch={branch} definition={definition} active={active}/>;
}
function BranchConfigurationEditor({branch,definition,parameters=false,active=true,focusVariables=false,feedback}:{branch:BranchDto;definition?:BranchDefinition;parameters?:boolean;active?:boolean;focusVariables?:boolean;feedback?:ReactNode}):JSX.Element {
 const client=useQueryClient(),notify=useMutationNotification(),[draft,writeDraft]=useState<BranchConfiguration>(),[revision,setRevision]=useState<number>();
 const currentDraft=useRef(draft);currentDraft.current=draft;
 const setDraft=(next:BranchConfiguration)=>{currentDraft.current=next;writeDraft(next)};
 const variablesSection=useRef<HTMLDivElement>(null),hasVariables=Boolean(Object.keys(definition?.parameters??{}).length);
 const baseline=useRef<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>();
 const settings=useQuery({queryKey:["branch-settings",branch.id],queryFn:()=>requestJson<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>(`/api/branches/${branch.id}/settings`)});
 useEffect(()=>{if(!settings.data||baseline.current&&settings.data.revision<baseline.current.revision)return;const locallyDirty=Boolean(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration));if(!locallyDirty){baseline.current=settings.data;setDraft(settings.data.configuration);setRevision(settings.data.revision)}},[settings.data,draft]);
 useReportWorkspaceRead({...workspaceRead(`branch:${branch.id}`,"Configuration",settings,Boolean(draft)),active});
 const save=useMutation({mutationFn:()=>requestJson<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>(`/api/branches/${branch.id}/settings`,{method:"PUT",body:JSON.stringify({configuration:draft,revision})}),onSuccess:next=>{baseline.current=next;setDraft(next.configuration);setRevision(next.revision);client.setQueryData(["branch-settings",branch.id],next);void client.invalidateQueries({queryKey:["branch-settings",branch.id]});notify({key:`branch-settings:${branch.id}`,message:"Settings Saved"})}});
 const reloadAction=useMutation({mutationFn:async(observed:BranchConfiguration|undefined)=>({observed,next:await requestJson<NonNullable<typeof settings.data>>(`/api/branches/${branch.id}/settings`,{cache:'no-store'})}),onSuccess:({observed,next})=>{if(currentDraft.current!==observed||baseline.current&&next.revision<baseline.current.revision)return;baseline.current=next;setDraft(next.configuration);setRevision(next.revision);client.setQueryData(['branch-settings',branch.id],next);save.reset()}});
 const dirty=Boolean(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration));
 useBranchDraftGuard(`branch-settings:${branch.id}:${parameters?'parameters':'limits'}`,dirty||save.isPending||reloadAction.isPending);
 const variablesIdle=!hasVariables&&!dirty&&!save.isPending&&!reloadAction.isPending&&!save.error&&!reloadAction.error&&!settings.error;
 const emptyVariables=parameters&&focusVariables&&(!branch.versionId||Boolean(definition&&variablesIdle));
 const variablesReady=emptyVariables||Boolean(hasVariables&&draft);
 useEffect(()=>{
  if(parameters&&active&&focusVariables&&variablesReady){
   variablesSection.current?.focus({preventScroll:true});
   variablesSection.current?.scrollIntoView({block:'start'});
  }
 },[parameters,active,focusVariables,variablesReady]);
 if(emptyVariables)return <Paper variant="outlined" component="section" ref={variablesSection} id="branch-workflow-variables" aria-label="Workflow Variables" tabIndex={-1} sx={{p:{xs:2,sm:2.5},scrollMarginTop:16}}>
  <Typography variant="h6" fontWeight={650}>Workflow Variables</Typography>
  <Typography variant="body2" color="text.secondary">Publish a workflow with variables to edit saved values here.</Typography>
 </Paper>;
 if(parameters&&!definition)return <>{feedback}</>;
 if(parameters&&variablesIdle)return <></>;
 if(!draft&&settings.error)return <WorkspaceQueryError active={active} initial read={workspaceRead(`branch:${branch.id}`,"Configuration",settings,false)}/>;
 if(!draft)return <Typography role="status">Loading configuration…</Typography>;
  const reload=<Button aria-busy={reloadAction.isPending||undefined} disabled={save.isPending||reloadAction.isPending} onClick={()=>reloadAction.mutate(currentDraft.current)}>{reloadAction.isPending?'Reloading Configuration…':parameters?'Reload Variables And Discard Edits':'Reload Configuration And Discard Edits'}</Button>;
  const setParameter=(key:string,value:string|number|boolean|undefined)=>{const parameters={...draft.parameters};if(value===undefined)delete parameters[key];else parameters[key]=value;setDraft({...draft,parameters})};
  const parameterErrors=Object.keys(draft.parameters).filter(key=>!definition?.parameters?.[key]||definition.parameters[key]!.type==='secret').map(key=>`Variable “${key}” is no longer editable in the published workflow.`).concat(Object.entries(definition?.parameters??{}).flatMap(([key,p])=>{if(p.type==='secret')return [];const value=draft.parameters[key]??p.default;return p.required&&(value===undefined||value==='')?[`${p.label??key} is required.`]:value!==undefined&&(typeof value!==(p.type==='path'?'string':p.type==='text'?'string':p.type)||typeof value==='number'&&!Number.isFinite(value))?[`${p.label??key} must be ${p.type==='number'?'a finite number':p.type==='boolean'?'true or false':'text'}.`]:[]}));
  const invalidLimits=Object.values(draft.limits).some(value=>!Number.isSafeInteger(value)||value<1);
  const settingsError=reloadAction.error?.message||save.error?.message;
  if(parameters)return <Stack spacing={2} component={hasVariables?'section':'div'} ref={variablesSection} id={hasVariables?'branch-workflow-variables':undefined} aria-label={hasVariables?'Workflow Variables':undefined} tabIndex={hasVariables?-1:undefined} sx={{minWidth:0,scrollMarginTop:16}}>
    <WorkspaceQueryError active={active} read={workspaceRead(`branch:${branch.id}`,"Configuration",settings,Boolean(draft))}/>
    {(settingsError||parameterErrors.length>0)&&<Alert severity="warning" action={reload}>{[settingsError,...parameterErrors].filter(Boolean).join(' ')}</Alert>}
    {hasVariables?<Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Typography variant="h6" fontWeight={650}>Workflow Variables</Typography>
      <Typography variant="body2" color="text.secondary">Save values for future runs of the published workflow.</Typography>
      {Object.entries(definition?.parameters??{}).map(([key,p])=>p.type==="secret"?<Alert severity="info" key={key}>{p.label??key}: {settings.data?.secretStatus?.[key]==="configured"?"Configured local binding":"Missing local binding"}. Secrets are available only to supported Engine-owned integrations.</Alert>:p.type==="boolean"?<FormControlLabel key={key} label={p.label??key} control={<Switch disabled={save.isPending||reloadAction.isPending} checked={Boolean(draft.parameters[key]??p.default??false)} onChange={(_,v)=>setParameter(key,v)}/>}/>:<TextField disabled={save.isPending||reloadAction.isPending} key={key} label={p.label??key} required={p.required} helperText={p.help} type={p.type==="number"?"number":"text"} value={draft.parameters[key]??p.default??""} onChange={e=>setParameter(key,p.type==="number"?(e.target.value===''?undefined:Number(e.target.value)):e.target.value)}/>)}
      {dirty&&<Button variant="contained" sx={{alignSelf:"start"}} aria-busy={save.isPending||undefined} disabled={save.isPending||reloadAction.isPending||!branch.versionId||parameterErrors.length>0} onClick={()=>save.mutate()}>{save.isPending?'Saving Variables…':'Save Variables'}</Button>}
    </Stack></Paper>:dirty&&parameterErrors.length===0?<Alert severity="warning">The published workflow no longer declares variables. {reload}</Alert>:null}
  </Stack>;
  return <Stack spacing={2}><WorkspaceQueryError active={active} read={workspaceRead(`branch:${branch.id}`,"Configuration",settings,Boolean(draft))}/>
   {settingsError&&<Alert severity="error" action={reload}>{settingsError}</Alert>}
   <Typography fontWeight={650}>Local limits</Typography>
   <Typography variant="body2" color="text.secondary">A run fails if it exceeds one of these limits.</Typography>
   {([
    ['maxCallDepth','Nested Branch Depth','How many workflows can be called in a chain beneath this one. A direct call is one level.'],
    ['maxLoopIterations','Loop Iterations','How many times a run can follow a loop-back connection in total, including loops in workflows it calls.'],
    ['maxTraversals','Graph Traversals','How many times a run can visit steps and routing points in total, including revisits and work in workflows it calls.'],
   ] as const).map(([key,label,help])=>{
    const value=draft.limits[key],invalid=!Number.isSafeInteger(value)||value<1;
    return <ExecutionControlHelp key={key} label={label} help={help}><TextField disabled={save.isPending||reloadAction.isPending} label={label} type="number" error={invalid} helperText={invalid?'Enter a positive whole number.':undefined} value={value} onChange={e=>setDraft({...draft,limits:{...draft.limits,[key]:Number(e.target.value)}})}/></ExecutionControlHelp>;
   })}
   {dirty&&<Button variant="contained" sx={{alignSelf:"start"}} disabled={save.isPending||reloadAction.isPending||!branch.versionId||invalidLimits} onClick={()=>save.mutate()}>{save.isPending?'Saving…':'Save local limits'}</Button>}
  </Stack>;
}

export function BranchSettings({branch,definition,active:settingsActive=true,focusVariables=false,focusExecutionControls=false,variablesFeedback,executionSettings,executionSettingsError,deletionTarget,onDeletionOpen,onDeleted}:{executionSettings?:ReactNode;executionSettingsError?:string;deletionTarget?:HTMLElement|null;onDeletionOpen?(open:boolean):void;branch:BranchDto;definition?:BranchDefinition;active?:boolean;focusVariables?:boolean;focusExecutionControls?:boolean;variablesFeedback?:ReactNode;onDeleted?():boolean|void}):JSX.Element {
 const client=useQueryClient(),[capabilityDirty,setCapabilityDirty]=useState(false),[deleteOpen,setDeleteOpen]=useState(false),[acknowledged,setAcknowledged]=useState(false);
 const [advancedOpen,setAdvancedOpen]=useState(false);
 useLayoutEffect(()=>{if(settingsActive&&executionSettingsError)setAdvancedOpen(true)},[settingsActive,executionSettingsError]);
 useEffect(()=>{onDeletionOpen?.(deleteOpen)},[deleteOpen,onDeletionOpen]);
 useEffect(()=>()=>onDeletionOpen?.(false),[onDeletionOpen]);
 const executionControls=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(settingsActive&&focusExecutionControls){executionControls.current?.focus({preventScroll:true});executionControls.current?.scrollIntoView({block:'start'})}},[settingsActive,focusExecutionControls]);
 const active=useRef(true),generation=useRef(0),removing=useRef(false),finished=useRef(false);
 useLayoutEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++}},[]);
 const finishDeleted=()=>{if(!active.current||finished.current)return;if(onDeleted?.()===false)return;finished.current=true;void client.invalidateQueries({queryKey:["branches"]})};
 const lifecycle=useQuery({queryKey:["branch-lifecycle-summary",branch.id],queryFn:()=>requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`),refetchInterval:3000,retry:false});
 useEffect(()=>{if(lifecycle.error instanceof ApiRequestError&&lifecycle.error.status===404)finishDeleted()},[lifecycle.error,onDeleted]);
 const dependencies=useQuery({queryKey:["branch-dependencies",branch.id],queryFn:()=>requestJson<{calls:Array<{id:string;ref:string}>;callers:Array<{id:string;ref:string}>}>(`/api/branches/${branch.id}/dependencies`)});
 useReportWorkspaceRead({...workspaceRead(`branch:${branch.id}`,"Dependencies",dependencies),active:settingsActive});
 const preflight=useMutation({mutationFn:(_sequence:number)=>requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`,{cache:"no-store"}),onSuccess:(next,sequence)=>{if(!active.current||sequence!==generation.current)return;client.setQueryData(["branch-lifecycle-summary",branch.id],next);if(next.deleting)setDeleteOpen(false)},onError:(error,sequence)=>{if(active.current&&sequence===generation.current&&error instanceof ApiRequestError&&error.status===404)finishDeleted()}});
 const remove=useMutation({mutationFn:async(observed:BranchLifecycleDto)=>{const next=await requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`,{cache:"no-store"});if(!active.current)throw new Error("The selected workflow changed. Reopen deletion to review it.");if(next.deleting)return {deleted:false,pending:true};if(next.callers.length||next.updates.length)throw new Error("This workflow has callers or a package update. Resolve those blockers before deleting.");if(next.chats!==observed.chats||next.activeExecutions!==observed.activeExecutions)throw new Error("Workflow counts changed. Review the current counts and acknowledge deletion again.");return requestJson<{deleted:boolean;pending:boolean}>(`/api/branches/${branch.id}`,{method:"DELETE"})},onSuccess:r=>{if(!active.current)return;setDeleteOpen(false);setAcknowledged(false);if(r.deleted)finishDeleted();else{void client.invalidateQueries({queryKey:["branches"]});void lifecycle.refetch()}},onError:async()=>{if(!active.current)return;setAcknowledged(false);try{await preflight.mutateAsync(++generation.current)}catch{/* Keep the failed readback visible; never retry DELETE automatically. */}},onSettled:()=>{removing.current=false}});
 const refreshDeletion=()=>{if(removing.current||(preflight.isPending&&preflight.variables===generation.current))return;setAcknowledged(false);preflight.mutate(++generation.current)};
 const closeDeletion=()=>{if(removing.current)return;generation.current++;setDeleteOpen(false);setAcknowledged(false)};
 const deletionBlocked=!preflight.data||preflight.isPending||preflight.isError||preflight.variables!==generation.current||preflight.data.deleting||Boolean(preflight.data.callers.length)||Boolean(preflight.data.updates.length)||Boolean(lifecycle.error)||Boolean(lifecycle.data?.callers.length)||Boolean(lifecycle.data?.updates.length);
 const confirmDeletion=()=>{if(removing.current||!acknowledged||deletionBlocked)return;removing.current=true;remove.mutate(preflight.data!)};
 useBranchDraftGuard(`branch-deletion:${branch.id}`,remove.isPending||(remove.isError&&(preflight.isPending||preflight.isError)));
 useBranchDraftGuard(`branch-capabilities:${branch.id}`,capabilityDirty);
 const callerNames=new Map(lifecycle.data?.callers.map(caller=>[caller.id,caller.name]));
 const deletionConfirmation=<ResourceDeletionDialog inWorkflowInspector={Boolean(deletionTarget)} open={deleteOpen} resourceType="workflow" resourceName={branch.name} pending={remove.isPending} pendingLabel="Deleting…" confirmDisabled={!acknowledged||deletionBlocked} error={remove.error||preflight.error?[remove.error?.message,preflight.error?.message].filter(Boolean).join(" "):undefined} onCancel={closeDeletion} onConfirm={confirmDeletion}>
       <Stack spacing={2}><Alert severity="warning"><Stack spacing={0.5}><Typography>Permanently deletes · definition · versions · execution history · owned Chats + Agents</Typography><Typography>Active executions · cancel + drain first</Typography><Typography>Source folders · preserved</Typography></Stack></Alert>
        {preflight.isPending&&<Typography role="status">Checking current workflow ownership and dependencies…</Typography>}
        {preflight.isSuccess&&preflight.variables===generation.current&&<Typography>{preflight.data.chats} owned Chats · {preflight.data.activeExecutions} active executions</Typography>}
        {Boolean(preflight.data?.callers.length)&&<Alert severity="warning">Dependent workflows · remove their calls before deletion</Alert>}
        {Boolean(preflight.data?.updates.length)&&<Alert severity="warning">Package update in progress · deletion waits for completion</Alert>}
        <Button disabled={preflight.isPending||remove.isPending} onClick={refreshDeletion}>Check Again</Button>
        <FormControlLabel control={<Checkbox checked={acknowledged} disabled={deletionBlocked||remove.isPending} onChange={(_,checked)=>setAcknowledged(checked)}/>} label="I understand this permanently deletes this workflow and its owned Chats and Agents."/>
       </Stack>
      </ResourceDeletionDialog>;
 return <Stack className="branch-settings" spacing={3} sx={{minWidth:0,width:"100%",maxWidth:880,mx:"auto",pb:"max(24px, env(safe-area-inset-bottom, 0px))"}}>
  <Stack component="section" aria-label="Execution Controls" id="branch-execution-controls" ref={executionControls} tabIndex={-1} spacing={2} sx={{minWidth:0,scrollMarginTop:16}}>
   <Typography variant="h6" fontWeight={650}>Execution Controls</Typography>
   <BranchExecutionBudget key={branch.id} branchId={branch.id} settings active={settingsActive}/>
   {executionSettingsError&&<Alert severity="error">{executionSettingsError}</Alert>}
   <Accordion disableGutters expanded={advancedOpen||Boolean(executionSettingsError)} onChange={(_,open)=>setAdvancedOpen(open)}><AccordionSummary expandIcon={<ExpandMoreIcon/>}>Advanced execution settings</AccordionSummary><AccordionDetails>
    <Stack spacing={3}>
     {executionSettings}
     <BranchLocalLimits key={branch.id} branch={branch} definition={definition} active={settingsActive}/>
    </Stack>
   </AccordionDetails></Accordion>
  </Stack>
  <WorkspaceQueryError active={settingsActive} read={workspaceRead(`branch:${branch.id}`,"Lifecycle",lifecycle)}/>
      {!lifecycle.data?.deleting&&!remove.data?.pending&&<CapabilityPolicyEditor endpoint={`/api/branches/${branch.id}/capabilities`} scopeKind="branch" immediateSave onDirtyChange={setCapabilityDirty}/>}
      <BranchConfigurationEditor branch={branch} definition={definition} parameters active={settingsActive} focusVariables={focusVariables} feedback={variablesFeedback}/>
      <Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={650}>Dependencies</Typography><Typography variant="body2" color="text.secondary">Caller links block deletion until removed</Typography></Box>{dependencies.isPending?<Typography>Loading dependencies…</Typography>:dependencies.error?<WorkspaceQueryError active={settingsActive} read={workspaceRead(`branch:${branch.id}`,"Dependencies",dependencies)}/>:<><Box><Typography variant="subtitle2">This Workflow Calls</Typography><Typography color="text.secondary">{dependencies.data?.calls.length?dependencies.data.calls.map(item=>item.ref).join(", "):"No other Branches"}</Typography></Box><Box><Typography variant="subtitle2">Called By</Typography><Typography color="text.secondary">{dependencies.data?.callers.length?[...new Set(dependencies.data.callers.map(item=>item.id))].map(id=>callerNames.get(id)??id).join(", "):"No other Branches"}</Typography></Box></>}</Stack></Paper>
      <Paper variant="outlined" sx={{p:{xs:2,sm:2.5},borderColor:"error.dark"}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={650}>Delete Workflow</Typography><Typography variant="body2" color="text.secondary">Deletes Branch + owned Chats/Agents after cancellation and drain; source folders preserved</Typography></Box>{lifecycle.data?.updates.map(update=><BranchInstallationUpdateStatus key={update.id} update={update}/>)}{lifecycle.data?.pendingRemoval.map(resource=><Alert key={resource.id} severity={resource.error?"error":"info"}>{resource.kind} pending removal: {resource.id}. {resource.error??"Waiting for earlier executions to drain."}</Alert>)}{lifecycle.data?.callers.length?<Alert severity="warning">Used by {lifecycle.data.callers.map(c=>c.name).join(", ")}. Remove those calls before deleting this Branch.</Alert>:null}{remove.error&&<Alert severity="error">{remove.error.message}</Alert>}{lifecycle.data?.deleting||remove.data?.pending?<BranchDeletionStatus error={lifecycle.data?.deletionError}/>:<Button color="error" variant="outlined" sx={{alignSelf:"start"}} disabled={remove.isPending||!lifecycle.data||Boolean(lifecycle.error)||Boolean(lifecycle.data?.callers.length)||Boolean(lifecycle.data?.updates.length)} onClick={()=>{setDeleteOpen(true);refreshDeletion()}}>Delete Workflow…</Button>}</Stack></Paper>

      {deletionTarget&&deleteOpen?createPortal(deletionConfirmation,deletionTarget):deletionTarget?null:deletionConfirmation}
  </Stack>;
}
