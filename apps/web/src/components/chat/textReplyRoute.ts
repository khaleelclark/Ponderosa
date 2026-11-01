import type {MessageDto,VoiceReplySnapshot} from '@ponderosa/core';

export function matchesHumanTextReplyRoute(source:MessageDto,reply:VoiceReplySnapshot):boolean {
 if(source.role!=='user'||reply.presentation!=='text'||reply.messageId!==(source.communicationEventId??source.id)||reply.conversationId!==source.conversationId)return false;
 if(reply.recipientAgentIds?.length)return false;
 return source.communicationIntent==='broadcast'?reply.replyIntent==='broadcast':source.communicationIntent==='user_dm'&&reply.replyIntent==='direct_to_user';
}
