import {WorkspaceQueryError} from "../WorkspaceQueryError";
import {matchesRequestTextReplyRoute,matchesTextReplyRoute,type ReplySource} from './textReplyRoute';
import {Box,Typography} from '@mui/material';
import {TERMINAL_REQUEST_STATES,type CoordinationRequestState,type VoiceReplySnapshot,type VoiceReplyStatus} from '@ponderosa/core';
import {useEffect,useRef,useState} from 'react';
import {api} from '../../api';
import {ApiRequestError} from '../../api/types';
import {availabilityFailure} from '../../workspaceAvailability';
import {browserPageIsVisible} from '../../queryVisibility';

/** Provisional host-authorized human reply; never authored Communication or audio. */
type PreviewProps={agentId:string;projectId:string;active?:boolean;agentTitle?:string}&(
 {sent:ReplySource;messages:ReplySource[];peerAgentId?:string;request?:never}|
 {request:{id:string;conversationId:string;state:CoordinationRequestState};sent?:never;messages?:never;peerAgentId?:never}
);
export function DirectReplyPreview({sent,request,agentId,messages=[],projectId,peerAgentId,active=true,agentTitle}:PreviewProps):JSX.Element|null {
 const [preview,setPreview]=useState<{owner:string;reply:VoiceReplySnapshot}>();
 const [foreground,setForeground]=useState(browserPageIsVisible);
 const [readState,setRead]=useState<{owner?:string;error?:unknown;success:boolean;runId?:string;canonicalReplyEventId?:string}>({success:false});
 const validation=useRef<{owner:string;blocked:boolean;exposure?:VoiceReplyStatus['memoryExposure'];observed?:VoiceReplySnapshot}>();
 const refreshRef=useRef<()=>Promise<void>>(async()=>{});
 const messageId=request?.id??sent!.communicationEventId??sent!.id;
 const conversationId=request?.conversationId??sent!.conversationId;
 const receipt=sent?.deliveryReceipts?.find(item=>item.targetAgentId===agentId);
 const executionId=receipt?.state==='recovering'?receipt.recoveryExecutionId:receipt?.executionId;
 const steeringInjectionId=receipt?.state!=='recovering'&&receipt?.injectionKind==='steer'?receipt.injectionId:undefined;
 const replyIntent=sent?.communicationIntent==='collaboration'?'collaboration':sent?.communicationIntent==='broadcast'?'broadcast':'direct_to_user';
 const sender=sent?.communicationSender;
 const peerSenderId=sender?.kind==='agent'?sender.agentId:undefined;
 const owner=JSON.stringify([projectId,conversationId,messageId,agentId,receipt?.activationId,receipt?.recoveryActivationId,receipt?.injectionId,receipt?.injectionKind,executionId,replyIntent,peerAgentId,peerSenderId,request?.id]);
 const reply=preview?.owner===owner?preview.reply:undefined;
 const read:typeof readState=readState.owner===owner?readState:{success:false};
 const quietRead=availabilityFailure(read.error)||read.error instanceof ApiRequestError&&read.error.status===429;
 const eligible=active&&Boolean(conversationId)&&(request?!TERMINAL_REQUEST_STATES.has(request.state):receipt?Boolean(executionId)&&!receipt.settingsTransitionHold&&!receipt.contextRolloverHold&&!receipt.taskDecisionRepairHold&&['preparing','started','steering','delivered','recovering'].includes(receipt.state):Boolean(peerAgentId));
 const canonical=request?TERMINAL_REQUEST_STATES.has(request.state):Boolean(read.canonicalReplyEventId&&(executionId??read.runId))&&messages.some(item=>(item.communicationEventId??item.id)===read.canonicalReplyEventId&&item.role==='assistant'&&item.communicationIntent===sent?.communicationIntent&&item.authorAgentId===agentId&&item.executionId===(executionId??read.runId)&&(replyIntent!=='collaboration'||(item.collaborationRecipients?.length===1&&item.collaborationRecipients[0]?.id===peerSenderId)));
 useEffect(()=>{if(!eligible)return;const changed=()=>{const visible=browserPageIsVisible();setForeground(visible);if(!visible)setPreview(undefined);};changed();document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed)},[eligible]);
 useEffect(()=>{
  setPreview(undefined);setRead(previous=>previous.owner===owner?previous:{owner,success:false});
  const guard=validation.current?.owner===owner?validation.current:{owner,blocked:false};validation.current=guard;
  if(!eligible||!foreground||!browserPageIsVisible()||canonical||guard.blocked)return;
  let disposed=false,busy=false,version=0,stopped=false;
  const controller=new AbortController();
  let stream:ReturnType<typeof api.subscribeAgent>|undefined,timer:ReturnType<typeof setInterval>|undefined;
  const stop=(invalidate=false)=>{if(invalidate)guard.blocked=true;if(stopped)return;stopped=true;controller.abort();if(timer)clearInterval(timer);stream?.close();};
  const clear=()=>{version++;setPreview(undefined);};
  const refresh=async()=>{
   if(disposed||busy||stopped||guard.blocked||!browserPageIsVisible())return;
   busy=true;const current=version;
   try{
    const status=await api.getTextReplyStatus(conversationId!,messageId,agentId,controller.signal);
    if(disposed||current!==version||!browserPageIsVisible())return;
    if(status.messageId!==messageId||(executionId&&status.runId!==executionId)){clear();return;}
    setRead({owner,success:true,runId:status.runId,canonicalReplyEventId:status.canonicalReplyEventId});
    const next=status.reply,context=status.memoryExposure;
    if(['completed','failed','cancelled','outcome_unknown'].includes(status.runStatus??'')){stop(true);clear();return;}
    if(!context||!['valid','disabled'].includes(context.state)) {if(guard.observed)stop(true);clear();return;}
    if(guard.exposure&&(guard.exposure.state!==context.state||guard.exposure.sessionResetSeq!==context.sessionResetSeq||guard.exposure.projectGeneration!==context.projectGeneration||guard.exposure.globalGeneration!==context.globalGeneration)){stop(true);clear();return;}
    guard.exposure=context;
    if(!next||!(request?matchesRequestTextReplyRoute(request.id,next):matchesTextReplyRoute(sent!,next,peerAgentId))||next.projectId!==projectId||next.conversationId!==conversationId||next.messageId!==messageId||next.agentId!==agentId||next.runId!==status.runId||(context.runId&&context.runId!==next.runId)||(executionId&&executionId!==next.runId)){clear();return;}
    if(steeringInjectionId&&next.steeringInjectionId!==steeringInjectionId){clear();return;}
    if(next.state==='failed'||next.failureReason==='context_changed'){stop(true);clear();return;}
    if(guard.observed&&(guard.observed.runId!==next.runId||guard.observed.fence!==next.fence||guard.observed.streamId!==next.streamId||guard.observed.steeringInjectionId!==next.steeringInjectionId)){stop(true);clear();return;}
    if(guard.observed&&next.sequence<guard.observed.sequence)return;
    guard.observed=next;setPreview({owner,reply:next});
   }catch(cause){if(!disposed&&current===version){clear();setRead({owner,error:cause,success:false});}}
   finally{busy=false;}
  };
  refreshRef.current=refresh;
  stream=api.subscribeAgent(agentId,undefined,{
   onEvent:envelope=>{
    if(envelope.agentId!==agentId)return;
    const event=envelope.event;
    if((event.type==='memory_changed'&&event.projectId===projectId)||event.type==='session_reset'){if(guard.observed)stop(true);clear();}
    if(event.type==='voice_reply'||event.type==='agent_lifecycle'||event.type==='memory_changed'||event.type==='session_reset')void refresh();
   },onOpen:()=>void refresh(),onStatus:()=>void refresh(),
  });
  void refresh();timer=setInterval(()=>void refresh(),500);
  return()=>{refreshRef.current=async()=>{};disposed=true;version++;stop();};
 },[owner,eligible,foreground,canonical,receipt?.state,request?.state]);
 if(!eligible||!foreground||canonical||reply&&(reply.projectId!==projectId||reply.conversationId!==conversationId||reply.agentId!==agentId||!(request?matchesRequestTextReplyRoute(request.id,reply):matchesTextReplyRoute(sent!,reply,peerAgentId))))return null;
 return <>{agentTitle&&read.error&&!quietRead&&<Typography variant="caption" sx={{overflowWrap:"anywhere"}}>{agentTitle}</Typography>}<WorkspaceQueryError compact read={{owner:`reply:${projectId}:${messageId}:${agentId}`,resource:"Reply",error:read.error,success:read.success,hasData:Boolean(reply),retry:()=>refreshRef.current()}} reportOnly={quietRead}/>{reply?.text&&<Box aria-label={request?"Request Result In Progress":"Reply In Progress"} sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',py:1}}>{reply.text}</Box>}</>;
}
