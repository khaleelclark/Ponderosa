import assert from 'node:assert/strict';
import test from 'node:test';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const compactError = 'failed to run pre-sampling compact: controlled retry-limit diagnostic';
async function terminal(f, agentId, before) {
  return until(async () => {
    const detail = await f.detail(agentId), runs = detail.runs.filter(run => !before.includes(run.id));
    return runs.length && runs.every(run => !['running', 'preparing'].includes(run.status)) ? detail : false;
  }, 'exact new Run becomes terminal');
}

test('check 95: repeated pre-work compaction failure stops after one fresh retry without duplicating scheduler work or publishing success', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Bounded compact recovery'), agent = await f.createAgent(chat, 'Bounded retry reader');
  const initial = await f.detail(agent.id);
  const priorReplies = initial.messages.filter(message => message.role === 'assistant').map(message => message.id).sort();
  assert.ok(priorReplies.length > 0, 'Initial successful reply is the positive control');
  const original = f.sessions.get(agent.id), before = initial.runs.map(run => run.id), turnsBefore = f.turns.length;
  f.plans.set(agent.id, [
    { output: false, run: async session => session.events.push({ type: 'error', terminalStatus: 'failed', message: compactError }) },
    { output: false, run: async session => {
      assert.equal(original.isAlive(), false, 'Fresh retry began before observed original root exit');
      assert.notEqual(session.engineAgentId, original.engineAgentId);
      session.events.push({ type: 'error', terminalStatus: 'failed', message: compactError });
    } },
  ]);
  await f.send(agent.id, 'Retry this harmless task at most once after a pre-work compact failure.');
  const detail = await terminal(f, agent.id, before), runs = detail.runs.filter(run => !before.includes(run.id));
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'failed');
  assert.equal(f.turns.length - turnsBefore, 2, 'Repeated compact failure opened an unbounded or missing retry');
  assert.equal(new Set(f.turns.slice(turnsBefore).map(turn => turn.sessionId)).size, 2);
  assert.deepEqual(detail.messages.filter(message => message.role === 'assistant').map(message => message.id).sort(), priorReplies, 'Failed retries published an extra Agent reply');
}));

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
