import {Alert,Button,Checkbox,FormControlLabel,Paper,Stack,Typography} from '@mui/material';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useRef,useState} from 'react';
import {api} from '../api';
import {createClientId} from '../clientId';
import {readBrowserStorage,writeBrowserStorage} from '../browserStorage';

/** Recovery measures retained context; original work and its effects stay unknown. */
export function ContextRecoveryPanel({agentId}:{agentId:string}):JSX.Element {
 const client=useQueryClient();
 const storageKey=`ponderosa.context-recovery:${agentId}`;
 const [key,setKey]=useState(()=>readBrowserStorage('localStorage',storageKey)||undefined);
 const [open,setOpen]=useState(false),[acknowledged,setAcknowledged]=useState(''),[dismissAck,setDismissAck]=useState('');
 const [starting,setStarting]=useState(false),[changing,setChanging]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const startLock=useRef(false),changeLock=useRef(false);
 const status=useQuery({queryKey:['context-recovery',agentId,key],enabled:open,queryFn:()=>api.getContextRecovery(agentId,key),retry:false,
  refetchInterval:query=>open&&query.state.data?.request?.state==='unsupported_fenced'&&['reserved','drained','native_started'].includes(query.state.data.request.progress?.phase??'')?1000:false});
 const boundary=status.data?.boundary,request=status.data?.request;
 const boundaryIdentity=boundary?JSON.stringify(boundary):'';
 const active=request?.state==='unsupported_fenced';
 const settled=active&&(!request.progress||['held','context_accepted'].includes(request.progress.phase));
 const start=async()=>{
  if(startLock.current||key||request||!boundary||acknowledged!==boundaryIdentity)return;
  startLock.current=true;setStarting(true);setError('');setNotice('');
  try{
   const fresh=await status.refetch();
   if(fresh.error)throw fresh.error;
   if(fresh.data?.request||JSON.stringify(fresh.data?.boundary)!==boundaryIdentity){setAcknowledged('');throw new Error('Recovery boundary changed · review status + acknowledge again');}
   const nextKey=createClientId();
   if(!writeBrowserStorage('localStorage',storageKey,nextKey))throw new Error('Recovery key not saved · no recovery requested');
   setKey(nextKey);
   await api.recoverContext(agentId,{idempotencyKey:nextKey,expectedSessionId:boundary.providerSessionId,expectedSourceRunId:boundary.sourceRunId,expectedToolContractHash:boundary.toolContractHash,acknowledgeUnknownEffects:true});
   setNotice('Recovery response received · inspect phase · original work unresolved');
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
    if(!writeBrowserStorage('localStorage',storageKey,''))throw new Error('Dismissal returned · local key not cleared · reload status before another action');
    setKey(undefined);setDismissAck('');setAcknowledged('');
    setNotice('Hold dismissed · original work unresolved · no automatic replay');
   }
  }catch(cause){setError((cause as Error).message);}
  finally{await client.invalidateQueries({queryKey:['context-recovery',agentId]});changeLock.current=false;setChanging(false);}
 };
 return <Paper variant="outlined" sx={{m:1,p:1.5}}><Stack spacing={1}>
  <Button onClick={()=>setOpen(value=>!value)} aria-expanded={open}>Context recovery</Button>
  {open&&<>
   <Typography variant="body2">Retained context inspection · original outcome/effects unknown · no original-work retry</Typography>
   {status.isFetching&&<Typography role="status">Reading recovery status…</Typography>}
   {(error||status.error)&&<Alert severity="error">{error||status.error?.message}</Alert>}
   {notice&&<Alert severity="info">{notice}</Alert>}
   <Button disabled={status.isFetching} onClick={()=>void status.refetch()}>Reload recovery status</Button>
   {status.data&&<>
    <Typography>Native recovery: {status.data.support.status==='managed_compaction'?'managed compaction':'unsupported'}</Typography>
    {!boundary&&!request&&<Typography>No eligible uncertain context boundary is available.</Typography>}
    {key&&!request&&<Alert severity="warning">Retained exact key · no recovery record returned · new recovery blocked here</Alert>}
    {request&&<>
     <Typography>Recorded phase: {request.progress?.phase.replaceAll('_',' ')??'unsupported hold'} · {request.state==='dismissed'?'dismissed':'dispatch held'}</Typography>
     {request.progress?.message&&<Typography sx={{overflowWrap:'anywhere'}}>{request.progress.message}</Typography>}
     {request.progress?.phase==='context_accepted'&&<Alert severity="info"><Stack spacing={0.5}><Typography>Context measurement accepted · original work/effects unknown</Typography><Typography>New independent work · explicit hold dismissal + runtime admission required</Typography></Stack></Alert>}
     {active&&<Button disabled={changing||status.isError} onClick={()=>void change('stop')}>Stop exact recovery</Button>}
     {settled&&<><FormControlLabel control={<Checkbox checked={dismissAck===request.id} onChange={event=>setDismissAck(event.target.checked?request.id:'')}/>} label="I understand dismissal leaves original work unresolved and does not replay it"/><Button disabled={changing||starting||status.isError||dismissAck!==request.id} onClick={()=>void change('dismiss')}>Dismiss settled hold</Button></>}
    </>}
    {boundary&&!request&&!key&&<>
     {status.data.support.status==='unsupported'&&<Alert severity="warning">Structured recovery unmapped · request records hold only · no provider launch or measurable context restoration</Alert>}
     <FormControlLabel control={<Checkbox checked={acknowledged===boundaryIdentity} onChange={event=>setAcknowledged(event.target.checked?boundaryIdentity:'')}/>} label="I understand prior effects remain unknown and this may compact retained native context"/>
     <Button disabled={starting||changing||status.isFetching||status.isError||acknowledged!==boundaryIdentity} onClick={()=>void start()}>Request context recovery</Button>
    </>}
    <details><summary>Source evidence</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({boundary,request,sourceEvidence:status.data.sourceEvidence},null,2)}</Typography></details>
   </>}
  </>}
 </Stack></Paper>;
}
