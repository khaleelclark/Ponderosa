import type {ActiveRun,AgentMessageCapability} from "./app-contracts.js";
import type {ReplyStreamCorrelation} from "@ponderosa/core";
import { canonicalizeProviderText, unicodeCodePointLength, TERMINAL_REQUEST_STATES,
  type ReplyStreamArguments, type ReplyStreamPublication } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { canonicalVoiceReplyInput } from "./voice-reply-input.js";
import { activeChatResourceOwner } from "./branch-resource-owner.js";
import { canonicalDefaultReplyRoute } from "./required-reply-route.js";

/** Tool arguments select authority before any candidate bytes. */
export function parseReplyStreamArguments(value: unknown, presentation: "voice" | "text", steeringIds: string[]): ReplyStreamArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid reply arguments");
  const body=value as Record<string,unknown>;
  if(Object.keys(body).some(k=>!["steeringInjectionId","publication","acknowledgement"].includes(k)) ||
    (body.steeringInjectionId!==undefined && typeof body.steeringInjectionId!=="string")) throw Error("invalid reply arguments");
  const result:ReplyStreamArguments={};
  if(typeof body.steeringInjectionId==="string")result.steeringInjectionId=body.steeringInjectionId;
  if(body.acknowledgement!==undefined){
    if(presentation!=="voice" || typeof body.acknowledgement!=="string")throw Error("acknowledgement requires voice input");
    const text=canonicalizeProviderText(body.acknowledgement,steeringIds).trim();
    if(!text || unicodeCodePointLength(text)>500)throw Error("acknowledgement requires 1–500 characters");
    result.acknowledgement=text;
  }
  if(body.publication!==undefined){
    if(presentation!=="text" || !body.publication || typeof body.publication!=="object" || Array.isArray(body.publication))throw Error("explicit publication requires text presentation");
    const p=body.publication as Record<string,unknown>;
    if(p.kind==="request_update"){
      if(Object.keys(p).some(k=>!["kind","requestId","updateKind"].includes(k)) || typeof p.requestId!=="string" || !p.requestId.trim() || p.requestId.length>200 ||
        !["completed","blocked","failed"].includes(String(p.updateKind)))throw Error("invalid Request publication");
      result.publication={kind:"request_update",requestId:p.requestId.trim(),updateKind:p.updateKind as "completed"|"blocked"|"failed"};
    }else if(p.kind==="message"){
      if(Object.keys(p).some(k=>!["kind","intent","recipientAgentIds","documentTitle","taskDelivery"].includes(k)) ||
        !["broadcast","direct_to_user","collaboration"].includes(String(p.intent)))throw Error("invalid message publication");
      const recipients=p.recipientAgentIds;
      if(p.intent==="collaboration" ? !Array.isArray(recipients)||recipients.length!==1||typeof recipients[0]!=="string"||!recipients[0].trim()||recipients[0].length>200 : recipients!==undefined)
        throw Error("streamed collaboration requires one explicit return recipient");
      if(p.taskDelivery!==undefined && !["final","blocked"].includes(String(p.taskDelivery)))throw Error("invalid task delivery");
      let documentTitle:string|undefined;
      if(p.documentTitle!==undefined){
        if(typeof p.documentTitle!=="string")throw Error("invalid document title");
        documentTitle=canonicalizeProviderText(p.documentTitle,steeringIds).trim();
        if(!documentTitle || unicodeCodePointLength(documentTitle)>160)throw Error("invalid document title");
      }
      result.publication={kind:"message",intent:p.intent as "broadcast"|"direct_to_user"|"collaboration",
        ...(Array.isArray(recipients)?{recipientAgentIds:[recipients[0].trim()]}:{}),
        ...(documentTitle?{documentTitle}:{}),...(p.taskDelivery?{taskDelivery:p.taskDelivery as "final"|"blocked"}:{})};
    }else throw Error("invalid publication kind");
  }
  return result;
}

export function replyStreamSource(store:AgentStore,coordination:CoordinationV3Store,
  scope:{runId:string;agentId:string;conversationId?:string},presentation:"voice"|"text",selected?:ReplyStreamPublication){
  const {runId,agentId,conversationId}=scope;
  if(selected?.kind==="request_update"){
    const request=coordination.getRequest(selected.requestId),agent=store.getAgent(agentId);
    const chat=conversationId?store.getConversation(conversationId):undefined;
    if(presentation!=="text" || !request || !agent || !chat || agent.conversationId!==conversationId || chat.projectId!==agent.projectId ||
      request.recipientAgentId!==agentId || request.projectId!==agent.projectId ||
      request.conversationId!==conversationId || !conversationId || TERMINAL_REQUEST_STATES.has(request.state) ||
      !coordination.requestIdsAttachedToRun(runId,agentId).includes(request.id) ||
      !activeChatResourceOwner(store,"agent",agentId) || !activeChatResourceOwner(store,"conversation",conversationId))return undefined;
    const source=store.sqlite.prepare("SELECT created_at FROM coordination_requests WHERE id=?").get(request.id) as {created_at:string}|undefined;
    return source?{messageId:request.id,projectId:request.projectId,conversationId,acceptedAt:source.created_at,publication:selected}:undefined;
  }
  const source=canonicalVoiceReplyInput(store,coordination,scope,presentation,selected);
  const route=selected??(presentation==="voice" ? {intent:"direct_to_user" as const} : canonicalDefaultReplyRoute(coordination,runId,agentId));
  if(!source || !route || (route.intent==="broadcast" && store.getAgent(agentId)?.managerAgentId))return undefined;
  const publication:ReplyStreamPublication=selected??{kind:"message",...route};
  return {messageId:source.input.eventId,projectId:source.input.projectId,conversationId:source.input.conversationId!,acceptedAt:source.input.createdAt,publication};
}

/** Completion invokes existing public authority, including artifact staging and idempotency. */
export function replyStreamCommit(publication:ReplyStreamPublication,text:string,steeringInjectionId?:string){
  if(publication.kind==="request_update")return {url:"/api/agent-request-updates",payload:{requestId:publication.requestId,kind:publication.updateKind,text,...(steeringInjectionId?{steeringInjectionId}:{})}};
  return {url:"/api/agent-messages",payload:{text:publication.documentTitle?publication.documentTitle:text,
    intent:publication.intent,...(publication.recipientAgentIds?{recipientAgentIds:publication.recipientAgentIds}:{}),
    ...(publication.taskDelivery?{taskDelivery:publication.taskDelivery}:{}),
    ...(publication.documentTitle?{document:{title:publication.documentTitle,content:text,mediaType:"text/markdown"}}:{}),
    ...(steeringInjectionId?{steeringInjectionId}:{})}};
}

/** Ordinary provider publications cannot claim a stream by supplying an ID.
 * Only the host's exact in-flight commit carries this opaque correlation token;
 * all existing canonical routing, context and idempotency checks still apply. */
export function textReplyPublicationCorrelation(token:unknown,run:ActiveRun|undefined,cap:AgentMessageCapability,
 publication:ReplyStreamPublication,steeringInjectionId?:string):ReplyStreamCorrelation|undefined {
 if(token===undefined)return;
 const owned=run?.textReplyPublication,s=run?.voiceReply?.snapshot;
 if(typeof token!=='string'||!owned||token!==owned.token||!s||s.presentation!=='text'||s.state==='failed'||s.purpose==='acknowledgement'||
   owned.streamId!==s.streamId||owned.sourceId!==s.messageId||s.agentId!==cap.agentId||s.conversationId!==cap.conversationId||s.runId!==cap.runId||s.fence!==cap.v3FencingToken||
   s.steeringInjectionId!==steeringInjectionId||JSON.stringify(s.publication)!==JSON.stringify(publication))throw Error('Text reply publication correlation changed');
 return {streamId:s.streamId,sourceId:s.messageId,runId:s.runId,fence:s.fence,...(s.steeringInjectionId?{steeringInjectionId:s.steeringInjectionId}:{})};
}
