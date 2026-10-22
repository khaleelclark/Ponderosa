import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TERMINAL_REQUEST_STATES } from '@ponderosa/core';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const rendered = turn => JSON.stringify({ input: turn.input, history: turn.history });
const joinActivations = detail => detail.coordinationV3.activations.filter(x => x.kind.startsWith('coordination_join_'));
const ended = (f, id) => until(async () => !(await f.detail(id)).runs.some(x => ['running', 'preparing'].includes(x.status)), 'owned Run ended');

test('checks 40, 46: managed creation replay preserves one visible child, opening Request and Join', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Managed creation replay'), manager = await f.createAgent(chat, 'Manager');
  const session = await f.hold(manager.id), assignment = `Opening assignment ${randomUUID()}`;
  const args = { idempotencyKey: randomUUID(), title: 'Visible managed worker', engine: 'codex', text: assignment, lifetime: { kind: 'indefinite' }, awaitResult: true };
  const agents = () => f.api('GET', `/api/projects/${chat.projectId}/agents`).then(f.ok);
  const before = (await agents()).length;
  assert.equal((await f.tool(session, 'ponderosa_create_managed_agent', { ...args, lifetime: undefined })).status, 400);
  assert.equal((await agents()).length, before, 'Invalid assignment created a partial Agent');
  const first = f.ok(await f.tool(session, 'ponderosa_create_managed_agent', args));
  const replay = f.ok(await f.tool(session, 'ponderosa_create_managed_agent', args));
  assert.equal(replay.replayed, true);
  assert.equal(replay.agent.id, first.agent.id); assert.equal(replay.requestId, first.requestId); assert.equal(replay.joinId, first.joinId);
  assert.equal(first.agent.managerAgentId, manager.id); assert.equal(first.agent.conversationId, chat.id); assert.equal(first.agent.activeEngine, 'codex');
  assert.equal((await agents()).length, before + 1);
  assert.equal((await f.tool(session, 'ponderosa_create_managed_agent', { ...args, title: 'Conflicting replay' })).status, 409);
  assert.equal((await agents()).length, before + 1);
  const child = await f.settled(first.agent.id);
  assert.equal(f.turns.filter(x => x.agentId === first.agent.id).length, 1, 'Replay started another opening assignment');
  assert.ok(rendered(f.turns.find(x => x.agentId === first.agent.id)).includes(assignment));
  assert.ok(child.coordinationV3.requests.some(x => x.id === first.requestId && x.state === 'completed' && x.counterpartyAgentId === manager.id));
  const d = await f.detail(manager.id);
  assert.equal(d.coordinationV3.requests.filter(x => x.direction === 'outbound').length, 1);
  assert.equal(d.coordinationV3.joins.length, 1); assert.equal(d.coordinationV3.joins[0].id, first.joinId); assert.equal(d.coordinationV3.joins[0].state, 'satisfied');
  let final;
  f.plans.set(manager.id, [{ run: async (s, input, turn) => {
    assert.ok(rendered(turn).includes('Controlled worker result'));
    final = f.ok(await f.tool(s, 'ponderosa_message', { intent: 'direct_to_user', text: 'Managed opening result integrated', taskDelivery: 'final' }));
  } }]);
  session.finish(); await until(() => final, 'manager consumed opening result'); await ended(f, manager.id);
}));

for (const [mode, required] of [['all', 3], ['any', 1], ['quorum', 2]]) test(`check 47: ${mode} Join completes at its selected threshold without completing remaining workers`, options, t => withFixture(t, async f => {
  const chat = await f.createChat('Join thresholds'), manager = await f.createAgent(chat, 'Manager');
  const workers = [];
  for (const title of ['Worker A', 'Worker B', 'Worker C']) workers.push(await f.createAgent(chat, title));
  const session = await f.hold(manager.id);
  for (const w of workers) f.plans.set(w.id, [{ hold: true }]);
  const coordinated = f.ok(await f.tool(session, 'ponderosa_coordinate', {
    idempotencyKey: randomUUID(), requests: workers.map(w => ({ recipientAgentId: w.id, text: `Threshold work ${w.title}`, lifetime: { kind: 'indefinite' } })),
    join: { mode, ...(mode === 'quorum' ? { quorum: required } : {}), wakePolicy: 'final_only' },
  }));
  await until(() => workers.every(w => f.turns.filter(x => x.agentId === w.id).length === 2), 'three scheduled workers');
  const resultTexts = [];
  for (let i = 0; i < required; i++) {
    const text = `Threshold result ${i} ${randomUUID()}`; resultTexts.push(text);
    f.ok(await f.tool(f.sessions.get(workers[i].id), 'ponderosa_update_request', { kind: 'completed', text }));
    f.sessions.get(workers[i].id).finish();
    const d = await f.detail(manager.id), join = d.coordinationV3.joins.find(x => x.id === coordinated.joinId);
    assert.equal(join.state, i + 1 === required ? 'satisfied' : 'open');
    assert.equal(joinActivations(d).length, i + 1 === required ? 1 : 0, 'Final-only Join woke before its threshold');
  }
  const d = await f.detail(manager.id), requests = d.coordinationV3.requests.filter(x => coordinated.requestIds.includes(x.id));
  assert.equal(requests.filter(x => x.state === 'completed').length, required);
  assert.ok(requests.filter(x => !workers.slice(0, required).some(w => w.id === x.counterpartyAgentId)).every(x => !TERMINAL_REQUEST_STATES.has(x.state)), 'Threshold fabricated completion of unfinished work');
  let integrated;
  f.plans.set(manager.id, [{ run: async (s, input, turn) => {
    for (const text of resultTexts) assert.ok(rendered(turn).includes(text));
    integrated = f.ok(await f.tool(s, 'ponderosa_message', { intent: 'direct_to_user', text: `${mode} threshold integrated`, ...(mode === 'all' ? { taskDelivery: 'final' } : {}) }));
  } }]);
  session.finish(); await until(() => integrated, 'threshold result consumed'); await ended(f, manager.id);
  assert.equal(joinActivations(await f.detail(manager.id)).filter(x => x.kind === 'coordination_join_satisfied' && x.state === 'consumed').length, 1);
}));

for (const wakePolicy of ['each_result', 'final_only']) test(`check 48: ${wakePolicy} delivers the first result at the intended point and one terminal wake`, options, t => withFixture(t, async f => {
  const chat = await f.createChat('Join wake policy'), manager = await f.createAgent(chat, 'Manager');
  const a = await f.createAgent(chat, 'Worker A'), b = await f.createAgent(chat, 'Worker B');
  const session = await f.hold(manager.id);
  for (const w of [a, b]) f.plans.set(w.id, [{ hold: true }]);
  const coordinated = f.ok(await f.tool(session, 'ponderosa_coordinate', { idempotencyKey: randomUUID(),
    requests: [a, b].map(w => ({ recipientAgentId: w.id, text: `Wake work ${w.title}`, lifetime: { kind: 'indefinite' } })), join: { mode: 'all', wakePolicy } }));
  await until(() => [a, b].every(w => f.turns.filter(x => x.agentId === w.id).length === 2), 'held workers');
  session.finish(); await ended(f, manager.id);
  const first = `First result ${randomUUID()}`, second = `Second result ${randomUUID()}`;
  let progress;
  if (wakePolicy === 'each_result') f.plans.set(manager.id, [{ run: async (s, input, turn) => {
    assert.ok(rendered(turn).includes(first));
    assert.equal((await f.detail(manager.id)).coordinationV3.joins.find(x => x.id === coordinated.joinId).state, 'open');
    assert.equal((await f.tool(s, 'ponderosa_message', { intent: 'direct_to_user', text: 'Premature progress final', taskDelivery: 'final' })).status, 409);
    progress = true;
  } }]);
  f.ok(await f.tool(f.sessions.get(a.id), 'ponderosa_update_request', { kind: 'completed', text: first })); f.sessions.get(a.id).finish();
  if (wakePolicy === 'each_result') { await until(() => progress, 'intermediate result consumed'); await ended(f, manager.id); }
  const partial = await f.detail(manager.id);
  assert.equal(partial.coordinationV3.joins.find(x => x.id === coordinated.joinId).state, 'open');
  assert.equal(joinActivations(partial).length, wakePolicy === 'each_result' ? 1 : 0);
  if (wakePolicy === 'each_result') assert.equal(joinActivations(partial)[0].state, 'consumed');
  let final;
  f.plans.set(manager.id, [{ run: async (s, input, turn) => {
    assert.ok(rendered(turn).includes(first)); assert.ok(rendered(turn).includes(second));
    final = f.ok(await f.tool(s, 'ponderosa_message', { intent: 'direct_to_user', text: `${wakePolicy} final integrated`, taskDelivery: 'final' }));
  } }]);
  f.ok(await f.tool(f.sessions.get(b.id), 'ponderosa_update_request', { kind: 'completed', text: second })); f.sessions.get(b.id).finish();
  await until(() => final, 'terminal result consumed'); await ended(f, manager.id);
  const d = await f.detail(manager.id);
  assert.equal(joinActivations(d).filter(x => x.kind === 'coordination_join_satisfied' && x.state === 'consumed').length, 1);
  assert.equal(d.messages.filter(x => x.text === `${wakePolicy} final integrated`).length, 1);
}));

test('check 51: unanswered blocking Decision rejects a final report until its exact response is consumed', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Blocking final guard'), agent = await f.createAgent(chat, 'Decision owner');
  const worker = await f.createAgent(chat, 'Completed dependency');
  const initialSession = await f.hold(agent.id), previous = f.turns.filter(x => x.agentId === agent.id).length;
  const workerPrevious = (await f.detail(worker.id)).runs.map(x => x.id);
  f.ok(await f.tool(initialSession, 'ponderosa_coordinate', { recipientAgentId: worker.id, text: 'Return the controlled result', completionMode: 'join', wakePolicy: 'final_only' }));
  await f.settled(worker.id, workerPrevious);
  f.plans.set(agent.id, [{ hold: true }]); initialSession.finish();
  await until(() => f.turns.filter(x => x.agentId === agent.id).length > previous, 'manager resumed with completed child');
  const session = f.sessions.get(agent.id), args = { idempotencyKey: randomUUID(), mode: 'text', question: `Final guard ${randomUUID()}`, blocking: true };
  assert.ok((await f.detail(agent.id)).coordinationV3.requests.filter(x => x.direction === 'outbound').every(x => x.state === 'completed'), 'Decision guard must have no unfinished child');
  const decision = f.ok(await f.tool(session, 'ponderosa_decision', args));
  assert.equal(f.ok(await f.tool(session, 'ponderosa_decision', args)).id, decision.id);
  const denied = await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: 'Unanswered premature final', taskDelivery: 'final' });
  assert.equal(denied.status, 409, JSON.stringify(denied.body)); assert.match(denied.body.error, /blocking Decision/);
  assert.ok(!(await f.detail(agent.id)).messages.some(x => x.text === 'Unanswered premature final'));
  session.finish(); await ended(f, agent.id);
  const answer = `Answer supplied after question ${randomUUID()}`; let final;
  f.plans.set(agent.id, [{ run: async (s, input, turn) => {
    assert.ok(rendered(turn).includes(decision.id)); assert.ok(rendered(turn).includes(answer));
    final = f.ok(await f.tool(s, 'ponderosa_message', { intent: 'direct_to_user', text: `Answered final: ${answer}`, taskDelivery: 'final' }));
  } }]);
  const resolved = f.ok(await f.api('POST', `/api/decisions/${decision.id}/respond`, { text: answer })); assert.equal(resolved.status, 'resolved');
  await until(() => final, 'exact Decision response consumed'); await ended(f, agent.id);
  assert.equal((await f.detail(agent.id)).messages.filter(x => x.text === `Answered final: ${answer}`).length, 1);
}));
