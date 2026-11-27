import BlockOutlinedIcon from "@mui/icons-material/BlockOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import {Accordion,AccordionDetails,AccordionSummary,Alert,Box,Button,Chip,Divider,FormControlLabel,Paper,Stack,Switch,Typography} from "@mui/material";
import {CAPABILITY_IDS,parseConnectorCapabilityId,type CapabilityCatalogEntry,type CapabilityPolicyHistory,type CapabilityPolicyResponse,type CapabilityScopeKind,type ConnectedToolsResponse} from "@ponderosa/core";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {useInfiniteQuery,useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {useEffect,useId,useMemo,useRef,useState} from "react";
import {currentProductScope} from "../api/productScope";
import {useUnsavedForm} from "../reloadSafety";
import {requestJson} from "../api/real";
import {useMutationNotification} from "./MutationNotifications";
import {capabilityDraftDirty,reconcileCapabilityDraft,type CapabilityDraft} from "./capabilityPolicyDraft";

export type {CapabilityPolicyResponse} from "@ponderosa/core";

type CapabilityPolicyEditorProps = { endpoint: string; scopeKind: Extract<CapabilityScopeKind,"product"|"branch"|"chat"|"agent">;
  title?: string; description?: string; immediateSave?: boolean;
  onSavingChange?(saving: boolean): void; onDirtyChange?(dirty: boolean): void };
export function CapabilityPolicyEditor(props: CapabilityPolicyEditorProps): JSX.Element {
  // Changing owners discards old query/mutation state, including late responses.
  return <CapabilityPolicyEditorContent key={props.endpoint} {...props} />;
}
function CapabilityPolicyEditorContent({endpoint,scopeKind,title="Tool permissions",description,immediateSave=false,onDirtyChange,onSavingChange}: CapabilityPolicyEditorProps): JSX.Element {
  const client=useQueryClient(),notify=useMutationNotification();
  const restrictionId=useId();
  const query=useQuery({queryKey:["capability-policy",endpoint],queryFn:({signal})=>requestJson<CapabilityPolicyResponse>(endpoint,{signal})});
  const [connectedOpen,setConnectedOpen]=useState(false);
  const refreshConnected=useRef(false);
  const connectedKey=["connected-tools",endpoint];
  const connected=useQuery({
    queryKey:connectedKey,enabled:connectedOpen,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false,
    queryFn:async({signal})=>{
      const refresh=refreshConnected.current;
      refreshConnected.current=false;
      const inventory=await requestJson<ConnectedToolsResponse>(`${endpoint}/connected-tools${refresh?"?refresh=1":""}`,{signal,cache:"no-store"});
      if(!inventory.discoveryFailed)return inventory;
      const prior=client.getQueryData<ConnectedToolsResponse>(connectedKey)?.catalog??[];
      const lastKnown=new Set(prior.map(item=>item.id));
      return {...inventory,catalog:[...prior,...inventory.catalog.filter(item=>!lastKnown.has(item.id))]};
    }
  });
  const refreshInventory=()=>{
    if(client.isFetching({queryKey:connectedKey,exact:true}))return;
    refreshConnected.current=true;
    void connected.refetch({cancelRefetch:false});
  };
  const [historyOpen,setHistoryOpen]=useState(false);
  const history=useInfiniteQuery({queryKey:["capability-history",endpoint,query.data?.policy.revision],
    initialPageParam:undefined as number|undefined, enabled:historyOpen,
    queryFn:({pageParam})=>requestJson<CapabilityPolicyHistory>(`${endpoint}/history${pageParam===undefined?"":`?beforeRevision=${pageParam}`}`),
    getNextPageParam:page=>page.nextBeforeRevision});
  const [draft,setDraft]=useState<CapabilityDraft>(),writing=useRef(false);
  useEffect(()=>{setDraft(undefined);save.reset()},[endpoint]);
  useEffect(()=>{if(query.data)setDraft(current=>reconcileCapabilityDraft(current,query.data!.policy))},[query.data]);
  const dirty=capabilityDraftDirty(draft);
  const conflict=Boolean(dirty&&query.data&&draft&&query.data.policy.revision!==draft.revision);
  const reloadPolicy=async(duringSave=false)=>{if(!immediateSave){await query.refetch();return;}if(writing.current&&!duringSave)return;writing.current=true;try{const next=await requestJson<CapabilityPolicyResponse>(endpoint,{cache:"no-store"});setDraft({restricted:next.policy.restrictedCapabilityIds,baseline:next.policy.restrictedCapabilityIds,revision:next.policy.revision});client.setQueryData(["capability-policy",endpoint],next)}catch{/* Only a completed HTTP readback can retire the uncertain draft. */}finally{if(!duringSave)writing.current=false}};
  const save=useMutation({
    mutationFn:(next:CapabilityDraft)=>requestJson<CapabilityPolicyResponse>(endpoint,{
      method:"PUT",body:JSON.stringify({revision:next.revision,restrictedCapabilityIds:next.restricted}),
    }),
    onMutate:()=>client.cancelQueries({queryKey:["capability-policy",endpoint],exact:true}),
    onSuccess:(next,submitted)=>{
      const saved=next.policy.restrictedCapabilityIds;
      setDraft({restricted:saved,baseline:saved,revision:next.policy.revision});
      client.setQueryData(["capability-policy",endpoint],next);
      const changed=[...submitted.baseline.filter(id=>!saved.includes(id)),...saved.filter(id=>!submitted.baseline.includes(id))];
      const nextRun=changed.some(id=>id===CAPABILITY_IDS.filesystemWrite||parseConnectorCapabilityId(id));
      notify({key:`capability-policy:${endpoint}`,message:"Settings Saved",...(nextRun?{description:"Provider tool changes apply on the next run."}:{})});
    },
    onError:()=>reloadPolicy(true),
    onSettled:()=>{writing.current=false},
    retry:false,
  });
  useUnsavedForm(`tool-permissions:${endpoint}`,immediateSave&&currentProductScope()!=="branches"&&(dirty||save.isPending));
  useEffect(()=>{onDirtyChange?.(dirty||(immediateSave&&save.isPending))},[dirty,immediateSave,save.isPending,onDirtyChange]);
  useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
  useEffect(()=>{onSavingChange?.(save.isPending)},[save.isPending,onSavingChange]);
  useEffect(()=>()=>onSavingChange?.(false),[onSavingChange]);
  const groups=useMemo(()=>{
    const grouped=new Map<string,CapabilityPolicyResponse["catalog"]>();
    for(const item of query.data?.catalog??[]){if(parseConnectorCapabilityId(item.id))continue;const rows=grouped.get(item.categoryLabel)??[];rows.push(item);grouped.set(item.categoryLabel,rows)}
    return [...grouped.entries()];
  },[query.data]);
  const heading=<Box sx={{maxWidth:"75ch"}}><Typography variant="h6" component="h2" fontWeight={800}>{title}</Typography>{description&&<Typography variant="body2" color="text.secondary">{description}</Typography>}</Box>;
  const policyError=query.error&&<Alert severity="error" action={<Button color="inherit" disabled={query.isFetching||save.isPending} onClick={()=>void reloadPolicy()}>Retry</Button>}>Tool permissions could not be loaded. {query.error.message}</Alert>;
  if(!query.data)return <Stack component="section" aria-label={title} spacing={2}>{heading}{query.isPending?<Typography role="status">Loading tool permissions…</Typography>:policyError}</Stack>;
  const own=new Set(draft?.restricted??query.data.policy.restrictedCapabilityIds);
  const toggle=(id:string,allow:boolean)=>{if(writing.current||save.isPending||(immediateSave&&dirty))return;const policy=query.data!.policy,base=immediateSave||!draft?{restricted:policy.restrictedCapabilityIds,baseline:policy.restrictedCapabilityIds,revision:policy.revision}:draft,restricted=new Set(base.restricted);if(allow)restricted.delete(id);else restricted.add(id);const next={...base,restricted:[...restricted].sort()};setDraft(next);if(immediateSave){writing.current=true;save.mutate(next)}};
  const connectedRows=new Map(query.data.catalog.filter(item=>parseConnectorCapabilityId(item.id)).map(item=>[item.id,item]));
  for(const item of connected.data?.catalog??[])connectedRows.set(item.id,item);
  const discoveryError=connected.error?.message??(connected.data?.discoveryFailed?"Some connected tools could not be loaded.":undefined);
  const renderRows=(items:CapabilityCatalogEntry[])=>items.map((item,index)=>{
        const source=query.data!.effective.restrictionSources[item.id];
        const inherited=Boolean(source&&(source.scopeKind!==scopeKind||source.scopeId!==query.data!.policy.scopeId));
        const explanationId=inherited?`${restrictionId}-${item.id}`:undefined;
        const inheritedLabel=source?.scopeKind==="global"||source?.scopeKind==="product"?"Restricted by workspace settings":`Restricted by ${source?.label}`;
        const restrictedHere=own.has(item.id);
        const effectiveRestricted=inherited||restrictedHere;
        const state=!item.available?(restrictedHere?"Unavailable · restricted here":"Unavailable"):effectiveRestricted?(inherited?"Restricted":"Restricted here"):"Allowed";
        return <Box key={item.id} sx={{px:2,py:1.5,borderTop:index?1:0,borderColor:"divider"}}><Stack direction="row" gap={1.5} sx={{flexWrap:"wrap",alignItems:"center"}}>
          <Box sx={{flex:"1 1 200px",minWidth:0,overflowWrap:"anywhere"}}><Typography fontWeight={650}>{item.label}</Typography><Typography variant="body2" color="text.secondary">{item.description}</Typography>{!item.available&&item.unavailableReason&&<Typography variant="caption" color="text.secondary">{item.unavailableReason}</Typography>}</Box>
          <Chip size="small" variant="outlined" sx={{maxWidth:"100%",height:"auto","& .MuiChip-label":{color:item.available&&!effectiveRestricted?"text.primary":undefined,whiteSpace:"normal",overflowWrap:"anywhere",py:0.25}}} icon={!item.available||effectiveRestricted?<BlockOutlinedIcon/>:<CheckCircleOutlineIcon/>} color={!item.available?"default":effectiveRestricted?"warning":"success"} label={state}/>
          <Stack spacing={0.25} sx={{ml:"auto",alignItems:"flex-end",minWidth:0}}>
            <FormControlLabel sx={{m:0,minWidth:92,flexShrink:0}} label="Allow" labelPlacement="start" control={
              <Switch slotProps={{input:{"aria-label":`Allow ${item.label}`,"aria-describedby":explanationId}}}
                checked={item.available&&!effectiveRestricted}
                disabled={save.isPending||(immediateSave&&dirty)||inherited||(!item.available&&!restrictedHere)}
                onChange={(_,allow)=>toggle(item.id,allow)}/>
            }/>
            {inherited&&<Typography id={explanationId} variant="caption" color="text.secondary"
              sx={{overflowWrap:"anywhere",textAlign:"right"}}>{inheritedLabel}</Typography>}
          </Stack>
        </Stack><Box component="details" sx={{mt:1,"& summary":{cursor:"pointer",fontSize:"0.875rem",color:"text.secondary"},"& summary:focus-visible":{outline:"2px solid",outlineColor:"primary.main",outlineOffset:2}}}><summary>Included Tools{item.includedTools?.length?` (${item.includedTools.length})`:""}</summary><Stack spacing={1} sx={{pt:1}}>{item.includedTools?.map(tool=><Box key={tool.name} sx={{minWidth:0,overflowWrap:"anywhere"}}><Typography variant="body2" fontWeight={650}>{tool.name}</Typography><Typography variant="body2" color="text.secondary">{tool.description??"The provider did not report a description for this tool."}</Typography></Box>)}{item.toolDetailsReason&&<Typography variant="body2" color="text.secondary">{item.toolDetailsReason}</Typography>}{!item.includedTools?.length&&!item.toolDetailsReason&&<Typography variant="body2" color="text.secondary">No tool definitions are currently reported.</Typography>}</Stack></Box></Box>;
  });
  return <Stack component="section" aria-label={title} spacing={2} sx={{minWidth:0,containerType:"inline-size",containerName:"capabilities"}}>
    {heading}
    {policyError}
    {conflict&&<Alert severity="warning" action={<Button disabled={save.isPending} color="inherit" onClick={()=>immediateSave?void reloadPolicy():setDraft({restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision})}>Load Latest</Button>}>Capability restrictions changed elsewhere. Load the latest policy, then reapply your edits.</Alert>}
    {save.error&&<Alert severity="error">{save.error.message}{immediateSave&&" Reload the current policy, review its state, then reapply your change if needed."} <Button disabled={save.isPending} onClick={()=>void reloadPolicy()}>Reload Current Policy</Button></Alert>}
    {immediateSave&&save.isPending&&<Typography role="status">Saving…</Typography>}
    <Box sx={{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:2,alignItems:"start","@container capabilities (min-width:68.75rem)":{gridTemplateColumns:"repeat(2,minmax(0,1fr))"}}}>
    {groups.map(([label,items])=><Paper key={label} variant="outlined" sx={{overflow:"hidden"}}>
      <Typography variant="subtitle2" component="h3" fontWeight={800} sx={{px:2,py:1.25,bgcolor:"action.hover"}}>{label}</Typography>
      <Divider/>
      {renderRows(items)}
    </Paper>)}
    </Box>
    <Accordion expanded={connectedOpen} onChange={(_,open)=>setConnectedOpen(open)}>
      <AccordionSummary expandIcon={<ExpandMoreIcon/>}>Connected tools</AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1}>
          {connected.isFetching&&<Typography role="status">{connected.data?"Refreshing connected tools…":"Loading connected tools…"}</Typography>}
          {discoveryError&&<Alert severity="error" action={<Button color="inherit" disabled={connected.isFetching} onClick={refreshInventory}>Retry</Button>}>{discoveryError}</Alert>}
          {connected.data?.selectionLimited&&<Typography variant="body2" color="text.secondary">Showing services from the first 100 distinct Agent setups. Open an Agent’s Settings for its exact services.</Typography>}
          {connectedRows.size>0&&<Paper variant="outlined">{renderRows([...connectedRows.values()])}</Paper>}
          {!connectedRows.size&&connected.data&&!discoveryError&&<Typography variant="body2" color="text.secondary">No connected tools reported.</Typography>}
          {connected.data&&!discoveryError&&<Button sx={{alignSelf:"start"}} disabled={connected.isFetching} onClick={refreshInventory}>Refresh</Button>}
        </Stack>
      </AccordionDetails>
    </Accordion>
    <Accordion expanded={historyOpen} onChange={(_,expanded)=>setHistoryOpen(expanded)}>
      <AccordionSummary>Permission change history</AccordionSummary>
      <AccordionDetails><Stack spacing={2}>
        <Typography variant="body2">History starts at upgrade · operator changes use Settings or the operator API</Typography>
        {history.isPending&&<Typography role="status">Loading history…</Typography>}
        {history.error&&<Alert severity="error">Permission history could not be loaded. {history.error.message}<Button onClick={()=>void history.refetch()}>Retry</Button></Alert>}
        {history.data?.pages.flatMap(page=>page.changes).map(change=><Box key={change.revision} sx={{overflowWrap:"anywhere"}}>
          <Typography fontWeight={650}>Revision {change.revision} · {change.actor === "operator" ? "Operator" : "System"} · {change.changedAt}</Typography>
          <Typography variant="body2">{change.reason}</Typography>
          <Typography variant="body2">Restricted before: {change.before.join(", ")||"None"}</Typography>
          <Typography variant="body2">Restricted after: {change.after.join(", ")||"None"}</Typography>
        </Box>)}
        {history.data&&!history.data.pages[0]?.changes.length&&<Typography>No recorded changes.</Typography>}
        {history.hasNextPage&&<Button disabled={history.isFetchingNextPage} onClick={()=>void history.fetchNextPage()}>Load Earlier Changes</Button>}
      </Stack></AccordionDetails>
    </Accordion>
    {!immediateSave&&<Stack direction="row" gap={1}><Button variant="contained" disabled={!dirty||conflict||save.isPending} onClick={()=>save.mutate(draft!)}>{save.isPending?"Saving…":"Save Capabilities"}</Button>{dirty&&<Button disabled={save.isPending} onClick={()=>setDraft({restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision})}>Discard</Button>}</Stack>}
  </Stack>;
}
