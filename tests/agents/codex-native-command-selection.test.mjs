// Deferred source only: not executed in the implementation phase.
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectNativeCommand } from '../../apps/server/dist/native-command-selection.js';
const command = '/plan {"prompt":"Inspect","mode":"plan"}';
const event = (eventId, overrides = {}) => ({ eventId, schemaVersion: 2, projectId: 'project', conversationId: 'chat', createdAt: '2026-11-01T00:00:00.000Z',
  sender: { kind: 'user', userId: 'local-operator' }, intent: 'broadcast',
  audience: { kind: 'organization', organizationId: 'organization' }, text: command, ...overrides });
function select(events, ids = events.map(e => e.eventId), body = () => undefined) {
  return selectNativeCommand({ projectId: 'project', agentId: 'agent', conversationId: 'chat',
    communicationIds: ids, read: id => events.find(e => e.eventId === id), documentText: body });
}
test('current canonical command after a nonhuman source is selected once', () => {
  const rows = [event('agent-source', { sender: { kind: 'agent', agentId: 'other' }, text: '/review {}' }), event('human')];
  assert.equal(select(rows, ['agent-source', 'human', 'human']).kind, 'plan');
});
test('explicit direct recipients authorize native actions, unrelated scopes do not', () => {
  assert.equal(select([event('direct', { intent: 'user_dm', conversationId: 'other-chat',
    audience: { kind: 'user_agents', userId: 'local-operator', agentIds: ['agent', 'other'] } })]).kind, 'plan');
  assert.equal(select([event('elsewhere', { conversationId: 'other-chat' })]), undefined);
  assert.equal(select([event('private', { intent: 'user_dm', audience: { kind: 'user_agent', agentId: 'other' } })]), undefined);
});
test('two distinct native source commands fail instead of dropping one', () => {
  assert.throws(() => select([event('first'), event('second')]), /Multiple native actions/);
});
test('document commands use authoritative full body and fail closed if missing', () => {
  const rows = [event('long', { text: 'clipped summary', document: { id: 'document' } })];
  assert.equal(select(rows, undefined, () => command).kind, 'plan');
  assert.throws(() => select(rows), /document is unavailable/);
  assert.throws(() => select([], ['missing']), /source is unavailable/);
});
test('malformed native syntax is explicit, ordinary prose does not choose an action', () => {
  assert.throws(() => select([event('bad', { text: '/plan {}' })]));
  assert.equal(select([event('prose', { text: 'Please consider /plan later' })]), undefined);
});
