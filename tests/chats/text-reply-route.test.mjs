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
test('peer drafts require the exact sole return recipient and never enter the human route',()=>{
 const peer={...source,role:'assistant',communicationIntent:'collaboration',communicationSender:{kind:'agent',agentId:'sender'},authorAgentId:'sender',collaborationRecipients:[{id:'receiver'}]};
 const draft={...reply,agentId:'receiver',replyIntent:'collaboration',recipientAgentIds:['sender']};
 assert.equal(matchesHumanTextReplyRoute(peer,draft,'receiver'),true);
 assert.equal(matchesHumanTextReplyRoute(source,draft),false);
 assert.equal(matchesHumanTextReplyRoute(peer,draft),false);
 for(const patch of [{recipientAgentIds:['other']},{recipientAgentIds:['sender','other']},{agentId:'other'},{replyIntent:'broadcast'}])assert.equal(matchesHumanTextReplyRoute(peer,{...draft,...patch},'receiver'),false);
 assert.equal(matchesHumanTextReplyRoute({...peer,coordinationRequests:[{id:'request'}]},draft,'receiver'),false);
});

test('explicit publication selects one exact document or mixed-route return',()=>{
 const direct={...source,communicationIntent:'user_dm'};
 const selected={...reply,replyIntent:undefined,publication:{kind:'message',intent:'direct_to_user',documentTitle:'Report',taskDelivery:'final'}};
 assert.equal(matchesHumanTextReplyRoute(direct,selected),true);
 assert.equal(matchesHumanTextReplyRoute(source,selected),false);
 assert.equal(matchesHumanTextReplyRoute(direct,{...selected,purpose:'acknowledgement'}),false);
 assert.equal(matchesHumanTextReplyRoute(direct,{...selected,publication:{...selected.publication,recipientAgentIds:['other']}}),false);
});
