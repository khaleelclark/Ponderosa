import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentStore, CoordinationV3Store } from '@ponderosa/agents';
import { containedCliInvocation } from '../../packages/engines/dist/contained-spawn.js';
import { runtimeEnvironment } from '../../packages/engines/dist/runtime-environment.js';
import { withFixture, fixtureTestOptions as options } from '../shared/fixture.mjs';

const input = { bin: '/owned/provider', args: ['literal ${HOME}', 'two words'], cwd: '/', env: {}, stdin: 'pipe' };
const host = { PONDEROSA_AGENT_SCOPE_MODE: 'systemd', PONDEROSA_AGENT_PARENT_UNIT: 'owned-parent.service' };

test('opt-in Linux scopes enforce validated host memory limits without changing provider arguments', () => {
  for (const [setting, mib] of [[undefined, 8192], ['1', 1], ['192', 192], ['1048576', 1048576]]) {
    const invocation = containedCliInvocation({ ...input, env: { PONDEROSA_AGENT_MEMORY_MAX_MIB: '999999999' } }, 'linux', {
      ...host, ...(setting === undefined ? {} : { PONDEROSA_AGENT_MEMORY_MAX_MIB: setting }),
    });
    assert.equal(invocation.bin, 'systemd-run');
    for (const property of [`MemoryMax=${mib * 1024 ** 2}`, 'MemorySwapMax=0', 'OOMPolicy=kill', 'PartOf=owned-parent.service']) {
      assert.ok(invocation.args.includes('--property=' + property), property);
    }
    assert.equal(invocation.args.some(argument => argument.startsWith('--property=MemoryHigh=')), false, 'Per-scope reclaim must not stall work before the hard boundary');
    assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--') + 1), [input.bin, ...input.args]);
    assert.ok(invocation.args.includes('--expand-environment=no'));
  }
  for (const setting of ['', '0', '-1', '1.5', '1e3', ' 192', '192 ', '1048577', 'NaN', 'Infinity']) {
    assert.throws(() => containedCliInvocation(input, 'linux', { ...host, PONDEROSA_AGENT_MEMORY_MAX_MIB: setting }), /PONDEROSA_AGENT_MEMORY_MAX_MIB/);
  }
  for (const platform of ['darwin', 'win32']) assert.deepEqual(containedCliInvocation(input, platform, host), { bin: input.bin, args: input.args });
  assert.deepEqual(containedCliInvocation(input, 'linux', {}), { bin: input.bin, args: input.args });
  assert.equal(runtimeEnvironment({ PONDEROSA_AGENT_MEMORY_MAX_MIB: '192' }).PONDEROSA_AGENT_MEMORY_MAX_MIB, undefined);
});

test('orderly shutdown skips full replay and restart repairs projections without losing Decisions or retrying uncertain work', options, async t => {
  let store, shutdownReplays = 0;
  await withFixture(t, async f => {
    const chat = await f.createChat('Shutdown canonical recovery');
    const questions = [];
    for (const title of ['Pending answer', 'Saved answer']) {
      const agent = await f.createIdleAgent(chat, title);
      let decision;
      f.plans.set(agent.id, [{ output: false, run: async session => {
        decision = f.ok(await f.tool(session, 'ponderosa_decision', {
          mode: 'text', question: title, blocking: true, idempotencyKey: randomUUID(),
        }));
      } }]);
      await f.send(agent.id, 'Ask ' + title);
      await f.settled(agent.id);
      questions.push({ agent, decision });
    }
    const [pending, answered] = questions;
    const previous = (await f.detail(answered.agent.id)).runs.map(run => run.id);
    const route = `/api/decisions/${answered.decision.id}/respond`;
    const saved = f.ok(await f.api('POST', route, { text: 'Preserve this decision' }));
    await f.settled(answered.agent.id, previous);

    const worker = await f.createIdleAgent(chat, 'Uncertain worker');
    const coordination = new CoordinationV3Store(store.sqlite);
    const requestId = coordination.coordinate({
      projectId: chat.projectId, conversationId: chat.id, actorScope: 'user:local-operator', idempotencyKey: randomUUID(),
      requests: [{ recipientAgentId: worker.id, lifetime: { kind: 'indefinite' } }],
    }).requestIds[0];
    coordination.updateRequest({ requestId, updateId: randomUUID(), kind: 'outcome_unknown', actor: { kind: 'supervisor' } });
    const requestBefore = store.sqlite.prepare('SELECT * FROM coordination_requests WHERE id=?').get(requestId);
    assert.equal(requestBefore.state, 'outcome_unknown');
    const turns = f.turns.length;
    const messages = (await f.detail(answered.agent.id)).messages.map(message => message.id).sort();
    assert.ok(messages.length);
    // Only the derived communication view is damaged. Canonical JSONL and V3
    // authority must survive a write-active close without a clean checkpoint.
    store.sqlite.prepare('DELETE FROM messages WHERE agent_id=?').run(answered.agent.id);
    await f.reopen();
    assert.equal(shutdownReplays, 0, 'Shutdown replayed the entire lifetime before releasing SQLite');
    assert.equal(store.startupProfile().mode, 'recovery');
    assert.deepEqual((await f.detail(answered.agent.id)).messages.map(message => message.id).sort(), messages);
    assert.equal(f.ok(await f.api('GET', '/api/decisions?id=' + pending.decision.id))[0].status, 'pending');
    assert.deepEqual(f.ok(await f.api('GET', '/api/decisions?id=' + answered.decision.id))[0], saved);
    assert.deepEqual(f.ok(await f.api('POST', route, { text: 'Preserve this decision' })), saved);
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM coordination_requests WHERE id=?').get(requestId), requestBefore);
    assert.equal(f.turns.length, turns, 'Restart or answer replay duplicated provider work');
    assert.equal(store.sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  }, { storeFactory: dataDir => {
    store = new AgentStore(dataDir);
    const rebuild = store.rebuildProjections.bind(store);
    store.rebuildProjections = () => { shutdownReplays++; return rebuild(); };
    return store;
  } });
});
