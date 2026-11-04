import assert from 'node:assert/strict';
import test from 'node:test';
import {AgentStore,CoordinationV3Store} from '@ponderosa/agents';
import { fixture, withFixture, until, fixtureTestOptions as options } from '../shared/fixture.mjs';

// This file runs in its own Node test process. Retain owned idle sessions so
// failure injection targets a reusable root rather than normal zero-idle eviction.
process.env.PONDEROSA_MAX_IDLE_RUNTIME_SESSIONS = '4';
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

test('product shutdown drains a live provider before fixture cleanup and retains the uncertain Run',options,async t=>{
 let store, reopened, succeeded=false, timeout;
 const closeCalls=[];
 const f=await fixture({
  storeFactory:dataDir=>(store=new AgentStore(dataDir)),
  beforeRuntimeClose:owner=>{closeCalls.push(owner);},
 });
 try {
  const chat=await f.createChat('Controlled shutdown');
  const agent=await f.createIdleAgent(chat,'Shutdown worker');
  const session=await f.hold(agent.id);
  const run=await until(()=>store.sqlite.prepare(
   "SELECT id,fencing_token,prompt_injection_state FROM scheduler_runs WHERE agent_id=? AND status='running' AND prompt_injection_state='injected'"
  ).get(agent.id),'held injected Run');
  assert.equal(session.isAlive(),true,'controlled provider must be live before product shutdown');
  assert.equal(closeCalls.length,0,'fixture must not close the provider before product shutdown');
  const turns=f.turns.length;
  let owned;
  if(session.processIdentity){
   owned=store.sqlite.prepare('SELECT pid,pgid,birth_marker FROM provider_process_authority WHERE agent_id=? AND run_id=?').get(agent.id,run.id);
   assert.deepEqual(owned,{pid:session.processIdentity.pid,pgid:session.processIdentity.pgid,birth_marker:session.processIdentity.birthMarker},'the durable authority matches the exact controlled provider');
  }
  await Promise.race([
   f.shutdownProduct(),
   new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Product shutdown did not complete within 10 seconds')),10_000);}),
  ]);
  clearTimeout(timeout); timeout=undefined;
  assert.ok(closeCalls.some(owner=>owner.agentId===agent.id&&owner.sessionId===session.engineAgentId),'product shutdown invoked the exact session close');
  assert.equal(session.isAlive(),false,'product shutdown returned before observed provider exit');
  assert.equal(f.turns.length,turns,'product shutdown replayed provider input');
  reopened=new AgentStore(f.dataDir);
  const persisted=reopened.sqlite.prepare('SELECT status,prompt_injection_state,terminal_at FROM scheduler_runs WHERE id=? AND agent_id=?').get(run.id,agent.id);
  assert.equal(persisted?.status,'outcome_unknown','the submitted Run remains durably uncertain');
  assert.equal(persisted?.prompt_injection_state,'injected');
  assert.ok(persisted?.terminal_at,'the uncertain outcome is durably recorded');
  assert.equal(reopened.sqlite.prepare("SELECT count(*) n FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(agent.id).n,0,'shutdown left a live Run');
  // An exited POSIX row may remain for the existing startup exit reconciliation.
  // If retained, it must be the exact root whose exit was observed above.
  const retained=reopened.sqlite.prepare('SELECT pid,pgid,birth_marker FROM provider_process_authority WHERE agent_id=?').all(agent.id);
  assert.ok(retained.length===0||owned&&retained.length===1&&retained[0].pid===owned.pid&&retained[0].pgid===owned.pgid&&retained[0].birth_marker===owned.birth_marker,'shutdown retained unrelated provider authority');
  reopened.close();reopened=undefined;
  // Restart directly after product close; no fixture child cleanup runs here.
  await f.restartAfterProductShutdown();
  const afterRestart=store.sqlite.prepare('SELECT status,prompt_injection_state,terminal_at FROM scheduler_runs WHERE id=? AND agent_id=?').get(run.id,agent.id);
  assert.equal(afterRestart?.status,'outcome_unknown','restart changed the uncertain outcome');
  assert.equal(afterRestart?.prompt_injection_state,'injected');
  assert.ok(afterRestart?.terminal_at);
  assert.equal(store.sqlite.prepare('SELECT count(*) n FROM provider_process_authority WHERE agent_id=?').get(agent.id).n,0,'startup did not reconcile the exited provider identity');
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(f.turns.length,turns,'startup replayed the uncertain provider input');
  assert.equal(store.sqlite.prepare("SELECT count(*) n FROM scheduler_runs WHERE agent_id=? AND status IN ('leased','running')").get(agent.id).n,0,'restart leased a replacement for the uncertain Run');
  succeeded=true;
 } finally {
  if(timeout)clearTimeout(timeout);
  reopened?.close();
  if(!succeeded)t.diagnostic(`Failed disposable fixture retained: ${f.root}`);
  // Only after the product shutdown assertion, use fixture cleanup as a fallback.
  await f.dispose(succeeded);
 }
});
