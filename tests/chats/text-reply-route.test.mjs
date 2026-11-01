import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesHumanTextReplyRoute} from '../../apps/web/src/components/chat/textReplyRoute.ts';
const source={id:'projection',communicationEventId:'source',conversationId:'chat',role:'user',communicationIntent:'broadcast'};
const reply={messageId:'source',conversationId:'chat',presentation:'text',replyIntent:'broadcast'};
test('shared human text rejects private, peer, voice and foreign source snapshots',()=>{
 assert.equal(matchesHumanTextReplyRoute(source,reply),true);
 for(const patch of [{replyIntent:'direct_to_user'},{replyIntent:'collaboration',recipientAgentIds:['peer']},{recipientAgentIds:['peer']},{presentation:'voice'},{messageId:'other'},{conversationId:'other'}])assert.equal(matchesHumanTextReplyRoute(source,{...reply,...patch}),false);
});
test('Direct Message text requires the explicit direct route',()=>{
 const direct={...source,communicationIntent:'user_dm'};
 assert.equal(matchesHumanTextReplyRoute(direct,{...reply,replyIntent:'direct_to_user'}),true);
 assert.equal(matchesHumanTextReplyRoute(direct,reply),false);
 assert.equal(matchesHumanTextReplyRoute({...direct,role:'assistant'},{...reply,replyIntent:'direct_to_user'}),false);
});
