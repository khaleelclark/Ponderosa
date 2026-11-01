import type {MessageDto,ConversationMessageDto,VoiceReplySnapshot} from '@ponderosa/core';
export type ReplySource=MessageDto|ConversationMessageDto;

export function matchesTextReplyRoute(source:ReplySource,reply:VoiceReplySnapshot,peerAgentId?:string):boolean {
 if(reply.presentation!=='text'||reply.messageId!==(source.communicationEventId??source.id)||reply.conversationId!==source.conversationId)return false;
 if(source.communicationIntent==='collaboration'){
  const sender=source.communicationSender;
  return Boolean(peerAgentId&&reply.agentId===peerAgentId&&sender?.kind==='agent'&&source.authorAgentId===sender.agentId&&
   source.collaborationRecipients?.some(item=>item.id===peerAgentId)&&!source.coordinationRequests?.length&&reply.replyIntent==='collaboration'&&
   reply.recipientAgentIds?.length===1&&reply.recipientAgentIds[0]===sender.agentId);
 }
 if(source.role!=='user'||reply.recipientAgentIds?.length)return false;
 return source.communicationIntent==='broadcast'?reply.replyIntent==='broadcast':source.communicationIntent==='user_dm'&&reply.replyIntent==='direct_to_user';
}
export const matchesHumanTextReplyRoute=matchesTextReplyRoute;
