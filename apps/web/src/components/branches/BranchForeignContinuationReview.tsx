import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import {BranchesClient} from '@ponderosa/core/branches-client';
import {type BranchForeignContinuationInput,type BranchForeignContinuationReview,type BranchForeignContinuationReceipt,type BranchRuntimeDataReadback} from '@ponderosa/core';
import {currentProductScope,productApiPath} from '../../api/productScope';
import {createClientId} from '../../clientId';
import {branchRoutePath} from '../../branchesRouting';
import {canonical} from './branchRuntimePackage';
import {PrivateJson} from './BranchRuntimePackageReview';
import {foreignCommandStorageKey,foreignReceiptMatches,foreignReviewMatches,readForeignCommand} from './branchForeignContinuation';

/** Mounted only for an original standalone installation; the server is the family/authority gate. */
export function BranchForeignContinuationReview({saved,sourceExecutionId,executionId}:{saved:BranchRuntimeDataReadback;sourceExecutionId:string;executionId:string}){
 const branchId=saved.receipt.branchId,planId=saved.receipt.planId;
 const storageKey=foreignCommandStorageKey(location.origin,`${currentProductScope()}:${productApiPath('/api/branches')}`,branchId,executionId);
 const client=new BranchesClient(location.origin,(input,init)=>fetch(productApiPath(new URL(String(input)).pathname+new URL(String(input)).search),init));
 const owner=saved.data.owners.find(item=>item.sourceExecutionId===sourceExecutionId);
 let checkpointOwner=owner;
 try {
  for(let depth=0;depth<16&&checkpointOwner;depth++){
   const origin=JSON.parse(checkpointOwner.facts.find(f=>f.kind==='provenance')!.json);
   if(origin.source!=='portable_runtime_data')break;
   const imported=JSON.parse(checkpointOwner.facts.find(f=>f.kind==='import')!.json);
   checkpointOwner=(imported.data as BranchRuntimeDataReadback['data']).owners.find(o=>o.sourceExecutionId===origin.sourceExecutionId);
  }
 }catch{checkpointOwner=undefined}
 const checkpoints=checkpointOwner?.facts.filter(f=>{if(f.kind!=='checkpoint')return false;try{return JSON.parse(f.json).restore_supported===true}catch{return false}})??[];
 const [selected,setSelected]=useState(''),[review,setReview]=useState<BranchForeignContinuationReview>(),[consent,setConsent]=useState(false),[command,setCommand]=useState<BranchForeignContinuationInput>(),[receipt,setReceipt]=useState<BranchForeignContinuationReceipt>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[storageBlocked,setStorageBlocked]=useState(true);
 const lock=useRef(false),epoch=useRef(0),loadedCommand=useRef<BranchForeignContinuationInput|undefined>(undefined);
 const originalMapsMatch=(value:BranchForeignContinuationReview)=>value.manifestSha256===saved.data.sha256&&value.ownerSha256===owner?.sha256&&canonical(value.nativeMaps)===canonical(saved.receipt);
 useLayoutEffect(()=>{
  loadedCommand.current=undefined;setCommand(undefined);setReceipt(undefined);setReview(undefined);setConsent(false);setSelected('');setError('');setBusy(false);setStorageBlocked(true);
  try{const retained=readForeignCommand(localStorage.getItem(storageKey),planId,sourceExecutionId);loadedCommand.current=retained;setCommand(retained);setStorageBlocked(false)}catch(e){setError(String(e))}
  return()=>{epoch.current++};
 },[storageKey,planId,sourceExecutionId]);
 // Reopening only reads the original receipt; it never repeats acceptance.
 useEffect(()=>{
  if(!command||loadedCommand.current!==command)return;
  let active=true;const token=epoch.current;setBusy(true);
  void client.foreignContinuationReceipt(branchId,executionId,command.commandKey).then(result=>{
   if(!active||token!==epoch.current)return;
   if(!foreignReceiptMatches(result,branchId,executionId,command)||!originalMapsMatch(result.review))throw Error('Original continuation receipt differs; held');
   setReceipt(result);setError('');
  }).catch(e=>{if(active&&token===epoch.current)setError(String(e))}).finally(()=>{if(active&&token===epoch.current)setBusy(false)});
  return()=>{active=false};
 },[storageKey,command]);
 const fact=checkpoints.find(f=>f.key===selected);
 const selection=fact?{planId,sourceExecutionId,checkpointKey:fact.key,checkpointSha256:fact.sha256}:undefined;
 async function act(action:'review'|'confirm'|'recover'){
  if(lock.current||busy||(storageBlocked&&action!=='recover'))return;lock.current=true;setBusy(true);setError('');const token=epoch.current;
  const current=()=>token===epoch.current;
  try{
   if(action==='recover'){
    if(!command)throw Error('Original command unavailable');
    const result=await client.foreignContinuationReceipt(branchId,executionId,command.commandKey);
    if(!foreignReceiptMatches(result,branchId,executionId,command)||!originalMapsMatch(result.review))throw Error('Original continuation receipt differs; held');
    if(current())setReceipt(result);
   }else{
    if(command||!selection)throw Error('Choose an exact original checkpoint; pending commands allow status lookup only');
    const fresh=await client.reviewForeignContinuation(branchId,executionId,selection);
    if(!current())return;
    if(!foreignReviewMatches(fresh,branchId,executionId,selection)||!originalMapsMatch(fresh))throw Error('Current review differs; held');
    if(action==='review'){setReview(fresh);setConsent(false);return}
    if(!consent||!review||fresh.reviewSha256!==review.reviewSha256){setReview(fresh);setConsent(false);throw Error('Current authority changed. Inspect the new review and consent again')}
    const input:BranchForeignContinuationInput={...selection,commandKey:createClientId('foreign:'),reviewSha256:review.reviewSha256,acceptCurrentAuthority:true};
    // Persist and read back before mutation; a lost result never permits another POST.
    try{
     if(localStorage.getItem(storageKey)!==null)throw Error('An original command already exists; reopen for status only');
     localStorage.setItem(storageKey,JSON.stringify(input));
     if(JSON.stringify(readForeignCommand(localStorage.getItem(storageKey),planId,sourceExecutionId))!==JSON.stringify(input))throw Error('Original command storage failed; held');
    }catch(e){setStorageBlocked(true);throw e}
    setCommand(input);setConsent(false);
    const result=await client.continueForeignCheckpoint(branchId,executionId,input);
    if(!foreignReceiptMatches(result,branchId,executionId,input)||!originalMapsMatch(result.review))throw Error('Continuation receipt differs; held');
    if(current())setReceipt(result);
   }
  }catch(e){if(current()){setError(String(e));setConsent(false);setReview(undefined)}}finally{lock.current=false;if(current())setBusy(false)}
 }
 return <Stack spacing={1}><Typography variant="h6">Continue a standalone Script checkpoint</Typography><Alert severity="warning">Manual, synchronous, serial Scripts with JSON state and condition/route controls only. The original owner stays held. Filesystem contents are not restored. Fresh current destination authority is required; unsupported or unknown effects remain held.</Alert>{error&&<Alert severity="error">{error}</Alert>}{command?<><Typography>Original command retained · no automatic retry or replacement command</Typography><Button disabled={busy} onClick={()=>void act('recover')}>{busy?'Checking saved result…':'Refresh saved result'}</Button></>:<><TextField select label="Original checkpoint" value={selected} disabled={busy||storageBlocked} onChange={e=>{epoch.current++;setSelected(e.target.value);setReview(undefined);setConsent(false)}}>{checkpoints.map(f=><MenuItem key={f.key} value={f.key}>{f.key} · {f.sha256}</MenuItem>)}</TextField>{fact&&<PrivateJson label="Exact original checkpoint evidence" value={fact.json}/>}<Button disabled={busy||storageBlocked||!selection} onClick={()=>void act('review')}>Review current continuation authority</Button>{review&&<><PrivateJson label="Current definition, bindings, configuration, directories, policy, budget and original maps" value={review}/>{review.sharedState&&<><Typography>Resume state revision {review.sharedState.selected.revision} · latest saved revision {review.sharedState.latest.revision}</Typography><PrivateJson label="Selected state, latest saved state and reducers" value={review.sharedState}/></>}{!!review.controls?.length&&<PrivateJson label="Condition and route controls" value={review.controls}/>}<Typography sx={{overflowWrap:'anywhere'}}>Review SHA-256 {review.reviewSha256}</Typography><FormControlLabel control={<Checkbox checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>} label="I reviewed this exact checkpoint and current destination choices, including directory identity, policy, budget and selected state. I authorize a fresh manual execution with no secrets or source authority."/><Button disabled={busy||!consent||storageBlocked} onClick={()=>void act('confirm')}>Accept current authority and continue</Button></>}</>}{receipt&&<><Alert severity="success">Fresh continuation accepted · original imported owner remains held</Alert><PrivateJson label="Fresh continuation receipt and identity maps" value={receipt}/><Button href={branchRoutePath({branchId,tab:'executions',executionId:receipt.executionId})}>Open fresh execution</Button></>}</Stack>;
}
