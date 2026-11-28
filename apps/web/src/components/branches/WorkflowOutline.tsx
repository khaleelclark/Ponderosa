import {Fragment,useLayoutEffect,useMemo,useRef,type ReactNode,type RefObject} from 'react';
import {Box,Button,IconButton,Stack,Tooltip,Typography} from '@mui/material';
import {alpha} from '@mui/material/styles';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import MergeIcon from '@mui/icons-material/Merge';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import AddIcon from '@mui/icons-material/Add';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import type {AgentDto,BranchBindings,BranchDefinition,BranchValidationIssue} from '@ponderosa/core';
import {isContextMenuKey} from "../contextMenuKeys";
import {guidedInsertionRestriction,type GuidedInsertionTarget} from './guided-operations';
import {nodeKind,nodeName} from './model';
import {workflowOutline,type OutlineItem} from './workflow-outline';
import type {WorkflowUndoRedo} from './WorkflowCanvas';

const rowHeight={minHeight:39,'@container (max-width: 440px)':{minHeight:44},'@media (any-pointer: coarse)':{minHeight:44}} as const;
const actionStyle={justifyContent:'start',textAlign:'left',textTransform:'none',overflowWrap:'anywhere',borderRadius:0} as const;
type RouteGroup=Extract<OutlineItem,{kind:'routes'}>;

export function WorkflowOutline({definition,bindings,agents,issues,active,selected,onSelect,onInsert,onStepMenu,stepMenuId,startControl,entryButtonRef,viewSelector,saveControl,undoRedo,expanded,onToggleExpanded,focusRequest,revealRequest,scrollPosition}:{
 definition:BranchDefinition;bindings:BranchBindings;agents:AgentDto[];issues:BranchValidationIssue[];
 active:boolean;selected?:string;onSelect(id:string):void;onStepMenu(id:string,anchor:HTMLElement):void;stepMenuId?:string;
 onInsert(target:GuidedInsertionTarget,anchor:HTMLElement,returnTo?:HTMLElement,label?:string):void;
 startControl:ReactNode;entryButtonRef:RefObject<HTMLButtonElement>;viewSelector:ReactNode;saveControl:ReactNode;undoRedo:WorkflowUndoRedo;
 expanded:boolean;onToggleExpanded():void;focusRequest:number;revealRequest:number;scrollPosition:{current:number};
}):JSX.Element {
 const items=useMemo(()=>workflowOutline(definition),[definition]);
 const rows=useRef(new Map<string,HTMLButtonElement>()),scroll=useRef<HTMLDivElement>(null);
 const lastFocus=useRef(focusRequest),lastReveal=useRef(revealRequest);
 const showInViewport=(row:HTMLElement,region:HTMLElement)=>{
  const viewport=region.getBoundingClientRect(),rect=row.getBoundingClientRect();
  if(rect.top<viewport.top)region.scrollTop+=rect.top-viewport.top;
  else if(rect.bottom>viewport.bottom)region.scrollTop+=rect.bottom-viewport.bottom;
 };
 const showRow=(id:string,focus:boolean)=>{
  const row=rows.current.get(id),region=scroll.current;
  if(!row||!region)return;
  for(let parent=row.parentElement;parent&&parent!==region;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;
  showInViewport(row,region);
  if(focus)row.focus({preventScroll:true});
 };
 useLayoutEffect(()=>{if(active&&scroll.current)scroll.current.scrollTop=scrollPosition.current},[active,scrollPosition]);
 useLayoutEffect(()=>{
  if(!active){lastFocus.current=focusRequest;lastReveal.current=revealRequest;return}
  const focus=focusRequest!==0&&lastFocus.current!==focusRequest;
  const reveal=lastReveal.current!==revealRequest;
  if(focusRequest)lastFocus.current=focusRequest;
  lastReveal.current=revealRequest;
  if(selected&&(focus||reveal))showRow(selected,focus);
  else if(!selected&&focus)entryButtonRef.current?.focus({preventScroll:true});
 },[active,selected,focusRequest,revealRequest,entryButtonRef]);
 const nodes=useMemo(()=>new Map([...definition.steps,...definition.controls].map(node=>[node.id,node])),[definition]);
 const indent=(depth:number)=>depth<4?1.25:.5;
 const guide=(depth:number)=>({ml:depth<4?1:0,pl:indent(depth),borderLeft:1,borderColor:'divider',minWidth:0});
 const link=(id:string,label:string,key:string,failure=false)=><Button key={key} size="small" color="inherit" onClick={()=>showRow(id,true)} sx={[{...rowHeight,minHeight:30},actionStyle,{alignSelf:'start',px:1,fontWeight:400,color:failure?'warning.main':'text.secondary','&:hover':{textDecoration:'underline'}}]}>{label}</Button>;
 const disclosure=(heading:string,summary?:string,warm=false)=><Box component="summary" onClick={event=>{
  const header=event.currentTarget,details=header.parentElement as HTMLDetailsElement,region=scroll.current;
  if(!region)return;
  event.preventDefault();
  header.focus({preventScroll:true});
  const top=header.getBoundingClientRect().top;
  details.open=!details.open;
  region.scrollTop+=header.getBoundingClientRect().top-top;
  showInViewport(header,region);
  scrollPosition.current=region.scrollTop;
 }} sx={[rowHeight,{boxSizing:'border-box',display:'flex',alignItems:'center',gap:.75,px:.75,py:.5,cursor:'pointer',borderRadius:.5,WebkitTapHighlightColor:'transparent',
  '&::-webkit-details-marker':{display:'none'},'&:hover':{bgcolor:'action.hover'},'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2}}]}>
  <ChevronRightIcon sx={{fontSize:16,flexShrink:0,color:warm?'warning.main':'text.secondary'}}/>
  <Box component="span" sx={{display:'flex',flexWrap:'wrap',alignItems:'baseline',columnGap:1,minWidth:0,overflowWrap:'anywhere'}}>
   <Typography component="span" variant="body2" fontWeight={600} color={warm?'warning.main':undefined}>{heading}</Typography>
   {summary&&<Typography component="span" variant="caption" color="text.secondary">· {summary}</Typography>}
  </Box>
 </Box>;
 const detailsStyle={minWidth:0,'&[open] > summary > svg':{transform:'rotate(90deg)'}} as const;
 const render=(entries:OutlineItem[],depth=0,group?:RouteGroup):ReactNode=>entries.map((item,index)=>{
  if(item.kind==='link')return link(item.id,item.label,`link:${item.id}:${index}`);
  if(item.kind==='missing')return <Typography key="missing" variant="body2" color="error.main">Choose a destination</Typography>;
  if(item.kind==='routes')return <Stack key={`routes:${item.id}`} sx={{...guide(depth),mt:item.mode==='decision' ? .5 : 0}}>{render(item.items,depth+1,item)}</Stack>;
  if(item.kind==='path'){
   const {path}=item,key=`path:${path.key}`;
   const parallel=group?.mode==='parallel';
   const failure=path.failure;
   const items=parallel&&group.joinId&&item.items[0]?.kind==='step'?item.items.filter(child=>child.kind!=='link'||child.id!==group.joinId||child.prefix!=='Rejoin at'):item.items;
   const first=items[0],destination=path.to?nodes.get(path.to):undefined;
   const name=destination?nodeName(destination):undefined;
   const heading=parallel&&name?name:path.label;
   const condition=group?.mode==='decision'&&nodes.get(group.id)?.kind==='condition';
   const summary=group?.mode==='decision'?path.summary:!parallel?name:undefined;
   if(first?.kind==='link'&&group?.mode!=='decision'){
    if(parallel)return link(first.id,`${path.label} → ${first.label}`,key);
    const destination=path.loop?first.label:summary;
    return link(first.id,destination&&destination!==heading?`${heading} → ${destination}`:heading,key,failure);
   }
   if(!first||first.kind==='missing')return <Typography key={key} variant="body2" color={first?'error.main':'text.secondary'} sx={{px:1,py:.5,overflowWrap:'anywhere'}}>{heading} → {first?'Choose a destination':'End this path'}</Typography>;
   if(failure&&destination)return <Fragment key={key}>
    {link(destination.id,`On failure → ${name}`,key,true)}
    <Box component="details">
     {/* The link reveals this destination through the same ancestor walk as other jumps. */}
     <summary hidden />
     <Stack sx={guide(depth)}>{render(items,depth+1)}</Stack>
    </Box>
   </Fragment>;
   if(parallel&&items.length===1&&first.kind==='step')return <Fragment key={key}>{render(items,depth)}</Fragment>;
   return <Box component="details" key={key} open={!parallel&&!path.secondary} sx={detailsStyle}>
    {disclosure(heading,condition||summary!==heading?summary:undefined)}
    <Stack sx={group?{pl:indent(depth)}:guide(depth)}>{render(items,depth+1)}</Stack>
   </Box>;
  }
  if(item.kind==='sharedFailure')return <Box key="sharedFailure" component="details" sx={{...detailsStyle,mt:1.5,pt:.5,borderTop:1,borderColor:'divider'}}>
   {disclosure(item.count===1?'Shared failure step':'Shared failure steps',undefined,true)}
   <Stack sx={guide(depth)}>{render(item.items,depth+1)}</Stack>
  </Box>;
  if(item.kind==='unconnected')return <Fragment key="unconnected"><Typography variant="body2" color="text.secondary" sx={{mt:1}}>Unconnected steps</Typography>{render(item.items,depth)}</Fragment>;
  const {node}=item,chosen=node.id===selected,problem=issues.some(issue=>issue.nodeId===node.id);
  const agentId=node.kind==='agent'&&'ref' in node.target?bindings.agents[node.target.ref]:undefined;
  const agent=agents.find(agent=>agent.id===agentId)?.title;
  const name=nodeName(node);
  const decision=node.kind==='condition'||node.kind==='route';
  const parallel=node.kind==='fork',join=node.kind==='join';
  const Icon=decision?AltRouteIcon:parallel?CallSplitIcon:join?MergeIcon:undefined;
  const pathCount=node.kind==='fork'?item.paths.filter(path=>path.on==='selected').length:0;
  return <Stack key={`step:${node.id}`} direction="row" alignItems="center"
   onContextMenu={event=>{const row=rows.current.get(node.id);if(row){event.preventDefault();event.stopPropagation();onStepMenu(node.id,row)}}}
   onKeyDown={event=>{if(isContextMenuKey(event)){event.preventDefault();event.stopPropagation();onStepMenu(node.id,event.target as HTMLElement)}}}
   sx={theme=>({borderBottom:decision||parallel||join?0:1,borderTop:join?1:0,borderColor:'divider',borderRadius:decision ? .75 : 0,
    mt:parallel ? .75 : 0,mb:join ? .375 : 0,bgcolor:chosen?'action.selected':decision?alpha(theme.palette.primary.main,.10):undefined,minWidth:0})}>
   <Button ref={element=>{if(element)rows.current.set(node.id,element);else rows.current.delete(node.id)}} aria-pressed={chosen} onClick={event=>{event.currentTarget.focus({preventScroll:true});onSelect(node.id)}} color="inherit" sx={[rowHeight,actionStyle,{flex:1,minWidth:0,gap:.5,px:1,py:.5,justifyContent:'space-between',
    '@container (max-width: 440px)':{minHeight:44,flexWrap:'wrap',rowGap:0}}]}>
    <Box component="span" sx={{display:'flex',alignItems:'baseline',gap:1,minWidth:0,overflowWrap:'anywhere',fontWeight:Icon?600:500,color:join?'primary.main':undefined}}>
     {Icon&&<Icon sx={{fontSize:16,alignSelf:'center',flexShrink:0,color:'primary.main'}}/>}
     <Box component="span">{name}{parallel&&<Typography component="span" variant="caption" color="text.secondary">{` · ${pathCount} parallel ${pathCount===1?'path':'paths'}`}</Typography>}</Box>
    </Box>
    {node.kind!=='fork'&&<Typography component="span" variant="caption" color={problem?'error.main':'text.secondary'} sx={{minWidth:0,overflowWrap:'anywhere',textAlign:'right'}}>{nodeKind(node)}{agent?` · ${agent}`:''}{problem?' · Needs attention':''}</Typography>}
    {node.kind==='fork'&&problem&&<Typography component="span" variant="caption" color="error.main">Needs attention</Typography>}
   </Button>
   <IconButton aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={stepMenuId===node.id} onContextMenu={event=>{event.preventDefault();event.stopPropagation();onStepMenu(node.id,event.currentTarget)}} onClick={event=>onStepMenu(node.id,event.currentTarget)} sx={[rowHeight,{width:44,p:.5,flexShrink:0}]}><MoreHorizIcon/></IconButton>
  </Stack>;
 });
 return <Stack role="region" aria-label="Workflow Outline" sx={{height:'100%',minHeight:0,minWidth:0}} onKeyDown={event=>{
  if(!scroll.current?.contains(event.target as Node)||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='z')return;
  event.preventDefault();
  if(event.shiftKey)undoRedo.onRedo();else undoRedo.onUndo();
 }}>
  <Box ref={scroll} onScroll={event=>{if(active)scrollPosition.current=event.currentTarget.scrollTop}} sx={{flex:1,minHeight:0,overflowY:'auto',overscrollBehavior:'contain',overflowAnchor:'none',p:{xs:1.5,sm:2}}}>
   <Stack spacing={.75} sx={{maxWidth:760,mx:'auto',containerType:'inline-size'}}>
    <Box sx={{alignSelf:'start'}}>{startControl}</Box>
    {!guidedInsertionRestriction(definition,{kind:'entry'})&&<Button ref={entryButtonRef} variant={definition.entry?'text':'outlined'} startIcon={<AddIcon/>} onClick={event=>onInsert({kind:'entry'},event.currentTarget)} sx={{alignSelf:'start',minHeight:44}}>
     {definition.entry?'Insert before the first step':'Add your first step'}
    </Button>}
    <Stack>{render(items)}</Stack>
   </Stack>
  </Box>
  <Stack direction="row" alignItems="center" gap={.5} sx={{px:1.5,pt:1,pb:'calc(8px + env(safe-area-inset-bottom, 0px))',borderTop:1,borderColor:'divider',flexWrap:'wrap',flexShrink:0}}>
   {viewSelector}
   <Tooltip title="Undo"><span><IconButton aria-label="Undo" disabled={!undoRedo.canUndo} onClick={undoRedo.onUndo} sx={{width:44,height:44}}><UndoIcon/></IconButton></span></Tooltip>
   <Tooltip title="Redo"><span><IconButton aria-label="Redo" disabled={!undoRedo.canRedo} onClick={undoRedo.onRedo} sx={{width:44,height:44}}><RedoIcon/></IconButton></span></Tooltip>
   <IconButton aria-label={expanded?'Collapse Workflow':'Expand Workflow'} aria-pressed={expanded} onClick={onToggleExpanded} sx={{width:44,height:44}}>{expanded?<CloseFullscreenIcon/>:<OpenInFullIcon/>}</IconButton>
   <Box sx={{ml:'auto',minWidth:0,maxWidth:'100%','& .MuiButton-root':{minHeight:44}}}>{saveControl}</Box>
  </Stack>
 </Stack>;
}
