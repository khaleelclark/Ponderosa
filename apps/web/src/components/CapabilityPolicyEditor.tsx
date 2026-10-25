import BlockOutlinedIcon from "@mui/icons-material/BlockOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import {Alert,Box,Button,Chip,Divider,FormControlLabel,Paper,Skeleton,Stack,Switch,Typography} from "@mui/material";
import type {CapabilityPolicyResponse,CapabilityScopeKind} from "@ponderosa/core";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {useEffect,useMemo,useRef,useState} from "react";
import {currentProductScope} from "../api/productScope";
import {useUnsavedForm} from "../reloadSafety";
import {requestJson} from "../api/real";
import {capabilityDraftDirty,reconcileCapabilityDraft,type CapabilityDraft} from "./capabilityPolicyDraft";

export type {CapabilityPolicyResponse} from "@ponderosa/core";

type CapabilityPolicyEditorProps = { endpoint: string; scopeKind: Extract<CapabilityScopeKind,"product"|"branch"|"chat"|"agent">;
  title?: string; description?: string; savedNotice?: string; immediateSave?: boolean;
  onSavingChange?(saving: boolean): void; onDirtyChange?(dirty: boolean): void };
export function CapabilityPolicyEditor(props: CapabilityPolicyEditorProps): JSX.Element {
  // Changing owners discards old query/mutation state, including late responses.
  return <CapabilityPolicyEditorContent key={props.endpoint} {...props} />;
}
function CapabilityPolicyEditorContent({endpoint,scopeKind,title="Capabilities",description,savedNotice,immediateSave=false,onDirtyChange,onSavingChange}: CapabilityPolicyEditorProps): JSX.Element {
  const client=useQueryClient();
  const query=useQuery({queryKey:["capability-policy",endpoint],queryFn:()=>requestJson<CapabilityPolicyResponse>(endpoint)});
  const [draft,setDraft]=useState<CapabilityDraft>(),writing=useRef(false);
  useEffect(()=>{setDraft(undefined);save.reset()},[endpoint]);
  useEffect(()=>{if(query.data)setDraft(current=>reconcileCapabilityDraft(current,query.data!.policy))},[query.data]);
  const dirty=capabilityDraftDirty(draft);
  const conflict=Boolean(dirty&&query.data&&draft&&query.data.policy.revision!==draft.revision);
  const reloadPolicy=async(duringSave=false)=>{if(!immediateSave){await query.refetch();return;}if(writing.current&&!duringSave)return;writing.current=true;try{const next=await requestJson<CapabilityPolicyResponse>(endpoint,{cache:"no-store"});setDraft({restricted:next.policy.restrictedCapabilityIds,baseline:next.policy.restrictedCapabilityIds,revision:next.policy.revision});client.setQueryData(["capability-policy",endpoint],next)}catch{/* Only a completed HTTP readback can retire the uncertain draft. */}finally{if(!duringSave)writing.current=false}};
  const save=useMutation({mutationFn:(next:CapabilityDraft)=>requestJson<CapabilityPolicyResponse>(endpoint,{method:"PUT",body:JSON.stringify({revision:next.revision,restrictedCapabilityIds:next.restricted})}),onSuccess:next=>{setDraft({restricted:next.policy.restrictedCapabilityIds,baseline:next.policy.restrictedCapabilityIds,revision:next.policy.revision});client.setQueryData(["capability-policy",endpoint],next)},onError:()=>reloadPolicy(true),onSettled:()=>{writing.current=false},retry:false});
  useUnsavedForm(`tool-permissions:${endpoint}`,immediateSave&&currentProductScope()!=="branches"&&(dirty||save.isPending));
  useEffect(()=>{onDirtyChange?.(dirty||(immediateSave&&save.isPending))},[dirty,immediateSave,save.isPending,onDirtyChange]);
  useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
  useEffect(()=>{onSavingChange?.(save.isPending)},[save.isPending,onSavingChange]);
  useEffect(()=>()=>onSavingChange?.(false),[onSavingChange]);
  const groups=useMemo(()=>{
    const grouped=new Map<string,CapabilityPolicyResponse["catalog"]>();
    for(const item of query.data?.catalog??[]){const rows=grouped.get(item.categoryLabel)??[];rows.push(item);grouped.set(item.categoryLabel,rows)}
    return [...grouped.entries()];
  },[query.data]);
  if(query.isPending)return <Stack spacing={1}><Skeleton height={40}/><Skeleton height={120}/><Skeleton height={120}/></Stack>;
  if(query.error||!query.data)return <Alert severity="error">Capabilities could not be loaded. {query.error?.message}{immediateSave&&<Button disabled={query.isFetching||save.isPending} onClick={()=>void reloadPolicy()}>Reload current policy</Button>}</Alert>;
  const own=new Set(draft?.restricted??query.data.policy.restrictedCapabilityIds);
  const toggle=(id:string,allow:boolean)=>{if(writing.current||save.isPending||(immediateSave&&dirty))return;const policy=query.data!.policy,base=immediateSave||!draft?{restricted:policy.restrictedCapabilityIds,baseline:policy.restrictedCapabilityIds,revision:policy.revision}:draft,restricted=new Set(base.restricted);if(allow)restricted.delete(id);else restricted.add(id);const next={...base,restricted:[...restricted].sort()};setDraft(next);if(immediateSave){writing.current=true;save.mutate(next)}};
  return <Stack spacing={2} sx={{minWidth:0,containerType:"inline-size",containerName:"capabilities"}}>
    <Box sx={{maxWidth:"75ch"}}><Typography variant="h6" fontWeight={800}>{title}</Typography><Typography variant="body2" color="text.secondary">{description??<>Available by default. Restrictions at a broader scope stay in effect, and {scopeKind==="product"?"these defaults":`this ${scopeKind}`} can narrow authority further.</>}</Typography></Box>
    <Typography variant="body2" color="text.secondary" sx={{maxWidth:"75ch"}}>Ponderosa-hosted tools check current restrictions when called. Provider-native filesystem and connector changes apply on the next Run, using a fresh session when its tool contract changes. This does not cancel work already running or make other allowed tools read-only. Actual tool calls remain in Activity.</Typography>
    {query.data.catalogNotice&&<Alert severity="info">{query.data.catalogNotice}</Alert>}
    {conflict&&<Alert severity="warning" action={<Button disabled={save.isPending} color="inherit" onClick={()=>immediateSave?void reloadPolicy():setDraft({restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision})}>Load latest</Button>}>Capability restrictions changed elsewhere. Load the latest policy, then reapply your edits.</Alert>}
    {save.error&&<Alert severity="error">{save.error.message}{immediateSave&&" Reload the current policy, review its state, then reapply your change if needed."} <Button disabled={save.isPending} onClick={()=>void reloadPolicy()}>Reload current policy</Button></Alert>}
    {immediateSave&&save.isPending&&<Typography role="status">Saving…</Typography>}
    {save.isSuccess&&!dirty&&(!immediateSave||savedNotice)&&<Alert severity="success">{savedNotice??"Capability restrictions saved. New Runs use the updated tool contract."}</Alert>}
    <Box sx={{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:2,alignItems:"start","@container capabilities (min-width:1100px)":{gridTemplateColumns:"repeat(2,minmax(0,1fr))"}}}>
    {groups.map(([label,items])=><Paper key={label} variant="outlined" sx={{overflow:"hidden"}}>
      <Typography variant="subtitle2" fontWeight={800} sx={{px:2,py:1.25,bgcolor:"action.hover"}}>{label}</Typography>
      <Divider/>
      {items.map((item,index)=>{
        const source=query.data!.effective.restrictionSources[item.id];
        const inherited=Boolean(source&&(source.scopeKind!==scopeKind||source.scopeId!==query.data!.policy.scopeId));
        const restrictedHere=own.has(item.id);
        const effectiveRestricted=inherited||restrictedHere;
        const state=!item.available?(restrictedHere?"Unavailable · restricted here":"Unavailable"):inherited?`Restricted by ${source!.label}`:restrictedHere?"Restricted here":"Allowed";
        return <Box key={item.id} sx={{px:2,py:1.5,borderTop:index?1:0,borderColor:"divider"}}><Stack direction="row" gap={1.5} sx={{flexWrap:"wrap",alignItems:"center"}}>
          <Box sx={{flex:"1 1 200px",minWidth:0,overflowWrap:"anywhere"}}><Typography fontWeight={650}>{item.label}</Typography><Typography variant="body2" color="text.secondary">{item.description}</Typography>{!item.available&&item.unavailableReason&&<Typography variant="caption" color="text.secondary">{item.unavailableReason}</Typography>}{!item.available&&(inherited||restrictedHere)&&<Typography variant="caption" display="block">{inherited?`Restricted by ${source!.label}`:"Restricted here"}</Typography>}</Box>
          <Chip size="small" variant="outlined" sx={{maxWidth:"100%",height:"auto","& .MuiChip-label":{whiteSpace:"normal",overflowWrap:"anywhere",py:0.25}}} icon={!item.available||effectiveRestricted?<BlockOutlinedIcon/>:<CheckCircleOutlineIcon/>} color={!item.available?"default":effectiveRestricted?"warning":"success"} label={state}/>
          <FormControlLabel sx={{m:0,minWidth:92,flexShrink:0}} label="Allow" labelPlacement="start" control={<Switch slotProps={{input:{"aria-label":`Allow ${item.label}`}}} checked={item.available&&!effectiveRestricted} disabled={save.isPending||(immediateSave&&dirty)||inherited||(!item.available&&!restrictedHere)} onChange={(_,allow)=>toggle(item.id,allow)}/>}/>
        </Stack><Box component="details" sx={{mt:1,"& summary":{cursor:"pointer",fontSize:"0.875rem",color:"text.secondary"},"& summary:focus-visible":{outline:"2px solid",outlineColor:"primary.main",outlineOffset:2}}}><summary>Included tools{item.includedTools?.length?` (${item.includedTools.length})`:""}</summary><Stack spacing={1} sx={{pt:1}}>{item.includedTools?.map(tool=><Box key={tool.name} sx={{minWidth:0,overflowWrap:"anywhere"}}><Typography variant="body2" fontWeight={650}>{tool.name}</Typography><Typography variant="body2" color="text.secondary">{tool.description??"The provider did not report a description for this tool."}</Typography></Box>)}{item.toolDetailsReason&&<Typography variant="body2" color="text.secondary">{item.toolDetailsReason}</Typography>}{!item.includedTools?.length&&!item.toolDetailsReason&&<Typography variant="body2" color="text.secondary">No tool definitions are currently reported.</Typography>}</Stack></Box></Box>;
      })}
    </Paper>)}
    </Box>
    {!immediateSave&&<Stack direction="row" gap={1}><Button variant="contained" disabled={!dirty||conflict||save.isPending} onClick={()=>save.mutate(draft!)}>{save.isPending?"Saving…":"Save capabilities"}</Button>{dirty&&<Button disabled={save.isPending} onClick={()=>setDraft({restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision})}>Discard</Button>}</Stack>}
  </Stack>;
}
