import {Alert,Box,Button} from '@mui/material';
import {useTheme} from '@mui/material/styles';
import {useQuery} from '@tanstack/react-query';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ARTIFACT_PREVIEW_MAX_BYTES} from '@ponderosa/core';
import {api} from '../../api';
import {productApiPath} from '../../api/productScope';
import {TEXT_SIZE_EVENT} from '../../textSize';
import {createClientId} from '../../clientId';
import type {VisualizationBlock,VisualizationScope} from './VisualizationDisplay';

export interface InlineVisualizationProps {block:VisualizationBlock;scope:VisualizationScope}

/** One live inline sandbox; Chat owns vertical scrolling. */
export function InlineVisualization({block,scope}:InlineVisualizationProps):JSX.Element {
 const theme=useTheme(),frame=useRef<HTMLIFrameElement>(null);
 const [attempt,setAttempt]=useState(0),[height,setHeight]=useState(420);
 const [ready,setReady]=useState(false),[failure,setFailure]=useState(false),loaded=useRef({nonce:"",count:0});
 const nonce=useMemo(()=>createClientId(),[attempt]),product=productApiPath('/api/').replace(/\/$/,'');
 const metadata=useQuery({queryKey:['inline-visualization',product,scope.projectId,scope.conversationId,scope.communicationEventId,block.artifactId],
  queryFn:({signal})=>api.getProjectArtifact(scope.projectId,block.artifactId,{conversationId:scope.conversationId,communicationEventId:scope.communicationEventId},signal),
  staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
 const colors=useMemo(()=>({bg:theme.palette.background.default,surface:theme.palette.background.paper,text:theme.palette.text.primary,
  muted:theme.palette.text.secondary,border:theme.palette.divider,accent:theme.palette.primary.main,'on-accent':theme.palette.primary.contrastText}),[theme]);
 const sendTheme=useCallback(()=>frame.current?.contentWindow?.postMessage({type:'ponderosa:visualization-theme',version:1,nonce,mode:theme.palette.mode,colors:{...colors,'font-family':getComputedStyle(document.body).fontFamily,'font-size':getComputedStyle(document.documentElement).fontSize}},'*'),[colors,nonce,theme.palette.mode]);
 useLayoutEffect(()=>{
  let timer:ReturnType<typeof setTimeout>|undefined,pendingHeight:number|undefined;
  const receive=(event:MessageEvent)=>{
   const data=event.data;
   if(event.source!==frame.current?.contentWindow||event.origin!=='null'||!data||data.type!=='ponderosa:visualization'||data.version!==1||data.nonce!==nonce)return;
   if(data.status==='error'){setFailure(true);return;}
   if(data.status!=='ready')return;
   setReady(true);
   if(data.height===undefined)return;
   // ponytail: reject million-pixel/invalid documents, never cap ordinary long content.
   // Larger documents require paginated rendering before increasing this safety ceiling.
   if(typeof data.height!=='number'||!Number.isFinite(data.height)||data.height<=0||data.height>1_000_000){setFailure(true);return;}
   pendingHeight=Math.ceil(data.height);
   if(timer===undefined)timer=setTimeout(()=>{timer=undefined;if(pendingHeight!==undefined)setHeight(pendingHeight);},150);
  };
  window.addEventListener('message',receive);return()=>{window.removeEventListener('message',receive);clearTimeout(timer);};
 },[nonce]);
 useEffect(()=>{
  // Root applies the shared text-size event too; read its final CSS after all listeners.
  const update=()=>queueMicrotask(sendTheme);sendTheme();window.addEventListener(TEXT_SIZE_EVENT,update);window.addEventListener('storage',update);
  return()=>{window.removeEventListener(TEXT_SIZE_EVENT,update);window.removeEventListener('storage',update);};
 },[sendTheme]);
 useEffect(()=>{if(ready||failure)return;const timer=setTimeout(()=>setFailure(true),10000);return()=>clearTimeout(timer);},[ready,failure,nonce]);
 const artifact=metadata.data;
 const preview=useMemo(()=>{
  if(artifact?.size===undefined||artifact.size>ARTIFACT_PREVIEW_MAX_BYTES||!artifact.previewUrl||artifact.kind!=='generated_file'||artifact.mediaType!=='text/html'||!artifact.sha256)return undefined;
  const url=new URL(productApiPath(artifact.previewUrl),location.origin);
  const expected=`${product}/projects/${encodeURIComponent(scope.projectId)}/artifacts/${encodeURIComponent(block.artifactId)}/preview`;
  if(url.origin!==location.origin||url.pathname!==expected)return undefined;
  url.searchParams.set('visualizationNonce',nonce);return url.pathname+url.search;
 },[artifact,nonce,product,scope.projectId,block.artifactId]);
 const unavailable=failure||metadata.isError||metadata.isSuccess&&!preview;
 const retry=()=>{setFailure(false);setReady(false);setAttempt(value=>value+1);void metadata.refetch();};
 return <Box sx={{position:'relative',minWidth:0,width:'100%'}}>
   {unavailable?<Alert severity="warning" action={<Button onClick={retry}>Retry</Button>}>This visualization is unavailable.</Alert>:
    <Box sx={{position:'relative',height,minWidth:0}}>
     {!ready?<Box role="status" sx={{position:'absolute',inset:0,p:2,color:'text.secondary'}}>Loading Visualization…</Box>:null}
     {preview?<iframe key={nonce} ref={frame} title={block.title} src={preview} sandbox="allow-scripts" scrolling="no" referrerPolicy="no-referrer" onLoad={event=>{
       if(frame.current!==event.currentTarget)return;
       if(loaded.current.nonce===nonce&&loaded.current.count>0){setFailure(true);return;}
       loaded.current={nonce,count:1};sendTheme();
      }} onError={()=>setFailure(true)}
      style={{display:'block',border:0,width:'100%',height:'100%',visibility:ready?'visible':'hidden',colorScheme:theme.palette.mode}}/>:null}
    </Box>}
 </Box>;
}
