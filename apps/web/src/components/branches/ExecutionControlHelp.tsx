import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ClickAwayListener,IconButton,Stack,Tooltip} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

export function ExecutionControlHelp({label,help,children}:{label:string;help:string;children:ReactNode}):JSX.Element {
 const [openedBy,setOpenedBy]=useState<'touch'|'other'>();
 const trigger=useRef<HTMLButtonElement>(null);
 const touchPointer=useRef(false);
 useEffect(()=>{
  const button=trigger.current;
  if(openedBy!=='touch'||!button)return;
  const document=button.ownerDocument;
  const dismissOnScroll=(event:Event)=>{
   if(event.target instanceof Node&&event.target.contains(button))setOpenedBy(undefined);
  };
  document.addEventListener('scroll',dismissOnScroll,true);
  return ()=>document.removeEventListener('scroll',dismissOnScroll,true);
 },[openedBy]);
 return <Stack direction="row" spacing={0.5} sx={{alignItems:'flex-start','& > :first-child':{flex:1,minWidth:0}}}>
  {children}
  <ClickAwayListener onClickAway={()=>setOpenedBy(undefined)}>
   <Tooltip describeChild title={<span>{help}</span>} placement="top-end" open={Boolean(openedBy)} enterDelay={0} disableTouchListener
    slotProps={{popper:{sx:{'&[data-popper-reference-hidden]':{visibility:'hidden'}}}}}
    onOpen={()=>setOpenedBy('other')} onClose={()=>setOpenedBy(undefined)}>
    <IconButton ref={trigger} type="button" aria-label={`Help for ${label}`}
     onPointerDown={({pointerType})=>{touchPointer.current=pointerType==='touch'}}
     onClick={({detail})=>setOpenedBy(detail>0&&touchPointer.current?'touch':'other')}
     sx={{width:44,height:44,flexShrink:0}}>
     <InfoOutlinedIcon fontSize="small"/>
    </IconButton>
   </Tooltip>
  </ClickAwayListener>
 </Stack>;
}
