import {Alert,Box,Button} from '@mui/material';
import {useEffect,useRef,useState} from 'react';
import {currentProductScope} from './api/productScope';
import type {AssistantMountApi,AssistantMountProps,AssistantMountWindow} from './assistantMount';

type EntryManifest={entries?:{assistant?:{initial?:{js?:string[]}}}};
let runtimeLoad:Promise<AssistantMountApi>|undefined;
async function loadAssistantRuntime():Promise<AssistantMountApi>{
 const existing=(window as AssistantMountWindow).__ponderosaAssistantMount;
 if(existing)return existing;
 runtimeLoad??=(async()=>{
  const response=await fetch('/assistant-assets/manifest.json',{cache:'no-store'});
  if(!response.ok)throw Error('Assistant assets could not be loaded.');
  const manifest=await response.json() as EntryManifest;
  const scripts=manifest.entries?.assistant?.initial?.js;
  if(!scripts?.length||scripts.some(src=>!/^\/assistant-assets\/static\/js\/[A-Za-z0-9/._-]+\.js$/.test(src)))throw Error('Assistant assets are unavailable.');
  for(const src of scripts){
   await new Promise<void>((resolve,reject)=>{
    const script=document.createElement('script');script.src=src;script.async=false;
    script.onload=()=>resolve();script.onerror=()=>reject(Error('Assistant assets could not be loaded.'));
    document.head.append(script);
   });
  }
  const api=(window as AssistantMountWindow).__ponderosaAssistantMount;
  if(!api)throw Error('Assistant did not start.');
  return api;
 })().catch(error=>{runtimeLoad=undefined;throw error;});
 return runtimeLoad;
}

/** Keeps the live Core sidebar and the canonical Branch-owned Assistant together without sharing API module state. */
export function AssistantSurface(props:AssistantMountProps):JSX.Element{
 const host=useRef<HTMLDivElement|null>(null),api=useRef<AssistantMountApi>();
 const latest=useRef(props);latest.current=props;
 const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 const [opening,setOpening]=useState(true);
 useEffect(()=>{
  let active=true;
  void loadAssistantRuntime().then(runtime=>{
   if(!active||!host.current)return;
   if(currentProductScope()!=='dev'||runtime.productScope()!=='branches')throw Error('Assistant transport is not isolated from Ponderosa.');
   runtime.mount(host.current,latest.current);api.current=runtime;setOpening(false);
  }).catch(cause=>{if(active){setOpening(false);setError(cause instanceof Error?cause.message:String(cause));}});
  return()=>{active=false;api.current?.unmount();api.current=undefined;};
 },[attempt]);
 useEffect(()=>{api.current?.update(props);},[props]);
 return <Box sx={{height:'100%',minHeight:0,minWidth:0,display:'flex',flexDirection:'column'}}>
  {opening&&!error&&<Box role="status" sx={{p:2,color:"text.secondary"}}>Opening Assistant…</Box>}
  {error&&<Alert severity="error" action={<Button onClick={()=>{setError('');setOpening(true);setAttempt(value=>value+1);}}>Retry</Button>}>{error}</Alert>}
  <Box ref={host} data-assistant-root sx={{flex:1,minHeight:0,minWidth:0,display:'flex','& > *':{flex:1,minHeight:0,minWidth:0}}}/>
 </Box>;
}
