import assert from 'node:assert/strict';
import test from 'node:test';
import { withFixture, until, fixtureTestOptions } from '../shared/fixture.mjs';
import { createServerReadModels } from '../../apps/server/dist/server-read-models.js';

test('UI013 receipt projection batches current targets, respects per-message engine and never decorates terminal/steering or cross-Project data', () => {
  const calls = [], rows = [
    { activationId: 'one', targetAgentId: 'a', state: 'queued', runtime: { engine: 'codex' } },
    { activationId: 'two', targetAgentId: 'a', state: 'queued', runtime: { engine: 'claude' } },
    { activationId: 'three', targetAgentId: 'a', state: 'retrying', runtime: { engine: 'codex' } },
    { activationId: 'terminal', targetAgentId: 'a', state: 'processed' },
    { activationId: 'steer', targetAgentId: 'a', state: 'queued', steeringWaitReason: 'context_refresh' },
    { activationId: 'foreign', targetAgentId: 'other', state: 'queued' },
  ];
  const models = createServerReadModels({ store: { getAgent(id) { calls.push('agent:'+id); return { id, projectId: id === 'other' ? 'foreign' : 'p', activeEngine: 'codex' }; } },
    coordinationV3: { deliveryReceiptsForCommunications: () => new Map([['message', rows]]), activeAgentRun(id) { calls.push('run:'+id); }, providerBlockedState(id) { calls.push('hold:'+id); } },
    admissionBlocker(agent) { calls.push('admission:'+agent.activeEngine); return { kind: agent.activeEngine === 'codex' ? 'authentication_required' : 'provider_unavailable', providerId: agent.activeEngine }; } });
  const result = models.deliveryReceiptsForCommunications('p', ['message']).get('message');
  assert.deepEqual(result.map(r => r.queueWaitReason), ['authentication_required', 'provider_unavailable', 'authentication_required', undefined, undefined, undefined]);
  assert.deepEqual(calls, ['agent:a', 'run:a', 'hold:a', 'agent:other', 'admission:codex', 'admission:claude']);
  for (const row of rows) assert.equal(row.queueWaitReason, undefined, 'source receipts stay immutable');
});

test('UI013 provider retry reasons bind exact activation IDs and do not borrow another queued hold', () => {
  const models = createServerReadModels({ store: { getAgent: () => ({ id: 'a', projectId: 'p', activeEngine: 'codex' }) },
    coordinationV3: { deliveryReceiptsForCommunications: () => new Map([['message', [{ activationId: 'held', targetAgentId: 'a', state: 'queued' }, { activationId: 'other', targetAgentId: 'a', state: 'queued' }]]]),
      activeAgentRun() {}, providerBlockedState: () => ({ activationIds: ['held'], classification: 'rate_limit' }) }, admissionBlocker: () => undefined });
  assert.deepEqual(models.deliveryReceiptsForCommunications('p', ['message']).get('message').map(r => r.queueWaitReason), ['provider_retry', undefined]);
});

async function receiptViews(f, chat, agent, eventId) {
  const from = messages => messages.find(m => m.communicationEventId === eventId)?.deliveryReceipts?.[0];
  const conversation = f.ok(await f.api('GET', `/api/conversations/${chat.id}?limit=100`));
  const detail = await f.detail(agent.id);
  const all = f.ok(await f.api('GET', '/api/all-chat?limit=100'));
  const refresh = f.ok(await f.api('POST', `/api/conversations/${chat.id}/message-delivery-receipts`, { communicationEventIds: [eventId], activationIds: [] }));
  return [from(conversation.messages), from(detail.messages), from(all.items), refresh.items[0]?.deliveryReceipts[0]];
}

test('UI013 a current host-resource hold explains the exact queued receipt on every read and clears without duplicate delivery', fixtureTestOptions, async t => {
  let pressure = false;
  await withFixture(t, async f => {
    const chat = await f.createChat('Queue hold projection'), agent = await f.createIdleAgent(chat, 'Held reader');
    pressure = true;
    await until(async () => f.ok(await f.api('GET', '/api/engines')).some(e => e.resourceAdmission?.state === 'held'), 'observed resource hold');
    const accepted = await f.send(agent.id, 'Exact held message');
    const eventId = accepted.communicationEventId;
    const rows = await receiptViews(f, chat, agent, eventId);
    assert.equal(rows.length, 4);
    for (const row of rows) { assert.ok(row); assert.equal(row.state, 'queued'); assert.equal(row.queueWaitReason, 'host_resource_pressure'); assert.equal(row.providerAcknowledged, undefined); }
    assert.equal(f.turns.length, 0);
    pressure = false;
    await until(async () => f.ok(await f.api('GET', '/api/engines')).every(e => e.resourceAdmission?.state !== 'held'), 'two healthy resource samples');
    await f.settled(agent.id);
    for (const row of await receiptViews(f, chat, agent, eventId)) assert.equal(row.queueWaitReason, undefined);
    assert.equal(f.turns.length, 1, 'one preserved activation produces one provider turn');
  }, { resourceAdmissionObservation: { platform: 'linux', sample: async () => ({ availableBytes: 8 * 1024 ** 3, memoryFullPercent: 0, ioFullPercent: pressure ? 50 : 0, source: 'linux_host' }) } });
});

test('UI013 a later queued message names its current Run barrier without claiming the earlier turn was its acknowledgement', fixtureTestOptions, async t => {
  await withFixture(t, async f => {
    const chat = await f.createChat('Current Run wait'), agent = await f.createIdleAgent(chat, 'Busy reader');
    await f.hold(agent.id);
    const accepted = await f.send(agent.id, 'Later queued message', { activeRunDelivery: 'queue' });
    for (const row of await receiptViews(f, chat, agent, accepted.communicationEventId)) {
      assert.ok(row); assert.equal(row.state, 'queued'); assert.equal(row.queueWaitReason, 'current_run'); assert.equal(row.providerAcknowledged, undefined); assert.equal(row.executionId, undefined);
    }
    assert.equal(f.turns.length, 1);
  });
});
