import {Alert,Button,Checkbox,FormControlLabel,Paper,Stack,Typography} from '@mui/material';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useEffect,useRef,useState} from 'react';
import {api} from '../api';
import {createClientId} from '../clientId';
import {readRecoveryKey,writeRecoveryKey} from './contextRecoveryStorage';
import {productApiPath} from '../api/productScope';

/** Recovery measures retained context; original work and its effects stay unknown. */
export function ContextRecoveryPanel({agentId}:{agentId:string}):JSX.Element {
 const client=useQueryClient();
 const productPath=productApiPath(`/api/agents/${encodeURIComponent(agentId)}/context-recoveries`);
 const storageKey=`ponderosa.context-recovery:${agentId}`;
 const [restored,setRestored]=useState(()=>readRecoveryKey(storageKey));
 const [key,setKey]=useState(restored.key);
 const [open,setOpen]=useState(false),[acknowledged,setAcknowledged]=useState(''),[dismissAck,setDismissAck]=useState('');
 const [starting,setStarting]=useState(false),[changing,setChanging]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const startLock=useRef(false),changeLock=useRef(false);
 const status=useQuery({queryKey:['context-recovery',agentId,productPath,key],enabled:open,queryFn:()=>api.getContextRecovery(agentId,key),retry:false,
  refetchInterval:query=>open&&((starting&&Boolean(key))||query.state.data?.request?.state==='unsupported_fenced'&&['reserved','drained','native_started'].includes(query.state.data.request.progress?.phase??''))?1000:false});
 const boundary=status.data?.boundary,request=status.data?.request;
 const stopped=status.data?.sourceEvidence?.sourceRunStatus==='cancelled';
 const boundaryIdentity=boundary?JSON.stringify(boundary):'';
 const active=request?.state==='unsupported_fenced';
 const settled=active&&(!request.progress||['held','context_accepted'].includes(request.progress.phase));
 useEffect(()=>{
  const changed=(event:StorageEvent)=>{if(event.key!==storageKey)return;const saved=readRecoveryKey(storageKey);setRestored(saved);setKey(saved.key);};
  window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
 },[storageKey]);
 const start=async()=>{
  if(startLock.current||restored.error||key||request||!boundary||acknowledged!==boundaryIdentity)return;
  startLock.current=true;setStarting(true);setError('');setNotice('');
  try{
   const fresh=await status.refetch();
   if(fresh.error)throw fresh.error;
   if(fresh.data?.request||JSON.stringify(fresh.data?.boundary)!==boundaryIdentity){setAcknowledged('');throw new Error('Recovery boundary changed · review status + acknowledge again');}
   const nextKey=createClientId();
   writeRecoveryKey(storageKey,nextKey);
   setKey(nextKey);
   await api.recoverContext(agentId,{idempotencyKey:nextKey,expectedSessionId:boundary.providerSessionId,expectedSourceRunId:boundary.sourceRunId,expectedToolContractHash:boundary.toolContractHash,acknowledgeUnknownEffects:true});
   setNotice(stopped?'Recovery response received · earlier task stays stopped · inspect phase':'Recovery response received · inspect phase · original work unresolved');
  }catch(cause){setError((cause as Error).message);}
  finally{await client.invalidateQueries({queryKey:['context-recovery',agentId]});startLock.current=false;setStarting(false);}
 };
 const change=async(action:'stop'|'dismiss')=>{
  if(changeLock.current||!request||!active)return;
  changeLock.current=true;setChanging(true);setError('');setNotice('');
  try{
   if(action==='stop'){
    const result=await api.stopContextRecovery(agentId,request.id);
    setNotice(result.stopRequested?'Stop requested · inspect phase for completed cleanup':'Recovery stop unconfirmed · inspect current status');
   }else{
    if(!settled||dismissAck!==request.id)return;
    await api.dismissContextRecovery(agentId,request.id);
    writeRecoveryKey(storageKey,'');
    setKey(undefined);setDismissAck('');setAcknowledged('');
    setNotice(stopped?'Hold dismissed · earlier task stays stopped · no original-work replay':'Hold dismissed · original work unresolved · no automatic replay');
   }
  }catch(cause){setError((cause as Error).message);}
  finally{await client.invalidateQueries({queryKey:['context-recovery',agentId]});changeLock.current=false;setChanging(false);}
 };
 return <Paper variant="outlined" sx={{m:1,p:1.5}}><Stack spacing={1}>
  <Button onClick={()=>setOpen(value=>!value)} aria-expanded={open}>Context Recovery</Button>
  {open&&<>
   {status.isFetching&&<Typography role="status">Reading recovery status…</Typography>}
   {(restored.error||error||status.error)&&<Alert severity="error">{restored.error||error||status.error?.message}</Alert>}
   {notice&&<Alert severity="info">{notice}</Alert>}
   {status.data&&<>
    {status.isError&&<Typography color="warning.main" fontWeight={600}>Last Loaded Result</Typography>}
    {!boundary&&!request&&<Typography fontWeight={600}>No Eligible Retained Context Boundary Is Available.</Typography>}
    {request&&<>
     <Typography fontWeight={600}>Recorded Phase: {request.progress?.phase.replaceAll('_',' ')??'Not Recorded'} · {request.state==='dismissed'?'Dismissed':'Dispatch Held'}</Typography>
     {request.progress?.message&&<Typography sx={{overflowWrap:'anywhere'}}>{request.progress.message}</Typography>}
    </>}
    <Typography>Native recovery: {status.data.support.status==='managed_compaction'?'managed compaction':'unsupported'}</Typography>
   </>}
   <Typography variant="body2">{stopped?'Task stopped · new work only · effects unknown':'Retained context inspection · original outcome/effects unknown · no original-work retry'}</Typography>
   <Button disabled={status.isFetching} onClick={()=>void status.refetch()}>Reload Recovery Status</Button>
   {status.data&&<>
    {key&&!request&&<Alert severity="warning">Retained exact key · no recovery record returned · new recovery blocked here</Alert>}
    {request&&<>
     {starting&&!request.progress&&<Typography role="status">Recovery request pending · reading exact operation status</Typography>}
     {request.progress?.phase==='context_accepted'&&<Alert severity="info"><Stack spacing={0.5}><Typography>{stopped?'Context measurement accepted · earlier task stays stopped':'Context measurement accepted · original work/effects unknown'}</Typography><Typography>New independent work · explicit hold dismissal + runtime admission required</Typography></Stack></Alert>}
     {active&&<Button disabled={changing||status.isError} onClick={()=>void change('stop')}>Stop Exact Recovery</Button>}
     {settled&&<><FormControlLabel control={<Checkbox checked={dismissAck===request.id} onChange={event=>setDismissAck(event.target.checked?request.id:'')}/>} label={stopped?"I understand the earlier task stays stopped and dismissal does not replay it":"I understand dismissal leaves original work unresolved and does not replay it"}/><Button disabled={changing||starting||status.isError||dismissAck!==request.id} onClick={()=>void change('dismiss')}>Dismiss Settled Hold</Button></>}
    </>}
    {boundary&&!request&&!key&&!restored.error&&<>
     {status.data.support.status==='unsupported'&&<Alert severity="warning">Structured recovery unmapped · request records hold only · no provider launch or measurable context restoration</Alert>}
     <FormControlLabel control={<Checkbox checked={acknowledged===boundaryIdentity} onChange={event=>setAcknowledged(event.target.checked?boundaryIdentity:'')}/>} label="I understand prior effects remain unknown and this may compact retained native context"/>
     <Button disabled={starting||changing||status.isFetching||status.isError||acknowledged!==boundaryIdentity} onClick={()=>void start()}>Request Context Recovery</Button>
    </>}
    <details><summary style={{minHeight:44,cursor:'pointer',overflowWrap:'anywhere'}}>Source Evidence{status.isError?' · Last Loaded':''}</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({boundary,request,sourceEvidence:status.data.sourceEvidence},null,2)}</Typography></details>
   </>}
  </>}
 </Stack></Paper>;
}
