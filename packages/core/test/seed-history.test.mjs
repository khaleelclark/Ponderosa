import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { boundedFrozenSeedHistory, communicationSeedProvenance, renderSeedHistoryMessage } from '../dist/seed-history.js';

export function legacyFrozenHistory() {
  const lead = '00000000-0000-4000-8000-000000000001';
  return Array.from({ length: 40 }, (_, i) => {
    const event = { schemaVersion: 2, eventId: `runtime-${String(i).padStart(64, '0')}`,
      projectId: '00000000-0000-4000-8000-000000000002', conversationId: '00000000-0000-4000-8000-000000000003',
      sender: { kind: 'agent', agentId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}` },
      intent: 'collaboration', audience: { kind: 'agents', agentIds: [lead, ...Array.from({ length: 99 }, (_, n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`)] } };
    const text = '🙂'.repeat(150);
    return { role: 'assistant', text, provenance: communicationSeedProvenance(event, lead, '🙂'.repeat(100)),
      sourceCommunicationEventId: event.eventId, sourceContentSha256: createHash('sha256').update(text).digest('hex') };
  });
}

test('legacy frozen tails retain all source bindings inside the actual UTF-8 presentation budget', () => {
  const original = legacyFrozenHistory(), before = JSON.stringify(original);
  assert.equal(original.reduce((n, m) => n + Buffer.byteLength(m.text), 0), 24000);
  assert.ok(original.reduce((n, m) => n + Buffer.byteLength(renderSeedHistoryMessage(m)), 0) > 24000);
  const bounded = boundedFrozenSeedHistory(original);
  assert.equal(bounded.length, 40);
  assert.ok(Buffer.byteLength(bounded.map(renderSeedHistoryMessage).join('\n')) + 64 <= 24000);
  assert.equal(JSON.stringify(original), before);
  for (let i = 0; i < bounded.length; i++) {
    assert.equal(bounded[i].sourceContentSha256, original[i].sourceContentSha256);
    assert.equal(bounded[i].sourceCommunicationEventId, original[i].sourceCommunicationEventId);
    assert.equal(bounded[i].provenance.sender.id, original[i].provenance.sender.id);
    assert.deepEqual(bounded[i].provenance.audience.agentIds, [original[i].provenance.currentAgentId]);
    assert.equal(bounded[i].provenance.audience.omittedRecipientCount, 99);
  }
  assert.match(bounded.map(renderSeedHistoryMessage).join('\n'), /Canonical content (?:omitted|clipped)/);
});

test('bounded frozen presentation preserves short complete records and fails closed on excessive indispensable identity', () => {
  const short = [{ role: 'assistant', text: 'complete', provenance: communicationSeedProvenance({
    eventId: 'e', projectId: 'p', conversationId: 'c', sender: { kind: 'agent', agentId: 'peer' },
    audience: { kind: 'agents', agentIds: ['lead'] }, intent: 'collaboration' }, 'lead', 'Peer') }];
  assert.deepEqual(boundedFrozenSeedHistory(short), short);
  assert.throws(() => boundedFrozenSeedHistory(Array(41).fill(short[0])), /message bound/);
  assert.throws(() => boundedFrozenSeedHistory([{ ...short[0], provenance: { ...short[0].provenance,
    sender: { kind: 'agent', id: 'x'.repeat(25000) } } }]), /provenance exceeds/);
});
