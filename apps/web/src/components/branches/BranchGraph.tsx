import {useEffect,useId,useRef} from 'react';
import {Box,ButtonBase,Chip,Stack,Typography} from '@mui/material';
import type {BranchDefinition,BranchStepExecutionDto} from '@ponderosa/core';
import {nodeKind,nodeName,workflowGraphLevels} from './model';
export function BranchGraph({definition,selected,onSelect,focusRequest=0,steps=[],controlStates={}}:{definition:BranchDefinition;selected?:string;onSelect(id:string):void;focusRequest?:number;steps?:BranchStepExecutionDto[];controlStates?:Record<string,string>}):JSX.Element{
 const nodes=[...definition.steps,...definition.controls],levels=workflowGraphLevels(definition),arrowId=useId().replaceAll(':','');
 const nodeButtons=useRef(new Map<string,HTMLButtonElement>());
 useEffect(()=>{if(focusRequest&&selected){const button=nodeButtons.current.get(selected);button?.scrollIntoView({block:'nearest',inline:'nearest'});button?.focus({preventScroll:true})}},[focusRequest,selected]);
 const layers=Array.from({length:Math.max(0,...levels.values())+1},(_,level)=>nodes.filter(n=>levels.get(n.id)===level));
 const width=Math.max(1,...layers.map(l=>l.length))*224+40,height=layers.length*142+45,positions=new Map<string,{x:number;y:number}>();
 layers.forEach((layer,index)=>layer.forEach((node,column)=>positions.set(node.id,{x:(width-layer.length*224)/2+column*224,y:30+index*142})));
 const entry=nodes.find(n=>n.id===definition.entry);
 return <Stack spacing={1}><Box component="details"><Typography component="summary">Workflow text description</Typography><Typography>{entry?`Start at ${nodeName(entry)}. ${nodes.length} nodes, ${definition.edges.length} connections.`:'This workflow has no steps.'}</Typography>{nodes.map(node=><Typography key={node.id} variant="body2">{nodeName(node)} ({nodeKind(node)}): {controlStates[node.id]??steps.filter(s=>s.stepId===node.id).at(-1)?.state??'not run'}. {definition.edges.filter(e=>e.from===node.id).map(e=>{const destination=nodes.find(n=>n.id===e.to);return `${e.on} → ${destination?nodeName(destination):'Missing step'}`}).join('; ')||'End of path.'}</Typography>)}</Box><Box role="region" aria-label="Workflow graph" sx={{overflow:'auto',minHeight:330,maxHeight:640,border:'1px solid',borderColor:'divider',borderRadius:3,bgcolor:'background.default',backgroundImage:'radial-gradient(circle, rgba(100,130,110,.18) 1px, transparent 1px)',backgroundSize:'18px 18px'}}>
  <Box sx={{position:'relative',width:Math.max(width,320),height,mx:'auto'}}>
   <svg width={width} height={height} style={{position:'absolute',inset:0,pointerEvents:'none'}} aria-hidden="true">
    <defs><marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="#789685"/></marker></defs>
    {definition.edges.map(e=>{const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)return null;const x1=a.x+102,y1=a.y+85,x2=b.x+102,y2=b.y;const source=definition.controls.find(c=>c.id===e.from);return <g key={e.id}><path d={`M${x1},${y1} C${x1},${y1+30} ${x2},${y2-30} ${x2},${y2}`} stroke={e.on==='failure'||e.on==='rejected'?'#ac7b69':'#789685'} strokeWidth="1.6" fill="none" markerEnd={`url(#${arrowId})`}/><text x={(x1+x2)/2+5} y={(y1+y2)/2-3} fill="#78877e" fontSize="10">{e.choice??(source?.kind==='map'?'each item':source?.kind==='route'&&e.on==='failure'?'otherwise':e.on)}</text></g>})}
   </svg>
   {nodes.map(node=>{const p=positions.get(node.id)!,state=controlStates[node.id]??steps.filter(s=>s.stepId===node.id).at(-1)?.state;return <ButtonBase ref={element=>{if(element)nodeButtons.current.set(node.id,element);else nodeButtons.current.delete(node.id)}} key={node.id} onClick={()=>onSelect(node.id)} aria-label={`Select ${nodeName(node)}${state?`, ${state}`:''}`} aria-pressed={selected===node.id} sx={{position:'absolute',left:p.x,top:p.y,width:204,height:85,p:1.5,textAlign:'left',display:'block',border:'1px solid',borderColor:selected===node.id?'primary.main':'divider',borderRadius:2,bgcolor:'background.paper',boxShadow:selected===node.id?'0 0 0 2px rgba(71,120,93,.18)':'0 2px 6px rgba(0,0,0,.04)'}}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="overline" sx={{fontSize:9,lineHeight:1.5,color:'text.secondary'}}>{nodeKind(node)}</Typography>{definition.entry===node.id&&<Typography variant="caption" color="primary">Start</Typography>}</Stack>
    <Typography fontWeight={650} noWrap sx={{mt:.5,fontSize:13}}>{nodeName(node)}</Typography>{state&&<Chip size="small" label={state} sx={{height:18,fontSize:10,mt:.5}}/>}
   </ButtonBase>})}
  </Box>
 </Box></Stack>;
}
