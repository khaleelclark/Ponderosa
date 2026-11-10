import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import {CopyMessageButton} from "../CopyMessageButton";
import {reconcileAcceptedCapture} from "./capturedDraftSubmissions";
import {ChatAttachments} from "./ChatAttachments";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {api} from "../../api";
import {queryKeys} from "../../queryKeys";
import { ConversationChromeContext } from "../ConversationChromeContext";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Link, Tooltip, Typography } from "@mui/material";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentDto, OperatorProfileDto, CommunicationAttachmentDto } from "@ponderosa/core";
import { createClientId } from "../../clientId";
import { sha256Bytes } from "../idempotentAttempt";
import { ChatMessageFrame } from "./ChatMessageFrame";
import { ChatMessageBody } from "./ChatMessages";
import { capturedSubmissionActivity, earlierCapturedSubmission, readCapturedSubmissions, saveCapturedSubmission, submissionOutboxEvent, type CapturedSubmission } from "./submissionOutbox";

type OutgoingMessage = { id:string; scope:string; text:string; fileNames:string[]; createdAt:string; createdAgent?:AgentDto; communicationId?:string; accepted?:boolean; reconciled?:boolean; captured?:CapturedSubmission; files?:File[] };
export interface OutgoingCanonicalRow {
  id:string;
  createdAt:string;
  communicationEventId?:string;
  creationIdempotencyKey?:string;
  projectId?:string;
  render(createdAt:string):ReactNode;
}
const OutgoingContext = createContext<{
  message?:OutgoingMessage;
  messages:OutgoingMessage[];
  profile?:OperatorProfileDto;
  begin(text:string,fileNames:string[],captured?:CapturedSubmission,files?:File[]):string;
  finish(id:string):void;
  identify(id:string,prefix:string,seed:string):Promise<void>;
  accepted(id:string,communicationId?:string):void;
  reconcile(rows:readonly Pick<OutgoingCanonicalRow,"communicationEventId"|"creationIdempotencyKey"|"projectId">[]):void;
  agentCreated(id:string,agent:AgentDto):void;
  onOpenAgent?(agentId:string,projectId:string):void;
}|undefined>(undefined);
export const isTimelineCapture=(item:CapturedSubmission):boolean=>item.action==="send"&&item.pending.request?.runtime.activeRunDelivery!=="queue";
export const capturedMessageAnchor=(id:string):string=>`captured-message-${id}`;
function projection(item:CapturedSubmission,scope:string):OutgoingMessage {
  return {id:item.pending.idempotencyKey,scope,text:item.text,fileNames:item.attachmentNames,createdAt:new Date(item.createdAt).toISOString(),communicationId:item.communicationId,accepted:item.status==="accepted",captured:item};
}
function matches(message:OutgoingMessage,row:Pick<OutgoingCanonicalRow,"communicationEventId"|"creationIdempotencyKey"|"projectId">):boolean {
  if(message.communicationId&&message.communicationId===row.communicationEventId)return true;
  const item=message.captured;
  if(!item||!row.creationIdempotencyKey||!item.projectId||item.projectId!==row.projectId)return false;
  const key=item.pending.idempotencyKey;
  return row.creationIdempotencyKey===(item.newAgentRequested?`${key}:new-agent:0`:`${key}:default-agent`);
}

function adoptionRow(message:OutgoingMessage,rows:readonly Pick<OutgoingCanonicalRow,"communicationEventId"|"creationIdempotencyKey"|"projectId">[]) {
  // A compound operation may have an opening plus a subsequent communication.
  // Its current exact transport ID wins; only one row owns its recovery anchor.
  return rows.find(row=>message.communicationId&&row.communicationEventId===message.communicationId)
    ??rows.find(row=>matches(message,row));
}

/** Presentation projects the existing durable outbox. No provisional row enters
 * canonical query data or Agent context. Accepted anchors last only while their
 * exact canonical row is in this view; they contain no second message history. */
export function OutgoingMessageProvider({children,profile,scope="new-chat",draftScope=scope,onOpenAgent}:{children:ReactNode;profile?:OperatorProfileDto;scope?:string;draftScope?:string;onOpenAgent?(agentId:string,projectId:string):void}) {
  const queryClient=useQueryClient();
  const [messages,setMessages]=useState<OutgoingMessage[]>([]),[outboxRevision,refresh]=useState(0);
  useEffect(()=>{
    const changed=()=>refresh(value=>value+1);
    const resume=()=>{
      const confirmed=new Map(readCapturedSubmissions(draftScope).filter(item=>item.status==="accepted").map(item=>[item.pending.idempotencyKey,item]));
      for(const message of messages)if(message.captured?.status==="accepted")confirmed.set(message.id,message.captured);
      for(const item of confirmed.values())void reconcileAcceptedCapture(queryClient,item,true).catch(()=>undefined);
      changed();
    };
    window.addEventListener(submissionOutboxEvent,changed);window.addEventListener("storage",changed);window.addEventListener("online",resume);window.addEventListener("focus",resume);
    return()=>{window.removeEventListener(submissionOutboxEvent,changed);window.removeEventListener("storage",changed);window.removeEventListener("online",resume);window.removeEventListener("focus",resume);};
  },[draftScope,messages,queryClient]);
  useEffect(()=>{for(const item of readCapturedSubmissions(draftScope))if(item.status==="accepted")void reconcileAcceptedCapture(queryClient,item).catch(()=>undefined);},[queryClient,draftScope,outboxRevision]);
  const begin=useCallback((text:string,fileNames:string[],captured?:CapturedSubmission,files?:File[])=>{
    const id=captured?.pending.idempotencyKey??createClientId("sending-");
    setMessages(current=>current.some(message=>message.id===id)?current:[...current,captured?{...projection(captured,scope),files}: {id,scope,text,fileNames:[...fileNames],createdAt:new Date().toISOString()}]);return id;
  },[scope]);
  const finish=useCallback((id:string)=>setMessages(current=>current.filter(message=>message.id!==id||Boolean(message.captured)||Boolean(message.accepted&&message.communicationId))),[]);
  const identify=useCallback(async(id:string,prefix:string,seed:string)=>{const communicationId=`${prefix}-${await sha256Bytes(new TextEncoder().encode(seed))}`;setMessages(current=>current.map(message=>message.id===id?{...message,communicationId}:message));},[]);
  const accepted=useCallback((id:string,communicationId?:string)=>setMessages(current=>current.map(message=>message.id===id?{...message,accepted:true,...(message.captured?{captured:{...message.captured,status:"accepted" as const}}:{}),...(communicationId?{communicationId}:{})}:message)),[]);
  const agentCreated=useCallback((id:string,agent:AgentDto)=>setMessages(current=>current.map(message=>message.id===id?{...message,createdAgent:agent,communicationId:`agent-opening:${agent.id}`}:message)),[]);
  const reconcile=useCallback((rows:readonly Pick<OutgoingCanonicalRow,"communicationEventId"|"creationIdempotencyKey"|"projectId">[])=>{
    const captures=readCapturedSubmissions(draftScope).filter(isTimelineCapture);
    const observed=captures.flatMap(item=>{const row=adoptionRow(projection(item,scope),rows);return row?.communicationEventId?[{item,row}]:[];});
    for(const {item,row} of observed){
      // A compound creation plus other recipients still needs its exact-key
      // reconciliation; an opening alone cannot settle the remaining work.
      const compound=item.newAgentRequested&&Boolean(item.pending.request?.recipientAgentIds.length);
      if(item.status!=="accepted"&&!compound){
        const confirmed={...item,status:"accepted" as const,communicationId:row.communicationEventId};
        try{saveCapturedSubmission(confirmed);}catch{/* Exact canonical acceptance still owns this presentation. */}
        void reconcileAcceptedCapture(queryClient,confirmed).catch(()=>undefined);
      }
    }
    setMessages(current=>{
      let changed=false;const next=current.flatMap(message=>{
        const row=adoptionRow(message,rows);
        if(message.reconciled&&!row){changed=true;return [];}
        if(row?.communicationEventId&&(!message.reconciled||message.communicationId!==row.communicationEventId||message.captured&&message.captured.status!=="accepted"&&!(message.captured.newAgentRequested&&message.captured.pending.request?.recipientAgentIds.length))){changed=true;return [{...message,reconciled:true,accepted:true,...(message.captured&&!(message.captured.newAgentRequested&&message.captured.pending.request?.recipientAgentIds.length)?{captured:{...message.captured,status:"accepted" as const}}:{}),communicationId:row.communicationEventId,text:"",fileNames:[]}];}
        return [message];
      });
      for(const {item,row} of observed)if(!next.some(message=>message.id===item.pending.idempotencyKey)){changed=true;next.push({...projection(item.newAgentRequested&&item.pending.request?.recipientAgentIds.length?item:{...item,status:"accepted"},scope),reconciled:true,accepted:true,communicationId:row.communicationEventId,text:"",fileNames:[]});}
      return changed?next:current;
    });
  },[draftScope,scope,queryClient]);
  const visibleMessages=useMemo(()=>{
    const captures=readCapturedSubmissions(draftScope).filter(isTimelineCapture),ids=new Set(captures.map(item=>item.pending.idempotencyKey));
    const byId=new Map(messages.filter(message=>message.scope===scope&&(!message.captured||ids.has(message.id)||message.accepted||message.reconciled)).map(message=>[message.id,message.captured&&!ids.has(message.id)?{...message,captured:undefined}:message]));
    for(const item of captures){
      const retained=byId.get(item.pending.idempotencyKey);byId.set(item.pending.idempotencyKey,{...retained,...projection(retained?.captured?.status==="accepted"?{...item,status:"accepted"}:item,scope),communicationId:item.communicationId??retained?.communicationId});
    }
    return [...byId.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  },[messages,scope,draftScope,outboxRevision]);
  const value=useMemo(()=>({message:visibleMessages.at(-1),messages:visibleMessages,profile,begin,finish,identify,accepted,reconcile,agentCreated,onOpenAgent}),[visibleMessages,profile,begin,finish,identify,accepted,reconcile,agentCreated,onOpenAgent]);
  return <OutgoingContext.Provider value={value}>{children}</OutgoingContext.Provider>;
}
export function useOutgoingMessage(){return useContext(OutgoingContext);}

/** Merge only presentation rows, preserving canonical order for tied timestamps.
 * The exact operation anchor and captured time survive Retry and adoption. */
export function OutgoingMessageRow({entries,canonicalCommunicationIds=[],empty}:{entries?:readonly OutgoingCanonicalRow[];canonicalCommunicationIds?:readonly(string|undefined)[];empty?:ReactNode}) {
  const outgoing=useOutgoingMessage();
  const rows=entries??canonicalCommunicationIds.flatMap(id=>id?[{id,createdAt:"",communicationEventId:id,render:()=>null}]:[]);
  useEffect(()=>{outgoing?.reconcile(rows);},[outgoing?.reconcile,rows]);
  const pending=outgoing?.messages??[],used=new Set<string>();
  const merged:Array<{key:string;at:string;index:number;anchor?:string;render:()=>ReactNode}>=rows.map((row,index)=>{
    const local=pending.find(message=>!used.has(message.id)&&adoptionRow(message,rows)===row);if(local)used.add(local.id);
    const at=local?.createdAt??row.createdAt;
    return {key:local?.id??row.id,at,index,anchor:local?capturedMessageAnchor(local.id):undefined,render:()=>entries?<Box sx={{minWidth:0}}>{row.render(at)}{local?.captured?<CapturedRecovery item={local.captured} canonicalObserved/>:null}</Box>:null};
  });
  for(const message of pending)if(!used.has(message.id))merged.push({key:message.id,at:message.createdAt,index:merged.length,anchor:capturedMessageAnchor(message.id),render:()=> <OutgoingRow message={message}/>});
  merged.sort((a,b)=>a.at.localeCompare(b.at)||a.index-b.index);
  return <>{merged.length===0?empty:null}{merged.map(row=><Box key={row.key} id={row.anchor} sx={{minWidth:0}}>{row.render()}</Box>)}</>;
}
function CapturedRecovery({item,canonicalObserved=false}:{item:CapturedSubmission;canonicalObserved?:boolean}) {
  const [details,setDetails]=useState(false);
  const activity=capturedSubmissionActivity(item.pending.idempotencyKey),earlier=earlierCapturedSubmission(item);
  if(item.status==="accepted")return null;
  const running=Boolean(activity),unknown=item.status==="unknown"||item.dispatchStarted&&item.status!=="failed";
  const status=activity==="remove"?"Removing":earlier?"Waiting":running?(unknown?"Checking Delivery":"Sending"):unknown?"Delivery Not Confirmed":"Message Not Sent";
  const removable=!canonicalObserved&&item.status==="failed";
  const explanation=unknown?"Delivery has not been confirmed. Retry checks the original message without creating another send.":"Your message wasn’t sent. Retry to send it, or remove it.";
  return <Box sx={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:.5,minWidth:0}}>
    {earlier&&activity!=="remove"?<Link role="status" href={`#${encodeURIComponent(capturedMessageAnchor(earlier.pending.idempotencyKey))}`} variant="caption">Waiting</Link>:<Typography role="status" variant="caption" color="text.secondary">{status}</Typography>}
    {!earlier&&!running?<Button size="small" onClick={()=>window.dispatchEvent(new CustomEvent("ponderosa-submission-retry",{detail:item.pending.idempotencyKey}))}>Retry</Button>:null}
    {removable?<Button size="small" disabled={running||!navigator.locks} onClick={()=>window.dispatchEvent(new CustomEvent("ponderosa-submission-discard",{detail:item.pending.idempotencyKey}))}>Remove</Button>:null}
    {!running&&!earlier?<Tooltip title="Technical Details"><IconButton size="small" aria-label="Technical Details" onClick={()=>setDetails(true)}><InfoOutlinedIcon fontSize="inherit"/></IconButton></Tooltip>:null}
    <Dialog open={details} onClose={()=>setDetails(false)} fullWidth maxWidth="sm">
      <DialogTitle>Technical Details</DialogTitle><DialogContent>
        <Typography>{explanation}</Typography>
        {item.error?<Typography component="pre" variant="body2" sx={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",mt:2}}>{item.error}</Typography>:null}
        {removable&&!navigator.locks?<Typography sx={{mt:2}}>Safe removal needs Web Locks in this browser. The original message is retained.</Typography>:null}
      </DialogContent><DialogActions><Button onClick={()=>setDetails(false)}>Close</Button></DialogActions>
    </Dialog>
  </Box>;
}
function OutgoingRow({message}:{message:OutgoingMessage}) {
  const outgoing=useOutgoingMessage()!,agent=message.createdAgent;
  const assistantMessages=useContext(ConversationChromeContext)?.assistantAgentId===message.scope;
  return <Box sx={{minWidth:0}}><ChatMessageFrame assistantMessages={assistantMessages} message={{
    id:message.id,ariaLabel:message.captured?"Captured Message":message.accepted?"Accepted Message":"Sending Message",author:{kind:"operator",profile:outgoing.profile},createdAt:message.createdAt,
    body:<Box sx={{overflowWrap:"anywhere"}}><ChatMessageBody text={message.text} compactMarkdown agentMentionForHandle={handle=>agent&&handle.toLocaleLowerCase()==="new-agent"?{agentId:agent.id,label:agent.handle}:undefined} onOpenAgent={agent&&outgoing.onOpenAgent?id=>outgoing.onOpenAgent?.(id,agent.projectId):undefined}/>{message.captured?<CapturedAttachments message={message}/>:message.fileNames.length?<Box sx={{mt:0.5}}>{message.fileNames.map((name,index)=><Typography key={index} component="div" variant="caption">{name}</Typography>)}</Box>:null}</Box>,
    actions:<CopyMessageButton text={message.text}/>,
    status:message.captured?<CapturedRecovery item={message.captured}/>:<Typography role="status" variant="caption" color="text.secondary">{message.accepted?"Accepted":"Sending"}</Typography>,
  }}/></Box>;
}

/** Existing draft authority supplies retained bytes after navigation; local Files
 * supply immediate previews before preparation. Neither becomes a Communication. */
function CapturedAttachments({message}:{message:OutgoingMessage}) {
  const item=message.captured!;
  const draft=useQuery({queryKey:queryKeys.conversationDraft.detail(item.scope,item.ownerId),queryFn:()=>api.getConversationDraft(item.scope,item.ownerId),enabled:message.fileNames.length>0&&!item.scope.startsWith("local:"),staleTime:0});
  const [local,setLocal]=useState<CommunicationAttachmentDto[]>([]);
  useEffect(()=>{
    const attachments=(message.files??[]).map((file,index)=>({id:`${message.id}:file:${index}`,agentId:item.scope,name:file.name,mediaType:file.type||"application/octet-stream",size:file.size,url:URL.createObjectURL(file)}));
    setLocal(attachments);
    return()=>{for(const attachment of attachments)URL.revokeObjectURL(attachment.url);};
  },[message.files,message.id,item.scope]);
  const byId=new Map([...(draft.data?.attachments??[]),...(draft.data?.pendingSubmissionAttachments??[])].map(attachment=>[attachment.id,attachment]));
  const attachments=(item.pending.draftAttachmentIds??[]).flatMap(id=>{const attachment=byId.get(id);return attachment?[{...attachment,agentId:item.scope}]:[];});
  const visible=local.length?local:attachments;
  return visible.length?<ChatAttachments attachments={visible}/>:<Box sx={{mt:.5}}>{message.fileNames.map((name,index)=><Typography key={index} component="div" variant="caption">{name}</Typography>)}</Box>;
}
