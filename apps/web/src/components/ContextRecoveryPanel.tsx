import {Alert,Button,Checkbox,Dialog,DialogActions,DialogContent,DialogTitle,FormControlLabel,Paper,Stack,Typography} from '@mui/material';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useEffect,useRef,useState} from 'react';
import {api} from '../api';
import {createClientId} from '../clientId';
import {readRecoveryKey,writeRecoveryKey} from './contextRecoveryStorage';
import {productApiPath} from '../api/productScope';
import {queryKeys} from '../queryKeys';
import {MutationErrorDetails,useMutationNotification} from './MutationNotifications';
import {useWorkspaceReadOnly} from './WorkspaceReadOnlyContext';

/** Recovery measures retained context; original work and its effects stay unknown. */
export function ContextRecoveryPanel({agentId,projectId,guided=false,required=false,assistant=false,onReview}:{agentId:string;projectId?:string;guided?:boolean;required?:boolean;assistant?:boolean;onReview?():void}):JSX.Element|null {
 const client=useQueryClient();
 const notify=useMutationNotification(),readOnly=useWorkspaceReadOnly();
 const productPath=productApiPath(`/api/agents/${encodeURIComponent(agentId)}/context-recoveries`);
 const storageKey=`ponderosa.context-recovery:${agentId}`;
 const [restored,setRestored]=useState(()=>readRecoveryKey(storageKey));
 const [key,setKey]=useState(restored.key);
 const [open,setOpen]=useState(false),[acknowledged,setAcknowledged]=useState(''),[dismissAck,setDismissAck]=useState('');
 const [starting,setStarting]=useState(false),[changing,setChanging]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const startLock=useRef(false),changeLock=useRef(false);
 const status=useQuery({queryKey:['context-recovery',agentId,productPath,key],enabled:open||guided&&(required||Boolean(key)),queryFn:()=>api.getContextRecovery(agentId,key),retry:guided?2:false,
  refetchInterval:query=>guided
   ? starting||query.state.data?.operationState==='running'||query.state.data?.operationState==='cleanup_pending'?1000:false
   : open&&((starting&&Boolean(key))||query.state.data?.request?.state==='unsupported_fenced'&&['reserved','drained','native_started'].includes(query.state.data.request.progress?.phase??''))?1000:false});
 const boundary=status.data?.boundary,request=status.data?.request;
 const stopped=status.data?.sourceEvidence?.sourceRunStatus==='cancelled';
 const boundaryIdentity=boundary?JSON.stringify(boundary):'';
 const active=request?.state==='unsupported_fenced';
 const settled=active&&(!request.progress||['held','context_accepted'].includes(request.progress.phase));
 const autoChecked=useRef(new Set<string>());
 const autoAttempts=useRef(new Map<string,number>());
 const recoveryIdentity=key&&request?JSON.stringify([key,request.id,request.state,request.progress?.updatedAt,request.progress?.phase]):undefined;
 const automaticExhausted=Boolean(recoveryIdentity&&!starting&&(autoAttempts.current.get(recoveryIdentity)??0)>=3&&!autoChecked.current.has(recoveryIdentity));
 const healthOwner=projectId??request?.projectId;
 useEffect(()=>{
  if(guided&&healthOwner&&(required||request))void client.invalidateQueries({queryKey:queryKeys.agents.health(healthOwner)});
 },[guided,required,healthOwner,request?.id,request?.progress?.phase,status.data?.operationState]);
 useEffect(()=>{
  const changed=(event:StorageEvent)=>{if(event.key!==storageKey)return;const saved=readRecoveryKey(storageKey);setRestored(saved);setKey(saved.key);};
  window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
 },[storageKey]);
 const refresh=async()=>{
  await Promise.all([
   client.invalidateQueries({queryKey:['context-recovery',agentId]}),
   client.invalidateQueries({queryKey:queryKeys.agents.detailPrefix(agentId)}),
   client.invalidateQueries({queryKey:queryKeys.conversations.detailAll}),
   client.invalidateQueries({queryKey:queryKeys.inboxAll}),
   client.invalidateQueries({queryKey:queryKeys.notifications.all}),
  ]);
 };
 const recoverGuided=async(consent=false,automaticIdentity?:string)=>{
  if(startLock.current||readOnly)return;
  startLock.current=true;setStarting(true);setError('');
  try {
   if(!navigator.locks)throw Error('Use a browser with Web Locks to safely coordinate recovery across tabs.');
   await navigator.locks.request(`ponderosa.context-recovery:${productPath}`,{ifAvailable:true},async lock=>{
    if(!lock)return;
    const saved=readRecoveryKey(storageKey);
    if(saved.error)throw Error(saved.error);
    if(saved.productPath&&saved.productPath!==productPath)throw Error('The saved recovery belongs to another workspace. Open that workspace to inspect it.');
    const fresh=await api.getContextRecovery(agentId,saved.key);
    const prior=fresh.request;
    if(saved.key&&prior?.state==='dismissed'&&prior.progress?.phase==='context_accepted') {
     writeRecoveryKey(storageKey,'');setKey(undefined);setRestored({});setOpen(false);notify({key:`context-recovery:${productPath}`,message:'Recovery Verified',dismiss:true});return;
    }
    if(fresh.blocker){if(automaticIdentity)autoChecked.current.add(automaticIdentity);throw Error(fresh.blocker.message);}
    const boundary=prior??saved.boundary??fresh.boundary;
    if(!boundary)throw Error('No eligible recovery boundary is available. Review the Agent’s activity.');
    const binding={providerSessionId:boundary.providerSessionId,sourceRunId:boundary.sourceRunId,toolContractHash:boundary.toolContractHash,sourceFence:boundary.sourceFence};
    const current=fresh.boundary;
    if(!prior&&(!current||JSON.stringify(binding)!==JSON.stringify({providerSessionId:current.providerSessionId,sourceRunId:current.sourceRunId,toolContractHash:current.toolContractHash,sourceFence:current.sourceFence})))throw Error('Recovery boundary changed. Review the Agent’s activity before continuing.');
    if(!prior&&!consent) return;
    if(!prior&&JSON.stringify(fresh.boundary)!==boundaryIdentity)throw Error('Recovery boundary changed. Read the updated explanation before recovering.');
    const operationKey=saved.key??createClientId();
    if(!saved.boundary)writeRecoveryKey(storageKey,operationKey,{boundary:binding,productPath});
    setKey(operationKey);setRestored({key:operationKey,boundary:binding,productPath});
    let failure:unknown;
    try {
     await api.recoverContext(agentId,{idempotencyKey:operationKey,expectedSessionId:binding.providerSessionId,expectedSourceRunId:binding.sourceRunId,expectedToolContractHash:binding.toolContractHash,expectedSourceFence:binding.sourceFence,acknowledgeUnknownEffects:true,settleRecoveredContext:true});
    } catch(cause){failure=cause;}
    const observed=await api.getContextRecovery(agentId,operationKey);
    if(observed.request?.state==='dismissed'&&observed.request.progress?.phase==='context_accepted') {
     // Still under the same product/Agent lock: never clear a newer tab's identity.
     if(readRecoveryKey(storageKey).key===operationKey)writeRecoveryKey(storageKey,'');
     setKey(undefined);setRestored({});setOpen(false);
     notify({key:`context-recovery:${productPath}`,message:'Recovery Verified',dismiss:true});
    } else {
     if(automaticIdentity&&observed.request&&observed.request.progress?.phase!=='context_accepted'&&observed.operationState!=='running')autoChecked.current.add(automaticIdentity);
     if(failure&&observed.operationState!=='running'&&observed.request?.progress?.phase!=='context_accepted')throw failure;
    }
   });
  }catch(cause){
   const message=cause instanceof Error?cause.message:'Recovery could not be verified.';setError(message);
   if(!automaticIdentity||autoChecked.current.has(automaticIdentity)||(autoAttempts.current.get(automaticIdentity)??0)>=3)
    notify({key:`context-recovery:${productPath}`,incident:key??boundaryIdentity,message:'Recovery Needs Review',details:message,severity:'error',persistent:true});
  }finally{startLock.current=false;setStarting(false);await refresh();}
 };
 useEffect(()=>{
  if(!guided||!key||starting||status.isError||!request)return;
  const phase=request.progress?.phase;
  if(status.data?.blocker&&!(request.state==='dismissed'&&phase==='context_accepted'))return;
  if(!(request.state==='dismissed'&&phase==='context_accepted'||phase==='context_accepted'||phase==='native_started'&&status.data?.operationState==='idle'))return;
  const identity=recoveryIdentity!;
  const attempts=autoAttempts.current.get(identity)??0;
  if(autoChecked.current.has(identity)||attempts>=3)return;
  const timer=setTimeout(()=>{autoAttempts.current.set(identity,attempts+1);void recoverGuided(false,identity);},attempts*500);
  return()=>clearTimeout(timer);
 },[guided,key,starting,status.data,status.isError]);
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
 if(guided) {
  if(!required&&!key&&!open)return null;
  const running=status.data?.operationState==='running';
  const cleanup=status.data?.operationState==='cleanup_pending';
  const uncertain=request?.progress?.nativeInvoked&&request.progress.phase!=='context_accepted'&&!running;
  const needsReview=automaticExhausted||Boolean(request&&request.state!=='dismissed'&&!running&&!cleanup&&request.progress?.phase!=='context_accepted');
  const unsupported=status.data?.support.status==='unsupported';
  const blocker=status.data?.blocker;
  const name=assistant?'Assistant':'Agent';
  const title=status.isError?'Recovery Status Unavailable':running?'Recovering':cleanup?'Recovery Cleanup Pending':uncertain?'Recovery Result Unconfirmed':needsReview?'Recovery Needs Review':`${name} Needs Recovery`;
  const explanation=status.isError?'The latest recovery state could not be checked. Saved input and the operation key are retained; check recovery status before another action.':running?'Restoring the retained session. Your new message is saved.':cleanup?'Recovery process cleanup must finish before conversation can continue. Your message is saved.':blocker?.message??(automaticExhausted?'The exact recovery could not be reconciled after bounded checks. Your message is saved. Check this operation or review Agent activity; native input will not be replayed.':uncertain?'The native recovery result is unconfirmed. Review the recorded operation; compaction will not be repeated.':needsReview?'The recorded recovery stopped before a verified result. Review Agent activity and the recorded operation. Your new message is saved; a different recovery key will not be created.':unsupported?'This provider does not support recovery of this retained session. Review Agent settings and the earlier work.':`The earlier session was interrupted. Your new message is saved. Recover ${name} to continue; the earlier task’s outcome stays unknown.`);
  return <Paper variant="outlined" sx={{mx:1,my:0.5,p:1,borderColor:'divider'}}><Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
   <Typography role="status" variant="body2" sx={{flex:1}}>{title}</Typography>
   <Button disabled={readOnly} onClick={()=>setOpen(true)}>{status.isError||running||cleanup||needsReview||uncertain||unsupported||blocker?'Review Recovery':`Recover ${name}`}</Button>
  </Stack><Dialog open={open} onClose={()=>setOpen(false)} maxWidth="sm" fullWidth><DialogTitle>{title}</DialogTitle><DialogContent><Stack spacing={1}>
   <Typography>{explanation}</Typography>
   {!running&&!cleanup&&!needsReview&&!uncertain&&!unsupported&&!blocker&&<Typography variant="body2">Recovery may compact this same native session without repeating the earlier task or resolving its unknown effects; verified recovery resumes eligible saved input.</Typography>}
   <MutationErrorDetails title="Recovery Details" error={restored.error||error||status.error}/>
   {request?.progress?.message&&<Typography variant="body2">{request.progress.message}</Typography>}
   {status.data&&<details><summary style={{minHeight:44,alignContent:'center',cursor:'pointer'}}>Recorded Recovery Details</summary><Typography component="pre" sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({boundary,request,sourceEvidence:status.data.sourceEvidence},null,2)}</Typography></details>}
  </Stack></DialogContent><DialogActions>
   <Button onClick={()=>setOpen(false)}>Close</Button>
   {onReview&&(needsReview||uncertain||unsupported||blocker||error||restored.error)&&<Button onClick={onReview}>Review Agent Activity</Button>}
   {(status.isError||!status.data)&&<Button disabled={starting||status.isFetching} onClick={()=>void status.refetch().then(result=>{notify(result.error?{key:`context-recovery:${productPath}`,incident:key??boundaryIdentity,message:'Recovery Check Failed',details:result.error.message,severity:'error'}:{key:`context-recovery:${productPath}`,message:'Recovery Status Checked',dismiss:true});})}>Check Recovery Status</Button>}
   {blocker?.kind==='authentication'&&status.data?.engineId&&<Button disabled={starting||readOnly} onClick={()=>{setStarting(true);void api.recheckEngine(status.data!.engineId!).catch(cause=>{setError((cause as Error).message);notify({key:`context-recovery:${productPath}`,message:'Provider Sign-In Check Failed',details:(cause as Error).message,severity:'error'});}).finally(()=>{setStarting(false);void refresh();});}}>Recheck Provider Sign-In</Button>}
   {cleanup&&request&&<Button disabled={changing||readOnly} onClick={()=>void change('stop')}>Check Process Cleanup</Button>}
   {!running&&!cleanup&&!needsReview&&!uncertain&&!unsupported&&!blocker&&<Button disabled={starting||readOnly||status.isFetching||status.isError||Boolean(restored.error)} onClick={()=>void recoverGuided(true)}>{starting?'Checking Recovery…':key?'Reconcile Exact Recovery':`Recover ${name}`}</Button>}
   {(uncertain||automaticExhausted)&&!blocker&&<Button disabled={starting||readOnly} onClick={()=>void recoverGuided()}>Check Exact Recovery</Button>}
  </DialogActions></Dialog></Paper>;
 }
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
