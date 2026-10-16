import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withFixture, until } from '../shared/fixture.mjs';

const options = { timeout: 30000 };

test('check 11: unavailable direct recipient is reported honestly while replay delivers to the available recipient once', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Partial delivery'), recipient = await f.createIdleAgent(chat, 'Available reader'), missing = randomUUID();
  const body = { text: `One real delivery ${randomUUID()}`, idempotencyKey: randomUUID(), recipients: [{ agentId: recipient.id }, { agentId: missing }] };
  const first = f.ok(await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, body));
  assert.ok(first.messageId); assert.ok(first.unavailableRecipients.some(x => x.agentId === missing)); assert.deepEqual(first.recipients.map(x => x.agentId), [recipient.id]);
  const replay = f.ok(await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, body)); assert.equal(replay.messageId, first.messageId);
  await f.settled(recipient.id); assert.equal(f.turns.filter(x => x.agentId === recipient.id).length, 1);
  const allMissing = await f.api('POST', `/api/conversations/${chat.id}/direct-messages`, { ...body, idempotencyKey: randomUUID(), recipients: [{ agentId: missing }] });
  assert.equal(allMissing.status, 409); assert.ok(allMissing.body.unavailableRecipients.some(x => x.agentId === missing));
}));

test('check 28: provider disabled state remains distinct from authenticated state and blocks new intake', options, t => withFixture(t, async f => {
  const engine = await until(async () => f.ok(await f.api('GET', '/api/engines')).find(x => x.id === 'codex' && x.authentication === 'authenticated'), 'controlled authentication observation');
  assert.equal(engine.enabled, true); assert.equal(engine.intakeReady, true);
  const disabled = f.ok(await f.api('PATCH', '/api/engines/codex', { enabled: false })); assert.equal(disabled.enabled, false); assert.equal(disabled.intakeReady, false);
  const chat = await f.createChat('Disabled provider');
  const created = await f.api('POST', `/api/projects/${chat.projectId}/agents`, { title: 'Refused reader', engine: 'codex', conversationId: chat.id, initialMessage: 'Do not run', idempotencyKey: randomUUID() });
  assert.equal(created.status, 409); assert.equal(f.turns.length, 0);
  const enabled = f.ok(await f.api('PATCH', '/api/engines/codex', { enabled: true })); assert.equal(enabled.enabled, true); assert.equal(enabled.authentication, engine.authentication);
}));

test('check 52: cancelling one delegated Request preserves its identity and leaves the other Request live', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Request cancellation'), manager = await f.createIdleAgent(chat, 'Manager'), a = await f.createIdleAgent(chat, 'Worker A'), b = await f.createIdleAgent(chat, 'Worker B');
  const session = await f.hold(manager.id);
  for (const w of [a, b]) f.plans.set(w.id, [{ hold: true }]);
  const args = { idempotencyKey: randomUUID(), requests: [a, b].map(w => ({ recipientAgentId: w.id, text: `Work for ${w.title}`, lifetime: { kind: 'indefinite' } })), join: { mode: 'all', wakePolicy: 'final_only', satisfyingOutcomes: ['completed', 'cancelled'] } };
  const coordinated = f.ok(await f.tool(session, 'ponderosa_coordinate', args)); await until(() => [a, b].every(w => f.turns.some(x => x.agentId === w.id)), 'two worker inputs');
  const before = await f.detail(manager.id), target = before.coordinationV3.requests.find(x => x.counterpartyAgentId === a.id && coordinated.requestIds.includes(x.id));
  const update = { requestId: target.id, updateId: randomUUID(), kind: 'cancelled', text: 'Cancel only A' };
  f.ok(await f.tool(session, 'ponderosa_update_request', update)); f.ok(await f.tool(session, 'ponderosa_update_request', update));
  const replay = f.ok(await f.tool(session, 'ponderosa_coordinate', args)); assert.deepEqual(replay.requestIds, coordinated.requestIds); assert.equal(replay.joinId, coordinated.joinId);
  const requests = (await f.detail(manager.id)).coordinationV3.requests.filter(x => coordinated.requestIds.includes(x.id));
  assert.equal(requests.find(x => x.id === target.id).state, 'cancelled');
  assert.ok(!['completed', 'cancelled', 'failed'].includes(requests.find(x => x.counterpartyAgentId === b.id).state));
  assert.ok((await f.tool(f.sessions.get(a.id), 'ponderosa_update_request', { requestId: target.id, kind: 'completed', text: 'Too late' })).status >= 400);
  f.ok(await f.tool(f.sessions.get(b.id), 'ponderosa_update_request', { kind: 'completed', text: 'B completed independently' }));
  assert.equal((await f.detail(manager.id)).coordinationV3.joins.find(x => x.id === coordinated.joinId).state, 'satisfied');
}));

test('checks 26, 27: structured command invokes only the selected idle runtime; unavailable commands and active work are refused', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Command scope'), a = await f.createAgent(chat, 'Idle command owner'), b = await f.createIdleAgent(chat, 'Busy unrelated owner');
  const command = { name: 'fixture-inspect', description: 'Harmless controlled command', source: 'provider-advertised', acceptsArguments: true, insertText: '/fixture-inspect', status: 'available', invocation: 'runtime' };
  f.capabilities.commands = [command, { ...command, name: 'unavailable-fixture', status: 'unavailable', unavailableReason: 'Declared unavailable' }];
  const session = await f.hold(b.id), active = (await f.detail(b.id)).runs.find(x => x.status === 'running');
  const before = (await f.detail(a.id)).runs.map(x => x.id);
  const invoked = f.ok(await f.api('POST', `/api/agents/${a.id}/provider-commands`, { name: command.name, argumentsText: 'Harmless exact argument' }));
  assert.equal(invoked.invoked, true); assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].agentId, a.id); assert.equal(f.commands[0].sessionId, f.sessions.get(a.id).engineAgentId); assert.equal(f.commands[0].argumentsText, 'Harmless exact argument');
  assert.equal((await f.api('POST', `/api/agents/${b.id}/provider-commands`, { name: command.name })).status, 409);
  assert.equal((await f.api('POST', `/api/agents/${a.id}/provider-commands`, { name: 'unavailable-fixture' })).status, 409);
  assert.equal(f.commands.length, 1); assert.deepEqual((await f.detail(a.id)).runs.map(x => x.id), before);
  assert.equal((await f.detail(b.id)).runs.find(x => x.status === 'running').id, active.id); assert.equal(session.isAlive(), true);
}));

test('check 34: replaying active steering injects once into the selected Run without starting duplicate work', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Exact steering'), a = await f.createIdleAgent(chat, 'Steered owner'), b = await f.createIdleAgent(chat, 'Unrelated active owner');
  await f.hold(a.id); await f.hold(b.id);
  const beforeA = (await f.detail(a.id)).runs.map(x => x.id), beforeB = (await f.detail(b.id)).runs.map(x => x.id);
  const marker = `Exact active steering ${randomUUID()}`, body = { text: marker, activeRunDelivery: 'steer', idempotencyKey: randomUUID() };
  f.ok(await f.api('POST', `/api/agents/${a.id}/messages`, body)); f.ok(await f.api('POST', `/api/agents/${a.id}/messages`, body));
  await until(() => f.steers.some(x => x.agentId === a.id && JSON.stringify(x.input).includes(marker)), 'accepted exact steering');
  assert.equal(f.steers.filter(x => JSON.stringify(x.input).includes(marker)).length, 1);
  assert.ok(!f.steers.some(x => x.agentId === b.id && JSON.stringify(x.input).includes(marker)));
  assert.deepEqual((await f.detail(a.id)).runs.map(x => x.id), beforeA); assert.deepEqual((await f.detail(b.id)).runs.map(x => x.id), beforeB);
  assert.equal(f.turns.length, 2);
  assert.equal((await f.detail(a.id)).messages.filter(x => x.role === 'user' && x.text.includes(marker)).length, 1);
}));
