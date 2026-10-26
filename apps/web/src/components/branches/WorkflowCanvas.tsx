import {createContext,memo,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,IconButton,Stack,Tooltip,Typography,useMediaQuery,useTheme} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CallSplitOutlinedIcon from '@mui/icons-material/CallSplitOutlined';
import PlaylistAddCheckOutlinedIcon from '@mui/icons-material/PlaylistAddCheckOutlined';
import RepeatOutlinedIcon from '@mui/icons-material/RepeatOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExploreOutlinedIcon from '@mui/icons-material/ExploreOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import {Background,BaseEdge,EdgeLabelRenderer,EdgeToolbar,Handle,MarkerType,Position,ReactFlow,ReactFlowProvider,ViewportPortal,getViewportForBounds,useStore,useUpdateNodeInternals,type Edge,type EdgeProps,type Node,type NodeProps,type ReactFlowInstance,type Viewport} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk-api.js';
import type {AgentDto,BranchBindings,BranchDefinition,BranchValidationIssue} from '@ponderosa/core';
import {SemanticStatusCircle} from '../SemanticStatus';
import {nodeKind,nodeName,type WorkflowNode} from './model';
import {layoutWorkflowCanvas,workflowCanvasKey,roundedWorkflowPath,type CanvasLayout,type CanvasLayoutEdge,type CanvasLayoutNode,type CanvasMeasurements} from './canvas-layout';
import {frameWorkflowCanvas,guidedWorkflowScene,workflowTranslateExtent,clampWorkflowViewport} from './canvas-navigation';
import {guidedInsertionRestriction,type GuidedInsertionTarget} from './guided-operations';

export type CanvasViewState={guided?:{x:number;y:number};explore?:Viewport;mobile?:Viewport;selected?:string};
export type WorkflowUndoRedo={canUndo:boolean;canRedo:boolean;onUndo():void;onRedo():void};
type CanvasNode=Node<{layout:CanvasLayoutNode;node?:WorkflowNode;issue:boolean;entry:boolean}>;
type CanvasEdge=Edge<{layout:CanvasLayoutEdge;issue:boolean}>;
type Actions={definition:BranchDefinition;selected?:string;selectedEdge?:string;insert(target:GuidedInsertionTarget,anchor:HTMLElement):void;measure(kind:'nodes'|'labels',id:string,width:number,height:number):void};
const CanvasActions=createContext<Actions>(null!);
function useMeasured(kind:'nodes'|'labels',id:string){
 const ref=useRef<HTMLDivElement>(null),{measure}=useContext(CanvasActions);
 useLayoutEffect(()=>{const element=ref.current;if(!element)return;const observer=new ResizeObserver(([entry])=>{if(entry)measure(kind,id,Math.ceil(entry.borderBoxSize?.[0]?.inlineSize??entry.contentRect.width),Math.ceil(entry.borderBoxSize?.[0]?.blockSize??entry.contentRect.height))});observer.observe(element);return()=>observer.disconnect()},[id,kind,measure]);
 return ref;
}
const WorkflowCard=memo(function WorkflowCard({data,selected}:NodeProps<CanvasNode>){
 const {layout,node,issue,entry}=data,ref=useMeasured('nodes',layout.id),updateInternals=useUpdateNodeInternals();
 const ports=JSON.stringify(layout.ports);useLayoutEffect(()=>updateInternals(layout.id),[layout.id,ports,updateInternals]);
 const Icon=node?.kind==='agent'?SmartToyOutlinedIcon:node?.kind==='script'?TerminalOutlinedIcon:node?.kind==='human_gate'||node?.kind==='join'?PlaylistAddCheckOutlinedIcon:node?.kind==='action'?NotificationsNoneOutlinedIcon:node?.kind==='map'?RepeatOutlinedIcon:node?.kind==='condition'||node?.kind==='route'||node?.kind==='fork'?CallSplitOutlinedIcon:AccountTreeOutlinedIcon;
 return <Box ref={ref} sx={{width:layout.kind==='terminal'?200:320,minHeight:layout.kind==='terminal'?64:128,boxSizing:'border-box',p:layout.kind==='terminal'?2:2.5,bgcolor:'background.paper',border:'2px solid',borderColor:issue?'error.main':selected?'primary.main':'divider',borderRadius:3,boxShadow:selected?2:1,overflowWrap:'anywhere'}}>
  {layout.ports.map(port=><Handle key={port.id} id={port.id} type={port.id.startsWith('canvas:out:')?'source':'target'} position={port.side==='NORTH'?Position.Top:port.side==='SOUTH'?Position.Bottom:Position.Right} isConnectable={false} style={{visibility:'hidden',left:port.x,top:port.y,width:0,height:0,minWidth:0,minHeight:0}}/>)}
  {node?<Stack direction="row" alignItems="center" gap={1.5}><Box sx={{display:'grid',placeItems:'center',width:42,height:42,flexShrink:0,borderRadius:2,bgcolor:'action.hover',color:selected?'primary.main':'text.secondary'}}><Icon sx={{fontSize:26}}/></Box><Box sx={{flex:1,minWidth:0}}><Typography title={nodeName(node)} fontSize={18} lineHeight={1.35} fontWeight={650} sx={{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}}>{nodeName(node)}</Typography><Typography variant="body2" color="text.secondary" sx={{mt:.5}}>{nodeKind(node)}{entry?' · Start':''}</Typography>{layout.context&&<Typography variant="body2" color="text.secondary" sx={{mt:.5,display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}} title={layout.context}>{layout.context}</Typography>}{issue&&<Stack direction="row" alignItems="center" gap={.5} color="error.main"><SemanticStatusCircle/><Typography variant="caption">Needs Attention</Typography></Stack>}</Box><ChevronRightIcon sx={{flexShrink:0,color:selected?'primary.main':'text.secondary',fontSize:22}}/></Stack>:<Typography textAlign="center" fontWeight={600}>End This Path</Typography>}
 </Box>;
});
function edgeTarget(edge:CanvasLayoutEdge):GuidedInsertionTarget{return edge.canonicalEdgeId?{kind:'edge',edgeId:edge.canonicalEdgeId}:{kind:'terminal',nodeId:edge.terminal!.from,on:edge.terminal!.on}}
const WorkflowConnection=memo(function WorkflowConnection({id,data,selected,markerEnd}:EdgeProps<CanvasEdge>){
 const {definition,insert,selected:sourceSelection,selectedEdge}=useContext(CanvasActions),zoom=useStore(state=>state.transform[2]);
 const edge=data!.layout,ref=useMeasured('labels',edge.id),target=edgeTarget(edge),restriction=guidedInsertionRestriction(definition,target);
 if(edge.unresolved)return null;
 const path=roundedWorkflowPath(edge.sections);
 return <><BaseEdge id={id} path={path} markerEnd={markerEnd} style={{stroke:data!.issue?'var(--canvas-error)':edge.on==='failure'&&!['condition','route'].includes(definition.controls.find(node=>node.id===edge.source)?.kind??'')?'var(--canvas-failure)':'var(--canvas-edge)',strokeWidth:selected?2.5:1.6}} interactionWidth={44/zoom}/>
  <EdgeLabelRenderer><Box ref={ref} className="nodrag nopan" title={edge.label} sx={{position:'absolute',transform:`translate(${edge.labelBox.x}px,${edge.labelBox.y}px)`,width:'max-content',maxWidth:180,p:.5,boxSizing:'border-box',fontSize:12,lineHeight:'18px',overflowWrap:'anywhere',whiteSpace:'pre-wrap',bgcolor:'background.default',color:data!.issue?'error.main':'text.secondary',pointerEvents:'all'}}>{edge.label}{data!.issue?' · Check Connection':''}</Box></EdgeLabelRenderer>
  {!restriction&&<EdgeToolbar edgeId={id} x={edge.insertion.x+edge.insertion.width/2} y={edge.insertion.y+edge.insertion.height/2} isVisible={zoom>=.8&&edge.insertionAvailable&&(edge.source===sourceSelection||Boolean(edge.terminal)||id===selectedEdge)}><Tooltip title={restriction??`Insert On ${edge.label}`}><span><IconButton className="nodrag nopan" aria-label={`Insert Step On ${edge.label}`} onClick={event=>insert(target,event.currentTarget)} sx={{width:44,height:44,p:.5,borderRadius:'50%',bgcolor:'transparent','&:hover':{bgcolor:'transparent'},'& > svg':{boxSizing:'content-box',width:20,height:20,p:.75,bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:'50%'},'&:hover > svg':{bgcolor:'action.hover'}}}><AddIcon/></IconButton></span></Tooltip></EdgeToolbar>}
 </>;
});
const nodeTypes={workflow:WorkflowCard,terminal:WorkflowCard},edgeTypes={guided:WorkflowConnection};
type Props={saveControl:ReactNode;settingsDocked?:boolean;startControl?:ReactNode;entryButtonRef:React.RefObject<HTMLButtonElement>;branchId:string;definition:BranchDefinition;bindings:BranchBindings;agents:AgentDto[];selected?:string;onSelect(id:string):void;focusRequest:number;issues:BranchValidationIssue[];onInsert(target:GuidedInsertionTarget,anchor:HTMLElement):void;onDelete(id:string):void;undoRedo:WorkflowUndoRedo;canvasViews:Map<string,CanvasViewState>;revealRequest?:number;bottomSheetHeight?:number;active:boolean};
export function WorkflowCanvas(props:Props):JSX.Element{return <ReactFlowProvider><GuidedCanvas {...props}/></ReactFlowProvider>}
function GuidedCanvas({saveControl,settingsDocked=false,startControl,entryButtonRef,branchId,definition,bindings,agents,selected,onSelect,focusRequest,issues,onInsert,onDelete,undoRedo,canvasViews,revealRequest=0,bottomSheetHeight=0,active}:Props):JSX.Element{
 const zoom=useStore(state=>state.transform[2]),theme=useTheme(),compact=useMediaQuery(theme.breakpoints.down('sm')),coarse=useMediaQuery('(pointer: coarse)');
 const region=useRef<HTMLDivElement>(null),scroll=useRef<HTMLDivElement>(null),start=useRef<HTMLDivElement>(null),outlineButton=useRef<HTMLButtonElement>(null);
 const [flow,setFlow]=useState<ReactFlowInstance<CanvasNode,CanvasEdge>>(),[measurements,setMeasurements]=useState<CanvasMeasurements>({}),[layout,setLayout]=useState<CanvasLayout>(),[error,setError]=useState(''),[retry,setRetry]=useState(0),[arranging,setArranging]=useState(false),[selectedEdge,setSelectedEdge]=useState<string>(),[outlineOpen,setOutlineOpen]=useState(false),[exploring,setExploring]=useState(false);
 const [available,setAvailable]=useState({width:600,height:500}),[startSize,setStartSize]=useState({width:320,height:44});
 const nativeGuided=!compact&&!coarse&&!exploring,mode=nativeGuided?'guided':exploring?'explore':'mobile';
 const lastFocusRequest=useRef(0),lastRevealRequest=useRef(0),latest=useRef({definition,bindings});latest.current={definition,bindings};
 const applied=useRef<{mode:typeof mode;layout:CanvasLayout;selected?:string;docked:boolean}>(),enterExplore=useRef<Viewport>(),fitPending=useRef(false);
 const remember=useCallback((patch:Partial<CanvasViewState>)=>{const previous=canvasViews.get(branchId);canvasViews.delete(branchId);canvasViews.set(branchId,{...previous,...patch,selected});while(canvasViews.size>100)canvasViews.delete(canvasViews.keys().next().value!);},[branchId,selected,canvasViews]);
 useEffect(()=>{remember({})},[selected,remember]);
 useEffect(()=>{if(!active)setOutlineOpen(false)},[active]);
 useLayoutEffect(()=>{const element=scroll.current;if(!element)return;const observer=new ResizeObserver(()=>setAvailable(previous=>previous.width===element.clientWidth&&previous.height===element.clientHeight?previous:{width:element.clientWidth,height:element.clientHeight}));observer.observe(element);return()=>observer.disconnect()},[]);
 useLayoutEffect(()=>{const element=start.current;if(!element)return;const observer=new ResizeObserver(([entry])=>{if(entry){const height=Math.ceil(entry.borderBoxSize?.[0]?.blockSize??entry.contentRect.height);if(height>0)setStartSize(previous=>previous.height===height?previous:{width:320,height})}});observer.observe(element);return()=>observer.disconnect()},[Boolean(layout)]);
 const context=Object.fromEntries(definition.steps.flatMap(node=>{if(node.kind!=='agent'||!('ref'in node.target))return[];const id=bindings.agents[node.target.ref];return [[node.id,agents.find(agent=>agent.id===id)?.title??(id?'Loading Agent…':'Select Agent')]]}));
 const key=workflowCanvasKey(definition,bindings,measurements,context),selectedExists=[...definition.steps,...definition.controls].some(node=>node.id===selected);
 const measure=useCallback((kind:'nodes'|'labels',id:string,width:number,height:number)=>{if(width<=0||height<=0)return;setMeasurements(previous=>previous[kind]?.[id]?.width===width&&previous[kind]?.[id]?.height===height?previous:{...previous,[kind]:{...previous[kind],[id]:{width,height}}})},[]);
 useEffect(()=>{if(!active)return;if(layout?.key===key){setError('');setArranging(false);return;}let current=true;const elk=new ELK({workerFactory:()=>new Worker(new URL('elkjs/lib/elk-worker.min.js',import.meta.url))});setArranging(true);setError('');void layoutWorkflowCanvas(latest.current.definition,latest.current.bindings,measurements,context,elk).then(result=>{if(current){setLayout(result);setError('');setArranging(false)}}).catch(error=>{if(current){setError(error instanceof Error?error.message:'The Workflow Could Not Be Arranged. Retry Or Use The Workflow Outline.');setArranging(false)}});return()=>{current=false;elk.terminateWorker()}},[key,branchId,retry,active]);
 const frame=useMemo(()=>layout?frameWorkflowCanvas(layout,definition.entry,startSize):undefined,[layout,definition.entry,startSize]),scene=frame?guidedWorkflowScene(frame,available):{...available,viewport:{x:0,y:0,zoom:1}};
 const saveGuided=()=>{const element=scroll.current;if(element&&nativeGuided&&frame)remember({guided:{x:element.scrollLeft-scene.viewport.x,y:element.scrollTop-scene.viewport.y}})};
 const setFree=(viewport:Viewport)=>{if(!flow||!frame||mode==='guided')return;const next=clampWorkflowViewport(frame,available,viewport);void flow.setViewport(next);remember({[mode]:next})};
 const reveal=useCallback((id:string,force=false)=>{
  if(!flow||!layout||!frame)return;const node=layout.nodes.find(item=>item.id===id);if(!node)return;
  if(nativeGuided){const element=scroll.current;if(!element)return;const left=node.x+scene.viewport.x,top=node.y+scene.viewport.y;let x=element.scrollLeft,y=element.scrollTop;
   if(force||left<x+16||left+node.width>x+element.clientWidth-16)x=left+(node.width-element.clientWidth)/2;
   if(force||top<y+16||top+node.height>y+element.clientHeight-72)y=top-Math.max(24,(element.clientHeight-node.height)/2);
   element.scrollTo({left:Math.max(0,x),top:Math.max(0,y),behavior:'instant'});saveGuided();
  }else{const viewport=flow.getViewport(),scale=Math.max(.8,Math.min(viewport.zoom,1.2));if(!force&&node.x*viewport.zoom+viewport.x>=16&&node.y*viewport.zoom+viewport.y>=16&&(node.x+node.width)*viewport.zoom+viewport.x<=available.width-16&&(node.y+node.height)*viewport.zoom+viewport.y<=available.height-72)return;setFree({x:available.width/2-(node.x+node.width/2)*scale,y:Math.max(24,(available.height-node.height*scale)/2)-node.y*scale,zoom:scale})}
 },[flow,layout,frame,nativeGuided,scene.viewport.x,scene.viewport.y,available.width,available.height,mode,remember]);
 // Restore only presentation state after the native scene has its real bounds. No draft/history owner is involved.
 useLayoutEffect(()=>{
  if(!flow||!layout||!frame||!active||available.width<=0||available.height<=0)return;
  const task=requestAnimationFrame(()=>{
   const previous=applied.current,saved=canvasViews.get(branchId),node=layout.nodes.find(node=>node.id===selected),oldNode=previous?.layout.nodes.find(node=>node.id===selected);
   if(nativeGuided){const element=scroll.current;if(!element)return;void flow.setViewport(scene.viewport);let origin=saved?.guided;
    if(origin&&previous?.mode==='guided'&&previous.layout.key!==layout.key&&node&&oldNode)origin={x:origin.x+node.x-oldNode.x,y:origin.y+node.y-oldNode.y};
    element.scrollLeft=origin?origin.x+scene.viewport.x:frame.entry?frame.entry.x+frame.entry.width/2+scene.viewport.x-element.clientWidth/2:0;
    element.scrollTop=origin?origin.y+scene.viewport.y:0;saveGuided();
   }else{const entering=previous?.mode!==mode,stored=mode==='explore'?saved?.explore:saved?.mobile;let viewport=entering?(mode==='explore'?enterExplore.current??stored:stored):flow.getViewport();
    if(!viewport){const entry=frame.entry??frame.start;viewport={x:available.width/2-entry.x-entry.width/2,y:32-frame.start.y,zoom:1}}
    if(previous?.mode===mode&&previous.layout.key!==layout.key&&node&&oldNode)viewport={...viewport,x:viewport.x+(oldNode.x-node.x)*viewport.zoom,y:viewport.y+(oldNode.y-node.y)*viewport.zoom};
    if(fitPending.current){viewport=getViewportForBounds(frame.bounds,available.width,available.height,.1,1.2,.1);fitPending.current=false}
    setFree(viewport);enterExplore.current=undefined;
   }
   applied.current={mode,layout,selected,docked:settingsDocked};
   if(node&&previous){const inserted=previous.layout.key!==layout.key&&!oldNode;if(inserted||settingsDocked&&!previous.docked)reveal(node.id,inserted)}
  });return()=>cancelAnimationFrame(task);
 },[flow,layout,active,mode,available.width,available.height,startSize.height,settingsDocked]);
 useEffect(()=>{if(!selectedExists){lastFocusRequest.current=focusRequest;return;}if(!focusRequest||lastFocusRequest.current===focusRequest||!selected||!active)return;const task=requestAnimationFrame(()=>{const element=Array.from(region.current?.querySelectorAll<HTMLElement>('[data-id]')??[]).find(node=>node.dataset.id===selected&&node.classList.contains('react-flow__node'));if(element){lastFocusRequest.current=focusRequest;element.focus({preventScroll:true})}});return()=>cancelAnimationFrame(task)},[focusRequest,selected,selectedExists,active,layout]);
 useEffect(()=>{if(!selectedExists){lastRevealRequest.current=revealRequest;return;}if(revealRequest&&lastRevealRequest.current!==revealRequest&&selected&&active&&flow&&layout?.nodes.some(node=>node.id===selected)){lastRevealRequest.current=revealRequest;reveal(selected)}},[revealRequest,selected,selectedExists,active,layout,flow,reveal]);
 const explore=()=>{if(!flow)return;saveGuided();const saved=canvasViews.get(branchId);enterExplore.current=saved?.explore??(nativeGuided?{x:scene.viewport.x-(scroll.current?.scrollLeft??0),y:scene.viewport.y-(scroll.current?.scrollTop??0),zoom:1}:flow.getViewport());setExploring(true)};
 const returnToWorkflow=()=>{if(flow)remember({explore:flow.getViewport()});setExploring(false)};
 const fit=()=>{if(!flow||!frame)return;if(!exploring){fitPending.current=true;explore()}else setFree(getViewportForBounds(frame.bounds,available.width,available.height,.1,1.2,.1))};
 const nodes=useMemo<CanvasNode[]>(()=>layout?.nodes.map(node=>{const canonical=[...definition.steps,...definition.controls].find(item=>item.id===node.id);return {id:node.id,type:node.kind,position:{x:node.x,y:node.y},initialWidth:node.width,initialHeight:node.height,style:{width:node.width},data:{layout:node,node:canonical,issue:issues.some(issue=>issue.nodeId===node.id),entry:definition.entry===node.id},selected:selected===node.id,draggable:false,connectable:false,deletable:false,focusable:Boolean(canonical),ariaLabel:canonical?`Select ${nodeName(canonical)}${issues.some(issue=>issue.nodeId===node.id)?', Configuration Issue':''}`:'End This Path'}})??[],[layout,definition,selected,issues]);
 const edges=useMemo<CanvasEdge[]>(()=>layout?.edges.filter(edge=>!edge.unresolved).map(edge=>({id:edge.id,type:'guided',source:edge.source,target:edge.target,sourceHandle:edge.sourcePort,targetHandle:edge.targetPort,data:{layout:edge,issue:issues.some(issue=>issue.edgeId===edge.id)},selected:edge.id===selectedEdge,focusable:true,reconnectable:false,deletable:false,ariaLabel:`${edge.label} Connection`,markerEnd:{type:MarkerType.ArrowClosed,width:18,height:18,color:theme.palette.text.secondary}}))??[],[layout,issues,selectedEdge,theme.palette.text.secondary]);
 const chosenConnection=layout?.edges.find(edge=>edge.id===selectedEdge&&!edge.unresolved),fallbackConnections=layout?.edges.filter(edge=>!edge.unresolved&&!guidedInsertionRestriction(definition,edgeTarget(edge))&&(edge.source===selected||edge.id===chosenConnection?.id)&&(zoom<.8||!edge.insertionAvailable))??[];
 const entryFallback=Boolean(frame?.entry&&zoom<.8&&!guidedInsertionRestriction(definition,{kind:'entry'}));
 const actions=useMemo(()=>({definition,selected,selectedEdge,insert:onInsert,measure}),[definition,selected,selectedEdge,onInsert,measure]);
 const insertionButton=(edge:CanvasLayoutEdge,fromOutline=false)=><Button key={edge.id} size="small" startIcon={<AddIcon/>} onClick={event=>{const anchor=fromOutline?outlineButton.current:event.currentTarget;setOutlineOpen(false);if(anchor)onInsert(edgeTarget(edge),anchor)}}>Insert On {edge.label}</Button>;
 const smallControls=compact||coarse||available.width<520;
 const zoomBy=(factor:number)=>{if(!flow)return;const view=flow.getViewport(),next=Math.max(.1,Math.min(2,view.zoom*factor)),ratio=next/view.zoom;setFree({x:available.width/2-(available.width/2-view.x)*ratio,y:available.height/2-(available.height/2-view.y)*ratio,zoom:next})};
 const controls:Array<[typeof AddIcon,string,()=>void,boolean]>=[[UndoIcon,'Undo',undoRedo.onUndo,!undoRedo.canUndo],[RedoIcon,'Redo',undoRedo.onRedo,!undoRedo.canRedo]];
 if(exploring)controls.unshift([ZoomInIcon,'Zoom In',()=>zoomBy(1.2),false],[ZoomOutIcon,'Zoom Out',()=>zoomBy(1/1.2),false],[FitScreenIcon,'Fit Workflow',fit,!layout]);
 else if(compact||coarse)controls.unshift([FitScreenIcon,'Fit Workflow',fit,!layout]);

 return <Stack sx={{minWidth:0,minHeight:0,height:'100%'}}>
  {error&&<Alert severity="error" action={<Button onClick={()=>setRetry(value=>value+1)}>Retry Layout</Button>}>{error}</Alert>}
  <Dialog open={active&&outlineOpen} onClose={()=>setOutlineOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Workflow Outline</DialogTitle><DialogContent sx={{overflowWrap:'anywhere'}}>{[...definition.steps,...definition.controls].map(node=><Box key={node.id} sx={{py:.5}}><Button size="small" onClick={()=>{onSelect(node.id);reveal(node.id,true);setOutlineOpen(false)}}>{nodeName(node)} · {nodeKind(node)}</Button>{layout?.groups.filter(group=>group.forkId===node.id).map(group=><Typography key={group.id} variant="caption" display="block">{group.label}</Typography>)}{layout?.edges.filter(edge=>edge.source===node.id).map(edge=>{const restriction=guidedInsertionRestriction(definition,edgeTarget(edge));return <Stack key={edge.id} spacing={.5} sx={{ml:1}}><Typography variant="body2">{edge.label} → {edge.terminal?'End This Path':nodeName([...definition.steps,...definition.controls].find(item=>item.id===edge.target)??{id:edge.target} as WorkflowNode)}</Typography>{restriction?<Typography variant="caption" color="text.secondary">{restriction}</Typography>:insertionButton(edge,true)}</Stack>})}</Box>)}</DialogContent><DialogActions><Button onClick={()=>setOutlineOpen(false)}>Close</Button></DialogActions></Dialog>
  <Box ref={region} role="region" aria-label="Workflow Canvas" aria-busy={arranging} onFocusCapture={event=>{const edge=(event.target as Element).closest('.react-flow__edge')?.getAttribute('data-id');if(edge)setSelectedEdge(edge)}} onKeyDown={event=>{const target=event.target as Element;if(target.closest('input,textarea,[contenteditable="true"],button:not(.react-flow__node)'))return;const nodeId=target.closest('.react-flow__node')?.getAttribute('data-id'),edgeId=target.closest('.react-flow__edge')?.getAttribute('data-id');if((event.key==='Enter'||event.key===' ')&&nodeId&&[...definition.steps,...definition.controls].some(node=>node.id===nodeId)){event.preventDefault();setSelectedEdge(undefined);onSelect(nodeId)}else if((event.key==='Enter'||event.key===' ')&&edgeId){event.preventDefault();setSelectedEdge(edgeId)}if((event.key==='Delete'||event.key==='Backspace')&&selected&&nodeId===selected&&!selectedEdge){event.preventDefault();onDelete(selected)}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();if(event.shiftKey)undoRedo.onRedo();else undoRedo.onUndo()}}} sx={{flex:1,minHeight:0,position:'relative',minWidth:0,overflow:'hidden',bgcolor:'background.default','--canvas-edge':theme.palette.text.secondary,'--canvas-failure':theme.palette.warning.main,'--canvas-error':theme.palette.error.main,'--xy-node-background-color':theme.palette.background.paper,'--xy-node-color':theme.palette.text.primary,'--xy-edge-stroke':theme.palette.text.secondary,'& .react-flow__node:focus-visible':{outline:'3px solid',outlineColor:'primary.main'}}}>
   <Box sx={{height:`calc(100% - ${bottomSheetHeight}px)`,display:'flex',flexDirection:'column',minHeight:0}}>
   <Box ref={scroll} role="region" aria-label={nativeGuided?'Scrollable Workflow':'Explore Canvas'} tabIndex={nativeGuided?0:undefined} onScroll={saveGuided} sx={{flex:1,minHeight:0,overflow:nativeGuided?'auto':'hidden',overscrollBehavior:'contain'}}>
    <Box sx={{width:nativeGuided?scene.width:'100%',height:nativeGuided?scene.height:'100%'}}>
    <CanvasActions.Provider value={actions}><ReactFlow<CanvasNode,CanvasEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onNodeClick={(_event,node)=>{if(node.data.node){setSelectedEdge(undefined);onSelect(node.id)}}} onEdgeClick={(_event,edge)=>setSelectedEdge(edge.id)} onMoveEnd={(event,viewport)=>{if(event&&mode!=='guided')setFree(viewport)}} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} connectOnClick={false} deleteKeyCode={null} autoPanOnNodeFocus={false} autoPanOnSelection={false} panActivationKeyCode={null} zoomActivationKeyCode={null} selectionKeyCode={null} panOnDrag={!nativeGuided} panOnScroll={!nativeGuided} preventScrolling={!nativeGuided} zoomOnScroll={false} zoomOnPinch={!nativeGuided} zoomOnDoubleClick={false} translateExtent={!nativeGuided&&frame?workflowTranslateExtent(frame,available,zoom):undefined} minZoom={.1} maxZoom={2} nodeClickDistance={6} paneClickDistance={6} defaultViewport={{x:0,y:0,zoom:1}} colorMode={theme.palette.mode} proOptions={{hideAttribution:true}}>
     <Background gap={24} size={.65} color={theme.palette.divider}/>
     {frame&&<ViewportPortal><Box ref={start} className="nodrag nopan" sx={{position:'absolute',left:frame.start.x,top:frame.start.y,width:frame.start.width,pointerEvents:'all','& > button':{width:'100%'}}}>{startControl}</Box><svg aria-hidden="true" style={{position:'absolute',left:frame.start.x+frame.start.width/2-8,top:frame.start.y+frame.start.height,width:16,height:64,overflow:'visible',pointerEvents:'none'}}><path d="M8 0 V56" fill="none" stroke={theme.palette.text.secondary} strokeWidth="1.6"/><path d="M3 55 L8 63 L13 55 Z" fill={theme.palette.text.secondary}/></svg>{frame.entry&&zoom>=.8&&!guidedInsertionRestriction(definition,{kind:'entry'})&&<Tooltip title="Insert Before The First Step"><IconButton ref={entryButtonRef} className="nodrag nopan" aria-label="Insert Before The First Step" onClick={event=>onInsert({kind:'entry'},event.currentTarget)} sx={{position:'absolute',left:frame.start.x+frame.start.width/2-22/zoom,top:frame.start.y+frame.start.height+(64-44/zoom)/2,width:44/zoom,height:44/zoom,'& svg':{fontSize:24/zoom},bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:'50%',pointerEvents:'all'}}><AddIcon/></IconButton></Tooltip>}{frame.firstStep&&<Button ref={entryButtonRef} variant="outlined" startIcon={<AddIcon/>} sx={{position:'absolute',left:frame.firstStep.x,top:frame.firstStep.y,width:frame.firstStep.width,height:frame.firstStep.height,pointerEvents:'all'}} onClick={event=>onInsert({kind:'entry'},event.currentTarget)}>Add Your First Step</Button>}</ViewportPortal>}
    </ReactFlow></CanvasActions.Provider>
    </Box>
   </Box>
   <Stack direction="row" alignItems="center" gap={1} sx={{flexShrink:0,flexWrap:'wrap',px:1.5,pt:1,pb:'calc(8px + env(safe-area-inset-bottom, 0px))',bgcolor:'background.default'}}>
    <Stack direction="row" alignItems="center" gap={.5} sx={{flexShrink:0}}>
    <Stack direction="row" sx={{bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:3,pointerEvents:'auto'}}>
     {controls.map(([Icon,label,action,disabled])=><Tooltip title={label} key={label}><span><IconButton aria-label={label} onClick={action} disabled={disabled} sx={{width:44,height:44}}><Icon/></IconButton></span></Tooltip>)}
    </Stack>
    <Tooltip title={exploring?'Return To Workflow':'Explore Workflow'}>{smallControls?<IconButton aria-label={exploring?'Return To Workflow':'Explore Workflow'} onClick={exploring?returnToWorkflow:explore} sx={{width:44,height:44,bgcolor:'background.paper'}}>{exploring?<ArrowBackIcon/>:<ExploreOutlinedIcon/>}</IconButton>:<Button variant="outlined" startIcon={exploring?<ArrowBackIcon/>:<ExploreOutlinedIcon/>} onClick={exploring?returnToWorkflow:explore} sx={{minHeight:44,bgcolor:'background.paper',whiteSpace:'nowrap'}}>{exploring?'Return To Workflow':'Explore Workflow'}</Button>}</Tooltip>
    </Stack>
    <Stack direction="row" alignItems="center" gap={1} sx={{ml:'auto',flexShrink:0,'& > .MuiButton-root':{minHeight:44,whiteSpace:'nowrap'}}}><Tooltip title="Workflow Outline"><IconButton ref={outlineButton} aria-label="Workflow Outline" onClick={()=>setOutlineOpen(true)} sx={{width:44,height:44,bgcolor:'background.paper',border:'1px solid',borderColor:'divider'}}><FormatListBulletedIcon/></IconButton></Tooltip>{saveControl}</Stack>
   </Stack>
   </Box>
   {(entryFallback||fallbackConnections.length>0)&&<Box sx={{position:'absolute',left:12,top:12,maxWidth:'calc(100% - 24px)',maxHeight:'30%',overflowY:'auto',bgcolor:'background.paper',borderRadius:1}}>{entryFallback&&<Button ref={entryButtonRef} size="small" startIcon={<AddIcon/>} sx={{minHeight:44}} onClick={event=>onInsert({kind:'entry'},event.currentTarget)}>Insert Before The First Step</Button>}{fallbackConnections.map(edge=>insertionButton(edge))}</Box>}
   {arranging&&<Typography role="status" variant="caption" sx={{position:'absolute',right:12,top:12,bgcolor:'background.paper',p:.5}}>Arranging Workflow…</Typography>}
  </Box>
 </Stack>;
}
