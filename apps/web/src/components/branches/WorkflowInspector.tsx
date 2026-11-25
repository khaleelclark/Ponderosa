import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Box} from '@mui/material';
import FocusTrap from '@mui/material/Unstable_TrapFocus';

const widthKey='ponderosa.workflow-inspector.width';
const minimumWidth=320;
const canvasWidth=380;
const dividerWidth=12;
const limitWidth=(width:number,max:number)=>Math.min(max,Math.max(minimumWidth,Math.round(width)));

export function WorkflowInspector({open,pane,mobile=false,fallbackFocus,children,content}:{
 open:boolean;pane?:string;mobile?:boolean;fallbackFocus():HTMLElement|null;children:ReactNode;content:ReactNode;
}):JSX.Element {
 const root=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),previous=useRef<HTMLElement>(),wasOpen=useRef(false);
 const drag=useRef<{start:number;width:number}>();
 const [workspaceWidth,setWorkspaceWidth]=useState(0);
 const [preferred,setPreferred]=useState(()=>{
  try{const saved=Number(localStorage.getItem(widthKey));return Number.isFinite(saved)&&saved>=minimumWidth?saved:400}catch{return 400}
 });
 const wide=!mobile&&workspaceWidth>=minimumWidth+canvasWidth+dividerWidth,max=Math.max(minimumWidth,workspaceWidth-canvasWidth-dividerWidth),width=limitWidth(preferred,max);
 const resize=(next:number)=>{const clamped=limitWidth(next,max);setPreferred(clamped);try{localStorage.setItem(widthKey,String(clamped))}catch{/* The current view still retains its width. */}};
 useLayoutEffect(()=>{
  const node=root.current;if(!node)return;
  const observer=new ResizeObserver(([entry])=>{if(entry)setWorkspaceWidth(Math.floor(entry.contentRect.width))});
  const track=(event:FocusEvent)=>{if(!wasOpen.current&&event.target instanceof HTMLElement&&!panel.current?.contains(event.target))previous.current=event.target};
  document.addEventListener('focusin',track);
  observer.observe(node);return()=>{observer.disconnect();document.removeEventListener('focusin',track)};

 },[]);
 useLayoutEffect(()=>{
  if(open&&!wasOpen.current&&document.activeElement instanceof HTMLElement&&document.activeElement!==document.body&&!panel.current?.contains(document.activeElement))previous.current=document.activeElement;
  if(!open&&wasOpen.current){
   const target=previous.current;previous.current=undefined;
   queueMicrotask(()=>{
    if(wasOpen.current)return;
    const active=document.activeElement;
    if(active!==document.body&&!panel.current?.contains(active))return;
    (target?.isConnected&&target.getClientRects().length?target:fallbackFocus())?.focus({preventScroll:true});
   });
  }
  wasOpen.current=open;
  const active=document.activeElement;
  if(open&&(!panel.current?.contains(active)||active===panel.current||!active?.getClientRects().length))
   (panel.current?.querySelector<HTMLElement>('[data-inspector-back]:not(:disabled)')??panel.current)?.focus({preventScroll:true});
 },[open,pane,wide]);
 return <Box ref={root} data-workflow-workspace sx={{position:'relative',display:'grid',minWidth:0,minHeight:0,flex:1,gridTemplateColumns:open&&wide?`minmax(0,1fr) ${dividerWidth}px ${width}px`:'minmax(0,1fr)'}}>
  <Box sx={{display:'flex',minWidth:0,minHeight:0,flexDirection:'column'}}>{children}</Box>
  {open&&wide&&<Box role="separator" aria-label="Resize workflow inspector" aria-orientation="vertical" aria-valuemin={minimumWidth} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`} tabIndex={0}
   onPointerDown={event=>{if(event.button!==0)return;event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);drag.current={start:event.clientX,width}}}
   onPointerMove={event=>{if(drag.current)resize(drag.current.width+drag.current.start-event.clientX)}}
   onLostPointerCapture={()=>{drag.current=undefined}}
   onKeyDown={event=>{const next={ArrowLeft:width+16,ArrowRight:width-16,Home:minimumWidth,End:max}[event.key];if(next!==undefined){event.preventDefault();resize(next)}}}
   sx={{cursor:'col-resize',touchAction:'none',borderLeft:1,borderRight:1,borderColor:'divider',bgcolor:'background.default','&:hover,&:focus-visible':{bgcolor:'action.selected',outline:'2px solid',outlineColor:'primary.main',outlineOffset:-2}}}/>}
  <Box sx={{display:open&&wide?'flex':'contents',minHeight:0,minWidth:0,'& > [data-testid^="sentinel"]':{position:'absolute',width:0,height:0}}}>
  <FocusTrap open={open&&!wide} disableAutoFocus disableRestoreFocus isEnabled={()=>!Array.from(document.querySelectorAll<HTMLElement>('.MuiModal-root')).some(modal=>modal.getAttribute('aria-hidden')!=='true'&&getComputedStyle(modal).visibility!=='hidden')}>
   <Box ref={panel} role={wide?'region':'dialog'} aria-label="Workflow inspector" aria-modal={!wide&&open||undefined} aria-hidden={!open||undefined} tabIndex={-1}
    sx={{display:wide&&!open?'none':'flex',flex:1,flexDirection:'column',minHeight:0,minWidth:0,bgcolor:'background.paper',overflow:'hidden',
     ...(wide?{}:{position:'fixed',inset:0,zIndex:theme=>theme.zIndex.modal,visibility:open?'visible':'hidden',
      transform:open?'translateX(0)':'translateX(100%)',transition:'transform 180ms ease',pointerEvents:open?'auto':'none',
      height:'var(--ponderosa-app-viewport-block-size, 100dvh)',pt:'env(safe-area-inset-top, 0px)',pb:'env(safe-area-inset-bottom, 0px)',
      '@media (prefers-reduced-motion: reduce)':{transition:'none'}})}}>
    {content}
   </Box>
  </FocusTrap>
  </Box>
 </Box>;
}
