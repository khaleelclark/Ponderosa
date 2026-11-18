import assert from 'node:assert/strict';
import test from 'node:test';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

// UI034: a successful reply whose provider close is still in flight is routine
// cleanup. Health must never flash interrupted/Error, yet the old root must still
// exit before the Agent is idle, and a real close failure must stay visible.
test('UI034 successful reply with held provider close stays quiet, keeps cleanup authority and settles Idle', options, async t => {
  let hold = false, release, held, closes = 0, refuse = false;
  await withFixture(t, async f => {
    const chat = await f.createChat('Quiet cleanup');
    const agent = await f.createAgent(chat, 'Quiet replier');
    const health = async () => f.ok(await f.api('GET', `/api/conversations/${chat.id}/agent-health`)).agents.find(item => item.agentId === agent.id);
    const quiet = item => item.runtimeOwnership !== 'interrupted' && !['error', 'failed', 'needs_attention'].includes(item.status) && !item.attention;

    // Normal reply; zero idle sessions closes the provider root after the Run.
    hold = true; held = new Promise(resolve => { release = resolve; });
    const before = (await f.detail(agent.id)).runs.map(run => run.id);
    await f.send(agent.id, 'A short harmless question.');
    const done = await f.settled(agent.id, before);
    const run = done.runs.find(item => !before.includes(item.id));
    assert.equal(run.status, 'completed', 'Canonical Run completion stays successful');
    await until(() => closes > 0, 'provider close begins after the successful Run');
    const session = f.sessions.get(agent.id);
    const replies = done.messages.filter(message => message.role === 'assistant').length;
    for (let read = 0; read < 5; read++) {
      const item = await health();
      assert.ok(quiet(item), `Held close must not read as interrupted/Error: ${JSON.stringify(item)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(session.isAlive(), true, 'Cleanup authority still owns the unclosed root');
    release(); hold = false;
    await until(() => !session.isAlive(), 'exact old root exits');
    const idle = await until(async () => { const item = await health(); return item.status === 'idle' && item; }, 'Agent settles Idle after cleanup');
    assert.ok(quiet(idle));
    assert.equal((await f.detail(agent.id)).messages.filter(message => message.role === 'assistant').length, replies, 'Reply is retained through the transition');

    // A genuine close failure remains distinguishable from routine cleanup.
    refuse = true;
    const before2 = (await f.detail(agent.id)).runs.map(item => item.id);
    await f.send(agent.id, 'Another harmless question.');
    await f.settled(agent.id, before2);
    await until(async () => (await health()).runtimeOwnership === 'interrupted', 'Failed close is still presented as interrupted work');
    refuse = false;
    await until(async () => (await health()).runtimeOwnership !== 'interrupted', 'Automatic retry clears the failure after observed exit');
    t.diagnostic(`Observed ${closes} provider closes`);
  }, { beforeRuntimeClose: async () => {
    closes++;
    if (refuse) throw new Error('Controlled provider close refusal');
    if (hold) await held;
  } });
});
