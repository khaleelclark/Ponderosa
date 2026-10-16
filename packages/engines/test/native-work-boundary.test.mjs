import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCodexAppServerNotification, projectAgentEvent, CodexResponseText } from '../dist/index.js';

// Official ThreadItem inventory, plus names present in installed 0.159.2's
// static tag table. Additional/unknown names deliberately need no tool contract.
const workTypes = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'functionCallOutput', 'webSearch', 'imageView', 'collabToolCall',
  'enteredReviewMode', 'exitedReviewMode', 'hookPrompt', 'collabAgentToolCall',
  'sleep', 'imageGeneration', 'futureNativeTool'];
const fences = events => events.some(e => ['work_start', 'tool_call', 'tool_result', 'command', 'file_change'].includes(e.type));
for (const type of workTypes) for (const method of ['item/started', 'item/completed']) {
  test(`native item matrix ${type} ${method} fences even sparse payload`, () => {
    const events = mapCodexAppServerNotification({ method, params: { item: { type, id: 'native', text: 'PRIVATE NATIVE BYTES' } } }, '/fixture');
    assert.ok(fences(events), `${type} ${method} must invalidate without optional tool output`);
    assert.ok(events.every(e => e.type !== 'text' && e.type !== 'response_text'));
    for (const event of events) assert.deepEqual(projectAgentEvent(event), event);
    const boundary = events.find(e => e.type === 'work_start');
    if (boundary) assert.ok(!JSON.stringify(boundary).includes('PRIVATE NATIVE BYTES'));
  });
}
test('malformed lifecycle and missing native identity fail closed without raw payload', () => {
  for (const method of ['item/started', 'item/completed']) for (const item of [undefined, null, [], 'raw', {}, { type: 7 }, { type: '' }, { type: 'webSearch' }, { type: 'webSearch', id: '' }, { type: 'futureNativeTool', id: 'x'.repeat(2000) }, { type: 'fileChange', changes: null }]) {
    const events = mapCodexAppServerNotification({ method, params: { item } }, '/fixture');
    assert.ok(fences(events));
    for (const event of events) assert.deepEqual(projectAgentEvent(event), event);
  }
  assert.deepEqual(mapCodexAppServerNotification({ method: 'thread/status/changed', params: {} }, '/fixture'), []);
});
test('answer, reasoning, plan, user input and passive compaction remain distinct from native work', () => {
  for (const type of ['agentMessage', 'reasoning', 'plan', 'userMessage', 'contextCompaction']) for (const method of ['item/started', 'item/completed']) {
    const events = mapCodexAppServerNotification({ method, params: { item: { type, id: 'answer', text: 'Work log answer', phase: 'final_answer' } } }, '/fixture');
    assert.equal(fences(events), false);
    if (type === 'agentMessage' && method === 'item/completed') assert.deepEqual(events, [{ type: 'text', delta: 'Work log answer\n\n' }]);
    else assert.deepEqual(events, []);
  }
  const map = new CodexResponseText('thread');
  map.map('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  assert.equal(map.map('item/started', { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '' } })[0].type, 'response_text');
  assert.deepEqual(map.map('item/started', { threadId: 'thread', turnId: 'turn', item: { type: 'reasoning', id: 'reason', text: 'PRIVATE REASONING' } }), []);
});
test('ordinary command, file and tool Worklog projections retain their bodies', () => {
  const map = (method, item) => mapCodexAppServerNotification({ method, params: { item } }, '/fixture').filter(e => e.type !== 'work_start');
  assert.deepEqual(map('item/started', { type: 'commandExecution', id: 'cmd', command: 'inert' }), [{ type: 'command', command: 'inert', cwd: '/fixture', callId: 'cmd' }]);
  assert.deepEqual(map('item/completed', { type: 'fileChange', id: 'edit', changes: [{ path: 'fixture.txt', kind: 'edit', diff: 'inert diff' }] }), [{ type: 'file_change', path: 'fixture.txt', kind: 'edit', diff: 'inert diff', callId: 'edit' }]);
  assert.deepEqual(map('item/started', { type: 'dynamicToolCall', id: 'tool', tool: 'ordinary', arguments: { inert: true } }), [{ type: 'tool_call', id: 'tool', name: 'ordinary', input: { inert: true } }]);
});
test('only the exact successfully acknowledged authorizing operation normalizes a receipt', () => {
  const contentItems = [{ type: 'inputText', text: JSON.stringify({ authorized: true, streamId: 'scoped-stream' }) }];
  const map = patch => mapCodexAppServerNotification({ method: 'item/completed', params: { item: { type: 'dynamicToolCall', id: 'auth', tool: 'ponderosa_voice_reply', success: true, contentItems, ...patch } } }, '/fixture');
  assert.equal(map({})[0].voiceReplyStreamId, 'scoped-stream');
  for (const patch of [{ namespace: 'foreign' }, { tool: 'foreign.ponderosa_voice_reply' }, { success: false }, { success: undefined }, { contentItems: [{ type: 'inputText', text: 'authorized prose' }] }]) assert.ok(map(patch).every(e => e.voiceReplyStreamId === undefined));
});
test('native tool boundary is closed and cannot carry raw output or accessor fields', () => {
  assert.deepEqual(projectAgentEvent({ type: 'work_start', kind: 'native_tool' }), { type: 'work_start', kind: 'native_tool' });
  for (const patch of [{ text: 'private' }, { itemType: 'webSearch' }, { kind: 'future' }]) assert.throws(() => projectAgentEvent({ type: 'work_start', kind: 'native_tool', ...patch }));
  let reads = 0;
  assert.throws(() => projectAgentEvent({ type: 'work_start', kind: 'native_tool', get callId() { reads++; return 'secret'; } }));
  assert.equal(reads, 0);
});
