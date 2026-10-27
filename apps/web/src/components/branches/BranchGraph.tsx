import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Box,ButtonBase,Chip,Stack,Typography,useTheme} from '@mui/material';
import {normalizeCanonicalText,type BranchDefinition,type BranchStepExecutionDto} from '@ponderosa/core';
import {nodeKind,nodeName,workflowGraphLevels} from './model';
type LabelRect={id:string;x:number;y:number;width:number;height:number;loop?:boolean};
const intersects=(a:Omit<LabelRect,'id'>,b:Omit<LabelRect,'id'>)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
/** Keep native-sized labels out of cards and each other, using existing row gaps. */
export function placeGraphLabels(labels:LabelRect[],nodes:Array<{x:number;y:number}>,gaps:number[]):LabelRect[] {
 const cards=nodes.map(p=>({x:p.x-8,y:p.y-8,width:220,height:101})),placed:LabelRect[]=[];
 for(const label of labels.filter(label=>!label.loop)){
  let best:LabelRect|undefined,score=Infinity;
  for(const y of [label.y,...gaps.map(center=>center-label.height/2)].sort((a,b)=>Math.abs(a-label.y)-Math.abs(b-label.y))){
   if(Math.abs(y-label.y)>=score)break;
   const candidate={...label,x:Math.max(8,label.x),y:Math.max(8,y)};if(cards.some(card=>intersects(candidate,card)))continue;
   for(const direction of [-1,1]){
    const next={...candidate};
    // Each move clears one already placed label; no new graph or routing model.
    for(let moves=0;moves<=placed.length;moves++){
     const hit=placed.find(other=>intersects(next,other));if(!hit)break;
     next.x=direction<0?hit.x-next.width-4:hit.x+hit.width+4;
    }
    if(next.x<8||cards.some(card=>intersects(next,card)))continue;
    const distance=Math.abs(next.x-label.x)+Math.abs(next.y-label.y);
    if(distance<score){best=next;score=distance}
   }
  }
  placed.push(best??{...label,x:Math.max(8,label.x),y:Math.max(8,...cards.map(card=>card.y+card.height),...placed.map(other=>other.y+other.height))+8});
 }
 for(const label of labels.filter(label=>label.loop))placed.push({...label,x:Math.max(8,...cards.map(card=>card.x+card.width+8),...placed.map(other=>other.x+other.width+16)),y:Math.max(8,label.y)});
 const byId=new Map(placed.map(label=>[label.id,label]));return labels.map(label=>byId.get(label.id)!);
}
/** Native widths, grapheme boundaries and existing SVG text; no guessed character sizes. */
export function wrapGraphLabel(text:string,measure:(value:string)=>number):string[] {
 // Over-limit authoring drafts retain full native text, with one measurement rather than wrapping work.
 if(normalizeCanonicalText(text).length>100)return [text];
 const parts=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),part=>part.segment),lines:string[]=[];
 for(let start=0;start<parts.length;){
  let end=start;
  while(end<parts.length&&measure(parts.slice(start,end+1).join(''))<=160)end++;
  if(end===start)end++;
  else if(end<parts.length){for(let i=end-1;i>start;i--)if(/\s/u.test(parts[i]!)){end=i+1;break}}
  lines.push(parts.slice(start,end).join(''));start=end;
 }
 return lines;
}
export function BranchGraph({definition,selected,onSelect,focusRequest=0,steps=[],controlStates={}}:{definition:BranchDefinition;selected?:string;onSelect(id:string):void;focusRequest?:number;steps?:BranchStepExecutionDto[];controlStates?:Record<string,string>}):JSX.Element{
 const theme=useTheme();
 const nodes=[...definition.steps,...definition.controls],levels=workflowGraphLevels(definition),arrowId=useId().replaceAll(':','');
 const labelElements=useRef(new Map<string,SVGTextElement>()),[labelSizes,setLabelSizes]=useState<Record<string,{width:number;height:number;top:number;lines:string[];lineHeight:number}>>({});
 const nodeButtons=useRef(new Map<string,HTMLButtonElement>());
 useEffect(()=>{if(focusRequest&&selected){const button=nodeButtons.current.get(selected);button?.scrollIntoView({block:'nearest',inline:'nearest'});button?.focus({preventScroll:true})}},[focusRequest,selected]);
 const layers=Array.from({length:Math.max(0,...levels.values())+1},(_,level)=>nodes.filter(n=>levels.get(n.id)===level));
 // ponytail: one measured row stride can spread dense long-label graphs; use per-level gaps only if denser packing is needed.
 const stride=Math.max(142,85+Math.max(0,...Object.values(labelSizes).map(size=>size.height))+32);
 const width=Math.max(1,...layers.map(l=>l.length))*224+40,height=layers.length*stride+45,positions=new Map<string,{x:number;y:number}>();
 layers.forEach((layer,index)=>layer.forEach((node,column)=>positions.set(node.id,{x:(width-layer.length*224)/2+column*224,y:30+index*stride})));
 const edges=definition.edges.flatMap(edge=>{const a=positions.get(edge.from),b=positions.get(edge.to);if(!a||!b)return [];const source=definition.controls.find(c=>c.id===edge.from),x1=a.x+102,y1=a.y+85,x2=b.x+102,y2=b.y;
  const path=`M${x1},${y1} C${x1},${y1+30} ${x2},${y2-30} ${x2},${y2}`;
  return [{...edge,path,x1,y1,x2,y2,labelX:(x1+x2)/2,labelY:(y1+y2)/2,label:edge.choice??(source?.kind==='condition'?(edge.on==='selected'?'Matches':'Otherwise'):source?.kind==='map'?'Each item':source?.kind==='route'&&edge.on==='failure'?'Otherwise':edge.on==='success'?'Next step':edge.on)}];
 });
 const labelKey=JSON.stringify(edges.map(edge=>[edge.id,edge.label]));
 useLayoutEffect(()=>{
  const measure=()=>{
   const first=labelElements.current.values().next().value;if(!first){setLabelSizes(previous=>Object.keys(previous).length?{}:previous);return;}if(!first.closest('svg')!.getClientRects().length)return;
   const probe=first.cloneNode(false) as SVGTextElement;probe.setAttribute('x','0');probe.setAttribute('y','0');probe.style.opacity='0';first.parentElement!.appendChild(probe);
   try{
    const cache=new Map<string,DOMRect>(),sizes:typeof labelSizes={};
    const box=(value:string)=>{let found=cache.get(value);if(!found){probe.textContent=value;found=probe.getBBox();cache.set(value,found)}return found};
    for(const edge of edges){if(!edge.label.trim()){sizes[edge.id]={width:0,height:0,top:0,lines:[edge.label],lineHeight:14};continue}const lines=wrapGraphLabel(edge.label,value=>box(value).width),bounds=lines.map(box),top=Math.min(...bounds.map(b=>b.y)),bottom=Math.max(...bounds.map(b=>b.y+b.height)),lineHeight=Math.max(14,bottom-top+2);
     sizes[edge.id]={width:Math.ceil(Math.max(...bounds.map(b=>b.width))*1000)/1000,height:Math.ceil(((lines.length-1)*lineHeight+bottom-top)*1000)/1000,top,lines,lineHeight};
    }
    setLabelSizes(previous=>JSON.stringify(previous)===JSON.stringify(sizes)?previous:sizes);
   }finally{probe.remove()}
  };
  measure();const observer=new ResizeObserver(measure);labelElements.current.forEach(element=>observer.observe(element));return ()=>observer.disconnect();
 },[labelKey]);
 const labels=useMemo(()=>placeGraphLabels(edges.map(edge=>{const size=labelSizes[edge.id],w=(size?.width??0)+8,h=(size?.height??12)+8;return {id:edge.id,loop:edge.loop,x:edge.labelX-w/2,y:edge.labelY-h/2,width:w,height:h}}),[...positions.values()],layers.map((_,i)=>30+i*stride+85+(stride-85)/2)),[definition,labelSizes]);
 const canvasWidth=Math.max(width,...labels.map(label=>label.x+label.width+8)),canvasHeight=Math.max(height,...labels.map(label=>label.y+label.height+8));
 const entry=nodes.find(n=>n.id===definition.entry);
 return <Stack spacing={1}><Box component="details" sx={{overflowWrap:'anywhere'}}><Typography component="summary">Workflow outline</Typography><Typography>{entry?`Start at ${nodeName(entry)}. ${nodes.length} nodes, ${definition.edges.length} connections.`:'This workflow has no steps.'}</Typography>{nodes.map(node=><Typography key={node.id} variant="body2">{nodeName(node)} ({nodeKind(node)}): {controlStates[node.id]??steps.filter(s=>s.stepId===node.id).at(-1)?.state??''} {definition.edges.filter(e=>e.from===node.id).map(e=>{const destination=nodes.find(n=>n.id===e.to);return `${edges.find(edge=>edge.id===e.id)?.label??e.on} → ${destination?nodeName(destination):'Missing step'}`}).join('; ')||'End of path.'}</Typography>)}</Box><Box role="region" aria-label="Workflow graph" sx={{overflow:'auto',minHeight:330,maxHeight:640,border:'1px solid',borderColor:'divider',borderRadius:3,bgcolor:'background.default',backgroundImage:'radial-gradient(circle, rgba(100,130,110,.18) 1px, transparent 1px)',backgroundSize:'18px 18px'}}>
  <Box sx={{position:'relative',width:Math.max(canvasWidth,320),height:canvasHeight,mx:'auto'}}>
   <svg width={canvasWidth} height={canvasHeight} style={{position:'absolute',inset:0,pointerEvents:'none'}} aria-hidden="true">
    <defs><marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="#789685"/></marker></defs>
    {edges.map((edge,index)=>{const label=labels[index]!,x=label.x+label.width/2,y=label.y+label.height/2,moved=Math.abs(x-edge.labelX)>1||Math.abs(y-edge.labelY)>1;
     const path=edge.loop?`M${edge.x1},${edge.y1} V${edge.y1+12} H${x} V${y} V${edge.y2-12} H${edge.x2} V${edge.y2}`:moved?`M${edge.x1},${edge.y1} C${edge.x1},${edge.y1+30} ${x},${y-20} ${x},${y} C${x},${y+20} ${edge.x2},${edge.y2-30} ${edge.x2},${edge.y2}`:edge.path;
     return <path key={edge.id} data-edge-id={edge.id} d={path} stroke={edge.on==='rejected'||edge.on==='failure'&&!['condition','route'].includes(definition.controls.find(node=>node.id===edge.from)?.kind??'')?'#ac7b69':'#789685'} strokeWidth="1.6" fill="none" markerEnd={`url(#${arrowId})`}/>;
    })}
    {edges.map((edge,index)=>{const label=labels[index]!,size=labelSizes[edge.id];return <text data-edge-id={edge.id} ref={element=>{if(element)labelElements.current.set(edge.id,element);else labelElements.current.delete(edge.id)}} key={edge.id} x={label.x+label.width/2} y={label.y+4-(size?.top??-10)} textAnchor="middle" fill={theme.palette.text.secondary} stroke={theme.palette.background.default} strokeWidth="8" strokeLinejoin="round" paintOrder="stroke" fontSize="10">{(size?.lines??[edge.label]).map((line,lineIndex)=><tspan key={lineIndex} x={label.x+label.width/2} dy={lineIndex===0?0:size!.lineHeight}>{line}</tspan>)}</text>})}
   </svg>
   {nodes.map(node=>{const p=positions.get(node.id)!,state=controlStates[node.id]??steps.filter(s=>s.stepId===node.id).at(-1)?.state;return <ButtonBase ref={element=>{if(element)nodeButtons.current.set(node.id,element);else nodeButtons.current.delete(node.id)}} key={node.id} onClick={()=>onSelect(node.id)} aria-label={`Select ${nodeName(node)}${state?`, ${state}`:''}`} aria-pressed={selected===node.id} sx={{position:'absolute',left:p.x,top:p.y,width:204,height:85,p:1.5,textAlign:'left',display:'block',border:'1px solid',borderColor:selected===node.id?'primary.main':'divider',borderRadius:2,bgcolor:'background.paper',boxShadow:selected===node.id?'0 0 0 2px rgba(71,120,93,.18)':'0 2px 6px rgba(0,0,0,.04)'}}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="overline" sx={{fontSize:9,lineHeight:1.5,color:'text.secondary'}}>{nodeKind(node)}</Typography>{definition.entry===node.id&&<Typography variant="caption" color="primary">Start</Typography>}</Stack>
    <Typography fontWeight={650} noWrap sx={{mt:.5,fontSize:13}}>{nodeName(node)}</Typography>{state&&<Chip size="small" label={state} sx={{height:18,fontSize:10,mt:.5}}/>}
   </ButtonBase>})}
  </Box>
 </Box></Stack>;
}
