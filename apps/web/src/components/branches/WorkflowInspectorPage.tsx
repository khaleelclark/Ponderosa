import {Box,Button,Stack,Typography} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {useLayoutEffect,useRef,type ReactNode} from 'react';

export function WorkflowInspectorPage({title,onBack,headerAction,backLabel='Back to workflow',pending=false,children,actions}:{
 title:ReactNode;onBack():void;headerAction?:ReactNode;backLabel?:string;pending?:boolean;children:ReactNode;actions?:ReactNode;
}):JSX.Element {
 const back=useRef<HTMLButtonElement>(null),page=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const root=page.current;
  if(root?.getClientRects().length&&!root.contains(document.activeElement))back.current?.focus({preventScroll:true});
 },[]);
 return <Stack ref={page} onKeyDown={event=>{if(event.key==='Escape'&&!pending&&!event.defaultPrevented&&page.current?.contains(event.target as Node)){event.stopPropagation();onBack()}}} sx={{height:'100%',minHeight:0,minWidth:0}} aria-busy={pending||undefined}>
  <Box sx={{px:2,py:1,borderBottom:1,borderColor:'divider'}}>
   <Stack direction="row" justifyContent="space-between" alignItems="center">
   <Button ref={back} data-inspector-back color="inherit" startIcon={<ArrowBackIcon/>} disabled={pending} onClick={onBack} sx={{minHeight:44}}>{backLabel}</Button>{headerAction}</Stack>
   <Typography component="h2" variant="h6" sx={{overflowWrap:'anywhere'}}>{title}</Typography>
  </Box>
  <Box data-inspector-scroll sx={{flex:1,minHeight:0,overflow:'auto',overscrollBehavior:'contain',p:2,overflowWrap:'anywhere'}}>{children}</Box>
  {actions&&<Stack direction="row" gap={1} useFlexGap flexWrap="wrap" justifyContent="flex-end" sx={{px:2,py:1,borderTop:1,borderColor:'divider','& .MuiButton-root':{minHeight:44}}}>{actions}</Stack>}
 </Stack>;
}
