import {useState,type ReactNode} from 'react';
import {ClickAwayListener,IconButton,Stack,Tooltip} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

export function ExecutionControlHelp({label,help,children}:{label:string;help:string;children:ReactNode}):JSX.Element {
 const [open,setOpen]=useState(false);
 return <Stack direction="row" spacing={0.5} sx={{alignItems:'flex-start','& > :first-child':{flex:1,minWidth:0}}}>
  {children}
  <ClickAwayListener onClickAway={()=>setOpen(false)}>
   <Tooltip describeChild title={<span>{help}</span>} placement="top-end" open={open} enterDelay={0} disableTouchListener
    slotProps={{popper:{sx:{'&[data-popper-reference-hidden]':{visibility:'hidden'}}}}}
    onOpen={()=>setOpen(true)} onClose={()=>setOpen(false)}>
    <IconButton type="button" aria-label={`Help for ${label}`} onClick={()=>setOpen(true)} sx={{width:44,height:44,flexShrink:0}}>
     <InfoOutlinedIcon fontSize="small"/>
    </IconButton>
   </Tooltip>
  </ClickAwayListener>
 </Stack>;
}
