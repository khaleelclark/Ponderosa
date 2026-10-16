import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceReply, voiceReplyInWindow } from '../src/components/speech/voiceReply.js';
const sent = () => ({ id: 'sent', conversationId: 'chat', deliveryReceipts: [{ targetAgentId: 'agent', state: 'processed', executionId: 'run' }] });
const reply = () => ({ id: 'reply', conversationId: 'chat', role: 'assistant', communicationIntent: 'user_dm', authorAgentId: 'agent', executionId: 'run', text: 'The exact reply.' });
test('ordinary DM without a Request follows its canonical processed execution', () => {
  assert.deepEqual(voiceReply(sent(), [reply()], 'agent'), { text: 'The exact reply.' });
  for (const patch of [{ executionId: 'old-run' }, { authorAgentId: 'other' }, { conversationId: 'other-chat' }, { role: 'system' }, { communicationIntent: 'broadcast' }]) {
    assert.equal(voiceReply(sent(), [{ ...reply(), ...patch }], 'agent'), undefined);
  }
});
test('voice waits for processing and pauses on unsuccessful delivery', () => {
  const item = sent();
  for (const state of ['queued', 'started', 'delivered', 'recovering']) {
    item.deliveryReceipts[0].state = state;
    assert.equal(voiceReply(item, [reply()], 'agent'), undefined);
  }
  for (const state of ['failed', 'cancelled', 'undelivered', 'retry_exhausted', 'unconfirmed']) {
    item.deliveryReceipts[0].state = state;
    assert.ok(voiceReply(item, [reply()], 'agent').error);
  }
});
test('recovery uses only its canonical recovery execution', () => {
  const item = sent(); Object.assign(item.deliveryReceipts[0], { state: 'recovered', recoveryExecutionId: 'recovery-run' });
  assert.equal(voiceReply(item, [reply()], 'agent'), undefined);
  assert.deepEqual(voiceReply(item, [{ ...reply(), executionId: 'recovery-run' }], 'agent'), { text: 'The exact reply.' });
});
test('ambiguous and artifact-backed replies pause instead of reading a stub', () => {
  assert.ok(voiceReply(sent(), [reply(), { ...reply(), id: 'second' }], 'agent').error);
  assert.ok(voiceReply(sent(), [{ ...reply(), text: 'Full reply: ponderosa://artifact/result', document: { artifactId: 'result' } }], 'agent').error);
  assert.ok(voiceReply(sent(), [{ ...reply(), text: ' ' }], 'agent').error);
});

test('a latest window missing the accepted turn never claims a unique reply', () => {
  const first = { ...reply(), id: 'first' };
  const second = { ...reply(), id: 'second' };
  const chatter = Array.from({ length: 20 }, (_, i) => ({ ...reply(), id: `other-${i}`, executionId: 'other-run' }));
  const full = [sent(), first, ...chatter, second];
  assert.ok(voiceReplyInWindow('sent', full.slice(-20), 'agent').error);
  assert.ok(voiceReplyInWindow('sent', full, 'agent').error);
  assert.deepEqual(voiceReplyInWindow('sent', [sent(), reply()], 'agent'), { text: 'The exact reply.' });
});

test('canonical authored bytes reconcile provisional text while display routing labels remain in Chat',()=>{
 assert.deepEqual(voiceReply(sent(),[{...reply(),text:'#user Display label',authoredText:'Authored reply.'}],'agent'),{text:'Authored reply.'});
});
