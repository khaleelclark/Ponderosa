import {Alert,Box,Button} from '@mui/material';
import {useEffect,useRef,useState,type ComponentType} from 'react';
import type {RichMessageBlock} from '@ponderosa/core';
import {productApiPath} from '../../api/productScope';
import type {InlineVisualizationProps} from './InlineVisualization';

export interface VisualizationScope {
 projectId:string; conversationId:string; communicationEventId:string; artifactIds:readonly string[];
}
export type VisualizationBlock=Extract<RichMessageBlock,{type:'visualization'}>;

/** Fetch neither a runtime chunk nor an artifact until this published panel is near view. */
export function VisualizationDisplay({block,scope}:{block:VisualizationBlock;scope?:VisualizationScope}):JSX.Element {
 const host=useRef<HTMLDivElement>(null),[near,setNear]=useState(false),[attempt,setAttempt]=useState(0);
 const [Renderer,setRenderer]=useState<ComponentType<InlineVisualizationProps>>(),[failed,setFailed]=useState(false);
 const authorized=Boolean(scope?.artifactIds.includes(block.artifactId));
 useEffect(()=>{
  if(!authorized||near)return;
  if(typeof IntersectionObserver==='undefined'){setNear(true);return;}
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setNear(true);observer.disconnect();}},{rootMargin:'300px'});
  if(host.current)observer.observe(host.current);return()=>observer.disconnect();
 },[authorized,near]);
 useEffect(()=>{
  if(!near||!authorized)return;let current=true;setFailed(false);
  void import('./InlineVisualization').then(module=>{if(current)setRenderer(()=>module.InlineVisualization);},()=>{if(current)setFailed(true);});
  return()=>{current=false;};
 },[near,authorized,attempt]);
 if(!authorized)return <Alert severity="info">This visualization is not attached to this published message.</Alert>;
 return <Box ref={host} sx={{minHeight:Renderer?undefined:420,minWidth:0,width:'100%'}}>
  {Renderer&&scope?<Renderer key={`${productApiPath("/api/")}:${scope.projectId}:${scope.conversationId}:${scope.communicationEventId}:${block.artifactId}`} block={block} scope={scope}/>:
   failed?<Alert severity="warning" action={<Button onClick={()=>setAttempt(value=>value+1)}>Retry</Button>}>This visualization could not be loaded.</Alert>:
    <Box role="status" sx={{p:2,color:'text.secondary'}}>Loading Visualization…</Box>}
 </Box>;
}
