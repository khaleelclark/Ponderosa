import {AssistantIcon} from './AssistantIcon';
import {useQuery} from '@tanstack/react-query';
import {Alert,Box,ButtonBase,Button,Typography} from '@mui/material';
import type {AssistantStatusDto} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {confirmUnsavedNavigation} from '../reloadSafety';

/** Opening Ponderosa initializes the default once; removed speakers stay disabled. */
export function useInitializeAssistant(){
 return useQuery({queryKey:['assistant-initialize'],staleTime:Infinity,retry:false,
  queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initialize:true})})});
}
export function AssistantEntry({wide=false}:{wide?:boolean}):JSX.Element{
 const query=useInitializeAssistant();
 const source=window.location.pathname+window.location.search+window.location.hash;
 return <Box sx={{minWidth:0,gridColumn:wide?'1 / -1':undefined}}>
  <ButtonBase href={'/branches?assistant=1&returnTo='+encodeURIComponent(source)} onClick={event=>{if(!confirmUnsavedNavigation())event.preventDefault();}} sx={{width:'100%',minHeight:44,gap:1,px:1,borderRadius:1.5,color:'text.secondary','&:hover':{bgcolor:'action.hover'}}}><AssistantIcon sx={{fontSize:19}}/><Typography component="span" sx={{fontSize:'.8125rem',fontWeight:600}}>Assistant</Typography></ButtonBase>
  {query.isError&&<Alert severity="error" action={<Button onClick={()=>void query.refetch()}>Retry</Button>}>Assistant could not be opened.<Box component="details" sx={{fontSize:'.8125rem','& summary':{minHeight:44,py:1,cursor:'pointer'},'& pre':{m:0,maxHeight:'20vh',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',font:'inherit'}}}><summary>Details</summary><pre>{(query.error as Error).message}</pre></Box></Alert>}
 </Box>;
}
