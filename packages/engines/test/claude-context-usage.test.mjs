import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeContextUsage } from '../dist/claude-context-usage.js';
import { projectAgentEvent } from '../dist/agent-event-projection.js';

const accepted = (id = 'current', session = 'session') => ({ type: 'user', uuid: id,
  session_id: session, parent_tool_use_id: null, isReplay: true, message: { role: 'user' } });
const assistant = (id = 'request', usage = { input_tokens: 10000, cache_read_input_tokens: 130001, cache_creation_input_tokens: 10000 }) => ({
  type: 'assistant', session_id: 'session', parent_tool_use_id: null,
  message: { id, role: 'assistant', model: 'claude-sonnet-4-6', usage },
});

test('current accepted main request counts cached input once and keeps aggregate/window unavailable', () => {
  const tracker = new ClaudeContextUsage('session');
  tracker.beginTurn('current');
  assert.equal(tracker.observe(assistant('before-acceptance')), undefined);
  tracker.observe(accepted('historical'));
  assert.equal(tracker.observe(assistant('after-old-echo')), undefined);
  tracker.observe(accepted());
  const observation = tracker.observe(assistant());
  assert.deepEqual(projectAgentEvent(observation), { type: 'context_usage', providerSessionId: 'session', providerSessionGeneration: 'session', usedTokens: 150001 });
  assert.deepEqual(tracker.contextUsage(), { usedTokens: 150001, providerSessionGeneration: 'session' });
  assert.equal(tracker.observe(assistant()), undefined);
  assert.equal(tracker.observe({ type: 'result', session_id: 'session', usage: { input_tokens: 1000000 } }), undefined);
  assert.equal(tracker.contextUsage().usedTokens, 150001);
  tracker.endTurn();
  assert.equal(tracker.observe(assistant('outside-turn')), undefined);
  tracker.beginTurn('next'); tracker.observe(accepted('next'));
  assert.equal(tracker.observe(assistant()), undefined, 'a prior request identity stays deduplicated across turns');
  assert.equal(tracker.observe(assistant('fresh-request', { input_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).usedTokens, 8000);
});

test('missing, malformed, synthetic, subagent, stale and replay observations cannot establish low occupancy', () => {
  const tracker = new ClaudeContextUsage('session'); tracker.beginTurn('current'); tracker.observe(accepted());
  tracker.observe(assistant());
  const low = assistant('low', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  for (const invalid of [
    { ...low, session_id: 'old-session' }, { ...low, parent_tool_use_id: 'native-helper' },
    { ...low, parent_tool_use_id: undefined }, { ...low, isReplay: true },
    { ...low, message: { ...low.message, id: '' } },
    { ...low, message: { ...low.message, model: '<synthetic>' } },
    { ...low, message: { ...low.message, usage: undefined } }, assistant('empty', {}), assistant('partial', { input_tokens: 1 }),
    assistant('zero', { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ...[NaN, Infinity, -1, 1.5, '10', 2147483648].flatMap(value => ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => assistant(`invalid-${key}`, { ...low.message.usage, [key]: value }))),
    assistant('overflow', { input_tokens: 2147483647, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }),
  ]) assert.equal(tracker.observe(invalid), undefined, JSON.stringify(invalid));
  assert.equal(tracker.contextUsage().usedTokens, 150001);
  tracker.submit('steer'); tracker.observe(accepted('steer'));
  assert.equal(tracker.observe(low).usedTokens, 100, 'steering keeps the accepted main turn observable');
});

test('request deduplication is bounded and fails closed rather than evicting historical identities', () => {
  const tracker = new ClaudeContextUsage('session'); tracker.beginTurn('current'); tracker.observe(accepted());
  for (let index = 0; index < 4096; index++) assert.ok(tracker.observe(assistant(`request-${index}`)));
  assert.equal(tracker.observe(assistant('beyond-budget')), undefined);
  tracker.endTurn(); tracker.beginTurn('next'); tracker.observe(accepted('next'));
  assert.equal(tracker.observe(assistant('request-0')), undefined);
  assert.equal(tracker.observe(assistant('still-beyond-budget')), undefined);
});
