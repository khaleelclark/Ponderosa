import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,FormControlLabel,MenuItem,Stack,TextField,Typography} from '@mui/material';
import {BranchesClient} from '@ponderosa/core/branches-client';
import {type BranchForeignContinuationInput,type BranchForeignContinuationReview,type BranchForeignContinuationReceipt,type BranchRuntimeDataReadback,type BranchRuntimeTreeReadback} from '@ponderosa/core';
import {currentProductScope,productApiPath} from '../../api/productScope';
import {createClientId} from '../../clientId';
import {branchRoutePath} from '../../branchesRouting';
import {canonical} from './branchRuntimePackage';
import {PrivateJson} from './BranchRuntimePackageReview';
import {beforeEntryFrontier,foreignCommandStorageKey,foreignReceiptMatches,foreignReviewMatches,isBeforeEntryReview,readForeignCommand} from './branchForeignContinuation';

/** Original private evidence only; the server proves family and current authority. */
export function BranchForeignContinuationReview({saved,sourceExecutionId,executionId}:{saved:BranchRuntimeDataReadback|BranchRuntimeTreeReadback;sourceExecutionId:string;executionId:string}){
 const branchId='rootBranchId'in saved.receipt?saved.receipt.rootBranchId:saved.receipt.branchId,planId=saved.receipt.planId;
 const storageKey=foreignCommandStorageKey(location.origin,`${currentProductScope()}:${productApiPath('/api/branches')}`,branchId,executionId);
 const client=new BranchesClient(location.origin,(input,init)=>fetch(productApiPath(new URL(String(input)).pathname+new URL(String(input)).search),init));
 const allOwners=saved.data.schema==='ponderosa.branch-runtime-tree.v1'?Object.values(saved.data.branches).flatMap(b=>b.owners):saved.data.owners;
 const owner=allOwners.find(item=>item.sourceExecutionId===sourceExecutionId);
 let checkpointOwner=owner;
 try {
  for(let depth=0;depth<16&&checkpointOwner;depth++){
   const origin=JSON.parse(checkpointOwner.facts.find(f=>f.kind==='provenance')!.json);
   if(origin.source!=='portable_runtime_data')break;
   const imported=JSON.parse(checkpointOwner.facts.find(f=>f.kind===(origin.tree?'tree-import':'import'))!.json);
   const priorOwners=imported.data.schema==='ponderosa.branch-runtime-tree.v1'?Object.values((imported.data as BranchRuntimeTreeReadback['data']).branches).flatMap(b=>b.owners):(imported.data as BranchRuntimeDataReadback['data']).owners;
   checkpointOwner=priorOwners.find(o=>o.sourceExecutionId===origin.sourceExecutionId);
  }
 }catch{checkpointOwner=undefined}
 const checkpoints=checkpointOwner?.facts.filter(f=>{if(f.kind!=='checkpoint')return false;try{return JSON.parse(f.json).restore_supported===true}catch{return false}})??[];
 const beforeEntry=saved.data.schema==='ponderosa.branch-runtime-tree.v1'?undefined:beforeEntryFrontier(owner);
 const choices=[...checkpoints.map(f=>({value:`checkpoint:${f.key}`,fact:f})),...(beforeEntry?[{value:`frontier:${beforeEntry.key}`,fact:beforeEntry}]:[])];
 const [selected,setSelected]=useState(''),[review,setReview]=useState<BranchForeignContinuationReview>(),[consent,setConsent]=useState(false),[command,setCommand]=useState<BranchForeignContinuationInput>(),[receipt,setReceipt]=useState<BranchForeignContinuationReceipt>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[storageBlocked,setStorageBlocked]=useState(true);
 const lock=useRef(false),epoch=useRef(0),loadedCommand=useRef<BranchForeignContinuationInput|undefined>(undefined);
 const originalMapsMatch=(value:BranchForeignContinuationReview)=>{
  if(value.manifestSha256!==saved.data.sha256||value.ownerSha256!==owner?.sha256||canonical(value.nativeMaps)!==canonical(saved.receipt))return false;
  if(!isBeforeEntryReview(value))return true;
  try{const original=beforeEntryFrontier(owner);return !!original&&original.sha256===value.selection.checkpointSha256&&canonical(value.checkpoint)===canonical(JSON.parse(original.json));}catch{return false;}
 };
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
 const fact=choices.find(choice=>choice.value===selected)?.fact;
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
    if(command||!selection)throw Error('Choose an original checkpoint or source; pending commands allow status lookup only');
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
 return <Stack spacing={1}><Typography variant="h6">Continue imported work</Typography><Alert severity="warning">Fresh manual execution · current authority required · original data stays held</Alert>{error&&<Alert severity="error">{error}</Alert>}{command?<><Typography>Original command retained · no automatic retry or replacement command</Typography><Button disabled={busy} onClick={()=>void act('recover')}>{busy?'Checking saved result…':'Refresh saved result'}</Button></>:<><TextField select label="Original checkpoint or source" value={selected} disabled={busy||storageBlocked} onChange={e=>{epoch.current++;setSelected(e.target.value);setReview(undefined);setConsent(false)}}>{choices.map(({value,fact})=><MenuItem key={value} value={value}>{fact.kind==='frontier'?'Check whether source never started':`${fact.key} · ${fact.sha256}`}</MenuItem>)}</TextField>{fact?.kind==='frontier'&&<Alert severity="info">Original source must be available in this installation.</Alert>}{fact&&<PrivateJson label={fact.kind==='frontier'?'Recorded source evidence':'Exact original checkpoint evidence'} value={fact.json}/>}<Button disabled={busy||storageBlocked||!selection} onClick={()=>void act('review')}>Review current continuation authority</Button>{review&&<>{isBeforeEntryReview(review)&&<Alert severity="info">Source checked here · current Agent permissions apply · imported record stays held</Alert>}<PrivateJson label="Current definition, bindings, configuration, directories, policy, budget and original maps" value={review}/>{review.sharedState&&<><Typography>Resume state revision {review.sharedState.selected.revision} · latest saved revision {review.sharedState.latest.revision}</Typography><PrivateJson label="Selected state, latest saved state and reducers" value={review.sharedState}/></>}{review.tree&&<>{review.tree.owners.map(owner=><Typography key={owner.sourceExecutionId} sx={{overflowWrap:'anywhere'}}>{owner.sourceExecutionId} · {owner.selectedState} · destination {owner.branchId}{owner.gates?.selected.length?` · ${owner.gates.selected.filter(g=>g.state==='waiting').length} pending decisions · ${owner.gates.selected.filter(g=>g.state==='resolved').length} completed decisions`:''}</Typography>)}<PrivateJson label="Every current Call destination and selected owner state" value={review.tree}/></>} {review.gates&&<PrivateJson label="Selected gate decisions and pending prompts · latest saved evidence" value={review.gates}/>} {!!review.controls?.length&&<PrivateJson label="Workflow controls" value={review.controls}/>}<Typography sx={{overflowWrap:'anywhere'}}>Review SHA-256 {review.reviewSha256}</Typography><FormControlLabel control={<Checkbox checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>} label={isBeforeEntryReview(review)?"I reviewed the source and current destination choices and authorize a fresh manual execution without secrets.":"I reviewed this exact checkpoint and current destination choices, including directory identity, policy, budget and selected state. I authorize a fresh manual execution with no secrets or source authority."}/><Button disabled={busy||!consent||storageBlocked} onClick={()=>void act('confirm')}>Accept current authority and continue</Button></>}</>}{receipt&&<><Alert severity="success">Fresh continuation accepted · original imported owner remains held</Alert><PrivateJson label="Fresh continuation receipt and identity maps" value={receipt}/><Button href={branchRoutePath({branchId,tab:'executions',executionId:receipt.executionId})}>Open fresh execution</Button></>}</Stack>;
}
