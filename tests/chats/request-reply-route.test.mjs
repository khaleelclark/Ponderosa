// Deferred source regression; not executed.
import '../shared/web-typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesRequestTextReplyRoute,matchesTextReplyRoute} from '../../apps/web/src/components/chat/textReplyRoute.ts';
const draft={presentation:'text',purpose:'answer',messageId:'request',conversationId:'chat',publication:{kind:'request_update',requestId:'request',updateKind:'completed'}};
test('Request provisional text requires exact private Request publication, never a human-message fallback',()=>{
 assert.equal(matchesRequestTextReplyRoute('request',draft),true);
 for(const patch of [{messageId:'other'},{purpose:'acknowledgement'},{presentation:'voice'},{replyIntent:'collaboration'},{recipientAgentIds:['other']},{publication:{...draft.publication,requestId:'other'}},{publication:{...draft.publication,updateKind:'progress'}},{publication:{kind:'message',intent:'broadcast'}}])assert.equal(matchesRequestTextReplyRoute('request',{...draft,...patch}),false);
 assert.equal(matchesTextReplyRoute({id:'request',conversationId:'chat',role:'user',communicationIntent:'broadcast'},draft),false);
});
