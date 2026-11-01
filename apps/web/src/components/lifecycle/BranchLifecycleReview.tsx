import {useRef,useState} from 'react';
import {useMutation,useQuery} from '@tanstack/react-query';
import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {CheckpointPackageSource,CheckpointCaptureAbandonmentReviewDto} from '@ponderosa/core';
import {requestJson} from '../../api/real';
import {currentProductScope} from '../../api/productScope';
import {ApiRequestError} from '../../api/types';
import {createClientId} from '../../clientId';
import {ConfirmDialog} from '../ConfirmationDialogs';
import {useWorkspaceReadOnly} from '../WorkspaceReadOnlyContext';
import {lifecycleReceiptMatches,sameLifecycleInput,restoreLifecycleCommand,type LifecycleCommand} from './lifecycleCommand';
/** Only canonical owner references supply checkpoint IDs and original command keys. */
export function BranchLifecycleReview({source,enabled=true}:{source:CheckpointPackageSource;enabled?:boolean}):JSX.Element {
 const [open,setOpen]=useState(false),[selected,setSelected]=useState<string[]>([]),[capture,setCapture]=useState(''),[captureReview,setCaptureReview]=useState<CheckpointCaptureAbandonmentReviewDto>(),[ack,setAck]=useState(false),[confirm,setConfirm]=useState<LifecycleCommand>(),[notice,setNotice]=useState('');
 const key=JSON.stringify(['branch-lifecycle',window.location.origin,currentProductScope(),source]);
 const [restored]=useState(()=>restoreLifecycleCommand(key));
 const [pending,setPending]=useState<LifecycleCommand|undefined>(restored.command);
 const [receipt,setReceipt]=useState<unknown>();
 const readOnly=useWorkspaceReadOnly()||!enabled||Boolean(restored.error),fence=useRef(false),epoch=useRef(0);
 const review=useQuery({queryKey:['branch-lifecycle-review',source],queryFn:async()=>{
  const value=await requestJson<Record<string,unknown>>('/api/lifecycle/branch-custody/review',{method:'POST',body:JSON.stringify({source})});
  if(!sameLifecycleInput(value.source,source)||typeof value.custodyId!=='string'||typeof value.revision!=='string'||!Array.isArray(value.references)||!Array.isArray(value.blockers)||!Array.isArray(value.abandonmentBlockers))throw Error('Branch lifecycle scope changed.');return value;
 },enabled:open,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false});
 const reset=()=>{epoch.current++;setSelected([]);setCaptureReview(undefined);setAck(false);setConfirm(undefined);};
 const refresh=async()=>{reset();await review.refetch();};
 const preview=useMutation({retry:false,mutationFn:async()=>{
  const version=epoch.current;
  const value=await requestJson<CheckpointCaptureAbandonmentReviewDto>('/api/lifecycle/checkpoint-captures/abandonment-review',{method:'POST',body:JSON.stringify({source,captureKey:capture})});
  if(value.custodyId!==review.data?.custodyId||value.branchRevision!==review.data?.revision)throw Error('Capture or Branch scope changed. Refresh evidence.');return {value,version};
 },onSuccess:({value,version})=>{if(version===epoch.current){setCaptureReview(value);setAck(false);}},onError:error=>{setNotice(error.message);setCaptureReview(undefined);setAck(false);}});
 const send=useMutation({retry:false,mutationFn:async(command:LifecycleCommand)=>{
  if(readOnly||!['/api/lifecycle/branch-custody/retire-checkpoints','/api/lifecycle/checkpoint-captures/abandon'].includes(command.path)||!('source' in command.body)||!sameLifecycleInput(command.body.source,source))throw Error('Branch lifecycle scope unavailable.');
  localStorage.setItem(key,JSON.stringify(command));setPending(command);
  const receipt=await requestJson(command.path,{method:'POST',body:JSON.stringify(command.body)});
  if(!lifecycleReceiptMatches(command,receipt))throw Error('Receipt differs from the retained command.');
  setReceipt(receipt);localStorage.removeItem(key);setPending(undefined);setNotice('Canonical disposition confirmed; original evidence remains preserved.');void refresh();
 },onError:error=>{setNotice(`Outcome unconfirmed; no automatic retry. ${error.message}`);if(error instanceof ApiRequestError&&error.status===409)void refresh();},onSettled:()=>{fence.current=false;setConfirm(undefined);setAck(false);}});
 const value=review.data;
 const refs=(Array.isArray(value?.references)?value.references:[]).filter((item):item is Record<string,unknown>=>Boolean(item&&typeof item==='object'));
 const checkpoints=refs.filter(item=>item.kind==='checkpoint'&&item.ownerId===source.intent.executionId&&typeof item.key==='string'&&/^[1-9]\d*$/.test(item.key)&&Number.isSafeInteger(Number(item.key))&&typeof item.sha256==='string');
 const commands=refs.filter(item=>item.kind==='command'&&item.ownerId===source.intent.executionId&&typeof item.key==='string');
 const busy=send.isPending||preview.isPending||review.isFetching,ready=Boolean(value&&!review.isError&&!busy&&!readOnly&&!pending&&ack);
 const stage=(kind:'checkpoint'|'capture')=>{
  if(!ready||!value)return;const commandKey=createClientId(),id=String(value.custodyId);
  if(kind==='checkpoint'&&selected.length){const body={source,commandKey,expectedRevision:String(value.revision),checkpoints:checkpoints.filter(item=>selected.includes(String(item.key))).map(item=>({id:Number(item.key),sha256:String(item.sha256)}))};if(body.checkpoints.length!==selected.length)return;setConfirm({path:'/api/lifecycle/branch-custody/retire-checkpoints',id,action:'retire-checkpoints',body});}
  if(kind==='capture'&&captureReview&&!captureReview.references.length&&!captureReview.blockers.length)setConfirm({path:'/api/lifecycle/checkpoint-captures/abandon',id,action:'abandon',body:{source,captureKey:capture,commandKey,reviewSha256:captureReview.reviewSha256,preserveEvidence:true}});
 };
 return <><Button size="small" onClick={()=>{reset();setOpen(true);}}>Review Branch evidence</Button><Dialog open={open} fullWidth maxWidth="sm" onClose={()=>{if(!busy){reset();setOpen(false);}}} disableEscapeKeyDown={busy}><DialogTitle>Branch custody lifecycle</DialogTitle><DialogContent><Stack spacing={2} sx={{pt:1}}>
  <Typography sx={{overflowWrap:'anywhere'}}>Source Run {source.intent.executionId} · Chat {source.sourceChatId} · checkpoint {source.checkpointId}</Typography>
  <Button disabled={busy} onClick={()=>void refresh()}>Refresh owner references</Button>
  {restored.error&&<Alert severity="error">{restored.error}</Alert>}
  {review.error&&<Alert severity="error">{review.error.message}</Alert>}{notice&&<Alert severity="info">{notice}</Alert>}
  <Alert severity="warning">Preserve all original package bytes and selected snapshot rows. Unknown effects and other source pins stay held.</Alert>
  {value&&!review.isError&&<><details><summary>Exact source, revision and blockers</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto',fontSize:12}}>{JSON.stringify(value,null,2)}</Typography></details>
   {checkpoints.map(item=><FormControlLabel key={String(item.key)} control={<Checkbox checked={selected.includes(String(item.key))} disabled={busy||Boolean(pending)||selected.length>=128&&!selected.includes(String(item.key))} onChange={(_,checked)=>{setSelected(previous=>checked?[...previous,String(item.key)]:previous.filter(id=>id!==item.key));setAck(false);setConfirm(undefined);}}/>} label={`Retire checkpoint ${item.key} · ${item.sha256}`}/>)}
   <Typography variant="caption">Initial checkpoints are never selected automatically or retired here.</Typography>
   <TextField select label="Canonical owner command to inspect" value={commands.some(item=>item.key===capture)?capture:''} disabled={busy||Boolean(pending)} onChange={event=>{setCapture(event.target.value);reset();}}><MenuItem value="">Choose command</MenuItem>{commands.map(item=><MenuItem key={String(item.key)} value={String(item.key)}>{String(item.key)}</MenuItem>)}</TextField>
   <Button disabled={busy||!capture||Boolean(pending)} onClick={()=>preview.mutate()}>Review capture abandonment</Button>
   {captureReview&&<Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(captureReview,null,2)}</Typography>}
   <FormControlLabel control={<Checkbox checked={ack} disabled={busy||Boolean(pending)||readOnly} onChange={(_,checked)=>setAck(checked)}/>} label="I reviewed this exact source, selection and revision"/>
   <Button color="error" disabled={!ready||!selected.length} onClick={()=>stage('checkpoint')}>Retire selected checkpoint history</Button>
   <Button color="error" disabled={!ready||!captureReview||Boolean(captureReview?.references.length||captureReview?.blockers.length)} onClick={()=>stage('capture')}>Abandon reviewed capture</Button>
  </>}
  {receipt!==undefined&&<details><summary>Canonical disposition receipt</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify(receipt,null,2)}</Typography></details>}
  {pending&&<><Alert severity="warning">Exact command retained. No pure command receipt lookup is provided for this operation. Retry only the unchanged input.</Alert><Button disabled={busy||readOnly} onClick={()=>setConfirm(pending)}>Retry exact lifecycle command</Button></>}
 </Stack></DialogContent><DialogActions><Button disabled={busy} onClick={()=>{reset();setOpen(false);}}>Close</Button></DialogActions></Dialog>
 <ConfirmDialog open={Boolean(confirm)} title="Preserve evidence and retire this state?" confirmLabel="Confirm exact disposition" pending={send.isPending} confirmDisabled={readOnly||fence.current} onCancel={()=>setConfirm(undefined)} onConfirm={()=>{if(!confirm||fence.current)return;fence.current=true;send.mutate(confirm);}}><Typography sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{confirm?JSON.stringify(confirm.body,null,2):''}</Typography></ConfirmDialog></>;
}
