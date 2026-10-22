import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import { withFixture, until } from '../shared/fixture.mjs';

// This file runs in its own Node test process. Retain owned idle sessions so
// failure injection targets a reusable root rather than normal zero-idle eviction.
process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = '4';
const options = { timeout: 30000 };
test('checks 39, 95: failed native provider cleanup blocks compact replacement, retries the same owned root and permits later work only after its observed exit', options, async t => {
  let blockedSession, refuse = false, refusedCloses = 0;
  await withFixture(t, async f => {
    try {
      const chat = await f.createChat('Failed provider cleanup boundary');
      const agent = await f.createAgent(chat, 'Cleanup owner');
      const unrelated = await f.createAgent(chat, 'Unrelated provider survivor');
      const old = f.sessions.get(agent.id), other = f.sessions.get(unrelated.id);
      blockedSession = old.engineAgentId;
      const initial = await f.detail(agent.id), before = initial.runs.map(run => run.id), turnsBefore = f.turns.length;
      const repliesBefore = initial.messages.filter(message => message.role === 'assistant').map(message => message.id).sort();
      assert.ok(old.isAlive() && other.isAlive() && repliesBefore.length);
      f.plans.set(agent.id, [{ output: false, run: async session => {
        refuse = true;
        session.events.push({ type: 'error', terminalStatus: 'failed', message: 'failed to run pre-sampling compact: owned cleanup refusal fixture' });
      } }]);
      await f.send(agent.id, 'One harmless task which must not be replayed across failed cleanup.');
      const failed = await until(async () => {
        const detail = await f.detail(agent.id), runs = detail.runs.filter(run => !before.includes(run.id));
        return runs.length && runs.every(run => !['running', 'preparing'].includes(run.status)) ? detail : false;
      }, 'original task fails before replacement');
      assert.equal(failed.runs.filter(run => !before.includes(run.id)).length, 1);
      assert.equal(failed.runs.find(run => !before.includes(run.id)).status, 'failed');
      await until(() => refusedCloses >= 2, 'automatic retry of retained provider cleanup');
      assert.equal(old.isAlive(), true, 'Controlled failure did not preserve a live native root');
      assert.equal(f.sessions.get(agent.id), old, 'A replacement opened across unconfirmed root exit');
      assert.equal(f.turns.length - turnsBefore, 1, 'Failed cleanup replayed provider input');
      assert.deepEqual(failed.messages.filter(message => message.role === 'assistant').map(message => message.id).sort(), repliesBefore);
      const health = f.ok(await f.api('GET', `/api/conversations/${chat.id}/agent-health`));
      assert.equal(health.agents.find(item => item.agentId === agent.id).runtimeOwnership, 'interrupted', 'Retained cleanup was presented as healthy idle');
      assert.equal(other.isAlive(), true, 'Cleanup retry terminated an unrelated provider root');
      refuse = false;
      await until(() => !old.isAlive(), 'automatic retry observes exact old root exit');
      assert.equal(f.turns.length - turnsBefore, 1, 'Cleanup success silently replayed the failed task');
      assert.equal(other.isAlive(), true);
      const recoveryBefore = (await f.detail(agent.id)).runs.map(run => run.id);
      f.plans.set(agent.id, [{ run: async (session, input) => {
        assert.equal(old.isAlive(), false);
        assert.notEqual(session.engineAgentId, old.engineAgentId);
        const accepted = await until(() => {
          const latestSteer = f.steers.filter(item => item.agentId === agent.id && item.input.prompt.includes('A separate later harmless task after observed cleanup.')).at(-1);
          if (latestSteer) return { prompt: latestSteer.input.prompt, fence: latestSteer.input.clientMessageId, kind: 'steering' };
          if (input.prompt.includes('A separate later harmless task after observed cleanup.')) return { kind: 'turn' };
          return false;
        }, 'later task arrives through actual turn or accepted steering');
        const fence = accepted.fence;
        if (accepted.kind === 'steering') assert.ok(fence, 'Accepted steering omitted its authoritative prompt injection fence');
        t.diagnostic(`Cleanup safety boundaries passed; latest accepted ${accepted.kind} fence ${fence ?? '(default initial turn)'}`);
        f.ok(await f.tool(session, 'ponderosa_message', { intent: 'direct_to_user', text: 'Later owned task completed after cleanup', ...(fence ? { steeringInjectionId: fence } : {}) }));
      } }]);
      await f.send(agent.id, 'A separate later harmless task after observed cleanup.');
      const recovered = await f.settled(agent.id, recoveryBefore);
      assert.equal(recovered.runs.filter(run => !recoveryBefore.includes(run.id)).length, 1);
      assert.equal(recovered.messages.filter(message => message.text === 'Later owned task completed after cleanup').length, 1);
      assert.equal(f.turns.length - turnsBefore, 2);
      assert.equal(other.isAlive(), true);
      t.diagnostic(`Observed ${refusedCloses} controlled close refusals, automatic exact-root retirement, no failed-task replay, one separate successful task`);
    } finally { refuse = false; }
  }, { beforeRuntimeClose: ({ sessionId }) => {
    if (refuse && sessionId === blockedSession) { refusedCloses++; throw new Error('Controlled provider close refusal before native termination'); }
  } });
});

test('coalescing an authored message after another activation preserves every source and its authoritative reply fence',options,async t=>{
  let store;
  await withFixture(t,async f=>{
    const chat=await f.createChat('Coalesced authority'),agent=await f.createIdleAgent(chat,'Bundle owner'),coordination=new CoordinationV3Store(store.sqlite);
    f.plans.set(agent.id,[{run:async(_session,input)=>{
      assert.match(input.prompt,/Earlier non-message source must remain visible/);
      assert.match(input.prompt,/Later authored source must remain visible/);
      assert.match(input.prompt,/After acknowledging this prompt, include steeringInjectionId:[a-f0-9-]+/);
      assert.equal(input.prompt.split('Later authored source must remain visible').length-1,1,'The primary source was duplicated');
    }}]);
    // Both canonical admissions happen in one synchronous turn before the
    // scheduler can lease either. The first source has no dispatch snapshot,
    // matching the recovery-before-human ordering of the Linux failure.
    const now=new Date().toISOString();
    coordination.enqueueMessageActivation({projectId:chat.projectId,agentId:agent.id,messageId:'earlier-source',kind:'human',payload:{steeringRecovery:{instruction:'Earlier non-message source must remain visible'}},now});
    coordination.enqueueMessageActivation({projectId:chat.projectId,agentId:agent.id,messageId:'later-source',kind:'human',payload:{dispatch:{text:'Later authored source must remain visible'}},now});
    await f.settled(agent.id);
    assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,1);
  },{storeFactory:dataDir=>(store=new AgentStore(dataDir))});
});
