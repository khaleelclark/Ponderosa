import type {MessageDto,ConversationMessageDto,VoiceReplySnapshot} from '@ponderosa/core';
export type ReplySource=MessageDto|ConversationMessageDto;

export function matchesTextReplyRoute(source:ReplySource,reply:VoiceReplySnapshot,peerAgentId?:string):boolean {
 if(reply.purpose==='acknowledgement'||reply.publication?.kind==='request_update')return false;
 const route=reply.publication?.kind==='message'?reply.publication:reply;
 if(reply.presentation!=='text'||reply.messageId!==(source.communicationEventId??source.id)||reply.conversationId!==source.conversationId)return false;
 if(source.communicationIntent==='collaboration'){
  const sender=source.communicationSender;
  return Boolean(peerAgentId&&reply.agentId===peerAgentId&&sender?.kind==='agent'&&source.authorAgentId===sender.agentId&&
   source.collaborationRecipients?.some(item=>item.id===peerAgentId)&&!source.coordinationRequests?.length&&('intent' in route?route.intent:reply.replyIntent)==='collaboration'&&
   route.recipientAgentIds?.length===1&&route.recipientAgentIds[0]===sender.agentId);
 }
 if(source.role!=='user'||route.recipientAgentIds?.length)return false;
 return source.communicationIntent==='broadcast'?('intent' in route?route.intent:reply.replyIntent)==='broadcast':source.communicationIntent==='user_dm'&&('intent' in route?route.intent:reply.replyIntent)==='direct_to_user';
}
export const matchesHumanTextReplyRoute=matchesTextReplyRoute;

/** A Request draft belongs only to its exact private lifecycle, never a Chat message. */
export function matchesRequestTextReplyRoute(requestId:string,reply:VoiceReplySnapshot):boolean {
 return reply.presentation==='text' && (reply.purpose??'answer')==='answer' && reply.messageId===requestId &&
  reply.publication?.kind==='request_update' && reply.publication.requestId===requestId &&
  ['completed','blocked','failed'].includes(reply.publication.updateKind) && !reply.replyIntent && !reply.recipientAgentIds?.length;
}
