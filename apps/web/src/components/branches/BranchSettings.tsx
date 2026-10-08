import {BranchExecutionBudget} from "./BranchExecutionBudget";
import {useBranchDraftGuard,useBranchNavigationGuard} from './BranchNavigation';
import {useEffect,useRef,useState} from "react";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Alert,Box,Button,FormControlLabel,Paper,Stack,Switch,Tab,Tabs,TextField,Typography} from "@mui/material";
import type {BranchConfiguration,BranchDefinition,BranchDto,BranchLifecycleDto} from "@ponderosa/core";
import {requestJson} from "../../api/real";
import {CapabilityPolicyEditor} from "../CapabilityPolicyEditor";
import {ProviderActivityCard} from "../ProviderActivityCard";

type Section="general"|"execution"|"capabilities"|"activity"|"dependencies"|"danger";

export function BranchSettings({branch,definition,parameters=false,onDeleted}:{branch:BranchDto;definition:BranchDefinition;parameters?:boolean;onDeleted?():void}):JSX.Element {
  const guard=useBranchNavigationGuard();
  const client=useQueryClient(),[draft,setDraft]=useState<BranchConfiguration>(),[revision,setRevision]=useState<number>(),[section,setSection]=useState<Section>("general"),[capabilityDirty,setCapabilityDirty]=useState(false);
  const baseline=useRef<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>();
  const settings=useQuery({queryKey:["branch-settings",branch.id],queryFn:()=>requestJson<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>(`/api/branches/${branch.id}/settings`)});
  useEffect(()=>{baseline.current=undefined;setDraft(undefined);setRevision(undefined)},[branch.id]);
  useEffect(()=>{if(!settings.data)return;const locallyDirty=Boolean(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration));if(!locallyDirty){baseline.current=settings.data;setDraft(settings.data.configuration);setRevision(settings.data.revision)}},[settings.data,draft]);
  const lifecycle=useQuery({queryKey:["branch-lifecycle",branch.id],queryFn:()=>requestJson<BranchLifecycleDto>(`/api/branches/${branch.id}/lifecycle`),refetchInterval:3000});
  const dependencies=useQuery({queryKey:["branch-dependencies",branch.id],queryFn:()=>requestJson<{calls:Array<{id:string;ref:string}>;callers:Array<{id:string;ref:string}>}>(`/api/branches/${branch.id}/dependencies`),enabled:!parameters});
  const remove=useMutation({mutationFn:()=>requestJson<{deleted:boolean;pending:boolean}>(`/api/branches/${branch.id}`,{method:"DELETE"}),onSuccess:r=>{void client.invalidateQueries({queryKey:["branches"]});void lifecycle.refetch();if(r.deleted)onDeleted?.()}});
  const save=useMutation({mutationFn:()=>requestJson<{configuration:BranchConfiguration;revision:number;secretStatus?:Record<string,string>}>(`/api/branches/${branch.id}/settings`,{method:"PUT",body:JSON.stringify({configuration:draft,revision})}),onSuccess:next=>{baseline.current=next;setDraft(next.configuration);setRevision(next.revision);client.setQueryData(["branch-settings",branch.id],next);void client.invalidateQueries({queryKey:["branch-settings",branch.id]})}});
  const availability=useMutation({mutationFn:(enabled:boolean)=>requestJson(`/api/branches/${branch.id}/availability`,{method:"PUT",body:JSON.stringify({enabled})}),onSuccess:()=>{void client.invalidateQueries({queryKey:["branch",branch.id]});void client.invalidateQueries({queryKey:["branches"]})}});
  useBranchDraftGuard('branch-settings',Boolean(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration)));
  useBranchDraftGuard('branch-capabilities',capabilityDirty);
  if(!draft&&settings.error)return <Alert severity="error" action={<Button onClick={()=>void settings.refetch()}>Retry configuration</Button>}>Configuration could not be loaded. {settings.error.message}</Alert>;
  if(!draft)return <Typography role="status">Loading configuration…</Typography>;
  const setParameter=(key:string,value:string|number|boolean|undefined)=>{const parameters={...draft.parameters};if(value===undefined)delete parameters[key];else parameters[key]=value;setDraft({...draft,parameters})};
  const parameterErrors=Object.entries(definition.parameters??{}).flatMap(([key,p])=>{if(p.type==='secret')return [];const value=draft.parameters[key]??p.default;return p.required&&(value===undefined||value==='')?[`${p.label??key} is required.`]:p.type==='number'&&value!==undefined&&(typeof value!=='number'||!Number.isFinite(value))?[`${p.label??key} must be a finite number.`]:[]});
  const invalidLimits=Object.values(draft.limits).some(value=>!Number.isSafeInteger(value)||value<1);
  if(parameters)return <Stack spacing={2} sx={{maxWidth:760}}>
    {(settings.error||save.error)&&<Alert severity="error">{settings.error?.message||save.error?.message}</Alert>}
    {parameterErrors.length>0&&<Alert severity="warning">{parameterErrors.join(' ')}</Alert>}
    {save.isSuccess&&<Alert severity="success">Parameters saved. New executions use these values.</Alert>}
    <Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Installation parameters</Typography><Typography variant="body2" color="text.secondary">Use {'{{parameter:name}}'} in workflow text fields such as Agent instructions and gate prompts. Scripts read JSON from PONDEROSA_PARAMETERS; Script source is not interpolated. File contents are never loaded automatically.</Typography></Box>
      {!Object.keys(definition.parameters??{}).length&&<Typography color="text.secondary">No parameters declared. Add parameter definitions in the Workflow editor.</Typography>}
      {Object.entries(definition.parameters??{}).map(([key,p])=>p.type==="secret"?<Alert severity="info" key={key}>{p.label??key}: {settings.data?.secretStatus?.[key]==="configured"?"Configured local binding":"Missing local binding"}. Secrets are available only to supported Engine-owned integrations.</Alert>:p.type==="boolean"?<FormControlLabel key={key} label={p.label??key} control={<Switch checked={Boolean(draft.parameters[key]??p.default??false)} onChange={(_,v)=>setParameter(key,v)}/>}/>:<TextField key={key} label={p.label??key} required={p.required} helperText={p.help} type={p.type==="number"?"number":"text"} value={draft.parameters[key]??p.default??""} onChange={e=>setParameter(key,p.type==="number"?(e.target.value===''?undefined:Number(e.target.value)):e.target.value)}/>)}
      <Button variant="contained" sx={{alignSelf:"start"}} disabled={save.isPending||!branch.versionId||parameterErrors.length>0} onClick={()=>save.mutate()}>Save parameters</Button>
    </Stack></Paper>
  </Stack>;
  const nav:ReadonlyArray<{id:Section;label:string}>=[
    {id:"general",label:"General"},
    {id:"execution",label:"Execution"},
    {id:"capabilities",label:"Capabilities"},
    {id:"activity",label:"Provider Activity"},
    {id:"dependencies",label:"Dependencies"},
    {id:"danger",label:"Delete workflow"},
  ];
  return <Stack spacing={2} sx={{width:"100%",minWidth:0}}>
    <Tabs aria-label="Workflow settings sections" value={section} variant="scrollable" allowScrollButtonsMobile onChange={(_,next:Section)=>guard(()=>{if(draft&&baseline.current&&JSON.stringify(draft)!==JSON.stringify(baseline.current.configuration)){setDraft(baseline.current.configuration);setRevision(baseline.current.revision)}setCapabilityDirty(false);setSection(next)})} sx={{maxWidth:"100%",borderBottom:1,borderColor:"divider"}}>
      {nav.map(item=><Tab key={item.id} value={item.id} label={item.label}/>)}
    </Tabs>
    <Stack spacing={2} sx={{minWidth:0,maxWidth:900,width:"100%"}}>
      {(settings.error||save.error||availability.error)&&<Alert severity="error">{settings.error?.message||save.error?.message||availability.error?.message}</Alert>}
      {section==="general"&&<Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>General</Typography><Typography variant="body2" color="text.secondary">Control whether this workflow can accept new work.</Typography></Box><FormControlLabel label="Branch enabled" control={<Switch checked={branch.enabled!==false} disabled={availability.isPending} onChange={(_,v)=>availability.mutate(v)}/>}/><Typography variant="body2" color="text.secondary">Disabling the Branch pauses manual runs and incoming Branch Calls. Waiting callers resume when it is enabled. Automatic trigger intake has its own control under Executions.</Typography></Stack></Paper>}
      {section==="execution"&&<BranchExecutionBudget branchId={branch.id} settings/>}
      {section==="execution"&&<Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Limits within an execution</Typography><Typography variant="body2" color="text.secondary">These ceilings stop runaway recursion and traversal with an explicit workflow failure.</Typography></Box>{([['maxCallDepth','Nested Branch depth'],['maxLoopIterations','Loop iterations'],['maxTraversals','Graph traversals']] as const).map(([key,label])=><TextField key={key} label={label} type="number" error={!Number.isSafeInteger(draft.limits[key])||draft.limits[key]<1} helperText="A positive whole number is required." value={draft.limits[key]} onChange={e=>setDraft({...draft,limits:{...draft.limits,[key]:Number(e.target.value)}})}/>)}{save.isSuccess&&<Alert severity="success">Execution settings saved.</Alert>}<Button variant="contained" sx={{alignSelf:"start"}} disabled={save.isPending||!branch.versionId||invalidLimits} onClick={()=>save.mutate()}>Save execution settings</Button></Stack></Paper>}
      {section==="capabilities"&&<CapabilityPolicyEditor endpoint={`/api/branches/${branch.id}/capabilities`} scopeKind="branch" title="Branch capabilities" onDirtyChange={setCapabilityDirty}/>}
      {section==="activity"&&<ProviderActivityCard initialScopeKey={`branch:${branch.id}`} scopes={[{scope:"branch",id:branch.id,label:`Branch · ${branch.name}`},{scope:"branches",label:"All Branches"}]} title="Branch Provider Activity"/>}
      {section==="dependencies"&&<Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Dependencies</Typography><Typography variant="body2" color="text.secondary">Branch Calls are explicit links. Callers block deletion until the link is removed.</Typography></Box>{dependencies.isPending?<Typography>Loading dependencies…</Typography>:dependencies.error?<Alert severity="error">Dependencies could not be loaded.</Alert>:<><Box><Typography variant="subtitle2">This workflow calls</Typography><Typography color="text.secondary">{dependencies.data?.calls.length?dependencies.data.calls.map(item=>item.ref).join(", "):"No other Branches"}</Typography></Box><Box><Typography variant="subtitle2">Called by</Typography><Typography color="text.secondary">{lifecycle.data?.callers.length?lifecycle.data.callers.map(item=>item.name).join(", "):"No other Branches"}</Typography></Box></>}</Stack></Paper>}
      {section==="danger"&&<Paper variant="outlined" sx={{p:{xs:2,sm:2.5},borderColor:"error.dark"}}><Stack spacing={2}><Box><Typography variant="h6" fontWeight={800}>Delete workflow</Typography><Typography variant="body2" color="text.secondary">Deletes this Branch, its owned Chats, and its Agents. Active executions are canceled and drained first; source folders are preserved.</Typography></Box>{lifecycle.data?.updates.map(update=><Alert key={update.id} severity={update.error?"error":"info"}>Package update is applying.{update.error?` Retrying: ${update.error}`:""}</Alert>)}{lifecycle.data?.pendingRemoval.map(resource=><Alert key={resource.id} severity={resource.error?"error":"info"}>{resource.kind} pending removal: {resource.id}. {resource.error??"Waiting for earlier executions to drain."}</Alert>)}{lifecycle.data?.callers.length?<Alert severity="warning">Used by {lifecycle.data.callers.map(c=>c.name).join(", ")}. Remove those calls before deleting this Branch.</Alert>:null}{remove.error&&<Alert severity="error">{remove.error.message}</Alert>}{lifecycle.data?.deleting?<Alert severity="info">Deletion is draining active work.</Alert>:<Button color="error" variant="outlined" sx={{alignSelf:"start"}} disabled={remove.isPending||Boolean(lifecycle.data?.callers.length)||Boolean(lifecycle.data?.updates.length)} onClick={()=>{if(window.confirm(`Delete ${branch.name}? This cancels ${lifecycle.data?.activeExecutions??0} active executions and deletes ${lifecycle.data?.chats??0} owned Chats and their Agents after cleanup.`))remove.mutate()}}>Delete workflow…</Button>}</Stack></Paper>}
    </Stack>
  </Stack>;
}
