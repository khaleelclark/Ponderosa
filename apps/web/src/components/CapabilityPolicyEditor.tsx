import BlockOutlinedIcon from "@mui/icons-material/BlockOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import {Alert,Box,Button,Chip,Divider,FormControlLabel,Paper,Skeleton,Stack,Switch,Typography} from "@mui/material";
import type {CapabilityDescriptor,CapabilityPolicyRecord,CapabilityScopeKind,EffectiveCapabilityPolicy} from "@ponderosa/core";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {useEffect,useMemo,useState} from "react";
import {requestJson} from "../api/real";
import {capabilityDraftDirty,reconcileCapabilityDraft,type CapabilityDraft} from "./capabilityPolicyDraft";

interface CapabilityPolicyResponse {
  policy: CapabilityPolicyRecord;
  effective: EffectiveCapabilityPolicy;
  catalog: Array<CapabilityDescriptor&{available:boolean;unavailableReason?:string}>;
}

export function CapabilityPolicyEditor({endpoint,scopeKind,title="Capabilities",onDirtyChange}:{endpoint:string;scopeKind:Extract<CapabilityScopeKind,"branch"|"chat"|"agent">;title?:string;onDirtyChange?(dirty:boolean):void}):JSX.Element {
  const client=useQueryClient();
  const query=useQuery({queryKey:["capability-policy",endpoint],queryFn:()=>requestJson<CapabilityPolicyResponse>(endpoint)});
  const [draft,setDraft]=useState<CapabilityDraft>();
  useEffect(()=>setDraft(undefined),[endpoint]);
  useEffect(()=>{if(query.data)setDraft(current=>reconcileCapabilityDraft(current,query.data!.policy))},[query.data]);
  const dirty=capabilityDraftDirty(draft);
  const conflict=Boolean(dirty&&query.data&&draft&&query.data.policy.revision!==draft.revision);
  useEffect(()=>{onDirtyChange?.(dirty)},[dirty,onDirtyChange]);
  useEffect(()=>()=>onDirtyChange?.(false),[onDirtyChange]);
  const save=useMutation({mutationFn:()=>requestJson<CapabilityPolicyResponse>(endpoint,{method:"PUT",body:JSON.stringify({revision:draft!.revision,restrictedCapabilityIds:draft!.restricted})}),onSuccess:next=>{setDraft({restricted:next.policy.restrictedCapabilityIds,baseline:next.policy.restrictedCapabilityIds,revision:next.policy.revision});client.setQueryData(["capability-policy",endpoint],next)}});
  const groups=useMemo(()=>{
    const grouped=new Map<string,CapabilityPolicyResponse["catalog"]>();
    for(const item of query.data?.catalog??[]){const rows=grouped.get(item.categoryLabel)??[];rows.push(item);grouped.set(item.categoryLabel,rows)}
    return [...grouped.entries()];
  },[query.data]);
  if(query.isPending)return <Stack spacing={1}><Skeleton height={40}/><Skeleton height={120}/><Skeleton height={120}/></Stack>;
  if(query.error||!query.data)return <Alert severity="error">Capabilities could not be loaded. {query.error?.message}</Alert>;
  const own=new Set(draft?.restricted??query.data.policy.restrictedCapabilityIds);
  const toggle=(id:string,allow:boolean)=>setDraft(current=>{const base=current??{restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision};const next=new Set(base.restricted);if(allow)next.delete(id);else next.add(id);return {...base,restricted:[...next].sort()}});
  return <Stack spacing={2}>
    <Box><Typography variant="h6" fontWeight={800}>{title}</Typography><Typography variant="body2" color="text.secondary">Available by default. Restrictions at a broader scope stay in effect, and this {scopeKind} can narrow authority further.</Typography></Box>
    {conflict&&<Alert severity="warning" action={<Button color="inherit" onClick={()=>setDraft({restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision})}>Load latest</Button>}>Capability restrictions changed elsewhere. Load the latest policy, then reapply your edits.</Alert>}
    {save.error&&<Alert severity="error">{save.error.message}</Alert>}
    {save.isSuccess&&!dirty&&<Alert severity="success">Capability restrictions saved. New Runs use the updated tool contract.</Alert>}
    {groups.map(([label,items])=><Paper key={label} variant="outlined" sx={{overflow:"hidden"}}>
      <Typography variant="subtitle2" fontWeight={800} sx={{px:2,py:1.25,bgcolor:"action.hover"}}>{label}</Typography>
      <Divider/>
      {items.map((item,index)=>{
        const source=query.data!.effective.restrictionSources[item.id];
        const inherited=Boolean(source&&source.scopeKind!==scopeKind);
        const restrictedHere=own.has(item.id);
        const effectiveRestricted=inherited||restrictedHere;
        const state=!item.available?(restrictedHere?"Unavailable · restricted here":"Unavailable"):inherited?`Restricted by ${source!.label}`:restrictedHere?"Restricted here":"Available";
        return <Box key={item.id} sx={{px:2,py:1.5,borderTop:index?1:0,borderColor:"divider"}}><Stack direction={{xs:"column",sm:"row"}} gap={1.5} alignItems={{sm:"center"}}>
          <Box sx={{flex:1,minWidth:0}}><Typography fontWeight={650}>{item.label}</Typography><Typography variant="body2" color="text.secondary">{item.description}</Typography>{!item.available&&item.unavailableReason&&<Typography variant="caption" color="text.secondary">{item.unavailableReason}</Typography>}</Box>
          <Chip size="small" variant="outlined" icon={!item.available||effectiveRestricted?<BlockOutlinedIcon/>:<CheckCircleOutlineIcon/>} color={!item.available?"default":effectiveRestricted?"warning":"success"} label={state}/>
          <FormControlLabel sx={{m:0,minWidth:92}} label="Allow" labelPlacement="start" control={<Switch checked={item.available&&!effectiveRestricted} disabled={inherited||(!item.available&&!restrictedHere)} onChange={(_,allow)=>toggle(item.id,allow)}/>}/>
        </Stack></Box>;
      })}
    </Paper>)}
    <Stack direction="row" gap={1}><Button variant="contained" disabled={!dirty||conflict||save.isPending} onClick={()=>save.mutate()}>{save.isPending?"Saving…":"Save capabilities"}</Button>{dirty&&<Button onClick={()=>setDraft({restricted:query.data!.policy.restrictedCapabilityIds,baseline:query.data!.policy.restrictedCapabilityIds,revision:query.data!.policy.revision})}>Discard</Button>}</Stack>
  </Stack>;
}
