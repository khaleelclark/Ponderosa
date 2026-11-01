import {matchesRequestTextReplyRoute,matchesTextReplyRoute,type ReplySource} from './textReplyRoute';
import {Alert,Box} from '@mui/material';
import {TERMINAL_REQUEST_STATES,type CoordinationRequestState,type VoiceReplySnapshot,type VoiceReplyStatus} from '@ponderosa/core';
import {useEffect,useState} from 'react';
import {api} from '../../api';

/** Provisional host-authorized human reply; never authored Communication or audio. */
type PreviewProps={agentId:string;projectId:string}&(
 {sent:ReplySource;messages:ReplySource[];peerAgentId?:string;request?:never}|
 {request:{id:string;conversationId:string;state:CoordinationRequestState};sent?:never;messages?:never;peerAgentId?:never}
);
export function DirectReplyPreview({sent,request,agentId,messages=[],projectId,peerAgentId}:PreviewProps):JSX.Element|null {
 const [reply,setReply]=useState<VoiceReplySnapshot>();
 const [error,setError]=useState('');
 const messageId=request?.id??sent!.communicationEventId??sent!.id;
 const conversationId=request?.conversationId??sent!.conversationId;
 const receipt=sent?.deliveryReceipts?.find(item=>item.targetAgentId===agentId);
 const executionId=receipt?.state==='recovered'?receipt.recoveryExecutionId:receipt?.executionId;
 const replyIntent=sent?.communicationIntent==='collaboration'?'collaboration':sent?.communicationIntent==='broadcast'?'broadcast':'direct_to_user';
 const sender=sent?.communicationSender;
 const peerSenderId=sender?.kind==='agent'?sender.agentId:undefined;
 const canonical=request?TERMINAL_REQUEST_STATES.has(request.state):Boolean(reply?.runId??executionId)&&messages.some(item=>item.role==='assistant'&&item.communicationIntent===sent?.communicationIntent&&item.authorAgentId===agentId&&item.executionId===(reply?.runId??executionId)&&(replyIntent!=='collaboration'||(item.collaborationRecipients?.length===1&&item.collaborationRecipients[0].id===peerSenderId)));
 useEffect(()=>{
  setReply(undefined);setError('');
  if(!conversationId||canonical||(!request&&!receipt&&!peerAgentId)||['failed','cancelled','undelivered','retry_exhausted','unconfirmed'].includes(receipt?.state??''))return;
  let disposed=false,busy=false,version=0,blocked=false;
  let exposure:VoiceReplyStatus['memoryExposure'];
  let observed:VoiceReplySnapshot|undefined;
  const clear=()=>{version++;setReply(undefined);};
  const refresh=async()=>{
   if(disposed||busy||blocked)return;
   busy=true;const current=version;
   try{
    const status=await api.getTextReplyStatus(conversationId,messageId,agentId);
    if(disposed||current!==version)return;
    const next=status.reply,context=status.memoryExposure;
    if(status.messageId!==messageId||!context||!['valid','disabled'].includes(context.state)||['failed','cancelled','outcome_unknown'].includes(status.runStatus??'')) {if(observed)blocked=true;clear();return;}
    if(exposure&&(exposure.state!==context.state||exposure.sessionResetSeq!==context.sessionResetSeq||exposure.projectGeneration!==context.projectGeneration||exposure.globalGeneration!==context.globalGeneration)){blocked=true;clear();setError('Reply context changed. Read the completed reply in Chat.');return;}
    exposure=context;
    if(!next||!(request?matchesRequestTextReplyRoute(request.id,next):matchesTextReplyRoute(sent!,next,peerAgentId))||next.projectId!==projectId||next.conversationId!==conversationId||next.messageId!==messageId||next.agentId!==agentId||next.runId!==status.runId||(context.runId&&context.runId!==next.runId)||(executionId&&executionId!==next.runId)){clear();return;}
    if(next.state==='failed'||next.failureReason==='context_changed'){blocked=true;clear();setError('Streaming stopped. Waiting for the completed reply.');return;}
    if(observed&&(observed.runId!==next.runId||observed.fence!==next.fence||observed.streamId!==next.streamId||observed.steeringInjectionId!==next.steeringInjectionId)){blocked=true;clear();return;}
    if(observed&&next.sequence<observed.sequence)return;
    observed=next;setError('');setReply(next);
   }catch(cause){if(!disposed&&current===version){clear();setError(cause instanceof Error?cause.message:'Reply unavailable');}}
   finally{busy=false;}
  };
  const stream=api.subscribeAgent(agentId,undefined,{
   onEvent:envelope=>{
    if(envelope.agentId!==agentId)return;
    const event=envelope.event;
    if((event.type==='memory_changed'&&event.projectId===projectId)||event.type==='session_reset'){if(observed){blocked=true;setError('Reply context changed. Read the completed reply in Chat.');}clear();exposure=undefined;}
    if(event.type==='voice_reply'||event.type==='agent_lifecycle'||event.type==='memory_changed'||event.type==='session_reset')void refresh();
   },onOpen:()=>void refresh(),onStatus:()=>void refresh(),
  });
  void refresh();const timer=setInterval(()=>void refresh(),500);
  return()=>{disposed=true;version++;clearInterval(timer);stream.close();};
 },[projectId,conversationId,messageId,agentId,executionId,canonical,receipt?.state,replyIntent,peerAgentId,peerSenderId,request?.id]);
 if(canonical||reply&&(reply.projectId!==projectId||reply.conversationId!==conversationId||reply.agentId!==agentId||!(request?matchesRequestTextReplyRoute(request.id,reply):matchesTextReplyRoute(sent!,reply,peerAgentId))))return null;
 return <>{error&&<Alert severity="warning">{error}</Alert>}{reply?.text&&<Box aria-label={request?"Request result in progress":"Reply in progress"} sx={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',py:1}}>{reply.text}</Box>}</>;
}
