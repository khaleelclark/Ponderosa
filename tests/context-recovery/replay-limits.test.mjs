import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const compactError = 'failed to run pre-sampling compact: controlled retry-limit diagnostic';
async function terminal(f, agentId, before) {
  return until(async () => {
    const detail = await f.detail(agentId), runs = detail.runs.filter(run => !before.includes(run.id));
    return runs.length && runs.every(run => !['running', 'preparing'].includes(run.status)) ? detail : false;
  }, 'exact new Run becomes terminal');
}

test('check 95: pre-work compaction failure preserves the accepted source without replay or fake success', options, async t => {
 let store;
 await withFixture(t, async f => {
  const chat = await f.createChat('Bounded compact recovery'), agent = await f.createAgent(chat, 'Bounded retry reader');
  const initial = await f.detail(agent.id);
  const priorReplies = initial.messages.filter(message => message.role === 'assistant').map(message => message.id).sort();
  assert.ok(priorReplies.length > 0, 'Initial successful reply is the positive control');
  const original = f.sessions.get(agent.id), before = initial.runs.map(run => run.id), turnsBefore = f.turns.length;
  const accepted = store.resumeSessionState(agent.id), input = store.acceptedProviderSessionInput(agent.id);
  assert.ok(accepted?.sessionId, 'The initial successful Run must establish a real accepted generation');
  assert.equal(accepted.sessionId, original.engineAgentId);
  assert.ok(input, 'The previously accepted input is the source-preservation control');
  f.plans.set(agent.id, [
    { output: false, run: async session => session.events.push({ type: 'error', terminalStatus: 'failed', message: compactError }) },
  ]);
  await f.send(agent.id, 'Continue this task using the retained source; do not replay earlier effects.');
  const detail = await terminal(f, agent.id, before), runs = detail.runs.filter(run => !before.includes(run.id));
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'failed');
  assert.equal(f.turns.length - turnsBefore, 1, 'Compaction failure must not submit a fresh replay');
  assert.deepEqual(f.turns.slice(turnsBefore).map(turn => turn.sessionId), [accepted.sessionId]);
  assert.deepEqual(store.resumeSessionState(agent.id), accepted, 'Keep the exact accepted generation and contract');
  assert.deepEqual(store.acceptedProviderSessionInput(agent.id), input, 'Keep the exact accepted input and source manifest');
  assert.ok(store.readEvents(agent.id).some(row => row.event.type === 'error' && /failed to run pre-sampling compact/.test(row.event.message)), 'The compaction failure remains visible');
  assert.deepEqual(detail.messages.filter(message => message.role === 'assistant').map(message => message.id).sort(), priorReplies, 'The failed Run must not publish an extra Agent reply');
  await f.reopen();
  assert.equal(f.turns.length - turnsBefore, 1, 'Reopen must not replay the failed task');
  assert.deepEqual(store.resumeSessionState(agent.id), accepted);
  assert.deepEqual(store.acceptedProviderSessionInput(agent.id), input);
  assert.deepEqual((await f.detail(agent.id)).messages.filter(message => message.role === 'assistant').map(message => message.id).sort(), priorReplies);
 }, { storeFactory: root => (store = new AgentStore(root)) });
});

test('check 95: a pre-work quota failure is terminal and does not acquire compact-retry authority', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Quota does not confer retry'), agent = await f.createAgent(chat, 'Quota reader');
  const initial = await f.detail(agent.id);
  const priorReplies = initial.messages.filter(message => message.role === 'assistant').map(message => message.id).sort();
  assert.ok(priorReplies.length > 0, 'Initial successful reply is the positive control');
  const original = f.sessions.get(agent.id), before = initial.runs.map(run => run.id), turnsBefore = f.turns.length;
  f.plans.set(agent.id, [{ output: false, run: async session => session.events.push({ type: 'error', terminalStatus: 'failed', message: 'Usage quota exceeded' }) }]);
  await f.send(agent.id, 'Do not replay this harmless task as compact recovery.');
  const detail = await terminal(f, agent.id, before), runs = detail.runs.filter(run => !before.includes(run.id));
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'failed');
  assert.equal(f.turns.length - turnsBefore, 1, 'Quota opened an automatic fresh replay');
  assert.equal(f.sessions.get(agent.id).engineAgentId, original.engineAgentId, 'Quota silently opened a replacement session');
  assert.deepEqual(detail.messages.filter(message => message.role === 'assistant').map(message => message.id).sort(), priorReplies);
}));
