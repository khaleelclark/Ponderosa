import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { AgentStore, WorkspaceStore, CoordinationV3Store } from '@ponderosa/agents';
import { processBirthMarker } from '@ponderosa/engines';
import { transitionFingerprint } from '../../apps/server/dist/context-transition-admission.js';
import { withFixture, until, runtimeAttachmentPaths, fixtureTestOptions as options } from '../shared/fixture.mjs';

test('checks 14, 15: server drafts use revision fencing, owner isolation and durable recovery', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Drafts'), ownerId = 'browser-a';
  const url = `/api/conversations/${chat.id}/draft`;
  const initial = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  const saved = f.ok(await f.api('PUT', url, { ownerId, clientId: 'tab-a', text: 'Saved draft', attachmentIds: [], expectedRevision: initial.revision }));
  assert.equal((await f.api('PUT', url, { ownerId, clientId: 'tab-b', text: 'Conflicting draft', attachmentIds: [], expectedRevision: initial.revision })).status, 409);
  assert.equal(f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`)).text, saved.text);
  assert.notEqual(f.ok(await f.api('GET', `${url}?ownerId=browser-b`)).text, saved.text);
  await f.reopen(); assert.equal(f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`)).text, saved.text);
}));

test('checks 29, 30, 91: settings persist and invalid settings do not overwrite valid values', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Settings');
  f.ok(await f.api('PATCH', `/api/conversations/${chat.id}`, { defaultModel: 'fixture', defaultEffort: 'medium', instructions: 'Saved Chat guidance' }));
  assert.equal((await f.api('PATCH', `/api/conversations/${chat.id}`, { defaultModel: 'unknown-model' })).status, 400);
  f.ok(await f.api('PATCH', '/api/workspace/preferences', { fontFamily: 'system', globalInstructions: 'Saved global guidance', maxConcurrentAgentRuns: 2 }));
  assert.equal((await f.api('PATCH', '/api/workspace/preferences', { maxConcurrentAgentRuns: 'two' })).status, 400);
  for (const route of ['/api/workspace/preferences', '/api/branches/engine/workspace/preferences']) {
    const full = 'é'.repeat(99_995) + 'TAIL!';
    f.ok(await f.api('PATCH', route, { globalInstructions: full }));
    assert.equal(f.ok(await f.api('GET', route)).globalInstructions, full);
    const rejected = await f.api('PATCH', route, { globalInstructions: full + 'X' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /100,000 characters/);
    assert.equal(f.ok(await f.api('GET', route)).globalInstructions, full);
    f.ok(await f.api('PATCH', route, { globalInstructions: 'Saved global guidance' }));
  }
  await f.reopen();
  const c = f.ok(await f.api('GET', `/api/conversations/${chat.id}`)).conversation;
  assert.equal(c.defaultModel, 'fixture'); assert.equal(c.instructions, 'Saved Chat guidance');
  const prefs = f.ok(await f.api('GET', '/api/workspace/preferences'));
  assert.equal(prefs.maxConcurrentAgentRuns, 2); assert.equal(prefs.globalInstructions, 'Saved global guidance');
}));

test('checks 26, 35, 36: unknown commands and wrong Run cancellation fail; cancelled capabilities cannot publish', options, async t => {
  let store;
  await withFixture(t, async f => {
    const chat = await f.createChat('Cancellation'), agent = await f.createAgent(chat, 'Worker');
    const session = await f.hold(agent.id), d = await f.detail(agent.id), run = d.runs.find(x => x.status === 'running');
    assert.ok(run);
    const packet = JSON.stringify(store.getProviderInput(run.id, true)), cancellationKey = randomUUID();
    assert.ok((await f.api('POST', `/api/agents/${agent.id}/provider-commands`, { name: 'unknown-command' })).status >= 400);
    assert.equal((await f.api('POST', `/api/agents/${agent.id}/cancel`, { targetRunId: randomUUID(), idempotencyKey: randomUUID() })).status, 409);
    f.ok(await f.api('POST', `/api/agents/${agent.id}/cancel`, { targetRunId: run.id, idempotencyKey: cancellationKey }));
    const late = await f.tool(session, 'ponderosa_message', { text: 'Late cancelled output' });
    assert.ok(late.status >= 400);
    const before = (await f.detail(agent.id)).runs.map(x => x.id), turnsBefore = f.turns.length;
    let freshSession;
    f.plans.set(agent.id, [{ run: async next => {
      assert.equal(session.isAlive(), false, 'New work waits for observed old-root exit');
      assert.notEqual(next,session,'The cancelled process capability is never reused');
      freshSession = next.engineAgentId;
      assert.equal((await next.tool('ponderosa_message', { text: 'Fresh independent work completed' })).success, true);
    } }]);
    const task='New work after cancellation';await f.send(agent.id, task);
    const queued=await until(()=>store.sqlite.prepare("SELECT a.id FROM agent_activations a JOIN activation_sources held ON held.activation_id=a.id AND held.source_kind='settings_transition_reservation_wait' WHERE a.agent_id=? AND instr(a.payload_json,?)>0").get(agent.id,task),'independent task held before reviewed recovery');
    await until(()=>store.stoppedProviderSessionBoundary(agent.id)?.cleanupConfirmed,'exact cancelled root cleanup');assert.equal(f.turns.length,turnsBefore);
    const original=store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(run.id),obligations=store.sqlite.prepare('SELECT * FROM required_reply_obligations WHERE run_id=? ORDER BY source_activation_id').all(run.id);
    const status=f.ok(await f.api('GET',`/api/agents/${agent.id}/context-recoveries`)),boundary=status.boundary;assert.equal(boundary.sourceRunId,run.id);
    const commandsBefore=f.commands.length,recoveryBody={idempotencyKey:randomUUID(),expectedSessionId:boundary.providerSessionId,expectedSourceRunId:run.id,expectedToolContractHash:boundary.toolContractHash,acknowledgeUnknownEffects:true};
    const recovered=f.ok(await f.api('POST',`/api/agents/${agent.id}/context-recoveries`,recoveryBody));
    assert.equal(recovered.request.progress.phase,'context_accepted');assert.equal(f.commands.length,commandsBefore+1);assert.equal(f.commands.at(-1).name,'compact');assert.equal(f.commands.at(-1).sessionId,boundary.providerSessionId);assert.equal(f.turns.length,turnsBefore,'Context repair sends no task input');
    f.ok(await f.api('POST',`/api/agents/${agent.id}/context-recoveries/${recovered.request.id}/dismiss`,{acknowledgeStillBlocked:true}));
    const next = await f.settled(agent.id, before);
    assert.equal(next.runs.filter(x => !before.includes(x.id)).length, 1);
    assert.ok(next.runs.some(x => !before.includes(x.id) && x.status === 'completed'));
    assert.equal(f.turns.length, turnsBefore + 1);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,1);
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(run.id),original);assert.deepEqual(store.sqlite.prepare('SELECT * FROM required_reply_obligations WHERE run_id=? ORDER BY source_activation_id').all(run.id),obligations);
    assert.ok(!next.messages.some(x => x.text.includes('Late cancelled output')));
    assert.equal(JSON.stringify(store.getProviderInput(run.id, true)), packet, 'Cancelling a cache cannot rewrite its accepted input');
    const accepted=store.resumeSessionState(agent.id),freshRun=next.runs.find(x=>!before.includes(x.id));
    const completed=store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(freshRun.id),freshPacket=f.ok(await f.api('GET',`/api/runs/${freshRun.id}/provider-input?exact=1`));
    const replay=f.ok(await f.api('POST', `/api/agents/${agent.id}/cancel`, { targetRunId: run.id, idempotencyKey: cancellationKey }));assert.equal(replay.replayed,true);
    assert.deepEqual(store.resumeSessionState(agent.id),accepted,'Replayed cancellation preserves the accepted generation');
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(freshRun.id),completed);
    assert.deepEqual(f.ok(await f.api('GET',`/api/runs/${freshRun.id}/provider-input?exact=1`)),freshPacket);assert.equal(f.turns.length,turnsBefore+1,'Cancellation replay cannot send more task input');
    assert.equal(store.resumeSessionId(agent.id), freshSession, 'Replayed cancellation must preserve the new accepted cache');
  }, { storeFactory: root => store = new AgentStore(root),providerValidatesResumeBeforeTurn:true,
    providerContextRecoverySupport:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},
    providerCommandResult:({sessionId})=>({outcome:'completed',contextUsage:{usedTokens:1000,windowTokens:200000,providerSessionGeneration:sessionId}}) });
});

test('cancelled cache is retained across failed cleanup and retired only after exact observed exit', options, async t => {
  let store, blockedSession, refuse = false, refusals = 0;
  await withFixture(t, async f => {
    try {
      const chat = await f.createChat('Cancelled cleanup boundary'), agent = await f.createIdleAgent(chat, 'Cleanup worker');
      const session = await f.hold(agent.id), run = (await f.detail(agent.id)).runs.find(x => x.status === 'running');
      blockedSession = session.engineAgentId; refuse = true;
      const resetExitObservations = [], clearResume = store.clearResumeSession.bind(store);
      store.clearResumeSession = (id, reason) => {
        if (id === agent.id && reason === 'agent_cancelled') {
          const identity = session.processIdentity;
          // Recovered native cleanup can observe OS exit before the fixture's
          // child-exit callback runs. This inert root has no descendants.
          resetExitObservations.push(!session.isAlive() || Boolean(identity && processBirthMarker(identity.pid) !== identity.birthMarker));
        }
        return clearResume(id, reason);
      };
      const packet = JSON.stringify(store.getProviderInput(run.id, true)), turnsBefore = f.turns.length;
      f.ok(await f.api('POST', `/api/agents/${agent.id}/cancel`, { targetRunId: run.id, idempotencyKey: randomUUID() }));
      await until(() => refusals > 0, 'owned cancellation cleanup refusal');
      assert.equal(session.isAlive(), true);
      assert.equal(store.resumeSessionId(agent.id), blockedSession, 'Failed cleanup must not clear the retained generation');
      assert.equal((await f.tool(session, 'ponderosa_message', { text: 'Late failed-cleanup output' })).status >= 400, true);
      f.plans.set(agent.id, [{ run: async next => {
        assert.equal(session.isAlive(), false, 'No replacement crosses unconfirmed root exit');
        assert.notEqual(next,session,'The cancelled process capability is not resumed');
        assert.equal((await next.tool('ponderosa_message', { text: 'Separate work after cleanup' })).success, true);
      } }]);
      const before = (await f.detail(agent.id)).runs.map(x => x.id);
      const task='Separate independent task waiting for cancellation cleanup';await f.send(agent.id, task);
      await until(() => refusals > 1 || !session.isAlive(), 'retained exact-root cleanup retry or recovered native exit');
      if (store.resumeSessionId(agent.id) === undefined) {
        await until(() => !session.isAlive(), 'fixture observes recovered exact-root exit');
      } else {
        assert.equal(store.resumeSessionId(agent.id), blockedSession);
        if (session.isAlive()) assert.equal(f.turns.length, turnsBefore, 'No input is admitted while old cleanup remains uncertain');
      }
      refuse = false;
      await until(()=>store.stoppedProviderSessionBoundary(agent.id)?.cleanupConfirmed,'exact failed-cleanup root exit');assert.equal(session.isAlive(),false);
      const queued=await until(()=>store.sqlite.prepare("SELECT a.id FROM agent_activations a JOIN activation_sources held ON held.activation_id=a.id AND held.source_kind='settings_transition_reservation_wait' WHERE a.agent_id=? AND instr(a.payload_json,?)>0").get(agent.id,task),'same separate task held for reviewed recovery');assert.equal(f.turns.length,turnsBefore);
      const original=store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(run.id),obligations=store.sqlite.prepare('SELECT * FROM required_reply_obligations WHERE run_id=? ORDER BY source_activation_id').all(run.id);
      const status=f.ok(await f.api('GET',`/api/agents/${agent.id}/context-recoveries`)),boundary=status.boundary;assert.equal(boundary.sourceRunId,run.id);
      const commandsBefore=f.commands.length,recoveryBody={idempotencyKey:randomUUID(),expectedSessionId:boundary.providerSessionId,expectedSourceRunId:run.id,expectedToolContractHash:boundary.toolContractHash,acknowledgeUnknownEffects:true};
      const recovered=f.ok(await f.api('POST',`/api/agents/${agent.id}/context-recoveries`,recoveryBody));
      assert.equal(recovered.request.progress.phase,'context_accepted');assert.equal(f.commands.length,commandsBefore+1);assert.equal(f.commands.at(-1).name,'compact');assert.equal(f.commands.at(-1).sessionId,blockedSession);assert.equal(f.turns.length,turnsBefore,'Context repair does not replay stopped work');
      f.ok(await f.api('POST',`/api/agents/${agent.id}/context-recoveries/${recovered.request.id}/dismiss`,{acknowledgeStillBlocked:true}));
      const finished = await f.settled(agent.id, before);
      assert.equal(session.isAlive(), false);
      assert.equal(f.turns.length, turnsBefore + 1, 'Only the separate new task executes, once');
      assert.deepEqual(resetExitObservations, [], 'Observed cleanup preserves the retained context for explicit recovery');
      assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(queued.id).n,1);
      assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(run.id),original);assert.deepEqual(store.sqlite.prepare('SELECT * FROM required_reply_obligations WHERE run_id=? ORDER BY source_activation_id').all(run.id),obligations);
      assert.equal(finished.runs.find(x => x.id === run.id).status, 'cancelled');
      assert.equal(JSON.stringify(store.getProviderInput(run.id, true)), packet);
      assert.ok(!finished.messages.some(x => x.text.includes('Late failed-cleanup output')));
    } finally { refuse = false; }
  }, { storeFactory: root => store = new AgentStore(root),providerValidatesResumeBeforeTurn:true,
    providerContextRecoverySupport:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},
    providerCommandResult:({sessionId})=>({outcome:'completed',contextUsage:{usedTokens:1000,windowTokens:200000,providerSessionGeneration:sessionId}}), beforeRuntimeClose: ({ sessionId }) => {
    if (refuse && sessionId === blockedSession) { refusals++; throw Error('Controlled cancellation cleanup refusal'); }
  } });
});

test('checks 32, 33: queued input edits and cancellation preserve exactly the remaining work', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Queue'), agent = await f.createAgent(chat, 'Queue worker');
  const session = await f.hold(agent.id), before = f.turns.filter(x => x.agentId === agent.id).length;
  await f.send(agent.id, 'First queued message', { activeRunDelivery: 'queue' });
  await f.send(agent.id, 'Second queued message', { activeRunDelivery: 'queue' });
  const list = f.ok(await f.api('GET', `/api/agents/${agent.id}/queued-messages`));
  const items = Array.isArray(list) ? list : list.items ?? list.messages;
  assert.equal(items.length, 2);
  const first = items.find(x => x.text.includes('First')), second = items.find(x => x.text.includes('Second'));
  const firstId = first.deliveryId ?? first.id, secondId = second.deliveryId ?? second.id;
  f.ok(await f.api('PATCH', `/api/agents/${agent.id}/queued-messages/${firstId}`, { text: 'Edited first queued message', idempotencyKey: randomUUID() }));
  f.ok(await f.api('POST', `/api/agents/${agent.id}/queued-messages/${secondId}/cancel`, { idempotencyKey: randomUUID() }));
  session.finish();
  await until(async () => { const d = await f.detail(agent.id); return f.turns.filter(x => x.agentId === agent.id).length > before && !d.runs.some(x => ['running','preparing'].includes(x.status)); }, 'remaining queue consumption');
  const fresh = f.turns.filter(x => x.agentId === agent.id).slice(before);
  assert.equal(fresh.length, 1); assert.ok(fresh[0].input.prompt.includes('Edited first queued message'));
  assert.ok(!fresh[0].input.prompt.includes('Second queued message'));
}));

test('check 53: passive information round trip uses the next Run without waking new work', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Collaboration'), a = await f.createAgent(chat, 'Sender'), b = await f.createAgent(chat, 'Recipient');
  const sender = await f.hold(a.id), count = f.turns.filter(x => x.agentId === b.id).length;
  const marker = `Passive fact ${randomUUID()}`;
  f.ok(await f.tool(sender, 'ponderosa_message', { delivery: 'next_run', recipientAgentIds: [b.id], text: marker, idempotencyKey: randomUUID() }));
  const recipient = await f.detail(b.id);
  assert.equal(recipient.runs.filter(x => ['running','preparing'].includes(x.status)).length, 0);
  assert.equal(f.turns.filter(x => x.agentId === b.id).length, count);
  const previous = recipient.runs.map(x => x.id);
  const response = `Collaborative answer ${randomUUID()}`;
  f.plans.set(b.id, [{ run: async (s, input) => {
    assert.ok(input.prompt.includes(marker));
    f.ok(await f.tool(s, 'ponderosa_message', { delivery: 'next_run', recipientAgentIds: [a.id], text: response, idempotencyKey: randomUUID() }));
    assert.equal((await s.tool('ponderosa_message', { text: 'Explicit response to the operator' })).success, true);
  } }]);
  await f.send(b.id, 'Use any delivered passive information'); await f.settled(b.id, previous);
  assert.ok(f.turns.filter(x => x.agentId === b.id).at(-1).input.prompt.includes(marker));
  const shared = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(!JSON.stringify(shared.messages ?? shared.conversation.messages).includes(marker));
  sender.finish();
  await until(async () => !(await f.detail(a.id)).runs.some(x => ['running','preparing'].includes(x.status)), 'sender completion');
  const senderPrevious = (await f.detail(a.id)).runs.map(x => x.id);
  await f.send(a.id, 'Read the response from the other Agent'); await f.settled(a.id, senderPrevious);
  assert.ok(f.turns.filter(x => x.agentId === a.id).at(-1).input.prompt.includes(response));
}));

test('check 10: authored Agent collaboration appears in Team Chat, with correct recipients and no shared Chat leak', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Authored collaboration'), a = await f.createAgent(chat, 'Sender'), b = await f.createAgent(chat, 'Recipient');
  const sender = await f.hold(a.id), marker = `Collaborative request ${randomUUID()}`, response = `Collaborative response ${randomUUID()}`;
  const previous = (await f.detail(b.id)).runs.map(x => x.id);
  f.plans.set(b.id, [{ run: async (s, input) => {
    assert.ok(input.prompt.includes(marker));
    f.ok(await f.tool(s, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [a.id], text: response, idempotencyKey: randomUUID() }));
  } }]);
  f.ok(await f.tool(sender, 'ponderosa_message', { intent: 'collaboration', recipientAgentIds: [b.id], text: marker, urgency: 'urgent', idempotencyKey: randomUUID() }));
  await f.settled(b.id, previous);
  const team = f.ok(await f.api('GET', `/api/conversations/${chat.id}/collaboration`));
  assert.ok(JSON.stringify(team).includes(marker)); assert.ok(JSON.stringify(team).includes(response));
  const shared = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
  assert.ok(!JSON.stringify(shared.messages).includes(marker)); assert.ok(!JSON.stringify(shared.messages).includes(response));
  sender.finish(); await until(async () => !(await f.detail(a.id)).runs.some(x => ['running','preparing'].includes(x.status)), 'sender finish');
}));

test('checks 18, 21: attachment references survive close/reopen; removed staged files cannot be sent', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Retained attachment'), agent = await f.createAgent(chat, 'Reader');
  const bytes = `Retained bytes ${randomUUID()}`;
  const upload = async name => f.ok(await f.api('POST', `/api/agents/${agent.id}/attachments`, Buffer.from(bytes), { 'content-type': 'application/octet-stream', 'x-ponderosa-filename': name, 'x-ponderosa-media-type': 'text/plain' }));
  const retained = await upload('retained.txt'), removed = await upload('removed.txt');
  f.ok(await f.api('DELETE', `/api/agents/${agent.id}/attachments/${removed.id}`));
  await f.reopen();
  const before = (await f.detail(agent.id)).runs.map(x => x.id);
  f.plans.set(agent.id, [{ run: async (s, input, turn) => {
    const suppliedPaths = runtimeAttachmentPaths(turn);
    const supplied = suppliedPaths.length ? suppliedPaths : null;
    assert.ok(supplied); assert.equal(await readFile(supplied[0], 'utf8'), bytes);
    assert.equal((await s.tool('ponderosa_message', { text: `Retained: ${bytes}` })).success, true);
  } }]);
  await f.send(agent.id, 'Read the explicitly attached retained file', { attachmentIds: [retained.id] });
  assert.ok((await f.settled(agent.id, before)).messages.some(x => x.text.includes(`Retained: ${bytes}`)));
  assert.equal((await f.api('POST', `/api/agents/${agent.id}/messages`, { text: 'Cannot read removed file', attachmentIds: [removed.id], idempotencyKey: randomUUID() })).status, 404);
}));

test('checks 78, 80, 81, 82: template scope, duplicate import replay and malformed package refusal', { timeout: process.platform === 'win32' ? 90000 : options.timeout }, t => withFixture(t, async f => {
  const source = await f.createChat('Export source'), target = await f.createChat('Import destination');
  const root = await f.createAgent(source, 'Root'); await f.createAgent(source, 'Child', root.id);
  const pkg = f.ok(await f.api('GET', `/api/agents/${root.id}/export?mode=template&organization=true`));
  assert.equal(pkg.agents.length, 2); assert.ok(pkg.agents.every(x => !x.history && !x.artifacts));
  const key = randomUUID(), payload = { package: pkg, conversationId: target.id, engineMapping: { codex: 'codex' } };
  const first = f.ok(await f.api('POST', `/api/projects/${target.projectId}/import-agents`, payload, { 'idempotency-key': key }));
  const retry = f.ok(await f.api('POST', `/api/projects/${target.projectId}/import-agents`, payload, { 'idempotency-key': key }));
  assert.deepEqual(retry.agentIds, first.agentIds); assert.equal(retry.rootAgentId, first.rootAgentId);
  const before = f.ok(await f.api('GET', `/api/projects/${target.projectId}/agents`)).length;
  const malformed = { ...pkg, agents: pkg.agents.map((x,i) => i ? x : { ...x, history: [{ role: 'user', text: 'Forbidden template history', createdAt: new Date().toISOString() }] }) };
  assert.equal((await f.api('POST', `/api/projects/${target.projectId}/import-agents`, { ...payload, package: malformed }, { 'idempotency-key': randomUUID() })).status, 400);
  assert.equal(f.ok(await f.api('GET', `/api/projects/${target.projectId}/agents`)).length, before);
  const copied = f.ok(await f.api('POST', `/api/projects/${target.projectId}/copy-agent`, { sourceAgentId: root.id, conversationId: target.id, rootTitle: 'Renamed copy', mode: 'template', organization: true }, { 'idempotency-key': randomUUID() }));
  assert.equal((await f.detail(copied.rootAgentId)).agent.title, 'Renamed copy');
}));

test('Q01 lost shared-send acknowledgment, settled work, restart and same-key retry preserve one logical delivery', {timeout:30000},t=>withFixture(t,async f=>{
 const chat=await f.createChat('Owned lost acknowledgment'),agent=await f.createAgent(chat,'Owned reader');
 const before=(await f.detail(agent.id)).runs.map(r=>r.id),turnsBefore=f.turns.length;
 const key=randomUUID(),text='#'+agent.handle+' Owned lost acknowledgment '+randomUUID();
 const body={text,idempotencyKey:key,recipientAgentMentions:[{agentId:agent.id,projectId:chat.projectId,handle:agent.handle,currentHandle:agent.handle,currentTitle:agent.title}]};
 await assert.rejects(async()=>{f.ok(await f.api('POST',`/api/conversations/${chat.id}/messages`,body));throw Error('Owned response dropped after server acceptance');},/response dropped/);
 await f.settled(agent.id,before);
 assert.equal(f.turns.length-turnsBefore,1);
 await f.reopen();
 const retry=f.ok(await f.api('POST',`/api/conversations/${chat.id}/messages`,body));
 assert.ok(retry.communicationEventId);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(f.turns.length-turnsBefore,1);
 const conversation=f.ok(await f.api('GET',`/api/conversations/${chat.id}`));
 assert.equal(conversation.messages.filter(m=>JSON.stringify(m).includes(text.split(' ').at(-1))).length,1);
 const mismatch=await f.api('POST',`/api/conversations/${chat.id}/messages`,{...body,text:'Mismatched retry'});
 assert.ok(mismatch.status>=400,'Changed same-key payload was accepted');
}));

test('Q01 lost queue-edit/cancel acknowledgments can be retried without duplicate remaining work',{timeout:30000},t=>withFixture(t,async f=>{
 const chat=await f.createChat('Owned queue retry'),agent=await f.createAgent(chat,'Owned queue reader');
 const session=await f.hold(agent.id),before=f.turns.filter(x=>x.agentId===agent.id).length;
 await f.send(agent.id,'Owned first queued',{activeRunDelivery:'queue'});
 await f.send(agent.id,'Owned second queued',{activeRunDelivery:'queue'});
 const list=f.ok(await f.api('GET',`/api/agents/${agent.id}/queued-messages`));
 const items=Array.isArray(list)?list:list.items??list.messages;
 const first=items.find(x=>x.text.includes('first')),second=items.find(x=>x.text.includes('second'));
 for(const [method,url,payload] of [
  ['PATCH',`/api/agents/${agent.id}/queued-messages/${first.deliveryId??first.id}`,{text:'Owned edited first',idempotencyKey:randomUUID()}],
  ['POST',`/api/agents/${agent.id}/queued-messages/${second.deliveryId??second.id}/cancel`,{idempotencyKey:randomUUID()}],
 ]){
  await assert.rejects(async()=>{f.ok(await f.api(method,url,payload));throw Error('Owned lost queue acknowledgment');},/lost queue/);
  f.ok(await f.api(method,url,payload));
 }
 session.finish();
 await until(async()=>{const detail=await f.detail(agent.id);return f.turns.filter(x=>x.agentId===agent.id).length>before&&!detail.runs.some(r=>['running','preparing'].includes(r.status));},'owned queue settles');
 const fresh=f.turns.filter(x=>x.agentId===agent.id).slice(before);
 assert.equal(fresh.length,1);assert.match(fresh[0].input.prompt,/Owned edited first/);assert.doesNotMatch(fresh[0].input.prompt,/Owned second queued/);
}));

test('Q01 accepted pending work and its durable draft identity survive restart without another logical send', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Pending restart'), blockers = [];
  for (let i = 0; i < 4; i++) { const agent = await f.createIdleAgent(chat, `Occupied ${i}`); await f.hold(agent.id); blockers.push(agent); }
  const agent = await f.createIdleAgent(chat, 'Pending reader'), key = randomUUID(), marker = `Pending restart ${randomUUID()}`;
  const url = `/api/conversations/${chat.id}/draft`, ownerId = 'pending-browser';
  const draft = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  const pending = { idempotencyKey: key, fingerprint: 'a'.repeat(64), text: marker, captureRevision: draft.revision, request: { conversationId: chat.id, recipientAgentIds: [agent.id], runtime: { activeRunDelivery: 'queue' } } };
  f.ok(await f.api('PUT', url, { ownerId, clientId: 'pending-tab', expectedRevision: draft.revision, text: 'Newer unsent draft', attachmentIds: [], pendingSubmissions: [pending] }));
  const body = { text: marker, idempotencyKey: key, activeRunDelivery: 'queue' };
  f.ok(await f.api('POST', `/api/agents/${agent.id}/messages`, body)); // Discard the accepted response.
  f.ok(await f.api('POST', '/api/deployment/drain', {})); // Pause leasing before the fixture releases occupied roots.
  assert.equal((await f.detail(agent.id)).runs.length, 0);
  assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, 0, 'Work must still be pending at restart');
  await f.reopen();
  const recovered = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  assert.equal(recovered.text, 'Newer unsent draft');
  const restored = recovered.pendingSubmissions.find(item => item.idempotencyKey === key); assert.ok(restored);
  for (const field of ['idempotencyKey', 'fingerprint', 'text', 'captureRevision', 'request']) assert.deepEqual(restored[field], pending[field]);
  f.ok(await f.api('POST', `/api/agents/${agent.id}/messages`, body));
  await f.settled(agent.id);
  assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, 1);
  assert.equal((await f.detail(agent.id)).messages.filter(message => message.role === 'user' && message.text.includes(marker)).length, 1);
  assert.equal((await f.api('POST', `/api/agents/${agent.id}/messages`, { ...body, text: 'Changed retry' })).status, 409);
  const latest = f.ok(await f.api('GET', `${url}?ownerId=${ownerId}`));
  const retired = f.ok(await f.api('PUT', url, { ownerId, clientId: 'pending-tab', expectedRevision: latest.revision, text: latest.text, attachmentIds: [], retirePendingSubmissionIds: [key] }));
  assert.equal(retired.text, 'Newer unsent draft'); assert.ok(!retired.pendingSubmissions?.some(item => item.idempotencyKey === key));
}));

test('Q01 exhausted required-reply recovery stops automatically and same-key explicit retry has one lineage', { timeout: process.platform === 'win32' ? 90000 : options.timeout }, t => withFixture(t, async f => {
  const chat = await f.createChat('Reply exhaustion'), agent = await f.createIdleAgent(chat, 'Silent reader'), marker = `Unanswered ${randomUUID()}`;
  f.plans.set(agent.id, Array.from({ length: 12 }, () => ({ run: async () => {} })));
  await f.send(agent.id, marker);
  const message = (await f.detail(agent.id)).messages.find(item => item.role === 'user' && item.text.includes(marker)); assert.ok(message?.communicationEventId);
  const receipts = async () => f.ok(await f.api('POST', `/api/conversations/${chat.id}/message-delivery-receipts`, { communicationEventIds: [message.communicationEventId], activationIds: [] })).items.flatMap(item => item.deliveryReceipts);
  const exhausted = await until(async () => (await receipts()).find(item => item.state === 'retry_exhausted'), 'bounded reply recovery exhaustion', process.platform === 'win32' ? 30000 : 10000);
  assert.equal(exhausted.providerAcknowledged, true); assert.equal(exhausted.retryMayDuplicate, true); assert.equal(exhausted.canRetry, true);
  const count = f.turns.filter(turn => turn.agentId === agent.id).length; assert.equal(count, 6);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, count);
  f.plans.set(agent.id, []);
  const url = `/api/projects/${chat.projectId}/message-deliveries/${exhausted.activationId}/retry`, body = { idempotencyKey: randomUUID() };
  const accepted = f.ok(await f.api('POST', url, body)), replay = f.ok(await f.api('POST', url, body));
  assert.equal(accepted.accepted, true); assert.equal(replay.replayed, true); assert.equal(replay.activationId, accepted.activationId);
  await until(async () => (await f.detail(agent.id)).messages.some(item => item.role === 'assistant'), 'explicit retry publishes one reply');
  assert.equal(f.turns.filter(turn => turn.agentId === agent.id).length, count + 1);
  assert.equal((await f.detail(agent.id)).messages.filter(item => item.role === 'user' && item.text.includes(marker)).length, 1);
  assert.match(f.turns.filter(turn => turn.agentId === agent.id).at(-1).input.prompt, /current state|already|repeat/iu);
}));

test('Q01 a stale stream cursor requests a canonical snapshot rather than replaying obsolete events', options, t => withFixture(t, async f => {
  const chat = await f.createChat('Stream reset'), marker = `Canonical reset ${randomUUID()}`;
  f.ok(await f.api('POST', `/api/conversations/${chat.id}/messages`, { text: marker, idempotencyKey: randomUUID() }));
  const base = await f.listen(), controller = new AbortController();
  const response = await fetch(base + '/api/workspace/stream?lastEventId=1000000000', { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder(); let frame = '';
    while (!frame.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); frame += decoder.decode(chunk.value, { stream: true }); }
    assert.match(frame, /event: workspace_status/u);
    const status = JSON.parse(frame.match(/data: (.+)\n/u)[1]);
    assert.equal(status.reset, true); assert.equal(status.snapshot, true); assert.ok(status.cursor < 1000000000);
    const snapshot = f.ok(await f.api('GET', `/api/conversations/${chat.id}`));
    assert.equal(snapshot.messages.filter(item => item.text.includes(marker)).length, 1);
  } finally { await reader.cancel(); controller.abort(); }
}));

test('global instruction rejection preserves the store revision and complete saved text', options, t => withFixture(t, async f => {
  const workspace = new WorkspaceStore(f.dataDir);
  try {
    const saved = workspace.updatePreferences({globalInstructions:'keep the complete saved text'});
    assert.throws(()=>workspace.updatePreferences({globalInstructions:'x'.repeat(100_001)}),/100,000 characters/);
    assert.equal(workspace.getPreferences().revision,saved.revision);
    assert.equal(workspace.getPreferences().globalInstructions,saved.globalInstructions);
  } finally { workspace.close(); }
}));

function reserveCurrentSettingsTransition(f,store,coordination,projectId,agentId,activationId){
  const workspace=new WorkspaceStore(f.dataDir);
  try {
    const fingerprint=transitionFingerprint({app:f.app,store,workspace},projectId,agentId,activationId);
    assert.equal(coordination.holdSettingsTransitionReservation({projectId,agentId,activationId,fingerprint}),true);
  } finally { workspace.close(); }
}

test('settings-handoff held message uses the existing delivery retry endpoint', options, async t => {
  let store;
  await withFixture(t,async f=>{
    const chat=await f.createChat('Held settings retry'),agent=await f.createIdleAgent(chat,'Reader');
    await f.hold(agent.id);
    await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status='running' AND prompt_injection_state='injected'").get(agent.id),'held input acknowledged');
    const marker='Original queued instructions '+randomUUID();
    await f.send(agent.id,marker,{activeRunDelivery:'queue',model:'fixture',effort:'medium'});
    const row=store.sqlite.prepare(`SELECT a.id,json_extract(r.payload_json,'$.communication.eventId') AS event_id,a.payload_json
      FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id AND s.source_kind='communication'
      JOIN runtime_communications r ON r.id=s.source_id
      WHERE a.agent_id=? AND json_extract(r.payload_json,'$.communication.text')=?`).get(agent.id,marker);
    assert.ok(row?.event_id);
    const coordination=new CoordinationV3Store(store.sqlite),before=row.payload_json;
    reserveCurrentSettingsTransition(f,store,coordination,chat.projectId,agent.id,row.id);
    const receipts=async()=>f.ok(await f.api('POST',`/api/conversations/${chat.id}/message-delivery-receipts`,
      {communicationEventIds:[row.event_id],activationIds:[]})).items.flatMap(item=>item.deliveryReceipts);
    let receipt=(await receipts()).find(item=>item.activationId===row.id);
    assert.equal(receipt.settingsTransitionHold,'retry_available');assert.equal(receipt.canRetry,true);
    const url=`/api/projects/${chat.projectId}/message-deliveries/${row.id}/retry`,body={idempotencyKey:randomUUID()};
    const firstResponse=await f.api('POST',url,body);
    assert.equal(firstResponse.status,202); // Simulate the client losing the accepted response body.
    const replay=f.ok(await f.api('POST',url,body));
    assert.equal(replay.replayed,true);assert.equal(replay.activationId,row.id);
    assert.equal(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(row.id).payload_json,before);
    assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(row.id).state,'pending');
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(row.id).n,0);
    assert.equal((await receipts()).find(item=>item.activationId===row.id).settingsTransitionHold,undefined);
    // A stale action must be refused if a later handoff outcome is unknown.
    const rollover=randomUUID(),handoff=randomUUID(),now=new Date().toISOString(),scope='conversation:'+chat.id;
    store.sqlite.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
      threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,
      source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,terminal_at)
      VALUES(?,?,?,'outcome_unknown','old-session','old-session',100,50,1,'event','[]','[]','old-run','[]',?,?,?,?)`)
      .run(rollover,chat.projectId,agent.id,scope,now,now,now);
    const payload={rolloverId:rollover,settingsTransition:{activationId:row.id,oldSessionId:'old-session',oldContractHash:'a'.repeat(64)}};
    store.sqlite.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
      VALUES(?,?,?,'context_rollover_handoff',100,'next_run','blocker','cancelled',?,?,?,?,?,?)`)
      .run(handoff,chat.projectId,agent.id,handoff,JSON.stringify(payload),now,now,now,scope);
    store.sqlite.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'context_rollover',?)").run(handoff,rollover);
    receipt=(await receipts()).find(item=>item.activationId===row.id);
    assert.equal(receipt.settingsTransitionHold,'review_required');assert.equal(receipt.canRetry,undefined);
    assert.equal((await f.api('POST',url,{idempotencyKey:randomUUID()})).status,409);
    assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(handoff).state,'cancelled');
    assert.equal(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(row.id).payload_json,before);
    assert.equal(f.turns.filter(turn=>turn.agentId===agent.id).length,1,'retry does not send the queued instructions to the active provider');
  },{storeFactory:root=>store=new AgentStore(root)});
});

test('held peer Request retries the same assignment through Work controls', options, async t => {
  let store;
  await withFixture(t,async f=>{
    const chat=await f.createChat('Held peer request'),manager=await f.createIdleAgent(chat,'Manager'),worker=await f.createIdleAgent(chat,'Worker');
    await f.hold(worker.id);
    await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status='running' AND prompt_injection_state='injected'").get(worker.id),'held input acknowledged');
    const coordination=new CoordinationV3Store(store.sqlite),requestId=randomUUID();
    const originalPayload={text:'Finish this exact assigned work',references:['safe-reference'],priority:'high'};
    const assigned=coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,requesterAgentId:manager.id,
      actorScope:'user:local-operator',idempotencyKey:randomUUID(),requests:[{requestId,recipientAgentId:worker.id,
        lifetime:{kind:'indefinite'},payload:originalPayload}]});
    assert.deepEqual(assigned.requestIds,[requestId]);
    const original=store.sqlite.prepare(`SELECT a.id,a.payload_json FROM agent_activations a JOIN activation_sources s
      ON s.activation_id=a.id AND s.source_kind='request' WHERE s.source_id=? AND a.kind='coordination_request'`).get(requestId);
    assert.ok(original);
    reserveCurrentSettingsTransition(f,store,coordination,chat.projectId,worker.id,original.id);
    const details=async()=>f.ok(await f.api('GET',`/api/projects/${chat.projectId}/agent-work/items/request/${requestId}?conversationId=${chat.id}`));
    assert.equal((await details()).requestLifecycle.request.settingsTransitionHold,'retry_available');
    const url=`/api/requests/${requestId}/retry`,body={idempotencyKey:randomUUID(),retryHeldContext:true};
    const first=await f.api('POST',url,body);assert.equal(first.status,200); // discard body, as if response was lost
    const replay=f.ok(await f.api('POST',url,body));
    assert.equal(replay.replayed,true);assert.deepEqual(replay.requestIds,[requestId]);assert.equal(replay.retryOfRequestId,requestId);
    assert.equal(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(original.id).payload_json,original.payload_json);
    assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(original.id).state,'pending');
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(original.id).n,0);
    assert.ok(store.sqlite.prepare("SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_retry_pending'").get(original.id));
    assert.equal(coordination.leaseNextSteering({workerId:'independent-retry-check'}),undefined,
      'a retried Request cannot bypass preflight by steering the current Run');
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests WHERE project_id=?').get(chat.projectId).n,1);
    assert.deepEqual(coordination.getRequest(requestId).payload,originalPayload);
    assert.equal((await details()).requestLifecycle.request.settingsTransitionHold,undefined);
    assert.equal(f.turns.filter(turn=>turn.agentId===worker.id).length,1);
    // Preserve and expose an unknown transition; neither retry mode may replay it.
    const rollover=randomUUID(),handoff=randomUUID(),now=new Date().toISOString(),scope='conversation:'+chat.id;
    store.sqlite.prepare(`INSERT INTO context_rollovers(id,project_id,agent_id,state,old_provider_session_id,provider_session_generation,
      threshold,low_water_mark,compaction_cutoff_ordinal,compaction_cutoff_event_id,recent_tail_event_ids_json,recent_tail_hashes_json,
      source_run_id,source_activation_ids_json,scope_key,created_at,updated_at,terminal_at)
      VALUES(?,?,?,'outcome_unknown','old-session','old-session',100,50,1,'event','[]','[]','old-run','[]',?,?,?,?)`)
      .run(rollover,chat.projectId,worker.id,scope,now,now,now);
    const payload={rolloverId:rollover,settingsTransition:{activationId:original.id,oldSessionId:'old-session',oldContractHash:'a'.repeat(64)}};
    store.sqlite.prepare(`INSERT INTO agent_activations(id,project_id,agent_id,kind,priority,dispatch_policy,prompt_class,state,dedupe_key,payload_json,available_at,created_at,updated_at,scope_key)
      VALUES(?,?,?,'context_rollover_handoff',100,'next_run','blocker','cancelled',?,?,?,?,?,?)`)
      .run(handoff,chat.projectId,worker.id,handoff,JSON.stringify(payload),now,now,now,scope);
    store.sqlite.prepare("INSERT INTO activation_sources(activation_id,source_kind,source_id) VALUES(?,'context_rollover',?)").run(handoff,rollover);
    assert.equal((await details()).requestLifecycle.request.settingsTransitionHold,'review_required');
    assert.equal((await f.api('POST',url,{idempotencyKey:randomUUID(),retryHeldContext:true})).status,409);
    store.sqlite.prepare("UPDATE coordination_requests SET state='outcome_unknown' WHERE id=?").run(requestId);
    assert.equal((await f.api('POST',url,{idempotencyKey:randomUUID()})).status,409,'ordinary retry cannot bypass this hold');
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM coordination_requests WHERE project_id=?').get(chat.projectId).n,1);
    assert.equal(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(original.id).payload_json,original.payload_json);
  },{storeFactory:root=>store=new AgentStore(root)});
});

test('changed settings reservation defers a peer Request until context preflight', options, async t => {
  let store;
  await withFixture(t,async f=>{
    const chat=await f.createChat('Changed reservation preflight'),manager=await f.createIdleAgent(chat,'Manager'),worker=await f.createIdleAgent(chat,'Worker');
    const session=await f.hold(worker.id);
    await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? AND status='running' AND prompt_injection_state='injected'").get(worker.id),'held input acknowledged');
    const coordination=new CoordinationV3Store(store.sqlite),requestId=randomUUID();
    coordination.coordinate({projectId:chat.projectId,conversationId:chat.id,requesterAgentId:manager.id,actorScope:'user:local-operator',idempotencyKey:randomUUID(),
      requests:[{requestId,recipientAgentId:worker.id,lifetime:{kind:'indefinite'},payload:{text:'Preserve this exact work'}}]});
    const original=store.sqlite.prepare("SELECT a.id,a.payload_json FROM agent_activations a JOIN activation_sources s ON s.activation_id=a.id AND s.source_kind='request' WHERE s.source_id=? AND a.kind='coordination_request'").get(requestId);
    assert.ok(original);
    const hold={projectId:chat.projectId,agentId:worker.id,activationId:original.id,fingerprint:'a'.repeat(64)};
    assert.equal(coordination.holdSettingsTransitionReservation(hold),true);
    assert.equal(coordination.settingsTransitionReservationHeld({...hold,fingerprint:'b'.repeat(64)}),false);
    assert.ok(store.sqlite.prepare("SELECT 1 FROM activation_sources WHERE activation_id=? AND source_kind='settings_transition_retry_pending'").get(original.id));
    assert.equal(coordination.leaseNextSteering({workerId:'preflight-bypass-check'}),undefined,'changed context must not steer the old Run');
    assert.equal(store.sqlite.prepare('SELECT state FROM agent_activations WHERE id=?').get(original.id).state,'pending');
    assert.equal(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(original.id).payload_json,original.payload_json);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(original.id).n,0);
    f.plans.set(worker.id,[{hold:true}]);
    assert.equal((await f.tool(session,'ponderosa_message',{text:'The earlier task is complete'})).status,200);
    session.finish();
    await until(()=>f.turns.filter(turn=>turn.agentId===worker.id).length===2,'the original Request reaches its later preflighted Run');
    const resumed=f.turns.filter(turn=>turn.agentId===worker.id).at(-1);
    assert.match(resumed.input.prompt,/Preserve this exact work/);
    assert.equal(store.sqlite.prepare("SELECT count(*) n FROM coordination_requests WHERE project_id=?").get(chat.projectId).n,1);
  },{storeFactory:root=>store=new AgentStore(root)});
});

test('conversation queue listing preserves exact receipts without projecting the full history', options, t => {
  let store;
  return withFixture(t, async f => {
    const chat = await f.createChat('Scoped queue listing'), agent = await f.createAgent(chat, 'Queue target');
    const session = await f.hold(agent.id), path = '/api/conversations/' + chat.id;
    const submissions = [];
    for (const text of ['First queued task', 'Second queued task']) {
      const response = f.ok(await f.api('POST', path + '/direct-messages', {
        text, recipients: [{agentId: agent.id}], activeRunDelivery: 'queue', idempotencyKey: randomUUID(),
      }));
      assert.equal(response.recipients[0].state, 'queued');
      submissions.push({text, response});
    }
    const original = store.getConversationMessages;
    store.getConversationMessages = () => { throw Error('Queue listing must not project unrelated chat history'); };
    let queued;
    try { queued = f.ok(await f.api('GET', path + '/queued-messages')); }
    finally { store.getConversationMessages = original; }
    assert.deepEqual(queued.map(row => ({
      deliveryId: row.deliveryId, messageId: row.messageId,
      targetAgentId: row.targetAgentId, text: row.text,
      position: row.position, conversationId: row.conversationId, status: row.status,
    })), submissions.map(({text, response}, index) => ({
      deliveryId: response.recipients[0].deliveryId, messageId: response.messageId,
      targetAgentId: agent.id, text, position: index + 1,
      conversationId: chat.id, status: 'queued',
    })));
    for (const row of queued) {
      const cancelled = f.ok(await f.api('POST', path + '/queued-messages/' + row.deliveryId + '/cancel', {idempotencyKey: randomUUID()}));
      assert.equal(cancelled.cancelled, true);
    }
    session.finish(); await f.settled(agent.id);
  }, {storeFactory: root => store = new AgentStore(root)});
});

test('Chat rename history records real PATCH origin, survives restart and never invents no-op or legacy provenance',options,async t=>{
 const known='synthetic-literal-title-token-'+randomUUID(),prior=process.env.PONDEROSA_TEST_TITLE_TOKEN;process.env.PONDEROSA_TEST_TITLE_TOKEN=known;t.after(()=>{if(prior===undefined)delete process.env.PONDEROSA_TEST_TITLE_TOKEN;else process.env.PONDEROSA_TEST_TITLE_TOKEN=prior;});
 let store;await withFixture(t,async f=>{
  const secret='synthetic-old-title-secret',chat=await f.createChat(`Original orchard ${known} api_key=${secret}`);
  const initialJournal=new WorkspaceStore(f.dataDir),cursor=initialJournal.cursor();initialJournal.close();
  const read=async(id=chat.id,projectId=chat.projectId,prefix='/api')=>f.ok(await f.api('GET',`${prefix}/projects/${projectId}/agent-work?conversationId=${id}`));
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{title:'First orchard title'}));
  const firstView=await read();assert.ok(firstView.chatChanges,'the existing Work response must expose recorded changes for its exact Chat');let rows=firstView.chatChanges.items;
  assert.equal(rows.length,1);const first=rows[0];
  assert.equal(first.titleChange.title,'First orchard title');assert.match(first.titleChange.previousTitle,/Original orchard/u);assert.equal(first.titleChange.previousTitle.includes(secret),false);assert.equal(first.titleChange.previousTitle.includes(known),false,'known literal credential is redacted before persistence');
  assert.deepEqual(first.titleChange.actor,{kind:'operator_api'});assert.equal(first.titleChange.origin,'operator_request');assert.ok(first.titleChange.requestId);
  const {AgentWorkProjection}=await import('../../apps/server/dist/routes/agent-work.js');const projectionJournal=new WorkspaceStore(f.dataDir);
  try{const projection=new AgentWorkProjection(store,new CoordinationV3Store(store.sqlite),projectionJournal),agent=await f.createIdleAgent(chat,'Inspector owner');for(const scope of [{conversationId:chat.id},{conversationId:chat.id,agentId:agent.id},{agentId:agent.id}])assert.equal(projection.inspect({projectId:chat.projectId,...scope}).chatChanges,undefined,'shared non-operator projection never gains private title history by default');}finally{projectionJournal.close();}
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{title:'First orchard title'}));assert.equal((await read()).chatChanges.items.length,1,'an unchanged title creates no fake Rename');
  f.ok(await f.api('PATCH',`/api/conversations/${chat.id}`,{title:'Second orchard title'}));rows=(await read()).chatChanges.items;
  assert.equal(rows.length,2);assert.equal(rows[0].titleChange.previousTitle,'First orchard title');assert.equal(rows[0].titleChange.title,'Second orchard title');assert.notEqual(rows[0].titleChange.requestId,first.titleChange.requestId);
  const other=await f.createChat('Other Chat');
  f.ok(await f.api('PATCH',`/api/conversations/${other.id}`,{title:'OTHER_CHAT_RENAME'}));
  const scoped=await read();assert.equal(scoped.chatChanges.items.length,2);assert.ok(scoped.chatChanges.items.every(row=>row.conversationId===chat.id&&row.projectId===chat.projectId));assert.equal(JSON.stringify(scoped.chatChanges).includes('OTHER_CHAT_RENAME'),false);
  const foreign=await f.createChat('Foreign project');assert.equal((await f.api('GET',`/api/projects/${foreign.projectId}/agent-work?conversationId=${chat.id}`)).status,404);
  assert.equal((await f.api('GET',`/api/branches/engine/projects/${chat.projectId}/agent-work?conversationId=${chat.id}`)).status,404,'another product cannot expose the same Chat history');
  assert.equal((await f.api('GET',`/api/projects/${chat.projectId}/agent-work`)).body.chatChanges,undefined,'project scope does not clone all Chat histories');
  // Give the one canonical workspace writer a clean lifecycle boundary before
  // adding a retained generic event that predates enriched title provenance.
  await f.shutdownProduct();const journal=new WorkspaceStore(f.dataDir);
  try{
   const persisted=journal.readSince(cursor,10).filter(item=>item.event.type==='conversation_changed'&&item.event.conversationId===chat.id&&item.event.action==='updated');
   assert.equal(persisted.length,2);assert.equal(JSON.stringify(persisted).includes(secret),false,'new durable event never stores the credential value');assert.equal(JSON.stringify(persisted).includes(known),false,'new durable event never stores the known literal credential');
   journal.append({type:'conversation_changed',projectId:chat.projectId,conversationId:chat.id,action:'updated'});
  }finally{journal.close();}
  await f.restartAfterProductShutdown();delete process.env.PONDEROSA_TEST_TITLE_TOKEN;const restarted=(await read()).chatChanges.items;
  assert.equal(restarted.length,3);assert.equal(restarted[0].titleChange,undefined,'legacy generic event does not become a fabricated Rename');
  assert.deepEqual(restarted.find(item=>item.id===first.id),first,'restart retains old/new/origin/request and timestamp');assert.equal(JSON.stringify(restarted).includes(secret),false);assert.equal(JSON.stringify(restarted).includes(known),false);
 },{storeFactory:dir=>(store=new AgentStore(dir))});
});

test('automatic Chat title records system provenance independently of operator renames',options,async t=>{
 await withFixture(t,async f=>{
  const chat=await f.createChat('New Chat'),agent=await f.createIdleAgent(chat,'Synthetic title worker');
  await f.send(agent.id,'Plan the synthetic orchard review.');await f.settled(agent.id);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/generate-title`));
  const history=f.ok(await f.api('GET',`/api/projects/${chat.projectId}/agent-work?conversationId=${chat.id}`)).chatChanges.items;
  const automatic=history.filter(item=>item.titleChange?.origin==='automatic_title');assert.equal(automatic.length,1);
  assert.deepEqual(automatic[0].titleChange.actor,{kind:'system'});assert.equal(automatic[0].titleChange.previousTitle,'New Chat');assert.notEqual(automatic[0].titleChange.title,'New Chat');assert.equal(automatic[0].titleChange.requestId,undefined);
  f.ok(await f.api('POST',`/api/conversations/${chat.id}/generate-title`));
  assert.equal(f.ok(await f.api('GET',`/api/projects/${chat.projectId}/agent-work?conversationId=${chat.id}`)).chatChanges.items.length,history.length,'repeated automatic title request invents no new change');
 });
});

test('Chat change projection is bounded, project-and-Chat exact and rebuilt from the existing workspace log',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'ponderosa-chat-changes-'));let workspace=new WorkspaceStore(root);
 try{
  for(let i=0;i<110;i++)workspace.append({type:'conversation_changed',projectId:'p',conversationId:'chat',action:'updated',titleChange:{previousTitle:`Title ${i}`,title:`Title ${i+1}`,actor:{kind:'operator_api'},origin:'operator_request',requestId:`request-${i}`}});
  workspace.append({type:'conversation_changed',projectId:'foreign',conversationId:'chat',action:'updated'});workspace.append({type:'conversation_changed',projectId:'p',conversationId:'other',action:'updated'});
  const read=()=>workspace.listConversationChanges({projectId:'p',conversationId:'chat',limit:3});
  const selected=read();assert.equal(selected.items.length,3);assert.equal(selected.truncated,true);assert.deepEqual(selected.items.map(item=>item.titleChange.title),['Title 110','Title 109','Title 108']);
  assert.ok(selected.items.every(item=>item.projectId==='p'&&item.conversationId==='chat'));assert.equal(workspace.listConversationChanges({projectId:'p',conversationId:'chat',limit:1000}).items.length,100);
  workspace.close();workspace=new WorkspaceStore(root);assert.deepEqual(read(),selected);assert.equal(workspace.listConversationChanges({projectId:'missing',conversationId:'chat'}).items.length,0);
 }finally{workspace.close();rmSync(root,{recursive:true,force:true});}
});

test('operator Work details trace coalesced messages and every exact Run publication without latest-Run inference', {...options,timeout:90000},async t=>{
 let store,session;
 await withFixture(t,async f=>{
  const chat=await f.createChat('Canonical message trail'),agent=await f.createIdleAgent(chat,'Worker');
  try{
   f.plans.set(agent.id,[{run:async initial=>assert.equal((await initial.tool('ponderosa_message',{text:'Earlier completed Run answer'})).success,true)}]);
   await f.send(agent.id,'Earlier completed requested work');const earlier=(await f.settled(agent.id)).runs.find(run=>run.status==='completed');assert.ok(earlier);
   session=await f.hold(agent.id);const first=(await f.detail(agent.id)).runs.find(run=>run.status==='running');assert.ok(first);
   const queued=await f.createIdleAgent(chat,'Queued worker');await f.send(queued.id,'Waiting message with no admitted Run');
   const wake=await until(()=>store.sqlite.prepare("SELECT id FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state='pending'").get(queued.id),'queued user message');
   const waiting=f.ok(await f.api('GET',`/api/projects/${chat.projectId}/agent-work/items/activation/${wake.id}?conversationId=${chat.id}`)).messageTrace;
   assert.equal(waiting.inputs.length,1);assert.equal(waiting.inputs[0].text,'Waiting message with no admitted Run');assert.deepEqual(waiting.runIds,[]);assert.deepEqual(waiting.replies,[],'a queued input never invents a Run or reply');
   assert.equal((await f.tool(session,'ponderosa_message',{text:'First published answer'})).status,200);
   const secret='fixture-secret-value-for-trail-redaction';await f.send(agent.id,`Second requested check. Authorization: Bearer ${secret}`);
   await until(()=>store.sqlite.prepare('SELECT COUNT(*) n FROM scheduler_run_activations attached JOIN scheduler_runs run ON run.id=attached.run_id LEFT JOIN provider_inputs provider ON provider.scheduler_run_id=run.id WHERE (run.id=? OR provider.execution_id=?)').get(first.id,first.id).n===2,'both actual user inputs attached to the same active Run');
   const endpoint=`/api/projects/${chat.projectId}/agent-work/items/run/${first.id}?conversationId=${chat.id}`;
   const record=f.ok(await f.api('GET',endpoint)),trace=record.messageTrace;assert.ok(trace);
   assert.equal(trace.inputs.length,2);assert.ok(trace.inputs.some(input=>input.text==='Controlled held task'));assert.ok(trace.inputs.some(input=>input.text.includes('Second requested check.')));
   assert.ok(trace.inputs.every(input=>input.sender==='You (local operator)'&&input.recipient==='Worker'&&input.communicationEventId&&input.activationId),'actual intake IDs/source labels are selected, not inferred from text');
   assert.deepEqual(trace.replies.map(reply=>reply.text),['First published answer'],'the one accepted canonical publication is returned; multiple-record rendering is qualified separately');
   assert.ok(trace.replies.every(reply=>reply.runId===first.id&&reply.communicationEventId&&reply.messageId),'all publications retain exact Run/Communication/message identity');
   assert.ok(trace.inputs.every(input=>input.createdAt)&&trace.inputs.some(input=>Date.parse(input.createdAt)>=Math.max(...trace.replies.map(reply=>Date.parse(reply.createdAt)))),'recorded timestamps expose that these Run-level messages precede the later input; no per-input reply is invented');
   assert.equal(JSON.stringify(trace).includes(secret),false,'plain cause excerpts preserve the existing diagnostic secret redaction');
   const earlierTrace=f.ok(await f.api('GET',`/api/projects/${chat.projectId}/agent-work/items/run/${earlier.id}?conversationId=${chat.id}`)).messageTrace;
   assert.deepEqual(earlierTrace.replies.map(reply=>reply.text),['Earlier completed Run answer'],'later same-Agent publications are never attached to an earlier Run by recency');
   assert.deepEqual(f.ok(await f.api('GET',endpoint)).messageTrace,trace,'reading the same evidence invents no action or changing linkage');
   const foreign=await f.createChat('Foreign scope');assert.equal((await f.api('GET',`/api/projects/${foreign.projectId}/agent-work/items/run/${first.id}`)).status,404);
   assert.equal((await f.api('GET',`/api/branches/engine/projects/${chat.projectId}/agent-work/items/run/${first.id}?conversationId=${chat.id}`)).status,404,'other-product inspector cannot expose the Chat');
   const {AgentWorkProjection}=await import('../../apps/server/dist/routes/agent-work.js'),workspace=new WorkspaceStore(f.dataDir);
   try{const projection=new AgentWorkProjection(store,new CoordinationV3Store(store.sqlite),workspace);assert.equal(projection.itemDetails({projectId:chat.projectId,conversationId:chat.id,kind:'run',recordId:first.id}).messageTrace,undefined,'shared callers never obtain host-only message content by default');}finally{workspace.close();}
  }finally{session?.finish();}
 },{storeFactory:dir=>(store=new AgentStore(dir)),schedulerMaxConcurrentRuns:1});
});
