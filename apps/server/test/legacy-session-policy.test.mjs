import assert from 'node:assert/strict';
import test from 'node:test';
import { communicationV3Prompt, communicationV3SessionPrompt, legacyCommunicationV3SessionPrompt } from '../dist/runtime-selection.js';

test('legacy transition recognizes only the exact previous reply-line policy, not changed immutable instructions', () => {
  const current = `Identity\n${communicationV3SessionPrompt().join('\n')}\nEnvironment`;
  for (const route of [undefined, { intent: 'broadcast' }, { intent: 'direct_to_user' },
    { intent: 'collaboration', recipientAgentIds: ['stable-agent'] }]) {
    const old = `Identity\n${communicationV3Prompt(route).join('\n')}\nEnvironment`;
    assert.deepEqual(legacyCommunicationV3SessionPrompt(current, old), communicationV3Prompt(route));
    for (const changed of [old.replace('Identity', 'Different identity'), old.replace('Environment', 'Different root'),
      old.replace('Provider-native/internal subagents are disabled', 'Provider-native/internal subagents are allowed'),
      `${old}\nAdditional policy`, old + communicationV3Prompt(route).join('\n')]) {
      assert.equal(legacyCommunicationV3SessionPrompt(current, changed), undefined);
    }
  }
  assert.equal(legacyCommunicationV3SessionPrompt(current, current), undefined);
});

test('legacy route recognition rejects malformed, unbounded, extra-field or unsupported routes', () => {
  const current = `Identity\n${communicationV3SessionPrompt().join('\n')}\nEnvironment`;
  const old = `Identity\n${communicationV3Prompt({ intent: 'direct_to_user' }).join('\n')}\nEnvironment`;
  for (const route of ['null', '[]', '{}', '{"intent":"arbitrary"}', '{"intent":"direct_to_user","extra":true}',
    '{"intent":"broadcast","recipientAgentIds":["a"]}', '{"intent":"collaboration","recipientAgentIds":[]}',
    JSON.stringify({ intent: 'collaboration', recipientAgentIds: ['invalid\ncontrol'] }),
    JSON.stringify({ intent: 'collaboration', recipientAgentIds: Array(201).fill('a') }),
    JSON.stringify({ intent: 'collaboration', recipientAgentIds: ['x'.repeat(17000)] })]) {
    assert.equal(legacyCommunicationV3SessionPrompt(current, old.replace('{"intent":"direct_to_user"}', route)), undefined);
  }
});
