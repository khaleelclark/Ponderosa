import test from 'node:test';
import assert from 'node:assert/strict';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const compactError = 'failed to run pre-sampling compact: controlled private diagnostic';

test('check 95: pre-work compaction failure retries the same task once in a fresh session after the original root exits', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Safe compact retry'), agent = await f.createAgent(chat, 'Retry reader');
  const old = f.sessions.get(agent.id), before = (await f.detail(agent.id)).runs.map(x => x.id), turnsBefore = f.turns.length;
  f.plans.set(agent.id, [
    { output: false, run: async s => s.events.push({ type: 'error', terminalStatus: 'failed', message: compactError }) },
    { run: async (s, input) => {
      assert.equal(old.isAlive(), false, 'Replacement began before observed root exit');
      assert.notEqual(s.engineAgentId, old.engineAgentId);
      assert.match(input.prompt, /One harmless retry task/);
      f.ok(await f.tool(s, 'ponderosa_message', { text: 'Safe retry completed' }));
    } },
  ]);
  await f.send(agent.id, 'One harmless retry task');
  const d = await f.settled(agent.id, before);
  assert.equal(f.turns.length - turnsBefore, 2);
  assert.equal(d.messages.filter(x => x.text === 'Safe retry completed').length, 1);
  assert.equal(d.runs.filter(x => !before.includes(x.id)).length, 1, 'Retry created duplicate scheduler work');
}));

for (const message of [compactError, 'Authentication failed', 'Network connection failed']) {
  test(`check 95: observed provider work prevents fresh replay after ${message.split(':')[0]}`, options, t => withFixture(t, async f => {
    const chat = await f.createChat('No post-work replay'), agent = await f.createAgent(chat, 'Failed reader');
    const before = (await f.detail(agent.id)).runs.map(x => x.id), turnsBefore = f.turns.length;
    f.plans.set(agent.id, [{ run: async s => s.events.push({ type: 'error', terminalStatus: 'failed', message }) }]);
    await f.send(agent.id, 'This task must not be silently replayed after observed work.');
    const d = await until(async () => {
      const detail = await f.detail(agent.id), runs = detail.runs.filter(x => !before.includes(x.id));
      return runs.length && runs.every(x => !['running', 'preparing'].includes(x.status)) ? detail : false;
    }, 'failed Run terminal');
    const runs = d.runs.filter(x => !before.includes(x.id));
    assert.equal(runs.length, 1); assert.equal(runs[0].status, 'failed');
    assert.equal(f.turns.length - turnsBefore, 1, 'Post-work failure opened an automatic replacement');
  }));
}
