import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRolloverEngineSession } from '@ponderosa/engines';
import { publicProviderFailureEvent } from '@ponderosa/core';
import { providerEventStream } from '../../apps/server/dist/provider-session-facade.js';
import { evaluateContextRolloverPressure, shouldRequestAutomaticContextRollover } from '../../apps/server/dist/context-rollover-pressure.js';

async function projected(message, extra = {}) {
  const stream = { async *[Symbol.asyncIterator]() { yield { type: 'error', message, terminalStatus: 'failed', ...extra }; } };
  const events = []; for await (const event of providerEventStream(stream)) events.push(event);
  return events[0];
}
test('check 95: canonical compact diagnostics retain harmless causes while only exact live events authorize recovery', async () => {
  const raw = 'failed to run pre-sampling compact: private diagnostic sentinel';
  const event = await projected(raw);
  assert.equal(shouldRolloverEngineSession('codex', event), true);
  assert.equal(shouldRolloverEngineSession('claude', event), false);
  assert.ok(JSON.stringify(event).includes(raw), 'Canonical Activity retains the inspected harmless cause');
  const summary = publicProviderFailureEvent(event);
  assert.equal(summary.message, 'Provider context limit was reached.');
  assert.ok(!JSON.stringify(summary).includes('private diagnostic sentinel'), 'The explicit summary projection stays concise');
  for (const copy of [{ ...event }, JSON.parse(JSON.stringify(event)), summary, JSON.parse(JSON.stringify(summary))]) {
    assert.equal(shouldRolloverEngineSession('codex', copy), false, 'Readable canonical/summary fields must not confer retry authority');
  }
  assert.equal(shouldRolloverEngineSession('codex', event), true, 'Serialization does not consume exact live-event provenance');
});
test('check 95: canonical serialized compact causes redact known fields and keep Unicode/tail without serializing retry authority', async () => {
  const secret='SYNTHETIC_COMPACT_CREDENTIAL_731', tail='日本語 café 🦄 EXACT_SAFE_TAIL';
  for(const diagnostic of [
    `api_key=${secret}`,
    JSON.stringify(JSON.stringify({OPENAI_API_KEY:secret})),
    JSON.stringify(JSON.stringify({api_key:secret})).slice(0,-1),
  ]) {
    const event=await projected(`failed to run pre-sampling compact: harmless cause ${diagnostic}; ${tail}`,{code:'context_length'});
    const serialized=JSON.stringify(event),copy=JSON.parse(serialized);
    assert.ok(!serialized.includes(secret));assert.ok(copy.message.includes('harmless cause'));assert.ok(copy.message.endsWith(tail));
    assert.equal(shouldRolloverEngineSession('codex',event),true);
    assert.equal(shouldRolloverEngineSession('codex',copy),false);
    const summary=publicProviderFailureEvent(copy);
    assert.equal(summary.message,'Provider context limit was reached.');
    assert.ok(!JSON.stringify(summary).includes(secret));assert.equal(shouldRolloverEngineSession('codex',summary),false);
  }
});

test('check 95: interrupted and structured authentication failures cannot gain retry authority from retained compact prose', async () => {
  const raw='failed to run pre-sampling compact: harmless cause';
  for(const extra of [{terminalStatus:'interrupted'},{code:'authentication_failed'}]) {
    const event=await projected(raw,extra);
    assert.ok(event.message.includes(raw));
    assert.equal(shouldRolloverEngineSession('codex',event),false);
    assert.equal(shouldRolloverEngineSession('codex',JSON.parse(JSON.stringify(event))),false);
  }
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
