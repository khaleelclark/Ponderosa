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
 if(!row.auditSelection)return <Alert severity="info">Audit unavailable · missing selector/server support or erased journal cannot be reconstructed</Alert>;
 return <Paper variant="outlined" sx={{p:2}}><Stack spacing={1}>
  <Typography component="h4" variant="subtitle2">Historical Group Audit — Evidence Only</Typography>
  <Typography>Retained audit · independent of scoped refusal / missing owner / missing plaintext key</Typography>
  <Button disabled={read.isPending||!groupAuditSelectionMatches(row)} onClick={()=>read.mutate()}>Read Historical Group Audit</Button>
  {!groupAuditSelectionMatches(row)&&<Alert severity="warning">Audit selection conflict · restart discovery · no key reconstruction</Alert>}
  {read.isPending&&<Typography role="status">Reading historical evidence…</Typography>}
  {read.error&&<Alert severity="warning">{read.error.message} · audit cleared · explicit rediscovery required · no automatic retry</Alert>}
  {audit&&<>
   <Alert severity="warning"><Stack spacing={0.5}><Typography>Historical: true · currentAuthority: false · actionEligible: false · held: true</Typography><Typography>Evidence only · no approval, preparation, admission, cleanup or Agent disclosure authority</Typography></Stack></Alert>
   <Typography>Original source owner {audit.sourceOwnerPresent?'present':'absent'} · historical state {audit.state} · missing identity: no deletion/drain/access proof · unknown imports held</Typography>
   <Alert severity="info">Private payloads suppressed · Request bodies · snapshots · configuration · package bytes</Alert>
   <details><summary>Every Retained Resource, Map, Import Status And Verified Receipt</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(groupAuditProjection(audit),null,2)}</Typography></details>
  </>}
 </Stack></Paper>;
}
