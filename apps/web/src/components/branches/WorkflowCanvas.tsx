import {createContext,memo,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {Alert,Box,Button,Dialog,DialogActions,DialogContent,DialogTitle,IconButton,Stack,Tooltip,Typography,useTheme} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import CallSplitOutlinedIcon from '@mui/icons-material/CallSplitOutlined';
import PlaylistAddCheckOutlinedIcon from '@mui/icons-material/PlaylistAddCheckOutlined';
import RepeatOutlinedIcon from '@mui/icons-material/RepeatOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
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
import {frameWorkflowCanvas,resizeWorkflowViewport,workflowTranslateExtent,clampWorkflowViewport} from './canvas-navigation';
import {guidedInsertionRestriction,type GuidedInsertionTarget} from './guided-operations';

export type CanvasViewState={viewport?:Viewport;available?:{width:number;height:number};selected?:string};
export type WorkflowUndoRedo={canUndo:boolean;canRedo:boolean;onUndo():void;onRedo():void};
type CanvasNode=Node<{layout:CanvasLayoutNode;node?:WorkflowNode;issue:boolean;entry:boolean}>;
type CanvasEdge=Edge<{layout:CanvasLayoutEdge;issue:boolean}>;
type Actions={definition:BranchDefinition;selected?:string;selectedEdge?:string;insert(target:GuidedInsertionTarget,anchor:HTMLElement,returnTo?:HTMLElement):void;measure(kind:'nodes'|'labels',id:string,width:number,height:number):void};
const CanvasActions=createContext<Actions>(null!);
function useMeasured(kind:'nodes'|'labels',id:string){
 const ref=useRef<HTMLDivElement>(null),{measure}=useContext(CanvasActions);
 useLayoutEffect(()=>{const element=ref.current;if(!element)return;const observer=new ResizeObserver(([entry])=>{if(entry)measure(kind,id,Math.ceil(entry.borderBoxSize?.[0]?.inlineSize??element.offsetWidth),Math.ceil(entry.borderBoxSize?.[0]?.blockSize??element.offsetHeight))});observer.observe(element);return()=>observer.disconnect()},[id,kind,measure]);
 return ref;
}
const WorkflowCard=memo(function WorkflowCard({data,selected}:NodeProps<CanvasNode>){
 const {layout,node,issue,entry}=data,ref=useMeasured('nodes',layout.id),updateInternals=useUpdateNodeInternals();
 const ports=JSON.stringify(layout.ports);useLayoutEffect(()=>updateInternals(layout.id),[layout.id,ports,updateInternals]);
 const Icon=node?.kind==='agent'?SmartToyOutlinedIcon:node?.kind==='script'?TerminalOutlinedIcon:node?.kind==='human_gate'||node?.kind==='join'?PlaylistAddCheckOutlinedIcon:node?.kind==='action'?NotificationsNoneOutlinedIcon:node?.kind==='map'?RepeatOutlinedIcon:node?.kind==='condition'||node?.kind==='route'||node?.kind==='fork'?CallSplitOutlinedIcon:AccountTreeOutlinedIcon;
 return <Box ref={ref} sx={{width:layout.kind==='terminal'?200:320,minHeight:layout.kind==='terminal'?56:104,boxSizing:'border-box',p:2,bgcolor:'background.paper',border:'1px solid',borderColor:issue?'error.main':selected?'primary.main':'divider',borderRadius:'12px',boxShadow:selected?'0 0 0 2px var(--ponderosa-accent), 0 4px 16px rgba(24,30,25,.08)':'0 2px 8px rgba(24,30,25,.04)',overflowWrap:'anywhere'}}>
  {layout.ports.map(port=><Handle key={port.id} id={port.id} type={port.id.startsWith('canvas:out:')?'source':'target'} position={port.side==='NORTH'?Position.Top:port.side==='SOUTH'?Position.Bottom:Position.Right} isConnectable={false} style={{visibility:'hidden',left:port.x,top:port.y,width:0,height:0,minWidth:0,minHeight:0}}/>)}
  {node?<Stack direction="row" alignItems="center" gap={1.5}><Box sx={{display:'grid',placeItems:'center',width:36,height:36,flexShrink:0,borderRadius:2,bgcolor:'action.hover',color:selected?'primary.main':'text.secondary'}}><Icon sx={{fontSize:22}}/></Box><Box sx={{flex:1,minWidth:0}}><Typography title={nodeName(node)} fontSize={16} lineHeight={1.35} fontWeight={650} sx={{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}}>{nodeName(node)}</Typography><Typography variant="body2" color="text.secondary" sx={{mt:.5}}>{nodeKind(node)}{entry?' · Start':''}</Typography>{layout.context&&<Typography variant="body2" color="text.secondary" sx={{mt:.5,display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden'}} title={layout.context}>{layout.context}</Typography>}{issue&&<Stack direction="row" alignItems="center" gap={.5} color="error.main"><SemanticStatusCircle/><Typography variant="caption">Needs Attention</Typography></Stack>}</Box><ChevronRightIcon sx={{flexShrink:0,color:selected?'primary.main':'text.secondary',fontSize:22}}/></Stack>:<Typography textAlign="center" fontWeight={600}>End This Path</Typography>}
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
  {!restriction&&<EdgeToolbar edgeId={id} x={edge.insertion.x+edge.insertion.width/2} y={edge.insertion.y+edge.insertion.height/2} isVisible={zoom>=.8&&edge.insertionAvailable&&(edge.source===sourceSelection||Boolean(edge.terminal)||id===selectedEdge)}><Tooltip title={restriction??`Insert On ${edge.label}`}><span><IconButton data-workflow-insertion={JSON.stringify(target)} className="nodrag nopan" aria-label={`Insert Step On ${edge.label}`} onClick={event=>insert(target,event.currentTarget)} sx={{width:44,height:44,p:.5,borderRadius:'50%',bgcolor:'transparent','&:hover':{bgcolor:'transparent'},'& > svg':{boxSizing:'content-box',width:20,height:20,p:.75,bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:'50%'},'&:hover > svg':{bgcolor:'action.hover'}}}><AddIcon/></IconButton></span></Tooltip></EdgeToolbar>}
 </>;
});
const nodeTypes={workflow:WorkflowCard,terminal:WorkflowCard},edgeTypes={guided:WorkflowConnection};
type Props={saveControl:ReactNode;expanded?:boolean;onToggleExpanded?():void;startControl?:ReactNode;entryButtonRef:React.RefObject<HTMLButtonElement>;branchId:string;definition:BranchDefinition;bindings:BranchBindings;agents:AgentDto[];selected?:string;onSelect(id:string):void;focusRequest:number;issues:BranchValidationIssue[];onInsert(target:GuidedInsertionTarget,anchor:HTMLElement,returnTo?:HTMLElement):void;onDelete(id:string):void;undoRedo:WorkflowUndoRedo;canvasViews:Map<string,CanvasViewState>;revealRequest?:number;bottomSheetHeight?:number;active:boolean};
export function WorkflowCanvas(props:Props):JSX.Element{return <ReactFlowProvider><GuidedCanvas {...props}/></ReactFlowProvider>}
function GuidedCanvas({saveControl,expanded=false,onToggleExpanded,startControl,entryButtonRef,branchId,definition,bindings,agents,selected,onSelect,focusRequest,issues,onInsert,onDelete,undoRedo,canvasViews,revealRequest=0,bottomSheetHeight=0,active}:Props):JSX.Element{
 const zoom=useStore(state=>state.transform[2]),theme=useTheme();
 const region=useRef<HTMLDivElement>(null),scroll=useRef<HTMLDivElement>(null),start=useRef<HTMLDivElement>(null),outlineButton=useRef<HTMLButtonElement>(null);
 const [flow,setFlow]=useState<ReactFlowInstance<CanvasNode,CanvasEdge>>(),[measurements,setMeasurements]=useState<CanvasMeasurements>({}),[layout,setLayout]=useState<CanvasLayout>(),[error,setError]=useState(''),[retry,setRetry]=useState(0),[arranging,setArranging]=useState(false),[selectedEdge,setSelectedEdge]=useState<string>(),[outlineOpen,setOutlineOpen]=useState(false);
 const [available,setAvailable]=useState({width:600,height:500}),[startSize,setStartSize]=useState({width:320,height:44});
 const lastFocusRequest=useRef(0),lastRevealRequest=useRef(0),latest=useRef({definition,bindings});latest.current={definition,bindings};
 // Keep an explicit Fit through measured toolbar reflow until the user moves the camera.
 const applied=useRef<{branchId:string;layout:CanvasLayout;selected?:string;available:typeof available}>(),fitPending=useRef<false|{width:number;height:number;key:string}>(false),restoringFocus=useRef(false);
 useLayoutEffect(()=>{fitPending.current=false},[branchId]);
 const remember=useCallback((patch:Partial<CanvasViewState>)=>{const previous=canvasViews.get(branchId);canvasViews.delete(branchId);canvasViews.set(branchId,{...previous,...patch,selected});while(canvasViews.size>100)canvasViews.delete(canvasViews.keys().next().value!);},[branchId,selected,canvasViews]);
 useEffect(()=>{remember({})},[selected,remember]);
 useEffect(()=>{if(!active)setOutlineOpen(false)},[active]);
 useLayoutEffect(()=>{const element=scroll.current;if(!element)return;const observer=new ResizeObserver(()=>setAvailable(previous=>element.clientWidth<=0||element.clientHeight<=0||previous.width===element.clientWidth&&previous.height===element.clientHeight?previous:{width:element.clientWidth,height:element.clientHeight}));observer.observe(element);return()=>observer.disconnect()},[]);
 useLayoutEffect(()=>{const element=start.current;if(!element)return;const observer=new ResizeObserver(([entry])=>{if(entry){const height=Math.ceil(entry.borderBoxSize?.[0]?.blockSize??element.offsetHeight);if(height>0)setStartSize(previous=>previous.height===height?previous:{width:320,height})}});observer.observe(element);return()=>observer.disconnect()},[Boolean(layout)]);
 const context=Object.fromEntries(definition.steps.flatMap(node=>{if(node.kind!=='agent'||!('ref'in node.target))return[];const id=bindings.agents[node.target.ref];return [[node.id,agents.find(agent=>agent.id===id)?.title??(id?'Loading Agent…':'Select Agent')]]}));
 const key=workflowCanvasKey(definition,bindings,measurements,context),selectedExists=[...definition.steps,...definition.controls].some(node=>node.id===selected);
 const measure=useCallback((kind:'nodes'|'labels',id:string,width:number,height:number)=>{if(width<=0||height<=0)return;setMeasurements(previous=>previous[kind]?.[id]?.width===width&&previous[kind]?.[id]?.height===height?previous:{...previous,[kind]:{...previous[kind],[id]:{width,height}}})},[]);
 useEffect(()=>{if(!active)return;if(layout?.key===key){setError('');setArranging(false);return;}let current=true;const elk=new ELK({workerFactory:()=>new Worker(new URL('elkjs/lib/elk-worker.min.js',import.meta.url))});setArranging(true);setError('');void layoutWorkflowCanvas(latest.current.definition,latest.current.bindings,measurements,context,elk).then(result=>{if(current){setLayout(result);setError('');setArranging(false)}}).catch(error=>{if(current){setError(error instanceof Error?error.message:'The Workflow Could Not Be Arranged. Retry Or Use The Workflow Outline.');setArranging(false)}});return()=>{current=false;elk.terminateWorker()}},[key,branchId,retry,active]);
 const measuring=arranging||!layout||layout.key!==key||layout.nodes.some(node=>!measurements.nodes?.[node.id])||layout.edges.some(edge=>!edge.unresolved&&!measurements.labels?.[edge.id]);
 const frame=useMemo(()=>layout?frameWorkflowCanvas(layout,definition.entry,startSize):undefined,[layout,definition.entry,startSize]);
 const setFree=(viewport:Viewport)=>{if(!flow||!frame)return;const next=clampWorkflowViewport(frame,available,viewport);void flow.setViewport(next);remember({viewport:next,available:{...available}})};
 const reveal=useCallback((id:string,force=false)=>{
  if(!flow||!layout||!frame)return;const node=layout.nodes.find(item=>item.id===id);if(!node)return;fitPending.current=false;
  const viewport=flow.getViewport(),scale=Math.max(.8,Math.min(viewport.zoom,1.2));if(!force&&node.x*viewport.zoom+viewport.x>=16&&node.y*viewport.zoom+viewport.y>=16&&(node.x+node.width)*viewport.zoom+viewport.x<=available.width-16&&(node.y+node.height)*viewport.zoom+viewport.y<=available.height-72)return;setFree({x:available.width/2-(node.x+node.width/2)*scale,y:Math.max(24,(available.height-node.height*scale)/2)-node.y*scale,zoom:scale});
 },[flow,layout,frame,available.width,available.height,remember]);

 // Restore against the measured viewport, preserving its visible world center.
 useLayoutEffect(()=>{
  if(!flow||!layout||!frame||measuring||!active||available.width<=0||available.height<=0)return;
  const task=requestAnimationFrame(()=>{
   const element=scroll.current;if(!element||element.clientWidth!==available.width||element.clientHeight!==available.height)return;
   const previous=applied.current,sameOwner=previous?.branchId===branchId,saved=canvasViews.get(branchId),node=layout.nodes.find(node=>node.id===selected),oldNode=sameOwner?previous.layout.nodes.find(node=>node.id===selected):undefined;
   let viewport=sameOwner?resizeWorkflowViewport(flow.getViewport(),previous.available,available):saved?.viewport?resizeWorkflowViewport(saved.viewport,saved.available??available,available):undefined;
   if(!viewport){const entry=frame.entry??frame.start;viewport={x:available.width/2-entry.x-entry.width/2,y:32-frame.start.y,zoom:1}}
   if(sameOwner&&previous.layout.key!==layout.key&&node&&oldNode)viewport={...viewport,x:viewport.x+(oldNode.x-node.x)*viewport.zoom,y:viewport.y+(oldNode.y-node.y)*viewport.zoom};
   const fitting=fitPending.current;if(fitting&&(fitting.width!==region.current?.clientWidth||fitting.height!==region.current?.clientHeight||fitting.key!==layout.key))fitPending.current=false;
   if(fitPending.current)viewport=getViewportForBounds(frame.bounds,available.width,available.height,.1,1.2,.1);
   setFree(viewport);applied.current={branchId,layout,selected,available:{...available}};
   const requested=Boolean(node)&&selectedExists&&revealRequest!==0&&lastRevealRequest.current!==revealRequest;if(requested)lastRevealRequest.current=revealRequest;
   if(sameOwner&&node&&previous.layout.key!==layout.key&&!oldNode)reveal(node.id,true);else if(requested&&selected)reveal(selected);
  });return()=>cancelAnimationFrame(task);
 },[flow,layout,measuring,active,branchId,available.width,available.height,startSize.height,revealRequest,selected,selectedExists]);
 useEffect(()=>{if(!selectedExists){lastFocusRequest.current=focusRequest;return;}if(!focusRequest||lastFocusRequest.current===focusRequest||!selected||!active)return;const task=requestAnimationFrame(()=>{const element=Array.from(region.current?.querySelectorAll<HTMLElement>('[data-id]')??[]).find(node=>node.dataset.id===selected&&node.classList.contains('react-flow__node'));if(element){lastFocusRequest.current=focusRequest;restoringFocus.current=true;try{element.focus({preventScroll:true})}finally{restoringFocus.current=false}}});return()=>cancelAnimationFrame(task)},[focusRequest,selected,selectedExists,active,layout]);
 useEffect(()=>{if(!selectedExists)lastRevealRequest.current=revealRequest},[selectedExists,revealRequest]);
 const fit=()=>{if(!flow||!frame||!layout)return;fitPending.current={width:region.current?.clientWidth??0,height:region.current?.clientHeight??0,key:layout.key};setFree(getViewportForBounds(frame.bounds,available.width,available.height,.1,1.2,.1))};
 const nodes=useMemo<CanvasNode[]>(()=>layout?.nodes.map(node=>{const canonical=[...definition.steps,...definition.controls].find(item=>item.id===node.id);return {id:node.id,type:node.kind,position:{x:node.x,y:node.y},initialWidth:node.width,initialHeight:node.height,style:{width:node.width},data:{layout:node,node:canonical,issue:issues.some(issue=>issue.nodeId===node.id),entry:definition.entry===node.id},selected:selected===node.id,draggable:false,connectable:false,deletable:false,focusable:Boolean(canonical),ariaLabel:canonical?`Select ${nodeName(canonical)}${issues.some(issue=>issue.nodeId===node.id)?', Configuration Issue':''}`:'End This Path'}})??[],[layout,definition,selected,issues]);
 const edges=useMemo<CanvasEdge[]>(()=>layout?.edges.filter(edge=>!edge.unresolved).map(edge=>({id:edge.id,type:'guided',source:edge.source,target:edge.target,sourceHandle:edge.sourcePort,targetHandle:edge.targetPort,data:{layout:edge,issue:issues.some(issue=>issue.edgeId===edge.id)},selected:edge.id===selectedEdge,focusable:true,reconnectable:false,deletable:false,ariaLabel:`${edge.label} Connection`,markerEnd:{type:MarkerType.ArrowClosed,width:18,height:18,color:theme.palette.text.secondary}}))??[],[layout,issues,selectedEdge,theme.palette.text.secondary]);
 const chosenConnection=layout?.edges.find(edge=>edge.id===selectedEdge&&!edge.unresolved),fallbackConnections=layout?.edges.filter(edge=>!edge.unresolved&&!guidedInsertionRestriction(definition,edgeTarget(edge))&&(edge.source===selected||edge.id===chosenConnection?.id)&&(zoom<.8||!edge.insertionAvailable))??[];
 const entryFallback=Boolean(frame?.entry&&zoom<.8&&!guidedInsertionRestriction(definition,{kind:'entry'}));
 const actions=useMemo(()=>({definition,selected,selectedEdge,insert:onInsert,measure}),[definition,selected,selectedEdge,onInsert,measure]);
 const outlineNodes=useMemo(()=>{const positions=new Map(layout?.nodes.map(node=>[node.id,node]));return [...definition.steps,...definition.controls].sort((a,b)=>{const first=positions.get(a.id),second=positions.get(b.id);return first&&second?first.y-second.y||first.x-second.x:first?-1:second?1:0})},[definition,layout]);
 const insertionButton=(edge:CanvasLayoutEdge,fromOutline=false)=><Button key={edge.id} data-workflow-insertion={JSON.stringify(edgeTarget(edge))} size="small" startIcon={<AddIcon/>} onClick={event=>{onInsert(edgeTarget(edge),event.currentTarget,fromOutline?outlineButton.current??undefined:undefined);setOutlineOpen(false)}}>Insert On {edge.label}</Button>;
 const zoomBy=(factor:number)=>{if(!flow)return;fitPending.current=false;const view=flow.getViewport(),next=Math.max(.1,Math.min(2,view.zoom*factor)),ratio=next/view.zoom;setFree({x:available.width/2-(available.width/2-view.x)*ratio,y:available.height/2-(available.height/2-view.y)*ratio,zoom:next})};
 const controls:Array<[typeof AddIcon,string,()=>void,boolean]>=[[UndoIcon,'Undo',undoRedo.onUndo,!undoRedo.canUndo],[RedoIcon,'Redo',undoRedo.onRedo,!undoRedo.canRedo]];
 controls.unshift([ZoomInIcon,'Zoom In',()=>zoomBy(1.2),false],[ZoomOutIcon,'Zoom Out',()=>zoomBy(1/1.2),false],[FitScreenIcon,'Fit Workflow',fit,measuring]);

 return <Stack sx={{minWidth:0,minHeight:0,height:'100%'}}>
  {error&&<Alert severity="error" action={<Button onClick={()=>setRetry(value=>value+1)}>Retry Layout</Button>}>{error}</Alert>}
  <Dialog open={active&&outlineOpen} onClose={()=>setOutlineOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Workflow Outline</DialogTitle><DialogContent sx={{overflowWrap:'anywhere'}}>{outlineNodes.map(node=><Box key={node.id} sx={{py:.5}}><Button size="small" onClick={()=>{onSelect(node.id);reveal(node.id,true);setOutlineOpen(false)}}>{nodeName(node)} · {nodeKind(node)}</Button>{layout?.groups.filter(group=>group.forkId===node.id).map(group=><Typography key={group.id} variant="caption" display="block">{group.label}</Typography>)}{layout?.edges.filter(edge=>edge.source===node.id).map(edge=>{const restriction=guidedInsertionRestriction(definition,edgeTarget(edge));return <Stack key={edge.id} spacing={.5} sx={{ml:1}}><Typography variant="body2">{edge.label} → {edge.terminal?'End This Path':nodeName([...definition.steps,...definition.controls].find(item=>item.id===edge.target)??{id:edge.target} as WorkflowNode)}</Typography>{restriction?<Typography variant="caption" color="text.secondary">{restriction}</Typography>:insertionButton(edge,true)}</Stack>})}</Box>)}</DialogContent><DialogActions><Button onClick={()=>setOutlineOpen(false)}>Close</Button></DialogActions></Dialog>
  <Box ref={region} role="region" aria-label="Workflow Canvas" aria-busy={measuring} onFocusCapture={event=>{const edge=(event.target as Element).closest('.react-flow__edge')?.getAttribute('data-id');if(edge)setSelectedEdge(edge);const id=(event.target as Element).closest('.react-flow__node')?.getAttribute('data-id');if(id&&!restoringFocus.current)reveal(id)}} onKeyDown={event=>{const target=event.target as Element;if(target.closest('input,textarea,[contenteditable="true"],button:not(.react-flow__node)'))return;const nodeId=target.closest('.react-flow__node')?.getAttribute('data-id'),edgeId=target.closest('.react-flow__edge')?.getAttribute('data-id');if((event.key==='Enter'||event.key===' ')&&nodeId&&[...definition.steps,...definition.controls].some(node=>node.id===nodeId)){event.preventDefault();setSelectedEdge(undefined);onSelect(nodeId)}else if((event.key==='Enter'||event.key===' ')&&edgeId){event.preventDefault();setSelectedEdge(edgeId)}if((event.key==='Delete'||event.key==='Backspace')&&selected&&nodeId===selected&&!selectedEdge){event.preventDefault();onDelete(selected)}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();if(event.shiftKey)undoRedo.onRedo();else undoRedo.onUndo()}}} sx={{flex:1,minHeight:0,position:'relative',minWidth:0,overflow:'hidden',bgcolor:'background.default','--canvas-edge':theme.palette.text.secondary,'--canvas-failure':theme.palette.warning.main,'--canvas-error':theme.palette.error.main,'--xy-node-background-color':theme.palette.background.paper,'--xy-node-color':theme.palette.text.primary,'--xy-edge-stroke':theme.palette.text.secondary,'& .react-flow__node:focus-visible':{outline:'3px solid',outlineColor:'primary.main'}}}>
   <Box sx={{height:`calc(100% - ${bottomSheetHeight}px)`,display:'flex',flexDirection:'column',minHeight:0}}>
   {(entryFallback||fallbackConnections.length>0)&&<Box role="group" aria-label="Workflow Insertion Actions" sx={{flexShrink:0,mx:1.5,mt:1.5,maxHeight:'30%',overflowY:'auto',bgcolor:'background.paper',borderRadius:1,'& > .MuiButton-root':{minHeight:44}}}>{entryFallback&&<Button ref={entryButtonRef} data-workflow-insertion="entry" size="small" startIcon={<AddIcon/>} sx={{minHeight:44}} onClick={event=>onInsert({kind:'entry'},event.currentTarget)}>Insert Before The First Step</Button>}{fallbackConnections.map(edge=>insertionButton(edge))}</Box>}
   <Box ref={scroll} role="region" aria-label="Canvas Viewport" sx={{flex:1,minHeight:0,overflow:'hidden',overscrollBehavior:'contain'}}>
    <Box sx={{width:'100%',height:'100%'}}>
    <CanvasActions.Provider value={actions}><ReactFlow<CanvasNode,CanvasEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onNodeClick={(_event,node)=>{if(node.data.node){setSelectedEdge(undefined);onSelect(node.id)}}} onEdgeClick={(_event,edge)=>setSelectedEdge(edge.id)} onMoveEnd={(event,viewport)=>{if(event){fitPending.current=false;setFree(viewport)}}} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} connectOnClick={false} deleteKeyCode={null} autoPanOnNodeFocus={false} autoPanOnSelection={false} panActivationKeyCode={null} zoomActivationKeyCode={['Control','Meta']} selectionKeyCode={null} panOnDrag panOnScroll preventScrolling zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick={false} translateExtent={frame?workflowTranslateExtent(frame,available,zoom):undefined} minZoom={.1} maxZoom={2} nodeClickDistance={6} paneClickDistance={6} defaultViewport={canvasViews.get(branchId)?.viewport??{x:0,y:0,zoom:1}} colorMode={theme.palette.mode} proOptions={{hideAttribution:true}}>
     <Background gap={24} size={.5} color={theme.palette.divider}/>
     {frame&&<ViewportPortal><Box ref={start} className="nodrag nopan" sx={{position:'absolute',left:frame.start.x,top:frame.start.y,width:frame.start.width,pointerEvents:'all','& > button':{width:'100%'}}}>{startControl}</Box><svg aria-hidden="true" style={{position:'absolute',left:frame.start.x+frame.start.width/2-8,top:frame.start.y+frame.start.height,width:16,height:64,overflow:'visible',pointerEvents:'none'}}><path d="M8 0 V56" fill="none" stroke={theme.palette.text.secondary} strokeWidth="1.6"/><path d="M3 55 L8 63 L13 55 Z" fill={theme.palette.text.secondary}/></svg>{frame.entry&&zoom>=.8&&!guidedInsertionRestriction(definition,{kind:'entry'})&&<Tooltip title="Insert Before The First Step"><IconButton ref={entryButtonRef} data-workflow-insertion="entry" className="nodrag nopan" aria-label="Insert Before The First Step" onClick={event=>onInsert({kind:'entry'},event.currentTarget)} sx={{position:'absolute',left:frame.start.x+frame.start.width/2-22/zoom,top:frame.start.y+frame.start.height+(64-44/zoom)/2,width:44/zoom,height:44/zoom,'& svg':{fontSize:24/zoom},bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:'50%',pointerEvents:'all'}}><AddIcon/></IconButton></Tooltip>}{frame.firstStep&&<Button ref={entryButtonRef} data-workflow-insertion="entry" variant="outlined" startIcon={<AddIcon/>} sx={{position:'absolute',left:frame.firstStep.x,top:frame.firstStep.y,width:frame.firstStep.width,height:frame.firstStep.height,pointerEvents:'all'}} onClick={event=>onInsert({kind:'entry'},event.currentTarget)}>Add Your First Step</Button>}</ViewportPortal>}
    </ReactFlow></CanvasActions.Provider>
    </Box>
   </Box>
   <Stack direction="row" alignItems="center" gap={1} sx={{flexShrink:0,flexWrap:'wrap',px:1.5,pt:1,borderTop:'1px solid',borderColor:'divider',pb:'calc(8px + env(safe-area-inset-bottom, 0px))',bgcolor:'background.default'}}>
    <Stack direction="row" alignItems="center" gap={.5} sx={{flexShrink:0}}>
    <Stack direction="row" sx={{bgcolor:'background.paper',border:'1px solid',borderColor:'divider',borderRadius:'12px',pointerEvents:'auto'}}>
     {controls.map(([Icon,label,action,disabled])=><Tooltip title={label} key={label}><span><IconButton aria-label={label} onClick={action} disabled={disabled} sx={{width:44,height:44}}><Icon/></IconButton></span></Tooltip>)}
    </Stack>
    {onToggleExpanded&&<Tooltip title={expanded?'Collapse Workflow':'Expand Workflow'}><IconButton aria-label={expanded?'Collapse Workflow':'Expand Workflow'} aria-pressed={expanded} onClick={onToggleExpanded} sx={{width:44,height:44,bgcolor:'background.paper'}}>{expanded?<CloseFullscreenIcon/>:<OpenInFullIcon/>}</IconButton></Tooltip>}
    </Stack>
    <Stack direction="row" alignItems="center" gap={1} sx={{ml:'auto',flexShrink:0,'& > .MuiButton-root':{minHeight:44,whiteSpace:'nowrap'}}}><Tooltip title="Workflow Outline"><IconButton ref={outlineButton} aria-label="Workflow Outline" onClick={()=>setOutlineOpen(true)} sx={{width:44,height:44,bgcolor:'background.paper',border:'1px solid',borderColor:'divider'}}><FormatListBulletedIcon/></IconButton></Tooltip>{saveControl}</Stack>
   </Stack>
   </Box>
   {measuring&&!error&&<Typography role="status" variant="caption" sx={{position:'absolute',right:12,top:12,bgcolor:'background.paper',p:.5}}>Arranging Workflow…</Typography>}
  </Box>
 </Stack>;
}
