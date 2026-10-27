import {useBranchDraftGuard} from './BranchNavigation';
import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Alert,Box,Button,Checkbox,FormControlLabel,Paper,Stack,Switch,TextField,Typography} from "@mui/material";
import type {BranchConfiguration,BranchDefinition,BranchDto,BranchLifecycleDto} from "@ponderosa/core";
import {requestJson} from "../../api/real";
import {ApiRequestError} from "../../api/types";
import {ResourceDeletionDialog} from "../ConfirmationDialogs";
import {CapabilityPolicyEditor} from "../CapabilityPolicyEditor";

export function BranchAvailability({branch,disabled=false}:{branch:BranchDto;disabled?:boolean}):JSX.Element {
 const client=useQueryClient();
 const availability=useMutation({mutationFn:(enabled:boolean)=>requestJson<BranchDto>(`/api/branches/${branch.id}/availability`,{method:"PUT",body:JSON.stringify({enabled})}),onSuccess:next=>{client.setQueryData(["branch",branch.id],next);},onSettled:()=>Promise.all([client.invalidateQueries({queryKey:["branch",branch.id]}),client.invalidateQueries({queryKey:["branches"]}),client.invalidateQueries({queryKey:["branch-lifecycle-summary",branch.id]})])});
 useBranchDraftGuard(`branch-availability:${branch.id}`,availability.isPending);
 return <Stack spacing={1}>
  <FormControlLabel label="Branch enabled" control={<Switch checked={branch.enabled!==false} disabled={availability.isPending||disabled} onChange={(_,enabled)=>availability.mutate(enabled)}/>}/>
  {availability.isPending&&<Typography role="status">Saving availability…</Typography>}
  {availability.error&&<Alert severity="error">{availability.error.message} Check the live state before trying again.</Alert>}
 </Stack>;
}

export function BranchSettings({branch,definition,parameters=false,onDeleted}:{branch:BranchDto;definition:BranchDefinition;parameters?:boolean;onDeleted?():boolean|void}):JSX.Element {
 return parameters?<BranchConfigurationEditor key={branch.id} branch={branch} definition={definition} parameters/>:<BranchSettingsPage key={branch.id} branch={branch} onDeleted={onDeleted}/>;
}
export function BranchLocalLimits({branch,definition}:{branch:BranchDto;definition:BranchDefinition}):JSX.Element {
 return <BranchConfigurationEditor key={branch.id} branch={branch} definition={definition}/>;
}
function BranchConfigurationEditor({branch,definition,parameters=false}:{branch:BranchDto;definition:BranchDefinition;parameters?:boolean}):JSX.Element {
 const client=useQueryClient(),[draft,setDraft]=useState<BranchConfiguration>(),[revision,setRevision]=useState<number>();
 const baseline=useRef<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>();
 const settings=useQuery({queryKey:["branch-settings",branch.id],queryFn:()=>requestJson<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>(`/api/branches/${branch.id}/settings`)});
 useEffect(()=>{if(!settings.data)return;const locallyDirty=Boolean(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration));if(!locallyDirty){baseline.current=settings.data;setDraft(settings.data.configuration);setRevision(settings.data.revision)}},[settings.data,draft]);
 const save=useMutation({mutationFn:()=>requestJson<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>(`/api/branches/${branch.id}/settings`,{method:"PUT",body:JSON.stringify({configuration:draft,revision})}),onSuccess:next=>{baseline.current=next;setDraft(next.configuration);setRevision(next.revision);client.setQueryData(["branch-settings",branch.id],next);void client.invalidateQueries({queryKey:["branch-settings",branch.id]})}});
 useBranchDraftGuard(`branch-settings:${branch.id}:${parameters?'parameters':'limits'}`,Boolean(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration))||save.isPending);
 if(!draft&&settings.error)return <Alert severity="error" action={<Button onClick={()=>void settings.refetch()}>Retry configuration</Button>}>Configuration could not be loaded. {settings.error.message}</Alert>;
 if(!draft)return <Typography role="status">Loading configuration…</Typography>;
  const reload=<Button disabled={settings.isFetching||save.isPending} onClick={async()=>{const next=await settings.refetch();if(next.data&&!next.error){baseline.current=next.data;setDraft(next.data.configuration);setRevision(next.data.revision);save.reset()}}}>Reload configuration and discard edits</Button>;
  const setParameter=(key:string,value:string|number|boolean|undefined)=>{const parameters={...draft.parameters};if(value===undefined)delete parameters[key];else parameters[key]=value;setDraft({...draft,parameters})};
  const parameterErrors=Object.entries(definition.parameters??{}).flatMap(([key,p])=>{if(p.type==='secret')return [];const value=draft.parameters[key]??p.default;return p.required&&(value===undefined||value==='')?[`${p.label??key} is required.`]:p.type==='number'&&value!==undefined&&(typeof value!=='number'||!Number.isFinite(value))?[`${p.label??key} must be a finite number.`]:[]});
  const invalidLimits=Object.values(draft.limits).some(value=>!Number.isSafeInteger(value)||value<1);
  if(parameters)return <Stack spacing={2} sx={{maxWidth:760}}>
    {(settings.error||save.error)&&<Alert severity="error">{settings.error?.message||save.error?.message}{save.error&&reload}</Alert>}
    {parameterErrors.length>0&&<Alert severity="warning">{parameterErrors.join(' ')}</Alert>}
    {save.isSuccess&&<Alert severity="success">Parameters saved. New executions use these values.</Alert>}
    <Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Installation parameters</Typography><Typography variant="body2" color="text.secondary">Use {'{{parameter:name}}'} in workflow text fields such as Agent instructions and gate prompts. Scripts read JSON from PONDEROSA_PARAMETERS; Script source is not interpolated. File contents are never loaded automatically.</Typography></Box>
      {!Object.keys(definition.parameters??{}).length&&<Typography color="text.secondary">No parameters declared. Add parameter definitions in the Workflow editor.</Typography>}
      {Object.entries(definition.parameters??{}).map(([key,p])=>p.type==="secret"?<Alert severity="info" key={key}>{p.label??key}: {settings.data?.secretStatus?.[key]==="configured"?"Configured local binding":"Missing local binding"}. Secrets are available only to supported Engine-owned integrations.</Alert>:p.type==="boolean"?<FormControlLabel key={key} label={p.label??key} control={<Switch disabled={save.isPending} checked={Boolean(draft.parameters[key]??p.default??false)} onChange={(_,v)=>setParameter(key,v)}/>}/>:<TextField disabled={save.isPending} key={key} label={p.label??key} required={p.required} helperText={p.help} type={p.type==="number"?"number":"text"} value={draft.parameters[key]??p.default??""} onChange={e=>setParameter(key,p.type==="number"?(e.target.value===''?undefined:Number(e.target.value)):e.target.value)}/>)}
      <Button variant="contained" sx={{alignSelf:"start"}} disabled={save.isPending||!branch.versionId||parameterErrors.length>0} onClick={()=>save.mutate()}>Save parameters</Button>
    </Stack></Paper>
  </Stack>;
  return <Stack spacing={2}>{(settings.error||save.error)&&<Alert severity="error">{settings.error?.message||save.error?.message}{save.error&&reload}</Alert>}<Box><Typography variant="h6" fontWeight={800}>Limits within an execution</Typography><Typography variant="body2" color="text.secondary">These ceilings stop runaway recursion and traversal with an explicit workflow failure.</Typography></Box>{([['maxCallDepth','Nested Branch depth'],['maxLoopIterations','Loop iterations'],['maxTraversals','Graph traversals']] as const).map(([key,label])=><TextField disabled={save.isPending} key={key} label={label} type="number" error={!Number.isSafeInteger(draft.limits[key])||draft.limits[key]<1} helperText="A positive whole number is required." value={draft.limits[key]} onChange={e=>setDraft({...draft,limits:{...draft.limits,[key]:Number(e.target.value)}})}/>)}{save.isSuccess&&<Alert severity="success">Execution settings saved.</Alert>}<Button variant="contained" sx={{alignSelf:"start"}} disabled={save.isPending||!branch.versionId||invalidLimits} onClick={()=>save.mutate()}>Save execution settings</Button></Stack>;
}

function BranchSettingsPage({branch,onDeleted}:{branch:BranchDto;onDeleted?():boolean|void}):JSX.Element {
 const client=useQueryClient(),[capabilityDirty,setCapabilityDirty]=useState(false),[deleteOpen,setDeleteOpen]=useState(false),[acknowledged,setAcknowledged]=useState(false);
 const active=useRef(true),generation=useRef(0),removing=useRef(false),finished=useRef(false);
 useLayoutEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++}},[]);
 const finishDeleted=()=>{if(!active.current||finished.current)return;if(onDeleted?.()===false)return;finished.current=true;void client.invalidateQueries({queryKey:["branches"]})};
 const lifecycle=useQuery({queryKey:["branch-lifecycle-summary",branch.id],queryFn:()=>requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`),refetchInterval:3000,retry:false});
 useEffect(()=>{if(lifecycle.error instanceof ApiRequestError&&lifecycle.error.status===404)finishDeleted()},[lifecycle.error,onDeleted]);
 const dependencies=useQuery({queryKey:["branch-dependencies",branch.id],queryFn:()=>requestJson<{calls:Array<{id:string;ref:string}>;callers:Array<{id:string;ref:string}>}>(`/api/branches/${branch.id}/dependencies`)});
 const preflight=useMutation({mutationFn:(_sequence:number)=>requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`,{cache:"no-store"}),onSuccess:(next,sequence)=>{if(!active.current||sequence!==generation.current)return;client.setQueryData(["branch-lifecycle-summary",branch.id],next);if(next.deleting)setDeleteOpen(false)},onError:(error,sequence)=>{if(active.current&&sequence===generation.current&&error instanceof ApiRequestError&&error.status===404)finishDeleted()}});
 const remove=useMutation({mutationFn:async(observed:BranchLifecycleDto)=>{const next=await requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`,{cache:"no-store"});if(!active.current)throw new Error("The selected workflow changed. Reopen deletion to review it.");if(next.deleting)return {deleted:false,pending:true};if(next.callers.length||next.updates.length)throw new Error("This workflow has callers or a package update. Resolve those blockers before deleting.");if(next.chats!==observed.chats||next.activeExecutions!==observed.activeExecutions)throw new Error("Workflow counts changed. Review the current counts and acknowledge deletion again.");return requestJson<{deleted:boolean;pending:boolean}>(`/api/branches/${branch.id}`,{method:"DELETE"})},onSuccess:r=>{if(!active.current)return;setDeleteOpen(false);setAcknowledged(false);if(r.deleted)finishDeleted();else{void client.invalidateQueries({queryKey:["branches"]});void lifecycle.refetch()}},onError:async()=>{if(!active.current)return;setAcknowledged(false);try{await preflight.mutateAsync(++generation.current)}catch{/* Keep the failed readback visible; never retry DELETE automatically. */}},onSettled:()=>{removing.current=false}});
 const refreshDeletion=()=>{if(removing.current||(preflight.isPending&&preflight.variables===generation.current))return;setAcknowledged(false);preflight.mutate(++generation.current)};
 const closeDeletion=()=>{if(removing.current)return;generation.current++;setDeleteOpen(false);setAcknowledged(false)};
 const deletionBlocked=!preflight.data||preflight.isPending||preflight.isError||preflight.variables!==generation.current||preflight.data.deleting||Boolean(preflight.data.callers.length)||Boolean(preflight.data.updates.length)||Boolean(lifecycle.error)||Boolean(lifecycle.data?.callers.length)||Boolean(lifecycle.data?.updates.length);
 const confirmDeletion=()=>{if(removing.current||!acknowledged||deletionBlocked)return;removing.current=true;remove.mutate(preflight.data!)};
 useBranchDraftGuard(`branch-deletion:${branch.id}`,remove.isPending||(remove.isError&&(preflight.isPending||preflight.isError)));
 useBranchDraftGuard(`branch-capabilities:${branch.id}`,capabilityDirty);
 const callerNames=new Map(lifecycle.data?.callers.map(caller=>[caller.id,caller.name]));
 return <Stack spacing={2} sx={{minWidth:0,width:"100%"}}>
  {lifecycle.error&&<Alert severity="error" action={<Button onClick={()=>void lifecycle.refetch()}>Retry lifecycle</Button>}>Workflow lifecycle could not be refreshed. Deletion is unavailable.</Alert>}
      {!lifecycle.data?.deleting&&!remove.data?.pending&&<CapabilityPolicyEditor endpoint={`/api/branches/${branch.id}/capabilities`} scopeKind="branch" title="Branch capabilities" immediateSave savedNotice="Capability restrictions saved. Current restrictions apply at Branch action boundaries." onDirtyChange={setCapabilityDirty}/>}
      <Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Dependencies</Typography><Typography variant="body2" color="text.secondary">Branch Calls are explicit links. Callers block deletion until the link is removed.</Typography></Box>{dependencies.isPending?<Typography>Loading dependencies…</Typography>:dependencies.error?<Alert severity="error">Dependencies could not be loaded.</Alert>:<><Box><Typography variant="subtitle2">This workflow calls</Typography><Typography color="text.secondary">{dependencies.data?.calls.length?dependencies.data.calls.map(item=>item.ref).join(", "):"No other Branches"}</Typography></Box><Box><Typography variant="subtitle2">Called by</Typography><Typography color="text.secondary">{dependencies.data?.callers.length?[...new Set(dependencies.data.callers.map(item=>item.id))].map(id=>callerNames.get(id)??id).join(", "):"No other Branches"}</Typography></Box></>}</Stack></Paper>
      <Paper variant="outlined" sx={{p:{xs:2,sm:2.5},borderColor:"error.dark"}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Delete workflow</Typography><Typography variant="body2" color="text.secondary">Deletes this Branch, its owned Chats, and its Agents. Active executions are canceled and drained first; source folders are preserved.</Typography></Box>{lifecycle.data?.updates.map(update=><Alert key={update.id} severity={update.error?"error":"info"}>Package update is applying.{update.error?` Retrying: ${update.error}`:""}</Alert>)}{lifecycle.data?.pendingRemoval.map(resource=><Alert key={resource.id} severity={resource.error?"error":"info"}>{resource.kind} pending removal: {resource.id}. {resource.error??"Waiting for earlier executions to drain."}</Alert>)}{lifecycle.data?.callers.length?<Alert severity="warning">Used by {lifecycle.data.callers.map(c=>c.name).join(", ")}. Remove those calls before deleting this Branch.</Alert>:null}{remove.error&&<Alert severity="error">{remove.error.message}</Alert>}{lifecycle.data?.deleting||remove.data?.pending?<Alert severity="info">Deletion is draining active work. This workflow remains here until cleanup is confirmed.</Alert>:<Button color="error" variant="outlined" sx={{alignSelf:"start"}} disabled={remove.isPending||!lifecycle.data||Boolean(lifecycle.error)||Boolean(lifecycle.data?.callers.length)||Boolean(lifecycle.data?.updates.length)} onClick={()=>{setDeleteOpen(true);refreshDeletion()}}>Delete workflow…</Button>}</Stack></Paper>

      <ResourceDeletionDialog open={deleteOpen} resourceType="workflow" resourceName={branch.name} pending={remove.isPending} pendingLabel="Deleting…" confirmDisabled={!acknowledged||deletionBlocked} error={remove.error||preflight.error?[remove.error?.message,preflight.error?.message].filter(Boolean).join(" "):undefined} onCancel={closeDeletion} onConfirm={confirmDeletion}>
       <Stack spacing={2}><Alert severity="warning">This permanently deletes the workflow definition, versions and execution history, plus its owned Chats and Agents. Active executions are canceled and drained first. Source folders are preserved.</Alert>
        {preflight.isPending&&<Typography role="status">Checking current workflow ownership and dependencies…</Typography>}
        {preflight.isSuccess&&preflight.variables===generation.current&&<Typography>{preflight.data.chats} owned Chats · {preflight.data.activeExecutions} active executions</Typography>}
        {Boolean(preflight.data?.callers.length)&&<Alert severity="warning">Other workflows depend on this workflow. Remove those calls before deleting.</Alert>}
        {Boolean(preflight.data?.updates.length)&&<Alert severity="warning">A package update is applying. Wait for it to finish before deleting.</Alert>}
        <Button disabled={preflight.isPending||remove.isPending} onClick={refreshDeletion}>Check again</Button>
        <FormControlLabel control={<Checkbox checked={acknowledged} disabled={deletionBlocked||remove.isPending} onChange={(_,checked)=>setAcknowledged(checked)}/>} label="I understand this permanently deletes this workflow and its owned Chats and Agents."/>
       </Stack>
      </ResourceDeletionDialog>
  </Stack>;
}
