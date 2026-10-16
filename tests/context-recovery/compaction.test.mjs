import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRolloverEngineSession } from '@ponderosa/engines';
import { providerEventStream } from '../../apps/server/dist/provider-session-facade.js';
import { evaluateContextRolloverPressure, shouldRequestAutomaticContextRollover } from '../../apps/server/dist/context-rollover-pressure.js';

async function projected(message, extra = {}) {
  const stream = { async *[Symbol.asyncIterator]() { yield { type: 'error', message, terminalStatus: 'failed', ...extra }; } };
  const events = []; for await (const event of providerEventStream(stream)) events.push(event);
  return events[0];
}
test('check 95: composed safe projection preserves exact pre-work compact recovery without publishing raw failure details', async () => {
  const raw = 'failed to run pre-sampling compact: private diagnostic sentinel';
  const event = await projected(raw);
  assert.equal(shouldRolloverEngineSession('codex', event), true);
  assert.equal(shouldRolloverEngineSession('claude', event), false);
  assert.ok(!JSON.stringify(event).includes('private diagnostic sentinel'));
  assert.equal(shouldRolloverEngineSession('codex', JSON.parse(JSON.stringify(event))), false, 'Public serialized fields must not confer retry authority');
});
for (const message of ['Authentication failed', 'Usage quota exceeded', 'Network connection failed', 'Context length exceeded', 'Command failed']) {
  test(`check 95: ${message} is not a compact-retry signal`, async () => assert.equal(shouldRolloverEngineSession('codex', await projected(message)), false));
}
test('check 93: cumulative usage is not current context pressure; an active cycle suppresses duplicate handoff', () => {
  const preferences = { contextRolloverTokens: 150000, contextRolloverWindowFraction: 0.75 };
  const low = evaluateContextRolloverPressure({ usedTokens: 1000, aggregateTokens: 900000, windowTokens: 200000 }, preferences);
  assert.equal(low.shouldRequest, false);
  const high = evaluateContextRolloverPressure({ usedTokens: 160000, windowTokens: 200000 }, preferences);
  assert.equal(shouldRequestAutomaticContextRollover(high, undefined), true);
  assert.equal(shouldRequestAutomaticContextRollover(high, { state: 'requested' }), false);
});
