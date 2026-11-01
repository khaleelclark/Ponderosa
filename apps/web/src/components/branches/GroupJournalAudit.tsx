import {useRef,useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Alert,Button,Paper,Stack,Typography} from '@mui/material';
import type {BranchGroupDiscoveryItem,BranchGroupClient,GroupJournalAuditReadback} from '@ponderosa/core';
import {groupAuditSelectionMatches,groupAuditMatches,groupAuditProjection} from './groupJournalAudit';
/** This panel never supplies values to ordinary scoped commands or mutation state. */
export function GroupJournalAudit({row,api,onRead,onStale}:{row:BranchGroupDiscoveryItem;api:BranchGroupClient;onRead():void;onStale():void}):JSX.Element {
 const [audit,setAudit]=useState<GroupJournalAuditReadback>(),epoch=useRef(0);
 const read=useMutation({retry:false,mutationFn:async()=>{
  setAudit(undefined);onRead();const token=++epoch.current;
  if(!groupAuditSelectionMatches(row)||!row.auditSelection)throw Error('No exact server audit selector; rediscover explicitly.');
  // Pass the discovered object intact; never derive a key from the plaintext command.
  const value=await api.journalAudit(row.auditSelection);
  if(!groupAuditMatches(value,row.auditSelection,row.resourceCount))throw Error('Historical selector or held-authority envelope differs; rediscover explicitly.');
  if(token===epoch.current)setAudit(value);
 },onError:()=>{epoch.current++;setAudit(undefined);onStale();}});
 if(!row.auditSelection)return <Alert severity="info">Historical audit is unavailable from this discovery item/server. Rediscovery cannot manufacture an erased journal or missing selector.</Alert>;
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Typography component="h4" variant="subtitle2">Historical group audit — evidence only</Typography>
  <Typography>Read retained evidence independently of a scoped current-owner refusal, missing source owner or legacy missing plaintext key.</Typography>
  <Button disabled={read.isPending||!groupAuditSelectionMatches(row)} onClick={()=>read.mutate()}>Read historical group audit</Button>
  {!groupAuditSelectionMatches(row)&&<Alert severity="warning">The discovered audit selection conflicts with this row. Restart discovery; no key is reconstructed.</Alert>}
  {read.isPending&&<Typography role="status">Reading historical evidence…</Typography>}
  {read.error&&<Alert severity="warning">{read.error.message} Audit cleared. Explicit rediscovery is required; no automatic retry.</Alert>}
  {audit&&<>
   <Alert severity="warning">Historical: true · currentAuthority: false · actionEligible: false · held: true. This evidence cannot authorize approval, preparation, admission, cleanup or disclosure to Agents.</Alert>
   <Typography>Original source owner {audit.sourceOwnerPresent?'present':'absent'} · historical state {audit.state}. Missing identities do not prove deletion, drain or access authority. Unknown imports remain held.</Typography>
   <Alert severity="info">Private Request bodies, snapshots, configuration and package bytes are suppressed by the audit API. Original resource identities, full maps, import statuses and receipts below are evidence only.</Alert>
   <details><summary>Every retained resource, map, import status and verified receipt</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(groupAuditProjection(audit),null,2)}</Typography></details>
  </>}
 </Stack></Paper>;
}
