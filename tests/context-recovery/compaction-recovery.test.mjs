import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../../packages/agents/dist/index.js';
import { withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

const compactError = 'failed to run pre-sampling compact: controlled private diagnostic';

test('check 95: pre-sampling failure preserves prior native-only work without a fresh retry', options, async t => {
  let store;
  const opened = [];
  await withFixture(t, async f => {
    const chat = await f.createChat('Retained compact failure'), agent = await f.createIdleAgent(chat, 'Retained reader');
    const nativeOnly = 'Only the native inspection found the archived checksum 7c913.';
    f.plans.set(agent.id, [{ run: async s => {
      s.events.push({ type: 'tool_call', id: 'prior-inspection', name: 'native_inspection', input: {} });
      s.events.push({ type: 'tool_result', id: 'prior-inspection', output: nativeOnly });
      f.ok(await f.tool(s, 'ponderosa_message', { text: 'Prior inspection completed.' }));
      s.events.push({ type: 'context_usage', providerSessionId: s.engineAgentId,
        providerSessionGeneration: s.engineAgentId, usedTokens: 1000, windowTokens: 200000,
        requestOutputIncluded: true });
    } }]);
    await f.send(agent.id, 'Inspect the original material and retain the finding.');
    await f.settled(agent.id);
    const old = f.sessions.get(agent.id), prior = store.resumeSessionState(agent.id);
    const priorInput = store.acceptedProviderSessionInput(agent.id), priorEvents = store.readEvents(agent.id);
    assert.ok(prior?.sessionId && priorInput, 'A real completed prior generation is required');
    assert.equal(prior.sessionId, old.engineAgentId);
    assert.ok(priorEvents.some(x => x.event.type === 'tool_result' && x.event.output === nativeOnly));
    assert.ok(!(await f.detail(agent.id)).messages.some(x => x.text.includes(nativeOnly)), 'Finding must not be an authored Communication');
    const before = (await f.detail(agent.id)).runs.map(x => x.id), turnsBefore = f.turns.length, opensBefore = opened.length;
    let failedSession;
    f.plans.set(agent.id, [{ output: false, run: async s => {
      failedSession = s;
      s.events.push({ type: 'error', terminalStatus: 'failed', message: compactError });
    } }]);
    await f.send(agent.id, 'Use the prior finding to finish this assignment.');
    const d = await until(async () => {
      const detail = await f.detail(agent.id), fresh = detail.runs.filter(x => !before.includes(x.id));
      return fresh.length && fresh.every(x => !['running', 'preparing'].includes(x.status)) ? detail : false;
    }, 'failed compaction Run terminal');
    const fresh = d.runs.filter(x => !before.includes(x.id));
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].status, 'failed');
    assert.equal(f.turns.length - turnsBefore, 1, 'Failure must not resubmit a fresh input');
    assert.ok(opened.length <= opensBefore + 1, 'At most one resumed root may open for the failed attempt');
    assert.ok(opened.slice(opensBefore).every(x => x.resumeSessionId === prior.sessionId), 'Any admitted root must resume the exact prior generation');
    assert.ok(f.turns.slice(turnsBefore).every(x => x.sessionId === prior.sessionId), 'No turn may use a fresh generation');
    assert.ok(failedSession && !failedSession.isAlive(), 'Actual failing provider process must drain');
    assert.deepEqual(store.resumeSessionState(agent.id), prior, 'Keep the exact prior accepted ID and contract');
    assert.deepEqual(store.acceptedProviderSessionInput(agent.id), priorInput, 'Keep the exact prior accepted input and manifest');
    assert.deepEqual(store.readEvents(agent.id).slice(0, priorEvents.length), priorEvents, 'Prior native work/history cannot be rewritten');
    assert.ok(!store.readEvents(agent.id).slice(priorEvents.length).some(x => x.event.type === 'session_reset'));
    assert.ok(store.readEvents(agent.id).some(x => x.event.type === 'error' && /failed to run pre-sampling compact/.test(x.event.message)));
    const recovery = f.ok(await f.api('GET', '/api/agents/'+agent.id+'/context-recoveries'));
    assert.equal(recovery.support.status, 'unsupported', 'The controlled adapter has no native recovery protocol');
    assert.equal(recovery.request, null, 'Failure must not manufacture a recovery operation');
    t.diagnostic(JSON.stringify({ recoverySupport: recovery.support.status, boundary: recovery.boundary }));
    const opensAfterFailure = opened.length;
    await f.reopen();
    assert.deepEqual(store.resumeSessionState(agent.id), prior);
    assert.deepEqual(store.acceptedProviderSessionInput(agent.id), priorInput);
    assert.deepEqual(store.readEvents(agent.id).slice(0, priorEvents.length), priorEvents);
    assert.equal(f.turns.length - turnsBefore, 1, 'Restart must not replay the failed assignment');
    assert.equal(opened.length, opensAfterFailure, 'Restart must not open another provider root');
    assert.equal((await f.detail(agent.id)).runs.filter(x => !before.includes(x.id)).length, 1);
  }, { storeFactory: p => (store = new AgentStore(p)), onProviderOpen: options => opened.push(options) });
});

test('check 95: first-turn pre-sampling failure stays visible without automatic replay', options, async t => {
  let store;
  const opened = [];
  await withFixture(t, async f => {
    const chat = await f.createChat('First compact failure'), agent = await f.createIdleAgent(chat, 'Fresh reader');
    assert.equal(store.resumeSessionState(agent.id), undefined, 'No accepted prior generation');
    const before = (await f.detail(agent.id)).runs.map(x => x.id), turnsBefore = f.turns.length;
    f.plans.set(agent.id, [{ output: false, run: async s => s.events.push({ type: 'error', terminalStatus: 'failed', message: compactError }) }]);
    await f.send(agent.id, 'A first task whose provider fails before sampling.');
    const d = await until(async () => {
      const detail = await f.detail(agent.id), fresh = detail.runs.filter(x => !before.includes(x.id));
      return fresh.length && fresh.every(x => !['running', 'preparing'].includes(x.status)) ? detail : false;
    }, 'first failed Run terminal');
    assert.equal(d.runs.filter(x => !before.includes(x.id)).length, 1);
    assert.equal(d.runs.find(x => !before.includes(x.id)).status, 'failed');
    assert.equal(f.turns.length - turnsBefore, 1);
    assert.equal(opened.length, 1);
    assert.ok(store.readEvents(agent.id).some(x => x.event.type === 'error' && /failed to run pre-sampling compact/.test(x.event.message)));
  }, { storeFactory: p => (store = new AgentStore(p)), onProviderOpen: options => opened.push(options) });
});

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
