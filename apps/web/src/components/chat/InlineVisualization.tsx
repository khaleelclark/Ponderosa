import {Alert,Box,Button,Stack,Typography} from '@mui/material';
import {useTheme} from '@mui/material/styles';
import {useQuery} from '@tanstack/react-query';
import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ARTIFACT_PREVIEW_MAX_BYTES} from '@ponderosa/core';
import {api} from '../../api';
import {productApiPath} from '../../api/productScope';
import {TEXT_SIZE_EVENT} from '../../textSize';
import {createClientId} from '../../clientId';
import type {VisualizationBlock,VisualizationScope} from './VisualizationDisplay';

export interface InlineVisualizationProps {block:VisualizationBlock;scope:VisualizationScope}

/** One live sandbox; native dialog promotion never reparents or replaces its frame. */
export function InlineVisualization({block,scope}:InlineVisualizationProps):JSX.Element {
 const theme=useTheme(),titleId=useId(),dialog=useRef<HTMLDialogElement>(null),frame=useRef<HTMLIFrameElement>(null),expandButton=useRef<HTMLButtonElement>(null);
 const [attempt,setAttempt]=useState(0),[height,setHeight]=useState(420),[expanded,setExpanded]=useState(false),[reserved,setReserved]=useState(0);
 const [ready,setReady]=useState(false),[failure,setFailure]=useState(false),lastSize=useRef(0),loaded=useRef({nonce:"",count:0});
 const nonce=useMemo(()=>createClientId(),[attempt]),product=productApiPath('/api/').replace(/\/$/,'');
 const metadata=useQuery({queryKey:['inline-visualization',product,scope.projectId,scope.conversationId,scope.communicationEventId,block.artifactId],
  queryFn:({signal})=>api.getProjectArtifact(scope.projectId,block.artifactId,{conversationId:scope.conversationId,communicationEventId:scope.communicationEventId},signal),
  staleTime:Infinity,retry:false,refetchOnWindowFocus:false});
 const colors=useMemo(()=>({bg:theme.palette.background.default,surface:theme.palette.background.paper,text:theme.palette.text.primary,
  muted:theme.palette.text.secondary,border:theme.palette.divider,accent:theme.palette.primary.main,'on-accent':theme.palette.primary.contrastText}),[theme]);
 const sendTheme=useCallback(()=>frame.current?.contentWindow?.postMessage({type:'ponderosa:visualization-theme',version:1,nonce,mode:theme.palette.mode,colors:{...colors,'font-family':getComputedStyle(document.body).fontFamily,'font-size':getComputedStyle(document.documentElement).fontSize}},'*'),[colors,nonce,theme.palette.mode]);
 useLayoutEffect(()=>{
  const receive=(event:MessageEvent)=>{
   const data=event.data;
   if(event.source!==frame.current?.contentWindow||event.origin!=='null'||!data||data.type!=='ponderosa:visualization'||data.version!==1||data.nonce!==nonce)return;
   if(data.status==='error'){setFailure(true);return;}
   if(data.status!=='ready')return;
   setReady(true);
   if(typeof data.height!=='number'||!Number.isFinite(data.height)||data.height<=0||performance.now()-lastSize.current<150)return;
   lastSize.current=performance.now();if(!dialog.current?.matches(':modal'))setHeight(Math.min(1200,Math.max(180,Math.ceil(data.height))));
  };
  window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
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
 const restore=()=>{const node=dialog.current;if(!node||node.matches(':modal'))return;if(!node.open)node.show();setExpanded(false);expandButton.current?.focus({preventScroll:true});};
 const toggle=()=>{
  const node=dialog.current;if(!node)return;
  if(node.matches(':modal')){node.close();restore();return;}
  setReserved(node.getBoundingClientRect().height);node.close();node.showModal();setExpanded(true);
 };
 const retry=()=>{setFailure(false);setReady(false);lastSize.current=0;setAttempt(value=>value+1);void metadata.refetch();};
 return <Box sx={{minWidth:0,width:'100%',height:expanded?reserved:undefined,'& dialog::backdrop':{backgroundColor:'rgba(0,0,0,.5)'}}}>
  <dialog ref={dialog} open role={expanded?'dialog':'region'} aria-labelledby={titleId} onClose={restore}
   style={{boxSizing:'border-box',display:'flex',flexDirection:'column',position:expanded?'fixed':'relative',inset:expanded?'16px':undefined,margin:expanded?'auto':0,
    width:expanded?'calc(100vw - 32px)':'100%',maxWidth:expanded?'calc(100vw - 32px)':'100%',height:expanded?'calc(100dvh - 32px)':undefined,maxHeight:expanded?'calc(100dvh - 32px)':undefined,
    padding:0,border:`1px solid ${theme.palette.divider}`,borderRadius:12,background:theme.palette.background.paper,color:theme.palette.text.primary,overflow:'hidden'}}>
   <Stack direction="row" sx={{p:1,gap:1,alignItems:'center',flexWrap:'wrap',flexShrink:0,borderBottom:1,borderColor:'divider'}}>
    <Typography id={titleId} component="span" variant="body2" fontWeight={600} sx={{flex:1,minWidth:80,overflowWrap:'anywhere'}}>{block.title}</Typography>
    <Button ref={expandButton} size="small" onClick={toggle} aria-expanded={expanded}>{expanded?'Restore':'Expand'}</Button>
    {artifact?.downloadUrl?<Button component="a" size="small" href={productApiPath(artifact.downloadUrl)} download>Download</Button>:null}
   </Stack>
   {unavailable?<Alert severity="warning" action={<Button onClick={retry}>Retry</Button>}>This visualization is unavailable. Retry or download the standalone HTML.</Alert>:
    <Box sx={{position:'relative',minHeight:180,height:expanded?'auto':height,flex:expanded?1:undefined,minWidth:0}}>
     {!ready?<Box role="status" sx={{position:'absolute',inset:0,p:2,color:'text.secondary'}}>Loading Visualization…</Box>:null}
     {preview?<iframe key={nonce} ref={frame} title={block.title} src={preview} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={event=>{
       if(frame.current!==event.currentTarget)return;
       if(loaded.current.nonce===nonce&&loaded.current.count>0){setFailure(true);return;}
       loaded.current={nonce,count:1};sendTheme();
      }} onError={()=>setFailure(true)}
      style={{display:'block',border:0,width:'100%',height:'100%',visibility:ready?'visible':'hidden',colorScheme:theme.palette.mode}}/>:null}
    </Box>}
  </dialog>
 </Box>;
}
