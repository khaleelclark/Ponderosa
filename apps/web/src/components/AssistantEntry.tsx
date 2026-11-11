import {useEffect} from "react";
import {createClientId} from "../clientId";
import {MutationErrorDetails,useMutationNotification} from "./MutationNotifications";
import {WorkspaceQueryError} from "./WorkspaceQueryError";
import {workspaceRead} from "../workspaceAvailability";
import {AssistantIcon} from './AssistantIcon';
import {useQuery} from '@tanstack/react-query';
import {Box,Button,ButtonBase,Typography} from '@mui/material';
import type {AssistantStatusDto} from '@ponderosa/core';
import {requestJson} from '../api/real';
import {isUnmodifiedPrimaryClick} from '../nativeNavigation';

/** Opening Ponderosa initializes the default once; removed speakers stay disabled. */
export function useInitializeAssistant(){
 return useQuery({queryKey:['assistant-initialize'],staleTime:Infinity,retry:false,retryOnMount:false,refetchOnMount:false,refetchOnWindowFocus:false,refetchOnReconnect:false,
  queryFn:()=>requestJson<AssistantStatusDto>('/api/branches/assistant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initialize:true})})});
}
export function AssistantEntry({wide=false,selected=false,href,onOpen}:{wide?:boolean;selected?:boolean;href:string;onOpen():void}):JSX.Element{
 const query=useInitializeAssistant(),notify=useMutationNotification();
 const feedbackKey=JSON.stringify(["/api/branches/assistant","setup"]);
 // Initialization is a POST, not a shared refresh participant. Reconcile its
 // outcome through the existing canonical GET before offering explicit setup retry.
 const status=useQuery({queryKey:['assistant-status'],retry:false,refetchInterval:15000,
  queryFn:({signal})=>requestJson<AssistantStatusDto>('/api/branches/assistant',{signal})});
 useEffect(()=>{if(status.isSuccess&&status.data.initialized&&!status.data.setupError)notify({key:feedbackKey,message:"",dismiss:true});},[status.isSuccess,status.data,notify,feedbackKey]);
 const retrySetup=async()=>{
  const key=feedbackKey,incident=createClientId("assistant-setup-feedback-");
  const result=await query.refetch();
  if(result.isError)notify({key,incident,severity:"error",message:"Assistant Setup Needs Review",description:"Check Assistant setup before trying again.",details:result.error instanceof Error?result.error.message:String(result.error)});
  else if(result.data?.initialized&&!result.data.setupError)notify({key,message:"",dismiss:true});
 };
 return <Box sx={{minWidth:0,gridColumn:wide?'1 / -1':undefined}}>
  <ButtonBase href={href} aria-current={selected?'page':undefined} onClick={event=>{if(isUnmodifiedPrimaryClick(event)){event.preventDefault();onOpen();}}} sx={{width:'100%',minHeight:44,gap:1,px:1,borderRadius:1.5,color:selected?'primary.main':'text.secondary',bgcolor:selected?'action.selected':'transparent','&:hover':{bgcolor:'action.hover'}}}><AssistantIcon sx={{fontSize:19,flexShrink:0}}/><Typography component="span" noWrap sx={{minWidth:0,fontSize:'.8125rem',fontWeight:600}}>{status.data?.app?.title??query.data?.app?.title??'Assistant'}</Typography></ButtonBase>
  <WorkspaceQueryError compact read={workspaceRead("workspace","Assistant Setup",status)}/>
  {query.isError&&status.isSuccess&&(!status.data.initialized||status.data.setupError)&&<MutationErrorDetails title="Assistant Setup Needs Review" error={status.data.setupError?.message??query.error}>
   <Button disabled={query.isFetching} onClick={()=>void retrySetup()}>Retry Assistant Setup</Button>
  </MutationErrorDetails>}

 </Box>;
}
