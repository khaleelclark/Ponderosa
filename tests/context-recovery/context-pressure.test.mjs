import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const Database = createRequire(new URL("../../apps/server/package.json", import.meta.url))('better-sqlite3');

test('rollover defaults on for a fresh workspace; saved choices and limits survive reopen', options, t => withFixture(t, async f => {
  const url = '/api/workspace/preferences';
  const fresh = f.ok(await f.api('GET', url));
  assert.equal(fresh.contextRolloverEnabled, true);
  assert.equal(fresh.contextRolloverTokens, 150000);
  assert.equal(fresh.contextRolloverWindowFraction, 0.7);
  await f.reopen();
  assert.equal(f.ok(await f.api('GET', url)).contextRolloverEnabled, true);
  for (const enabled of [false, true, false]) {
    f.ok(await f.api('PATCH', url, { contextRolloverEnabled: enabled, contextRolloverTokens: 180000, contextRolloverWindowFraction: 0.6 }));
    f.ok(await f.api('PATCH', url, { globalInstructions: 'Preserve the saved rollover choice' }));
    await f.reopen();
    const saved = f.ok(await f.api('GET', url));
    assert.equal(saved.contextRolloverEnabled, enabled);
    assert.equal(saved.contextRolloverTokens, 180000);
    assert.equal(saved.contextRolloverWindowFraction, 0.6);
  }
  const chat = await f.createChat('Saved rollover opt-out'), agent = await f.createAgent(chat, 'Opt-out reader');
  const session = await f.hold(agent.id);
  session.events.push({ type: 'context_usage', providerSessionId: session.engineAgentId, providerSessionGeneration: session.engineAgentId, usedTokens: 190000, windowTokens: 200000 });
  await until(async () => (await readFile(path.join(f.dataDir, 'projects', chat.projectId, 'agents', agent.id, 'events.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).some(line => { const { event } = JSON.parse(line); return event.type === 'context_usage' && event.usedTokens === 190000; }), 'opt-out pressure observation processed');
  const db = new Database(path.join(f.dataDir, 'ponderosa.db'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM context_rollovers WHERE agent_id=?').get(agent.id).n, 0, 'Saved opt-out still triggered automatic rollover');
  } finally { db.close(); }
}));

test('check 93: repeated provider occupancy signals admit one automatic rollover for the exact active session', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Automatic pressure admission'), agent = await f.createAgent(chat, 'Pressure reader');
  const unrelated = await f.createIdleAgent(chat, 'Unaffected reader');
  assert.equal(f.ok(await f.api('GET', '/api/workspace/preferences')).contextRolloverEnabled, true);
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverTokens: 150000, contextRolloverWindowFraction: 0.75 }));
  const session = await f.hold(agent.id), active = (await f.detail(agent.id)).runs.find(x => x.status === 'running');
  assert.ok(active);
  const db = new Database(path.join(f.dataDir, 'ponderosa.db'), { readonly: true, fileMustExist: true });
  try {
    const rows = () => db.prepare('SELECT * FROM context_rollovers WHERE agent_id=?').all(agent.id);
    const occupancy = usedTokens => ({ type: 'context_usage', providerSessionId: session.engineAgentId, providerSessionGeneration: session.engineAgentId, usedTokens, aggregateTokens: 900000, windowTokens: 200000 });
    const events = async () => (await readFile(path.join(f.dataDir, 'projects', chat.projectId, 'agents', agent.id, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
    session.events.push(occupancy(1000));
    await until(async () => (await events()).some(x => x.type === 'context_usage' && x.usedTokens === 1000), 'low occupancy persisted');
    assert.equal(rows().length, 0, 'Aggregate billing usage triggered replacement');
    for (let i = 0; i < 3; i++) session.events.push(occupancy(160000));
    await until(async () => (await events()).filter(x => x.type === 'context_usage' && x.usedTokens === 160000).length === 3, 'all repeated pressure observations processed');
    const cycles = rows(); assert.equal(cycles.length, 1);
    assert.equal(cycles[0].source_run_id, active.id); assert.equal(cycles[0].old_provider_session_id, session.engineAgentId);
    assert.equal(cycles[0].detected_occupancy, 160000);
    assert.ok(cycles[0].compaction_cutoff_event_id, 'Automatic refresh lost its canonical input boundary');
    assert.equal(db.prepare('SELECT count(*) AS n FROM context_rollovers WHERE agent_id=?').get(unrelated.id).n, 0);
    assert.equal((await events()).filter(x => x.type === 'context_rollover_triggered' && x.executionId === active.id).length, 1);
  } finally { db.close(); }
}));

test('checks 93, 94: automatic pressure completes one bounded handoff and preserves its fact in a verified replacement', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Automatic handoff completion'), agent = await f.createAgent(chat, 'Handoff reader');
  const unrelated = await f.createIdleAgent(chat, 'Unaffected reader');
  const fact = `handoff-${randomUUID()}`;
  let retainedFact, replacementSessionId;
  assert.equal(f.ok(await f.api('GET', '/api/workspace/preferences')).contextRolloverEnabled, true);
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { contextRolloverTokens: 150000, contextRolloverWindowFraction: 0.75 }));
  const session = await f.hold(agent.id);
  session.contextUsage = () => ({ usedTokens: 160000, windowTokens: 200000 });
  const events = async () => (await readFile(path.join(f.dataDir, 'projects', chat.projectId, 'agents', agent.id, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
  f.plans.set(agent.id, [
    { run: async (s) => {
      assert.equal(s.engineAgentId, session.engineAgentId, 'Handoff did not use the original provider context');
      s.events.push({ type: 'text', delta: `Continuation context: retain the private harmless fact ${fact}. The original user request still needs its reply. No external side effects have been performed.` });
    } },
    { run: async (s, input, turn) => {
      assert.notEqual(s.engineAgentId, session.engineAgentId, 'Replacement reused the old session');
      retainedFact = JSON.stringify(turn).match(/handoff-[a-f0-9-]{36}/)?.[0];
      assert.equal(retainedFact, fact, 'The accepted handoff was absent from the replacement input');
      replacementSessionId = s.engineAgentId;
      s.events.push({ type: 'context_usage', providerSessionId: s.engineAgentId, providerSessionGeneration: s.engineAgentId, usedTokens: 1000, windowTokens: 200000 });
      await until(async () => (await events()).some(x => x.type === 'context_rollover_completed'), 'replacement accepted before task delivery');
      f.ok(await f.tool(s, 'ponderosa_message', { text: 'Original request recovered' }));
    } },
  ]);
  for (let i = 0; i < 3; i++) session.events.push({ type: 'context_usage', providerSessionId: session.engineAgentId, providerSessionGeneration: session.engineAgentId, usedTokens: 160000, windowTokens: 200000 });
  await until(async () => (await events()).some(x => x.type === 'context_rollover_triggered'), 'automatic rollover admission');
  session.finish();
  const completed = await until(async () => (await events()).find(x => x.type === 'context_rollover_completed'), 'automatic replacement verified');
  assert.notEqual(completed.replacementProviderSessionId, session.engineAgentId);
  await until(async () => !(await f.detail(agent.id)).runs.some(x => ['running', 'preparing'].includes(x.status)), 'verification Run settled');
  assert.equal(session.isAlive(), false, 'The original provider root survived replacement');
  const before = (await f.detail(agent.id)).runs.map(x => x.id);
  f.plans.set(agent.id, [{ run: async (s, input, turn) => {
    assert.equal(s.engineAgentId, replacementSessionId, 'Follow-up left the verified replacement session');
    assert.ok(!input.prompt.includes(fact), 'The follow-up question supplied its own answer');
    f.ok(await f.tool(s, 'ponderosa_message', { text: `Recovered ${retainedFact}` }));
  } }]);
  const followup = 'Report the harmless fact retained before the automatic context refresh.';
  assert.ok(!followup.includes(fact));
  await f.send(agent.id, followup);
  const detail = await f.settled(agent.id, before);
  assert.equal(detail.messages.filter(x => x.text === `Recovered ${fact}`).length, 1);
  const all = await events();
  assert.equal(all.filter(x => x.type === 'context_rollover_triggered').length, 1);
  assert.equal(all.filter(x => x.type === 'context_rollover_completed').length, 1);
  assert.equal(f.turns.filter(x => x.agentId === unrelated.id).length, 0, 'Unrelated Agent woke for another Agent\'s pressure');
}));
