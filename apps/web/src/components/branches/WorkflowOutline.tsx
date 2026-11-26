import {Fragment,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type RefObject} from 'react';
import {Box,Button,IconButton,Menu,MenuItem,Stack,Tooltip,Typography} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import AddIcon from '@mui/icons-material/Add';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import UndoIcon from '@mui/icons-material/Undo';
import RedoIcon from '@mui/icons-material/Redo';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import type {AgentDto,BranchBindings,BranchDefinition,BranchValidationIssue} from '@ponderosa/core';
import {guidedInsertionRestriction,type GuidedInsertionTarget} from './guided-operations';
import {nodeKind,nodeName,removeWorkflowNode} from './model';
import {workflowOutline,type OutlineItem} from './workflow-outline';
import type {WorkflowUndoRedo} from './WorkflowCanvas';

export function WorkflowOutline({definition,bindings,agents,issues,active,selected,onSelect,onInsert,onDelete,startControl,entryButtonRef,viewSelector,saveControl,undoRedo,expanded,onToggleExpanded,focusRequest,revealRequest,scrollPosition}:{
 definition:BranchDefinition;bindings:BranchBindings;agents:AgentDto[];issues:BranchValidationIssue[];
 active:boolean;selected?:string;onSelect(id:string):void;onDelete(id:string):void;
 onInsert(target:GuidedInsertionTarget,anchor:HTMLElement,returnTo?:HTMLElement,label?:string):void;
 startControl:ReactNode;entryButtonRef:RefObject<HTMLButtonElement>;viewSelector:ReactNode;saveControl:ReactNode;undoRedo:WorkflowUndoRedo;
 expanded:boolean;onToggleExpanded():void;focusRequest:number;revealRequest:number;scrollPosition:{current:number};
}):JSX.Element {
 const items=useMemo(()=>workflowOutline(definition),[definition]);
 const nodes=useMemo(()=>new Map([...definition.steps,...definition.controls].map(node=>[node.id,node])),[definition]);
 const rows=useRef(new Map<string,HTMLButtonElement>()),scroll=useRef<HTMLDivElement>(null);
 const lastFocus=useRef(focusRequest),lastReveal=useRef(revealRequest);
 const [menu,setMenu]=useState<{id:string;anchor:HTMLElement}>();
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
 useLayoutEffect(()=>{if(active&&scroll.current)scroll.current.scrollTop=scrollPosition.current;else setMenu(undefined)},[active,scrollPosition]);
 useLayoutEffect(()=>{
  if(!active){lastFocus.current=focusRequest;lastReveal.current=revealRequest;return}
  const focus=focusRequest!==0&&lastFocus.current!==focusRequest;
  const reveal=lastReveal.current!==revealRequest;
  if(focusRequest)lastFocus.current=focusRequest;
  lastReveal.current=revealRequest;
  if(selected&&(focus||reveal))showRow(selected,focus);
  else if(!selected&&focus)entryButtonRef.current?.focus({preventScroll:true});
 },[active,selected,focusRequest,revealRequest,entryButtonRef]);
 const menuNode=menu&&nodes.get(menu.id);
 const remove=menuNode&&removeWorkflowNode(definition,menuNode.id);
 const pathIndent={xs:1,sm:2};
 const link=(id:string,label:string,key:string,indent:number|typeof pathIndent=0)=><Button key={key} size="small" onClick={()=>showRow(id,true)} sx={{ml:indent,minHeight:44,justifyContent:'start',textAlign:'left',textTransform:'none',overflowWrap:'anywhere'}}>{label}</Button>;
 const render=(entries:OutlineItem[],depth=0):ReactNode=>entries.map((item,index)=>{
  if(item.kind==='link')return link(item.id,item.label,`link:${item.id}:${index}`);
  if(item.kind==='missing')return <Typography key="missing" variant="body2" color="error.main">Choose a destination</Typography>;
  if(item.kind==='path'){
   const {path,items}=item,key=`path:${path.key}`,first=items[0],indent=depth<4?pathIndent:0;
   if(first?.kind==='link')return link(first.id,`${path.label} → ${first.label}`,key,indent);
   if(!first||first.kind==='missing')return <Typography key={key} variant="body2" color={first?'error.main':'text.secondary'} sx={{ml:indent,py:.25}}>{path.label} → {first?'Choose a destination':'End this path'}</Typography>;
   return <Box component="details" key={key} open={!path.secondary} sx={{ml:indent,minWidth:0,'&[open] > summary .outline-destination':{display:'none'},'&[open] > summary > svg':{transform:'rotate(90deg)'}}}>
    <Box component="summary" onClick={event=>{
     const summary=event.currentTarget,details=summary.parentElement as HTMLDetailsElement,region=scroll.current;
     if(!region)return;
     event.preventDefault();
     summary.focus({preventScroll:true});
     const top=summary.getBoundingClientRect().top;
     details.open=!details.open;
     region.scrollTop+=summary.getBoundingClientRect().top-top;
     showInViewport(summary,region);
     scrollPosition.current=region.scrollTop;
    }} sx={{display:'flex',alignItems:'flex-start',gap:.5,px:.5,py:1.5,minHeight:44,cursor:'pointer',borderRadius:1,bgcolor:'action.hover',
     '&::-webkit-details-marker':{display:'none'},'&:hover':{bgcolor:'action.selected'},'&:focus-visible':{outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2}}}>
     <ChevronRightIcon fontSize="small" sx={{flexShrink:0,color:'text.secondary'}}/>
     <Typography component="span" variant="body2" sx={{minWidth:0,overflowWrap:'anywhere'}}>
      <Box component="span" fontWeight={600}>{path.label}</Box>{first.kind==='step'&&<Box component="span" className="outline-destination" sx={{color:'text.secondary'}}> → {nodeName(first.node)}</Box>}
     </Typography>
    </Box>
    <Stack spacing={.5} sx={{ml:.5,pl:depth<4?1.25:.5,pb:.5,borderLeft:1,borderColor:'divider'}}>{render(items,depth+1)}</Stack>
   </Box>;
  }
  if(item.kind==='unconnected')return <Fragment key="unconnected"><Typography variant="body2" color="text.secondary" sx={{mt:1}}>Unconnected steps</Typography>{render(item.items,depth)}</Fragment>;
  const {node,paths}=item,chosen=node.id===selected,problem=issues.some(issue=>issue.nodeId===node.id);
  const agentId=node.kind==='agent'&&'ref' in node.target?bindings.agents[node.target.ref]:undefined;
  const agent=agents.find(agent=>agent.id===agentId)?.title;
  const name=nodeName(node),options=paths.filter(path=>!guidedInsertionRestriction(definition,path.target));
  const editable=options.length>0||Boolean(menu?.id===node.id?remove?.ok:removeWorkflowNode(definition,node.id).ok);
  return <Stack key={`step:${node.id}`} direction="row" alignItems="center" sx={{border:1,borderColor:problem?'error.main':chosen?'primary.main':'divider',borderRadius:1.5,bgcolor:chosen?'action.selected':'background.paper',minWidth:0}}>
   <Button ref={element=>{if(element)rows.current.set(node.id,element);else rows.current.delete(node.id)}} aria-pressed={chosen} onClick={event=>{event.currentTarget.focus({preventScroll:true});onSelect(node.id)}} color="inherit" sx={{flex:1,minWidth:0,minHeight:44,justifyContent:'start',textAlign:'left',textTransform:'none',px:1.25,py:.5}}>
    <Box component="span" sx={{overflowWrap:'anywhere'}}>{name}<Typography component="span" variant="caption" display="block" color="text.secondary">{nodeKind(node)}{agent?` · ${agent}`:''}{problem?' · Needs attention':''}</Typography></Box>
   </Button>
   {editable&&<IconButton aria-label={`Actions for ${name}`} aria-haspopup="menu" aria-expanded={menu?.id===node.id} onClick={event=>setMenu({id:node.id,anchor:event.currentTarget})} sx={{width:44,height:44,flexShrink:0}}><MoreHorizIcon/></IconButton>}
   {menu?.id===node.id&&<Menu anchorEl={menu.anchor} open onClose={()=>{setMenu(undefined);requestAnimationFrame(()=>menu.anchor.focus({preventScroll:true}))}} disableRestoreFocus slotProps={{list:{'aria-label':`Actions for ${name}`},paper:{sx:{maxWidth:'calc(100vw - 32px)','& .MuiMenuItem-root':{minHeight:44,whiteSpace:'normal',overflowWrap:'anywhere'}}}}}>
    {options.map(path=>{
     const linear=paths.length===1&&!path.loop&&['On success','If approved'].includes(path.label);
     const destination=path.to?nodes.get(path.to):undefined;
     const route=destination?`${path.label} → ${path.loop?'loop to ':''}${nodeName(destination)}`:path.label;
     const label=linear?'Add after this step':/^(On |If |Otherwise$)/.test(path.label)?`Add ${route[0]!.toLowerCase()}${route.slice(1)}`:`Add on ${route}`;
     return <MenuItem key={path.key} onClick={()=>{setMenu(undefined);onInsert(path.target,menu.anchor,rows.current.get(node.id),linear?`After ${name}`:route)}}>{label}</MenuItem>;
    })}
    {!['fork','join','map'].includes(node.kind)&&<MenuItem disabled={!remove?.ok} onClick={()=>{setMenu(undefined);onDelete(node.id)}}>Remove step</MenuItem>}
   </Menu>}
  </Stack>;
 });
 return <Stack role="region" aria-label="Workflow Outline" sx={{height:'100%',minHeight:0,minWidth:0}} onKeyDown={event=>{
  if(!scroll.current?.contains(event.target as Node)||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='z')return;
  event.preventDefault();
  if(event.shiftKey)undoRedo.onRedo();else undoRedo.onUndo();
 }}>
  <Box ref={scroll} onScroll={event=>{if(active)scrollPosition.current=event.currentTarget.scrollTop}} sx={{flex:1,minHeight:0,overflowY:'auto',overscrollBehavior:'contain',overflowAnchor:'none',p:{xs:1.5,sm:2}}}>
   <Stack spacing={.75} sx={{maxWidth:760,mx:'auto'}}>
    <Box sx={{alignSelf:'start'}}>{startControl}</Box>
    {!guidedInsertionRestriction(definition,{kind:'entry'})&&<Button ref={entryButtonRef} variant={definition.entry?'text':'outlined'} startIcon={<AddIcon/>} onClick={event=>onInsert({kind:'entry'},event.currentTarget)} sx={{alignSelf:'start',minHeight:44}}>
     {definition.entry?'Insert before the first step':'Add your first step'}
    </Button>}
    {render(items)}
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
