import {Typography} from '@mui/material';
import {useEffect,useReducer,useRef,useState} from 'react';
import {TERMINAL_REQUEST_STATES,type CoordinationRequestState,type CoordinationRequestUpdateDto,type VoiceReplySnapshot,type VoiceReplyStatus,type ReplyStreamCorrelation} from '@ponderosa/core';
import {api} from '../../api';
import {ApiRequestError} from '../../api/types';
import {browserPageIsVisible} from '../../queryVisibility';
import {availabilityFailure} from '../../workspaceAvailability';
import {WorkspaceQueryError} from '../WorkspaceQueryError';
import {matchesTextReplyRoute,matchesRequestTextReplyRoute,type ReplySource} from './textReplyRoute';

type Source={agentId:string;conversationId:string;sourceId:string;sent?:ReplySource;request?:{id:string;state:CoordinationRequestState}};
type Canonical={replyStream?:ReplyStreamCorrelation;authorAgentId?:string;actorId?:string;executionId?:string;conversationId?:string;communicationIntent?:string;collaborationRecipients?:Array<{id:string}>};
type Observed={owner:string;source:Source;reply?:VoiceReplySnapshot;exposure?:VoiceReplyStatus['memoryExposure'];blocked?:'authority'|'access';error?:unknown;success:boolean;cursor?:number;authorityRun?:string;attempt?:ReturnType<typeof sourceAttempt>;refresh():Promise<void>;retry():Promise<void>;close():void};
export const replyPresentationKey=(binding:ReplyStreamCorrelation,agentId:string)=>`reply:${JSON.stringify([binding.streamId,binding.sourceId,binding.runId,binding.fence,agentId,binding.steeringInjectionId])}`;
const snapshotBinding=(reply:VoiceReplySnapshot):ReplyStreamCorrelation=>({streamId:reply.streamId,sourceId:reply.messageId,runId:reply.runId,fence:reply.fence,...(reply.steeringInjectionId?{steeringInjectionId:reply.steeringInjectionId}:{})});
const sourceKey=(source:Source)=>JSON.stringify([source.conversationId,source.sourceId,source.agentId,Boolean(source.request)]);
const expectedRun=(source:Source)=>{const receipt=source.sent?.deliveryReceipts?.find(item=>item.targetAgentId===source.agentId);return receipt?.state==='recovering'||receipt?.state==='recovered'?receipt.recoveryExecutionId??receipt.executionId:receipt?.executionId;};
function sourceAttempt(source:Source){const r=source.sent?.deliveryReceipts?.find(item=>item.targetAgentId===source.agentId);return {activation:r?.activationId,recovery:r?.recoveryActivationId,steer:r?.injectionKind==='steer'?r.injectionId:undefined};}
function changedAttempt(before:ReturnType<typeof sourceAttempt>|undefined,after:ReturnType<typeof sourceAttempt>,reply?:VoiceReplySnapshot){return before&&(['activation','recovery','steer'] as const).some(key=>after[key]!==undefined&&before[key]!==after[key]&&!(key==='steer'&&before[key]===undefined&&reply?.steeringInjectionId===after[key]));}
function sourceAllowed(source:Source,observed=false){
 if(source.request)return !['cancelled','superseded','outcome_unknown','expired','recipient_unavailable'].includes(source.request.state)&&(observed||!TERMINAL_REQUEST_STATES.has(source.request.state));
 const r=source.sent?.deliveryReceipts?.find(item=>item.targetAgentId===source.agentId);
 return Boolean(r&&!r.settingsTransitionHold&&!r.contextRolloverHold&&!r.taskDecisionRepairHold&&!['failed','cancelled','undelivered','retry_exhausted','run_unconfirmed','unconfirmed'].includes(r.state)&&
  (observed||['preparing','started','steering','delivered','recovering','recovered'].includes(r.state)));
}
function sameCanonical(item:Canonical,reply:VoiceReplySnapshot){return Boolean(item.replyStream&&
 (item.authorAgentId??item.actorId)===reply.agentId&&(!item.executionId||item.executionId===reply.runId)&&
 replyPresentationKey(item.replyStream,reply.agentId)===replyPresentationKey(snapshotBinding(reply),reply.agentId));}

function settledSource(source:Source,item:Canonical){
 if(!source.sent||!item.replyStream||!expectedRun(source))return false;
 const receipt=source.sent.deliveryReceipts?.find(r=>r.targetAgentId===source.agentId);
 const steering=receipt?.state==='recovering'||receipt?.state==='recovered'?undefined:receipt?.injectionKind==='steer'?receipt.injectionId:undefined;
 return item.replyStream.sourceId===source.sourceId&&item.replyStream.runId===expectedRun(source)&&item.replyStream.steeringInjectionId===steering&&item.authorAgentId===source.agentId&&item.executionId===item.replyStream.runId&&item.conversationId===source.conversationId&&item.communicationIntent===source.sent.communicationIntent&&
  (source.sent.communicationIntent!=='collaboration'||item.collaborationRecipients?.length===1&&item.collaborationRecipients[0]?.id===source.sent.authorAgentId);
}

/** One view-local projection of the existing authorized stream, never Communication.
 * Receipt changes update the read fence without replacing the stream owner. */
function useReplyStreams(projectId:string,owner:string,sources:Source[],canonical:Canonical[],active=true){
 const [,render]=useReducer((n:number)=>n+1,0);
 const entries=useRef(new Map<string,Observed>());
 const current=useRef({sources,canonical,projectId,owner,active});current.current={sources,canonical,projectId,owner,active};
 const [visible,setVisible]=useState(browserPageIsVisible);
 useEffect(()=>{const change=()=>setVisible(browserPageIsVisible());document.addEventListener('visibilitychange',change);return()=>document.removeEventListener('visibilitychange',change);},[]);
 const keys=sources.map(source=>JSON.stringify([sourceKey(source),sourceAllowed(source,Boolean(entries.current.get(sourceKey(source))?.reply)),expectedRun(source),sourceAttempt(source),source.request?.state,entries.current.get(sourceKey(source))?.blocked])).join('|');
 useEffect(()=>{for(const entry of entries.current.values())if(entry.owner===owner&&entry.reply&&canonical.some(item=>sameCanonical(item,entry.reply!)))entry.close();});
 useEffect(()=>{
  if(!active||!visible)return;
  const owned:Observed[]=[];
  for(const source of current.current.sources){
   const key=sourceKey(source),existing=entries.current.get(key);
   const run=expectedRun(source);
   const attempt=sourceAttempt(source);
   const entry:Observed=existing?.owner===owner&&!changedAttempt(existing.attempt,attempt,existing.reply)&&(!run||!existing.authorityRun||run===existing.authorityRun)?existing:{owner,source,success:false,refresh:async()=>{},retry:async()=>{},close:()=>{}};
   entry.authorityRun=run??entry.authorityRun;entry.attempt=attempt;
   entry.source=source;entries.current.set(key,entry);owned.push(entry);
   if(!sourceAllowed(source,Boolean(entry.reply))){if(entry.reply){entry.reply=undefined;entry.blocked='authority';render();}continue;}
   if(entry.blocked||current.current.canonical.some(item=>entry.reply?sameCanonical(item,entry.reply):settledSource(source,item)))continue;
   let disposed=false,busy=false;
   const controller=new AbortController();
   const invalidate=(reason:'authority'|'access'='authority')=>{entry.reply=undefined;entry.blocked=reason;entry.close();render();};
   const rejectSnapshot=()=>{if(entry.reply)invalidate();else render();};
   const refresh=async()=>{
    if(disposed||busy||entry.blocked||!browserPageIsVisible())return;
    const latest=current.current;
    if(latest.owner!==owner||!latest.active)return;
    const source=latest.sources.find(item=>sourceKey(item)===key);
    if(!source||!sourceAllowed(source,Boolean(entry.reply))){invalidate();return;}
    if(entry.reply&&latest.canonical.some(item=>sameCanonical(item,entry.reply!))){entry.close();return;}
    entry.source=source;busy=true;
    try{
     const status=await api.getTextReplyStatus(source.conversationId,source.sourceId,source.agentId,controller.signal);
     if(disposed||current.current.owner!==owner||!current.current.active)return;
     const liveSource=current.current.sources.find(item=>sourceKey(item)===key);
     if(!liveSource||changedAttempt(entry.attempt,sourceAttempt(liveSource),entry.reply)||!sourceAllowed(liveSource,Boolean(entry.reply))){invalidate();return;}
     const run=expectedRun(liveSource),next=status.reply,context=status.memoryExposure;
     entry.error=undefined;entry.success=true;
     if(status.messageId!==source.sourceId||run&&status.runId!==run){rejectSnapshot();return;}
     if(['failed','cancelled','outcome_unknown'].includes(status.runStatus??'')||context?.state==='invalid'){invalidate();return;}
     if(!context||!['valid','disabled'].includes(context.state)){if(entry.reply)invalidate();else render();return;}
     if(entry.exposure&&['state','sessionResetSeq','projectGeneration','globalGeneration'].some(k=>entry.exposure?.[k as keyof typeof context]!==context[k as keyof typeof context])){invalidate();return;}
     entry.exposure=context;
     // A status read can precede the stream snapshot or lag its last SSE wake.
     if(!next){render();return;}
     if((status.runStatus==='completed'||next.state==='completed')&&!(liveSource.request?next.canonicalRequestUpdateId:next.canonicalReplyEventId)){invalidate();return;}
     if(liveSource.request&&TERMINAL_REQUEST_STATES.has(liveSource.request.state)&&(!next.canonicalRequestUpdateId||next.state!=='completed'||next.publication?.kind!=='request_update'||next.publication.updateKind!==liveSource.request.state)){invalidate();return;}
     const receipt=liveSource.sent?.deliveryReceipts?.find(item=>item.targetAgentId===source.agentId);
     const steering=receipt?.state!=='recovering'&&receipt?.state!=='recovered'&&receipt?.injectionKind==='steer'?receipt.injectionId:undefined;
     if(!(liveSource.request?matchesRequestTextReplyRoute(source.sourceId,next):matchesTextReplyRoute(liveSource.sent!,next,liveSource.sent?.communicationIntent==='collaboration'?source.agentId:undefined))||
       next.projectId!==projectId||next.conversationId!==source.conversationId||next.messageId!==source.sourceId||next.agentId!==source.agentId||next.runId!==status.runId||context.runId&&context.runId!==next.runId||run&&run!==next.runId||steering&&steering!==next.steeringInjectionId||next.state==='failed'||next.failureReason==='context_changed'){rejectSnapshot();return;}
     if(entry.reply&&(replyPresentationKey(snapshotBinding(entry.reply),source.agentId)!==replyPresentationKey(snapshotBinding(next),source.agentId)||entry.reply.steeringInjectionId!==next.steeringInjectionId)){invalidate();return;}
     if(entry.reply&&next.sequence===entry.reply.sequence&&next.text!==entry.reply.text){invalidate();return;}
     if(!entry.reply||next.sequence>=entry.reply.sequence){entry.reply=next;entry.authorityRun=next.runId;}
     render();
    }catch(error){if(!disposed&&current.current.owner===owner){entry.error=error;entry.success=false;if(error instanceof ApiRequestError&&[401,403,404].includes(error.status))invalidate('access');else render();}}
    finally{busy=false;}
   };
   entry.refresh=refresh;
   entry.retry=async()=>{
    if(current.current.owner!==owner||!current.current.active||entries.current.get(key)!==entry)return;
    if(entry.blocked==='access'){entry.blocked=undefined;entry.error=undefined;render();}
    else if(!entry.blocked)await refresh();
   };
   const subscription=api.subscribeAgent(source.agentId,entry.cursor,{
    onEvent:envelope=>{
     if(disposed||envelope.agentId!==source.agentId)return;
     entry.cursor=Math.max(entry.cursor??0,envelope.seq);
     const event=envelope.event;
     if(event.type==='session_reset'||event.type==='memory_changed'&&event.projectId===projectId&&(!event.conversationId||event.conversationId===source.conversationId)){invalidate();return;}
     if(event.type==='voice_reply'||event.type==='agent_lifecycle')void refresh();
    },onOpen:()=>void refresh(),onStatus:()=>void refresh(),
   });
   const timer=setInterval(()=>void refresh(),500);
   entry.close=()=>{disposed=true;controller.abort();clearInterval(timer);subscription.close();};
   void refresh();
  }
  for(const [key,entry]of entries.current)if(entry.owner!==owner||!current.current.sources.some(source=>sourceKey(source)===key)){entry.close();entries.current.delete(key);}
  return()=>{for(const entry of owned)entry.close();};
 },[owner,projectId,active,visible,keys]);
 const projected=[...entries.current.values()].filter(entry=>entry.owner===owner&&active&&sources.some(source=>sourceKey(source)===sourceKey(entry.source)&&sourceAllowed(source,Boolean(entry.reply))&&!changedAttempt(entry.attempt,sourceAttempt(source),entry.reply)&&(!entry.reply||!expectedRun(source)||expectedRun(source)===entry.reply.runId)));
 return projected;
}

function messageSources(messages:ReplySource[],agentId?:string):Source[]{
 return messages.flatMap(sent=>{
  if(!sent.conversationId||sent.communicationIntent==='collaboration'&&sent.coordinationRequests?.length||!(sent.role==='user'&&['user_dm','broadcast'].includes(sent.communicationIntent??'')||sent.communicationIntent==='collaboration'&&sent.communicationSender?.kind==='agent'))return [];
  return [...new Set(sent.deliveryReceipts?.map(r=>r.targetAgentId)??[])].filter(id=>!agentId||id===agentId).map(id=>({sent,agentId:id,conversationId:sent.conversationId!,sourceId:sent.communicationEventId??sent.id}));
 });
}
export function ReplyReadFeedback({entry,agentTitle}:{entry:Observed|Observed[];agentTitle?(id:string):string|undefined}){
 return <>{(Array.isArray(entry)?entry:[entry]).map(item=>{
  const quiet=availabilityFailure(item.error)||item.error instanceof ApiRequestError&&item.error.status===429;
  return <div key={sourceKey(item.source)}>{item.error&&!quiet&&agentTitle?<Typography variant="caption">{agentTitle(item.source.agentId)}</Typography>:null}<WorkspaceQueryError compact read={{owner:`reply:${item.owner}:${sourceKey(item.source)}`,resource:'Reply',error:item.error,success:item.success,hasData:Boolean(item.reply),retry:item.retry}} reportOnly={quiet}/></div>;
 })}</>;
}
export function useTextReplyProjection<T extends ReplySource>(messages:T[],projectId:string,owner:string,{active=true,agentId}:{active?:boolean;agentId?:string}={}){
 const entries=useReplyStreams(projectId,owner,messageSources(messages,agentId),messages,active);
 const anchors=useRef(new Map<string,string>()),anchorOwner=useRef(owner);
 if(anchorOwner.current!==owner){anchors.current.clear();anchorOwner.current=owner;}
 const rows=messages.map(message=>{
  const key=message.replyStream&&message.authorAgentId&&message.executionId===message.replyStream.runId?replyPresentationKey(message.replyStream,message.authorAgentId):`message:${message.id}`;
  return {key,at:anchors.current.get(key)??message.createdAt,message,provisional:false,feedback:entries.filter(entry=>entry.error&&!entry.reply&&entry.source.sourceId===(message.communicationEventId??message.id))};
 });
 for(const entry of entries){
  const reply=entry.reply;if(!reply?.text||messages.some(message=>sameCanonical(message,reply)))continue;
  const key=replyPresentationKey(snapshotBinding(reply),reply.agentId),at=anchors.current.get(key)??reply.firstTextAt??reply.acceptedAt;
  anchors.current.set(key,at);
  const sent=entry.source.sent!;
  const message={id:key,agentId:agentId??reply.agentId,seq:0,conversationId:reply.conversationId,role:'assistant',authorAgentId:reply.agentId,executionId:reply.runId,text:reply.text,createdAt:at,
   communicationIntent:sent.communicationIntent,
   ...(sent.communicationIntent==='collaboration'?{collaborationRecipients:[{id:sent.authorAgentId!,title:'',available:true}]}:{})} as T;
  rows.push({key,at,message,provisional:true,feedback:[entry]});
 }
 return rows;
}
export function useRequestReplyProjection(updates:CoordinationRequestUpdateDto[],projectId:string,conversationId:string|undefined,request:{id:string;state:CoordinationRequestState;recipientAgentId:string}|undefined,active:boolean){
 const owner=JSON.stringify([projectId,conversationId,request?.id,request?.recipientAgentId]);
 const entries=useReplyStreams(projectId,owner,request&&conversationId?[{agentId:request.recipientAgentId,conversationId,sourceId:request.id,request}]:[],updates,active);
 const rows=updates.map(update=>({key:update.replyStream&&update.actorId?replyPresentationKey(update.replyStream,update.actorId):update.id,update,provisional:false}));
 for(const entry of entries){const reply=entry.reply;if(!reply?.text||updates.some(update=>sameCanonical(update,reply))||reply.publication?.kind!=='request_update')continue;
  rows.push({key:replyPresentationKey(snapshotBinding(reply),reply.agentId),provisional:true,update:{id:reply.streamId,kind:reply.publication.updateKind,actorKind:'agent',actorId:reply.agentId,text:reply.text,refs:[],artifacts:[],resultingState:'in_progress',resultingVersion:0,createdAt:reply.firstTextAt??reply.acceptedAt}});
 }
 return {rows,feedback:entries.filter(entry=>entry.error)};
}
